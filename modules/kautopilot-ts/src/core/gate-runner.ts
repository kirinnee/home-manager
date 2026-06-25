import {
	ghIsPrMerged,
	ghLatestReleaseComplete,
	ghMergePr,
	hasSemanticReleaser,
} from "./github";
import {
	type GateLevel,
	type Orchestration,
	type PlanProgress,
	readOrchestration,
	recordPlanProgress,
	unsatisfiedDeps,
} from "./orchestration";
import { findRepo, type SessionMeta } from "./session-meta";

// ============================================================================
// Gate runner — advance merge-/release-gated dependencies between drives.
//
// The DAG edges carry a gate level (completed | merged | released). `completed`
// is satisfied purely from exec progress, but `merged`/`released` depend on the
// outside world, so something must OBSERVE (and, in `auto` sessions, ACTION) the
// merge + release of upstream PRs. That's this module: before the driver decides
// whether a repo/plan is blocked, it reconciles every `pr_open` plan against
// GitHub — promoting it to `merged`/`released` as the world catches up, and (only
// in `auto`) merging a ready PR itself. Everything is best-effort + sandbox-safe:
// missing gh / worktree degrades to "no change", never throws.
// ============================================================================

/** The highest gate any downstream plan demands of this upstream plan. */
function maxGateDemanded(
	orch: Orchestration,
	repo: string,
	plan: string,
): GateLevel | null {
	const gates = orch.master.deps
		.filter((d) => d.dependsOnRepo === repo && d.dependsOn === plan)
		.map((d) => d.gate);
	if (gates.includes("released")) return "released";
	if (gates.includes("merged")) return "merged";
	if (gates.includes("completed")) return "completed";
	return null;
}

/** Resolve the worktree path for a plan's repo (for release-config detection). */
function worktreeFor(meta: SessionMeta, repo: string): string | null {
	return findRepo(meta, repo)?.worktree ?? null;
}

/**
 * Reconcile one `pr_open` plan against the world. In `auto` mode, merge its PR
 * once it is ready (the poll loop already drove it to ready-to-merge before the
 * repo reached `pr_open`). Promote `pr_open → merged → released` as GitHub catches
 * up. Only does the release check when a downstream actually demands `released`
 * AND the repo has a semantic releaser — otherwise `merged` is the terminal gate.
 */
async function reconcilePlan(
	meta: SessionMeta,
	orch: Orchestration,
	p: PlanProgress,
): Promise<void> {
	const wt = worktreeFor(meta, p.repo);
	if (p.prNumber == null) {
		// A `pr_open` plan should always carry the PR number polish recorded with it.
		// If it doesn't, the record is inconsistent and we can't observe its merge —
		// surface it rather than silently blocking downstream gates forever.
		console.warn(
			`[gate-runner] ${p.repo}/${p.plan} is pr_open but has no prNumber — cannot reconcile its merge/release gate`,
		);
		return;
	}

	// In auto mode, merge a ready PR so downstream `merged`/`released` gates clear.
	if (orch.mergeMode === "auto") {
		const alreadyMerged = await ghIsPrMerged(p.prNumber, wt ?? undefined).catch(
			() => false,
		);
		if (!alreadyMerged) {
			await ghMergePr(p.prNumber, wt ?? undefined).catch(() => false);
		}
	}

	// Re-read the merged state (auto: post-merge; manual: the user's merge). If the
	// merge hasn't landed yet (queue, API lag), we record nothing and return — this
	// runs again on the NEXT drive (reconcileGates is idempotent), so it self-heals
	// once GitHub catches up; the downstream simply stays blocked until then.
	const merged = await ghIsPrMerged(p.prNumber, wt ?? undefined).catch(
		() => false,
	);
	if (!merged) return;

	const demanded = maxGateDemanded(orch, p.repo, p.plan);
	// If a downstream needs `released` and the repo publishes releases, hold at
	// `merged` until the release is fully out; otherwise `merged` is terminal.
	if (demanded === "released" && wt && hasSemanticReleaser(wt)) {
		const released = await ghLatestReleaseComplete(wt).catch(() => false);
		recordPlanProgress(meta.sessionId, p.repo, p.plan, {
			status: released ? "released" : "merged",
		});
		return;
	}
	recordPlanProgress(meta.sessionId, p.repo, p.plan, { status: "merged" });
}

/**
 * Reconcile every gated plan for the session, then return the freshly-read
 * orchestration (or null when there is none). Safe to call before any gate
 * decision: it only advances `pr_open` plans whose downstreams demand
 * merge/release, and never regresses a status.
 */
export async function reconcileGates(
	meta: SessionMeta,
): Promise<Orchestration | null> {
	const orch = readOrchestration(meta.sessionId);
	if (!orch) return null;
	// Only plans that have an open PR and at least one downstream needing
	// merge/release are worth a network round-trip. A `completed`-only demand is
	// satisfied locally from exec progress, so it never needs a gh reconcile.
	const toCheck = orch.progress.filter((p) => {
		if (p.status !== "pr_open") return false;
		const demanded = maxGateDemanded(orch, p.repo, p.plan);
		return demanded === "merged" || demanded === "released";
	});
	for (const p of toCheck) {
		await reconcilePlan(meta, orch, p).catch(() => {});
	}
	return readOrchestration(meta.sessionId);
}

/**
 * The blockers for a repo's NOT-YET-STARTED plans: unsatisfied merge/release gate
 * edges, as human-readable strings. Empty when the repo is clear to proceed. The
 * driver surfaces these as a "waiting on gate" done-result rather than letting the
 * repo seed a worktree off a base that doesn't yet contain the upstream work.
 *
 * Only `pending` plans gate the repo: a plan that is already running / implemented /
 * pr_open is in flight (its worktree is seeded), so blocking on it now would only
 * stall its own commit/PR/polish. The driver further consults this only BEFORE a
 * repo goes active, so in-flight work is never retroactively gated.
 */
export function repoGateBlockers(orch: Orchestration, repo: string): string[] {
	const blockers: string[] = [];
	for (const p of orch.progress) {
		if (p.repo !== repo) continue;
		if (p.status !== "pending") continue;
		for (const d of unsatisfiedDeps(orch, p.repo, p.plan)) {
			blockers.push(
				`${repo}/${p.plan} waits for ${d.dependsOnRepo}/${d.dependsOn} to be ${d.gate}`,
			);
		}
	}
	return blockers;
}
