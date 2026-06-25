import {
	type GateLevel,
	type MergeMode,
	type Orchestration,
	type PlanNode,
	type PlanProgress,
	unsatisfiedDeps,
} from "./orchestration";

// ============================================================================
// DAG scheduler — kautopilot as a record-keeper + scheduler (not a kloop driver).
//
// The master plan is a multi-stage DAG of plans grouped into PRs, with gate-leveled
// edges. The AGENT drives kloop / resolves conflicts / opens + merges PRs, and
// records each lifecycle transition via `kautopilot record`. This module answers the
// two scheduling questions the agent asks via `kautopilot schedule`:
//   1. "What plan(s) can I run NOW?"     → `ready` (deps satisfied, not started)
//   2. "What PR must merge to unblock?"  → `toMerge` (a pr_open PR gating a downstream)
// plus `blocked` (waiting, with why), `running` (in flight), and the epoch-level
// `allReady` (every PR ready-to-merge → advance to feedback) / `done` (all merged).
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
	/** Downstream `repo/plan`s this PR's merge would unblock (empty = terminal PR). */
	unblocks: string[];
}

export interface Schedule {
	mergeMode: MergeMode;
	/** Plans runnable now: pending with every gate dependency satisfied. */
	ready: PlanRef[];
	/** Plans in flight (kloop running). */
	running: PlanRef[];
	/** Pending plans whose gate deps are not yet satisfied. */
	blocked: BlockedRef[];
	/** Open PRs that should merge to unblock a waiting downstream (or, when nothing
	 * else is runnable, the terminal PRs left to merge). */
	toMerge: MergeRef[];
	/** Every plan has reached ready-to-merge (pr_open/merged/released) → feedback. */
	allReady: boolean;
	/** Every plan is merged or released → the DAG is fully delivered. */
	done: boolean;
}

const READY_TO_MERGE = new Set(["pr_open", "merged", "released"]);
const TERMINAL = new Set(["merged", "released"]);

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

/**
 * The downstream `repo/plan`s that depend (gate `merged`/`released`) on a plan in
 * this PR and are not yet satisfied — i.e. what merging this PR would unblock.
 */
function unblockedBy(
	orch: Orchestration,
	upstreamPlans: { repo: string; plan: string }[],
): string[] {
	const upstreamKeys = new Set(upstreamPlans.map((x) => `${x.repo}/${x.plan}`));
	const out = new Set<string>();
	for (const d of orch.master.deps) {
		if (d.gate !== "merged" && d.gate !== "released") continue;
		if (!upstreamKeys.has(`${d.dependsOnRepo}/${d.dependsOn}`)) continue;
		// Only count it if the edge is currently UNsatisfied (still gating).
		if (unsatisfiedDeps(orch, d.repo, d.plan).some((u) => u === d)) {
			out.add(`${d.repo}/${d.plan}`);
		}
	}
	return [...out];
}

/** Compute the schedulable frontier from the orchestration record. */
export function computeSchedule(orch: Orchestration): Schedule {
	const ready: PlanRef[] = [];
	const running: PlanRef[] = [];
	const blocked: BlockedRef[] = [];

	for (const p of orch.progress) {
		if (p.status === "pending") {
			const unmet = unsatisfiedDeps(orch, p.repo, p.plan);
			if (unmet.length === 0) {
				ready.push({
					repo: p.repo,
					plan: p.plan,
					pr: prIdOf(orch, p.repo, p.plan),
				});
			} else {
				blocked.push({
					repo: p.repo,
					plan: p.plan,
					waitingOn: unmet.map((d) => ({
						repo: d.dependsOnRepo,
						plan: d.dependsOn,
						gate: d.gate,
					})),
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

	// PRs that are OPEN (every plan in them at least pr_open) but not fully merged.
	const toMerge: MergeRef[] = [];
	for (const pr of orch.master.prs) {
		const planNodes = orch.master.nodes.filter((n) => n.pr === pr.id);
		if (planNodes.length === 0) continue;
		const statuses = planNodes.map(
			(n) => progressOf(orch, n.repo, n.plan)?.status ?? "pending",
		);
		const open = statuses.every((s) => READY_TO_MERGE.has(s));
		const fullyMerged = statuses.every((s) => TERMINAL.has(s));
		if (!open || fullyMerged) continue;
		const prNumber =
			planNodes
				.map((n) => progressOf(orch, n.repo, n.plan)?.prNumber)
				.find((x): x is number => x != null) ?? null;
		const prUrl =
			planNodes
				.map((n) => progressOf(orch, n.repo, n.plan)?.prUrl)
				.find((x): x is string => !!x) ?? null;
		toMerge.push({
			pr: pr.id,
			repo: pr.repo,
			branch: pr.branch,
			prNumber,
			prUrl,
			unblocks: unblockedBy(
				orch,
				planNodes.map((n) => ({ repo: n.repo, plan: n.plan })),
			),
		});
	}
	// Surface gate-clearing merges first (those that unblock a waiting downstream).
	toMerge.sort((a, b) => b.unblocks.length - a.unblocks.length);

	const nonEmpty = orch.progress.length > 0;
	const allReady =
		nonEmpty && orch.progress.every((p) => READY_TO_MERGE.has(p.status));
	const done = nonEmpty && orch.progress.every((p) => TERMINAL.has(p.status));

	return {
		mergeMode: orch.mergeMode,
		ready,
		running,
		blocked,
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
