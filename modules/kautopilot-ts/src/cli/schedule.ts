import { Command } from "commander";
import { readOrchestration } from "../core/orchestration";
import { computeSchedule } from "../core/scheduler";
import { logError, logInfo } from "../util/format";
import { resolveSession } from "./resolve-session";

// ============================================================================
// `kautopilot schedule [--json]` — the DAG scheduler. Reads orchestration.yaml
// and reports the runnable frontier so the AGENT can drive the work: which plans
// can run NOW, which PRs need polish, which PRs must merge to unblock a downstream,
// what's blocked/in flight, and whether the epoch is ready for feedback or fully
// done. kautopilot does NOT drive kloop — it only records (via `record`) and
// schedules (here).
// ============================================================================

export function createScheduleCommand(): Command {
	return new Command("schedule")
		.description(
			"Report the runnable DAG frontier (ready plans / PRs to merge)",
		)
		.option("--json", "Emit JSON")
		.option("--session <id>", "Target session id")
		.action(async (opts: { json?: boolean; session?: string }) => {
			try {
				const { sessionId } = resolveSession(opts.session);
				const orch = readOrchestration(sessionId);
				if (!orch) {
					if (opts.json) {
						console.log(
							JSON.stringify({
								ok: false,
								error: "no master plan / orchestration for this session",
							}),
						);
					} else {
						logInfo(
							"No master plan recorded — this session has no DAG to schedule (run the plan phase + approve a master plan first).",
						);
					}
					process.exit(0);
				}
				const sched = computeSchedule(orch);
				if (opts.json) {
					console.log(JSON.stringify({ ok: true, ...sched }, null, 2));
					process.exit(0);
				}
				printHuman(sched);
				process.exit(0);
			} catch (err) {
				logError(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});
}

function printHuman(s: ReturnType<typeof computeSchedule>): void {
	if (s.done) {
		logInfo("✅ DAG complete — every plan is merged/released.");
		return;
	}
	logInfo(
		`merge mode: ${s.mergeMode}${s.allReady ? "  ·  execution DAG clear → feedback" : ""}`,
	);
	if (s.ready.length) {
		console.log("\nREADY to run now:");
		for (const p of s.ready)
			console.log(`  • ${p.repo}/${p.plan}${p.pr ? ` (PR ${p.pr})` : ""}`);
	}
	if (s.running.length) {
		console.log("\nRUNNING:");
		for (const p of s.running)
			console.log(
				`  • ${p.repo}/${p.plan}${p.kloopRunId ? ` (kloop ${p.kloopRunId})` : ""}`,
			);
	}
	if (s.toPolish.length) {
		console.log("\nPRs to POLISH:");
		for (const p of s.toPolish)
			console.log(
				`  • ${p.pr} (${p.repo} ${p.branch}${p.prNumber != null ? ` #${p.prNumber}` : ""})` +
					(p.status === "pending" ? " — open PR" : " — continue polish"),
			);
	}
	if (s.toMerge.length) {
		console.log("\nPRs to MERGE:");
		for (const m of s.toMerge)
			console.log(
				`  • ${m.pr} (${m.repo} ${m.branch}${m.prNumber != null ? ` #${m.prNumber}` : ""})` +
					` — clear ${m.gate} gate` +
					(m.unblocks.length
						? ` → unblocks ${m.unblocks.join(", ")}`
						: " (terminal)"),
			);
	}
	if (s.blocked.length) {
		console.log("\nBLOCKED:");
		for (const b of s.blocked)
			console.log(
				`  • ${b.repo}/${b.plan} waits for ${b.waitingOn.map((w) => `${w.repo}/${w.plan}:${w.gate}`).join(", ")}`,
			);
	}
	if (
		!s.ready.length &&
		!s.running.length &&
		!s.toPolish.length &&
		!s.toMerge.length &&
		!s.blocked.length
	) {
		logInfo(
			"Nothing runnable and nothing to merge — check `kautopilot status`.",
		);
	}
}
