import { Command } from "commander";
import {
	type PlanExecStatus,
	type PlanProgress,
	readOrchestration,
	recordPlanProgress,
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
//   record merged     (--pr <prId> | --repo <r> --plan <p>)
//   record released   (--pr <prId> | --repo <r> --plan <p>)
//
// `--pr` updates EVERY plan that ships in that PR (the master plan's PrPlan), which
// is how multi-PR-per-repo layouts are recorded — one PR at a time, not one per repo.
// ============================================================================

const EVENTS = new Set([
	"started",
	"implemented",
	"pr-opened",
	"merged",
	"released",
	"failed",
]);

const EVENT_STATUS: Record<string, PlanExecStatus> = {
	started: "running",
	implemented: "implemented",
	"pr-opened": "pr_open",
	merged: "merged",
	released: "released",
	failed: "failed",
};

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
			"started | implemented | pr-opened | merged | released | failed",
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

				const status = EVENT_STATUS[event];
				const patch: Partial<Omit<PlanProgress, "plan" | "repo">> = { status };
				if (event === "started" && opts.kloop) patch.kloopRunId = opts.kloop;
				if (event === "pr-opened") {
					if (opts.number != null) patch.prNumber = opts.number;
					if (opts.url) patch.prUrl = opts.url;
				}

				for (const t of targets) {
					recordPlanProgress(sessionId, t.repo, t.plan, patch);
				}
				// The ledger is the source of truth for scheduling (writes are best-effort
				// at the I/O layer), so VERIFY the record actually persisted — re-read and
				// confirm every target reached the new status. A silent write failure must
				// surface as an error, not a false success.
				const after = readOrchestration(sessionId);
				const missed = targets.filter(
					(t) =>
						after?.progress.find((p) => p.repo === t.repo && p.plan === t.plan)
							?.status !== status,
				);
				if (missed.length > 0) {
					logError(
						`failed to persist ${event} for ${missed.map((t) => `${t.repo}/${t.plan}`).join(", ")} (check the orchestration store is writable).`,
					);
					process.exit(1);
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
