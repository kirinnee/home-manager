import {
	type GateLevel,
	type MergeMode,
	type Orchestration,
	type PlanNode,
	type PlanProgress,
	derivePrProgress,
	unsatisfiedDeps,
} from "./orchestration";

// ============================================================================
// DAG scheduler — kautopilot as a record-keeper + scheduler (not a kloop driver).
//
// The master plan is a multi-stage DAG of plans grouped into PRs, with gate-leveled
// edges. The AGENT drives kloop / resolves conflicts / opens + merges PRs, and
// records each lifecycle transition via `kautopilot record`. This module answers the
// three scheduling questions the agent asks via `kautopilot schedule`:
//   1. "What plan(s) can I run NOW?"    → `ready` (deps satisfied, not started)
//   2. "Which PR needs polish now?"     → `toPolish` (all plans implemented)
//   3. "What PR must merge to unblock?" → `toMerge` (a pr_ready PR gating a downstream)
// plus `blocked` (waiting, with why), `running` (in flight), and the epoch-level
// `allReady` (no scheduled execution/merge work remains → feedback) / `done` (all merged).
//
// Pure over the orchestration record; no I/O, no GitHub, no kloop.
// ============================================================================

export interface PlanRef {
	repo: string;
	plan: string;
	/** The PR (PrPlan id) this plan ships in, per the master plan. */
	pr: string | null;
	kloopRunId?: string | null;
}

export interface BlockedRef {
	repo: string;
	plan: string;
	/** The upstream gate edges not yet satisfied. */
	waitingOn: { repo: string; plan: string; gate: GateLevel }[];
}

export interface MergeRef {
	pr: string;
	repo: string;
	branch: string;
	prNumber: number | null;
	prUrl: string | null;
	/** The next gate the controller must clear for this PR. */
	gate: "merged" | "released";
	/** Downstream `repo/plan`s this PR's merge would unblock (empty = terminal PR). */
	unblocks: string[];
}

export interface PolishRef {
	pr: string;
	repo: string;
	branch: string;
	prNumber: number | null;
	prUrl: string | null;
	/** `pending` means open the PR first; `open` means continue PR polish. */
	status: "pending" | "open";
	plans: { repo: string; plan: string }[];
}

export interface Schedule {
	mergeMode: MergeMode;
	/** Plans runnable now: pending with every gate dependency satisfied. */
	ready: PlanRef[];
	/** Plans in flight (kloop running). */
	running: PlanRef[];
	/** Pending plans whose gate deps are not yet satisfied. */
	blocked: BlockedRef[];
	/** PRs whose plans are implemented and whose PR polish is not complete. */
	toPolish: PolishRef[];
	/** Ready PRs that should merge before the execution DAG advances to feedback. */
	toMerge: MergeRef[];
	/** No remaining work or scheduled merges → feedback. */
	allReady: boolean;
	/** Every plan is merged or released → the DAG is fully delivered. */
	done: boolean;
}

const PR_READY_TO_MERGE = new Set(["ready", "merged", "released"]);
const PR_TERMINAL = new Set(["merged", "released"]);
const PLAN_IMPLEMENTED_OR_BETTER = new Set([
	"implemented",
	"pr_open",
	"pr_ready",
	"merged",
	"released",
]);
const PLAN_PR_OPEN_OR_BETTER = new Set([
	"pr_open",
	"pr_ready",
	"merged",
	"released",
]);
const PLAN_PR_READY_OR_BETTER = new Set(["pr_ready", "merged", "released"]);
const PLAN_TERMINAL = new Set(["merged", "released"]);
const PR_POLISHABLE = new Set(["pending", "open"]);

function nodeOf(
	orch: Orchestration,
	repo: string,
	plan: string,
): PlanNode | undefined {
	return orch.master.nodes.find((n) => n.repo === repo && n.plan === plan);
}

function prIdOf(
	orch: Orchestration,
	repo: string,
	plan: string,
): string | null {
	return nodeOf(orch, repo, plan)?.pr ?? null;
}

function progressOf(
	orch: Orchestration,
	repo: string,
	plan: string,
): PlanProgress | undefined {
	return orch.progress.find((p) => p.repo === repo && p.plan === plan);
}

function priorIncompletePlansInPr(
	orch: Orchestration,
	repo: string,
	plan: string,
): { repo: string; plan: string; gate: GateLevel }[] {
	const nodeIndex = orch.master.nodes.findIndex(
		(n) => n.repo === repo && n.plan === plan,
	);
	if (nodeIndex < 0) return [];
	const node = orch.master.nodes[nodeIndex];
	if (!node?.pr) return [];
	return orch.master.nodes
		.slice(0, nodeIndex)
		.filter((n) => n.pr === node.pr)
		.filter(
			(n) =>
				!PLAN_IMPLEMENTED_OR_BETTER.has(
					progressOf(orch, n.repo, n.plan)?.status ?? "pending",
				),
		)
		.map((n) => ({ repo: n.repo, plan: n.plan, gate: "completed" }));
}

function effectivePrProgress(
	orch: Orchestration,
	pr: string,
	prProgresses: ReturnType<typeof derivePrProgress>[],
): ReturnType<typeof derivePrProgress> {
	const persisted =
		prProgresses.find((p) => p.pr === pr) ?? derivePrProgress(orch, pr);
	const planNodes = orch.master.nodes.filter((n) => n.pr === pr);
	const statuses = planNodes.map(
		(n) => progressOf(orch, n.repo, n.plan)?.status ?? "pending",
	);
	if (persisted.status === "failed") return persisted;
	if (statuses.length === 0) return { ...persisted, status: "pending" };
	if (statuses.every((s) => s === "released")) {
		return { ...persisted, status: "released" };
	}
	if (statuses.every((s) => PLAN_TERMINAL.has(s))) {
		return persisted.status === "released"
			? persisted
			: { ...persisted, status: "merged" };
	}
	if (statuses.every((s) => PLAN_PR_READY_OR_BETTER.has(s))) {
		return persisted.status === "ready"
			? persisted
			: { ...persisted, status: "ready" };
	}
	if (statuses.every((s) => PLAN_PR_OPEN_OR_BETTER.has(s))) {
		return { ...persisted, status: "open" };
	}
	if (statuses.every((s) => PLAN_IMPLEMENTED_OR_BETTER.has(s))) {
		return { ...persisted, status: "pending" };
	}
	return { ...persisted, status: "pending" };
}

/**
 * The downstream `repo/plan`s that depend (gate `merged`/`released`) on a plan in
 * this PR and are not yet satisfied — i.e. what advancing this PR would unblock.
 */
function unblockedByGate(
	orch: Orchestration,
	upstreamPlans: { repo: string; plan: string }[],
): { target: string; gate: "merged" | "released" }[] {
	const upstreamKeys = new Set(upstreamPlans.map((x) => `${x.repo}/${x.plan}`));
	const out = new Map<string, "merged" | "released">();
	const strongest = (
		prev: "merged" | "released" | undefined,
		next: "merged" | "released",
	): "merged" | "released" =>
		prev === "released" || next === "released" ? "released" : "merged";
	for (const d of orch.master.deps) {
		if (d.gate !== "merged" && d.gate !== "released") continue;
		if (!upstreamKeys.has(`${d.dependsOnRepo}/${d.dependsOn}`)) continue;
		// Only count it if the edge is currently UNsatisfied (still gating).
		if (unsatisfiedDeps(orch, d.repo, d.plan).some((u) => u === d)) {
			const target = `${d.repo}/${d.plan}`;
			out.set(target, strongest(out.get(target), d.gate));
		}
	}
	return [...out].map(([target, gate]) => ({ target, gate }));
}

/** Compute the schedulable frontier from the orchestration record. */
export function computeSchedule(orch: Orchestration): Schedule {
	const ready: PlanRef[] = [];
	const running: PlanRef[] = [];
	const blocked: BlockedRef[] = [];
	const prProgresses =
		orch.prProgress ??
		orch.master.prs.map((pr) => derivePrProgress(orch, pr.id));

	for (const p of orch.progress) {
		if (p.status === "pending") {
			const unmet = unsatisfiedDeps(orch, p.repo, p.plan);
			const samePrUnmet = priorIncompletePlansInPr(orch, p.repo, p.plan);
			if (unmet.length === 0 && samePrUnmet.length === 0) {
				ready.push({
					repo: p.repo,
					plan: p.plan,
					pr: prIdOf(orch, p.repo, p.plan),
				});
			} else {
				blocked.push({
					repo: p.repo,
					plan: p.plan,
					waitingOn: [
						...unmet.map((d) => ({
							repo: d.dependsOnRepo,
							plan: d.dependsOn,
							gate: d.gate,
						})),
						...samePrUnmet,
					],
				});
			}
		} else if (p.status === "running") {
			running.push({
				repo: p.repo,
				plan: p.plan,
				pr: prIdOf(orch, p.repo, p.plan),
				kloopRunId: p.kloopRunId ?? null,
			});
		}
	}

	const toPolish: PolishRef[] = [];
	for (const pr of orch.master.prs) {
		const planNodes = orch.master.nodes.filter((n) => n.pr === pr.id);
		if (planNodes.length === 0) continue;
		const prProgress = effectivePrProgress(orch, pr.id, prProgresses);
		const prStatus = prProgress?.status ?? "pending";
		if (!PR_POLISHABLE.has(prStatus)) continue;
		const plans = planNodes.map((n) => ({ repo: n.repo, plan: n.plan }));
		const allPlansImplemented = plans.every((p) =>
			PLAN_IMPLEMENTED_OR_BETTER.has(
				progressOf(orch, p.repo, p.plan)?.status ?? "pending",
			),
		);
		if (!allPlansImplemented) continue;
		toPolish.push({
			pr: pr.id,
			repo: pr.repo,
			branch: pr.branch,
			prNumber: prProgress?.prNumber ?? null,
			prUrl: prProgress?.prUrl ?? null,
			status: prStatus as "pending" | "open",
			plans,
		});
	}

	// PRs that are READY (CI + PR polish complete) but not fully merged.
	const toMerge: MergeRef[] = [];
	for (const pr of orch.master.prs) {
		const planNodes = orch.master.nodes.filter((n) => n.pr === pr.id);
		if (planNodes.length === 0) continue;
		const prProgress = effectivePrProgress(orch, pr.id, prProgresses);
		const upstreamPlans = planNodes.map((n) => ({
			repo: n.repo,
			plan: n.plan,
		}));
		const blockedByThisPr = unblockedByGate(orch, upstreamPlans);
		const gate =
			prProgress?.status === "merged" &&
			blockedByThisPr.some((x) => x.gate === "released")
				? "released"
				: prProgress?.status === "ready"
					? "merged"
					: null;
		if (gate == null) continue;
		const prNumber =
			prProgress?.prNumber ??
			planNodes
				.map((n) => progressOf(orch, n.repo, n.plan)?.prNumber)
				.find((x): x is number => x != null) ??
			null;
		const prUrl =
			prProgress?.prUrl ??
			planNodes
				.map((n) => progressOf(orch, n.repo, n.plan)?.prUrl)
				.find((x): x is string => !!x) ??
			null;
		toMerge.push({
			pr: pr.id,
			repo: pr.repo,
			branch: pr.branch,
			prNumber,
			prUrl,
			gate,
			unblocks: blockedByThisPr
				.filter((x) => x.gate === gate)
				.map((x) => x.target),
		});
	}
	// Surface gate-clearing merges first (those that unblock a waiting downstream).
	toMerge.sort((a, b) => b.unblocks.length - a.unblocks.length);

	const nonEmpty = orch.progress.length > 0;
	const prsNonEmpty = prProgresses.length > 0;
	const allReady =
		nonEmpty &&
		prsNonEmpty &&
		toMerge.length === 0 &&
		orch.progress.every((p) => PLAN_IMPLEMENTED_OR_BETTER.has(p.status)) &&
		orch.master.prs.every((pr) =>
			PR_READY_TO_MERGE.has(
				effectivePrProgress(orch, pr.id, prProgresses).status,
			),
		);
	const done =
		nonEmpty &&
		prsNonEmpty &&
		orch.progress.every((p) => PLAN_TERMINAL.has(p.status)) &&
		orch.master.prs.every((pr) =>
			PR_TERMINAL.has(effectivePrProgress(orch, pr.id, prProgresses).status),
		);

	return {
		mergeMode: orch.mergeMode,
		ready,
		running,
		blocked,
		toPolish,
		toMerge,
		allReady,
		done,
	};
}

/** The `{repo, plan}`s that ship in a given PR (PrPlan id), per the master plan. */
export function plansInPr(
	orch: Orchestration,
	prId: string,
): { repo: string; plan: string }[] {
	return orch.master.nodes
		.filter((n) => n.pr === prId)
		.map((n) => ({ repo: n.repo, plan: n.plan }));
}
