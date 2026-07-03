import { Command } from "commander";
import {
	derivePrProgress,
	type PlanExecStatus,
	type PlanProgress,
	type PrLifecycleStatus,
	readOrchestration,
	recordPlanProgress,
	recordPrProgress,
} from "../core/orchestration";
import { plansInPr } from "../core/scheduler";
import { logError, logInfo } from "../util/format";
import { resolveSession } from "./resolve-session";

// ============================================================================
// `kautopilot record <event> …` — the event ledger. The AGENT drives kloop /
// conflicts / PRs and records each lifecycle transition here; kautopilot just
// updates orchestration.yaml so `schedule` can recompute the DAG frontier.
//
//   record started   --repo <r> --plan <p> [--kloop <runId>]
//   record implemented --repo <r> --plan <p>
//   record failed     --repo <r> --plan <p>
//   record pr-opened  --pr <prId> --number <n> [--url <u>]   (marks every plan in the PR)
//   record pr-ready   --pr <prId>                            (CI + PR polish complete)
//   record merged     --pr <prId>
//   record released   --pr <prId>
//
// `--pr` updates EVERY plan that ships in that PR (the master plan's PrPlan), which
// is how multi-PR-per-repo layouts are recorded — one PR at a time, not one per repo.
// ============================================================================

const EVENTS = new Set([
	"started",
	"implemented",
	"pr-opened",
	"pr-ready",
	"merged",
	"released",
	"failed",
]);

const EVENT_STATUS: Record<string, PlanExecStatus> = {
	started: "running",
	implemented: "implemented",
	"pr-opened": "pr_open",
	"pr-ready": "pr_ready",
	merged: "merged",
	released: "released",
	failed: "failed",
};

const PR_EVENT_STATUS: Partial<Record<string, PrLifecycleStatus>> = {
	"pr-opened": "open",
	"pr-ready": "ready",
	merged: "merged",
	released: "released",
	failed: "failed",
};

const PR_SCOPED_EVENTS = new Set([
	"pr-opened",
	"pr-ready",
	"merged",
	"released",
]);

const IMPLEMENTED_OR_BETTER = new Set<PlanExecStatus>([
	"implemented",
	"pr_open",
	"pr_ready",
	"merged",
	"released",
]);

const PR_OPEN_OR_BETTER = new Set<PlanExecStatus>([
	"pr_open",
	"pr_ready",
	"merged",
	"released",
]);

const PR_READY_OR_BETTER = new Set<PlanExecStatus>([
	"pr_ready",
	"merged",
	"released",
]);

const MERGED_OR_BETTER = new Set<PlanExecStatus>(["merged", "released"]);

const PLAN_RANK: Record<PlanExecStatus, number> = {
	pending: 0,
	failed: 0,
	running: 1,
	implemented: 2,
	pr_open: 3,
	pr_ready: 4,
	merged: 5,
	released: 6,
};

const PR_RANK: Record<PrLifecycleStatus, number> = {
	pending: 0,
	failed: 0,
	open: 1,
	ready: 2,
	merged: 3,
	released: 4,
};

function maxPlanStatus(a: PlanExecStatus, b: PlanExecStatus): PlanExecStatus {
	if (b === "failed" && a !== "merged" && a !== "released") return "failed";
	if (a === "failed" && b !== "failed") return b;
	return PLAN_RANK[a] >= PLAN_RANK[b] ? a : b;
}

function maxPrStatus(
	a: PrLifecycleStatus,
	b: PrLifecycleStatus,
): PrLifecycleStatus {
	if (b === "failed" && a !== "merged" && a !== "released") return "failed";
	if (a === "failed" && b !== "failed") return b;
	return PR_RANK[a] >= PR_RANK[b] ? a : b;
}

interface RecordOpts {
	repo?: string;
	plan?: string;
	pr?: string;
	kloop?: string;
	number?: number;
	url?: string;
	session?: string;
}

export function createRecordCommand(): Command {
	return new Command("record")
		.description(
			"Record a plan/PR lifecycle event into the orchestration ledger",
		)
		.argument(
			"<event>",
			"started | implemented | pr-opened | pr-ready | merged | released | failed",
		)
		.option("--repo <r>", "Repo of the plan")
		.option("--plan <p>", "Plan id (e.g. plan-2)")
		.option("--pr <prId>", "PR id from the master plan (marks all its plans)")
		.option("--kloop <runId>", "kloop run id (for `started`)")
		.option("--number <n>", "PR number (for `pr-opened`)", (v) =>
			Number.parseInt(v, 10),
		)
		.option("--url <u>", "PR url (for `pr-opened`)")
		.option("--session <id>", "Target session id")
		.action(async (event: string, opts: RecordOpts) => {
			try {
				if (!EVENTS.has(event)) {
					logError(`Unknown event: ${event}. Use ${[...EVENTS].join(" | ")}.`);
					process.exit(1);
				}
				const { sessionId } = resolveSession(opts.session);
				const orch = readOrchestration(sessionId);
				if (!orch) {
					logError(
						"No master plan / orchestration for this session — nothing to record against.",
					);
					process.exit(1);
				}

				if (event === "pr-opened" && opts.number == null) {
					logError("--number <n> is required for `pr-opened`.");
					process.exit(1);
				}
				if (PR_SCOPED_EVENTS.has(event) && !opts.pr) {
					logError(
						`\`${event}\` is a PR lifecycle event; specify --pr <prId>.`,
					);
					process.exit(1);
				}

				// Resolve the target plan(s): a whole PR, or a single repo/plan.
				let targets: { repo: string; plan: string }[];
				if (opts.pr) {
					targets = plansInPr(orch, opts.pr);
					if (targets.length === 0) {
						logError(`PR '${opts.pr}' has no plans in the master plan.`);
						process.exit(1);
					}
				} else if (opts.repo && opts.plan) {
					// Reject an unknown repo/plan so a typo can't create an orphaned
					// progress entry the master-plan DAG never references.
					const known = orch.master.nodes.some(
						(n) => n.repo === opts.repo && n.plan === opts.plan,
					);
					if (!known) {
						logError(
							`No plan ${opts.repo}/${opts.plan} in the master plan — check \`kautopilot schedule\` for the valid plan ids.`,
						);
						process.exit(1);
					}
					targets = [{ repo: opts.repo, plan: opts.plan }];
				} else {
					logError("Specify either --pr <prId> or both --repo <r> --plan <p>.");
					process.exit(1);
				}

				const targetProgress = targets.map((t) => ({
					...t,
					progress: orch.progress.find(
						(p) => p.repo === t.repo && p.plan === t.plan,
					),
				}));
				const unfinished = targetProgress.filter(
					(t) => !IMPLEMENTED_OR_BETTER.has(t.progress?.status ?? "pending"),
				);
				if (event === "pr-opened" && unfinished.length > 0) {
					logError(
						`cannot record pr-opened for ${opts.pr}: plans not implemented: ${unfinished.map((t) => `${t.repo}/${t.plan}`).join(", ")}`,
					);
					process.exit(1);
				}
				const notOpen = targetProgress.filter(
					(t) => !PR_OPEN_OR_BETTER.has(t.progress?.status ?? "pending"),
				);
				const currentPr = opts.pr
					? {
							...derivePrProgress(orch, opts.pr),
							...(orch.prProgress?.find((p) => p.pr === opts.pr) ?? {}),
						}
					: null;
				if (event === "pr-ready") {
					if (
						currentPr?.status !== "open" &&
						currentPr?.status !== "ready" &&
						currentPr?.status !== "merged" &&
						currentPr?.status !== "released"
					) {
						logError(
							`cannot record pr-ready for ${opts.pr}: record pr-opened first.`,
						);
						process.exit(1);
					}
					if (notOpen.length > 0) {
						logError(
							`cannot record pr-ready for ${opts.pr}: PR is not open for plans: ${notOpen.map((t) => `${t.repo}/${t.plan}`).join(", ")}`,
						);
						process.exit(1);
					}
				}
				if (event === "merged") {
					const notReady = targetProgress.filter(
						(t) => !PR_READY_OR_BETTER.has(t.progress?.status ?? "pending"),
					);
					if (notReady.length > 0) {
						logError(
							`cannot record merged for ${opts.pr}: PR is not ready for plans: ${notReady.map((t) => `${t.repo}/${t.plan}`).join(", ")}`,
						);
						process.exit(1);
					}
					if (
						currentPr?.status !== "ready" &&
						currentPr?.status !== "merged" &&
						currentPr?.status !== "released"
					) {
						logError(
							`cannot record merged for ${opts.pr}: record pr-ready after PR polish completes first.`,
						);
						process.exit(1);
					}
				}
				if (event === "released") {
					const notMerged = targetProgress.filter(
						(t) => !MERGED_OR_BETTER.has(t.progress?.status ?? "pending"),
					);
					if (notMerged.length > 0) {
						logError(
							`cannot record released for ${opts.pr}: PR is not merged for plans: ${notMerged.map((t) => `${t.repo}/${t.plan}`).join(", ")}`,
						);
						process.exit(1);
					}
					if (
						currentPr?.status !== "merged" &&
						currentPr?.status !== "released"
					) {
						logError(
							`cannot record released for ${opts.pr}: record merged first.`,
						);
						process.exit(1);
					}
				}

				const status = EVENT_STATUS[event];
				const patch: Partial<Omit<PlanProgress, "plan" | "repo">> = {};
				if (event === "started" && opts.kloop) patch.kloopRunId = opts.kloop;
				if (event === "pr-opened" || event === "pr-ready") {
					if (opts.number != null) patch.prNumber = opts.number;
					if (opts.url) patch.prUrl = opts.url;
				}

				for (const t of targetProgress) {
					const current =
						t.progress?.status ?? ("pending" satisfies PlanExecStatus);
					recordPlanProgress(sessionId, t.repo, t.plan, {
						...patch,
						status: maxPlanStatus(current, status),
					});
				}
				if (opts.pr) {
					const prPatch: Parameters<typeof recordPrProgress>[2] = {};
					const prStatus = PR_EVENT_STATUS[event];
					if (prStatus) {
						prPatch.status = maxPrStatus(
							currentPr?.status ?? "pending",
							prStatus,
						);
					}
					if (event === "pr-opened" || event === "pr-ready") {
						if (opts.number != null) prPatch.prNumber = opts.number;
						if (opts.url) prPatch.prUrl = opts.url;
					}
					if (Object.keys(prPatch).length > 0) {
						recordPrProgress(sessionId, opts.pr, prPatch);
					}
				}
				// The ledger is the source of truth for scheduling (writes are best-effort
				// at the I/O layer), so VERIFY the record actually persisted — re-read and
				// confirm every target reached the new status. A silent write failure must
				// surface as an error, not a false success.
				const after = readOrchestration(sessionId);
				const missed = targetProgress.filter((t) => {
					const expected = maxPlanStatus(
						t.progress?.status ?? "pending",
						status,
					);
					return (
						after?.progress.find((p) => p.repo === t.repo && p.plan === t.plan)
							?.status !== expected
					);
				});
				if (missed.length > 0) {
					logError(
						`failed to persist ${event} for ${missed.map((t) => `${t.repo}/${t.plan}`).join(", ")} (check the orchestration store is writable).`,
					);
					process.exit(1);
				}
				if (opts.pr && PR_EVENT_STATUS[event]) {
					const afterPr = after?.prProgress?.find((p) => p.pr === opts.pr);
					const expected = maxPrStatus(
						currentPr?.status ?? "pending",
						PR_EVENT_STATUS[event],
					);
					if (afterPr?.status !== expected) {
						logError(
							`failed to persist ${event} for PR ${opts.pr} (check the orchestration store is writable).`,
						);
						process.exit(1);
					}
				}
				logInfo(
					`recorded ${event} → ${status} for ${targets.map((t) => `${t.repo}/${t.plan}`).join(", ")}`,
				);
				process.exit(0);
			} catch (err) {
				logError(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});
}
