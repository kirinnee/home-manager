import { Command } from "commander";
import { getSessionByFolder, listSessions } from "../core/db";
import { readLog } from "../core/log";
import { isSessionActive } from "../core/status";
import { logDim, logError } from "../util/format";

export function createLogsCommand(): Command {
	return new Command("logs")
		.argument("[phase]", "Filter by phase (plan, implementation, polish)")
		.option("--tail <N>", "Show last N entries", "50")
		.option("--json", "Raw JSONL output")
		.action(
			async (
				phase: string | undefined,
				opts: { tail: string; json?: boolean },
			) => {
				try {
					await runLogs(phase, opts);
				} catch (err) {
					logError(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}
			},
		);
}

async function runLogs(
	phase: string | undefined,
	opts: { tail: string; json?: boolean },
): Promise<void> {
	// Try the cwd folder's session, else fall back to the single active session.
	let session = getSessionByFolder(process.cwd());
	if (!session) {
		const active = listSessions().filter((s) => isSessionActive(s.id));
		if (active.length === 1) session = active[0];
	}
	if (!session) {
		logError("No session here. Pass --session <id> (or run from its folder).");
		process.exit(1);
	}

	let entries = readLog(session.id);

	// Filter by phase
	if (phase) {
		// Flat machine step names per phase (interactive|agent|code steps). Feedback
		// steps fold into the plan phase (the driver maps feedback→phase1).
		const phaseMap: Record<string, string[]> = {
			plan: [
				"resolve_org",
				"brainstorm",
				"create_ticket",
				"fetch_ticket",
				"triage",
				"write_spec",
				"write_plans",
				"finalize_plans",
				"feedback_check",
				"feedback",
				"cleanup",
			],
			implementation: [
				"seed",
				"clear_loop",
				"setup_run",
				"running",
				"resolve",
				"amend_plans",
				"commit",
				"next_plan",
			],
			polish: [
				"commit_pending",
				"prereview",
				"push",
				"create_pr",
				"poll",
				"ensure_branch",
				"eval",
				"act",
				"tty_resolve",
				"write_fix",
				"run_fix",
				"verify_fixes",
				"repo_ready",
			],
		};
		const phaseSteps = phaseMap[phase.toLowerCase()];
		if (phaseSteps) {
			entries = entries.filter((e) =>
				phaseSteps.some((step) => e.event.startsWith(step)),
			);
		} else {
			// Treat as general filter
			entries = entries.filter((e) => e.event.includes(phase));
		}
	}

	// Tail
	const tailN = parseInt(opts.tail, 10) || 50;
	entries = entries.slice(-tailN);

	if (opts.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}

	// Human-readable
	for (const entry of entries) {
		const ts = new Date(entry.ts).toLocaleTimeString("en-US", {
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		const meta = entry.metadata
			? " " +
				Object.entries(entry.metadata)
					.map(([k, v]) => `${k}=${v}`)
					.join(", ")
			: "";
		const version =
			entry.version !== undefined ? ` version=${entry.version}` : "";
		const attempt =
			entry.attempt !== undefined ? ` attempt=${entry.attempt}` : "";
		logDim(`${ts} ${entry.event}${version}${attempt}${meta}`);
	}
}
