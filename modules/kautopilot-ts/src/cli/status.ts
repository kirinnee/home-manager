import { Command } from "commander";
import { getSessionByFolder, getSessionById, listSessions } from "../core/db";
import { checkLock } from "../core/lock";
import { readSessionMeta } from "../core/session-meta";
import type { PolishState } from "../core/status";
import {
	ensureStatus,
	getCurrentKloopRunId,
	isSessionActive,
	PHASE_STEPS,
} from "../core/status";
import {
	formatDuration,
	formatStepLine,
	logError,
	logField,
	logHeading,
	logOk,
} from "../util/format";

export function createStatusCommand(): Command {
	return new Command("status")
		.argument(
			"[id]",
			"Session ID (optional — defaults to this folder's session)",
		)
		.option("--json", "Machine-readable JSON output")
		.option(
			"--session <id>",
			"Target session id (alias for the positional id; matches next/complete)",
		)
		.action(
			async (
				id: string | undefined,
				opts: { json?: boolean; session?: string },
			) => {
				try {
					// Accept `--session <id>` for parity with next/complete (the skill drives
					// a specific session in hub mode where the cwd isn't its worktree). The
					// positional id still works; --session wins when both are given.
					await runStatus(opts.session ?? id, opts);
				} catch (err) {
					logError(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}
			},
		);
}

function stepDetail(stepType: string | null): string {
	return stepType ? `(${stepType})` : "";
}

function printPhaseProgress(
	phase: string,
	currentState: string,
	stepType: string | null,
	completedSteps: string[],
): void {
	const steps = PHASE_STEPS[phase];
	if (!steps) return;

	const phaseLabel =
		phase === "plan"
			? "Plan"
			: phase === "implementation"
				? "Implementation"
				: "Polish";
	logHeading(`${phaseLabel} Phase`);
	console.log();

	const completedSet = new Set(completedSteps);
	let foundActive = false;

	for (const step of steps) {
		if (completedSet.has(step)) {
			console.log(formatStepLine(step, "done"));
		} else if (step === currentState && !foundActive) {
			console.log(formatStepLine(step, "active", stepDetail(stepType)));
			foundActive = true;
		} else {
			console.log(formatStepLine(step, "pending"));
		}
	}
}

function printPolishDetails(polishState: PolishState): void {
	if (!polishState) return;

	console.log();
	logHeading("Delivery");
	console.log();

	if (polishState.prNumber) {
		logField("PR", `#${polishState.prNumber}`);
	}
	if (polishState.prUrl) {
		logField("URL", polishState.prUrl);
	}

	logField("Push cycles", String(polishState.pushCycle));

	if (polishState.lastEvalSummary) {
		const s = polishState.lastEvalSummary;
		logField(
			"Eval",
			`${s.replies} reply, ${s.resolves} resolve, ${s.codeFixes} fix, ${s.ambiguous} ambiguous`,
		);
	}

	if (polishState.ttyReason) {
		logField("TTY reason", polishState.ttyReason);
	}
}

async function runStatus(
	id: string | undefined,
	opts: { json?: boolean },
): Promise<void> {
	if (id) {
		const session = getSessionById(id);
		if (session) {
			const status = ensureStatus(session.id);
			const lockInfo = checkLock(session.id);
			const running = lockInfo.locked;
			const phaseElapsed = status.startedAt
				? Date.now() - new Date(status.startedAt).getTime()
				: 0;
			const kloopRunId = getCurrentKloopRunId(status);
			// Host-driven per-repo registry (session.json) — CLI-CONTRACT §7. A session
			// is tied to a folder, not a repo: org/repo/branch come from meta (repos[]).
			const meta = readSessionMeta(session.id);
			const org = meta?.org ?? "—";
			const repo =
				meta && meta.repos.length > 0
					? meta.repos.map((r) => r.repo).join(",")
					: "—";
			const branch = meta?.repos.find((r) => r.branch)?.branch ?? "—";
			const data = {
				kind: "session",
				session: session.id,
				ticketId: meta?.ticketId ?? session.ticket_id,
				branch,
				folder: session.folder,
				org,
				ticketSystem: meta?.ticketSystem ?? null,
				epoch: meta?.epoch ?? status.version,
				maxParallelRepos: meta?.maxParallelRepos ?? null,
				// Each repo's {repo, status, prNumber, prUrl, worktree, branch} — the
				// controller enumerates these to drive `next --repo <repo>` loops.
				repos: meta?.repos ?? [],
				local: session.local === 1,
				phase: status.phase,
				state: status.state,
				stateStatus: status.stateStatus,
				running,
				completed: !running && status.stateStatus === "completed",
				stepType: status.stepType,
				checkpoint: status.lastCheckpoint,
				version: status.version,
				context: status.context,
				elapsed: phaseElapsed,
				walCursor: status.walCursor,
				activeEpoch: status.version,
				// New rich fields
				activePlan: status.activePlan,
				polishState: status.polishState,
				kloopRunId,
				phases: status.phases,
			};

			if (opts.json) {
				console.log(JSON.stringify(data, null, 2));
				return;
			}

			// Header
			logField("Session", session.id);
			logField("Ticket", data.ticketId || "—");
			logField("Org/Repo", `${org}/${repo}`);
			logField("Branch", branch);
			if (data.repos.length > 0) {
				logField(
					"Repos",
					data.repos.map((r) => `${r.repo}[${r.status}]`).join(", "),
				);
			}
			console.log();

			// Completed session — show summary instead of in-progress phase
			if (data.completed) {
				logOk("Completed");

				// Show delivery result if available
				if (status.context.prNumber) {
					console.log();
					logField("PR", `#${status.context.prNumber}`);
					if (status.context.prUrl)
						logField("URL", status.context.prUrl as string);
				}

				// Show kloop runs
				const allRunIds = Object.values(status.planRuns).flat();
				if (allRunIds.length > 0) {
					console.log();
					logField("Kloop", allRunIds.join(", "));
				}

				console.log();
				logHeading("Progress");
				console.log();
				logField("Duration", formatDuration(phaseElapsed));
				logField("Version", String(status.version));
				logField("Phase", status.phase);
				logField("Step", status.state);
				return;
			}

			// Phase progress (running)
			printPhaseProgress(
				status.phase,
				status.state,
				status.stepType,
				status.completedSteps,
			);

			// Polish phase details
			if (status.phase === "polish" && status.polishState) {
				printPolishDetails(status.polishState);
			}

			// Progress & Stats
			console.log();
			logHeading("Progress");
			console.log();
			logField("Checkpoint", status.lastCheckpoint || "—");
			logField("Duration", formatDuration(phaseElapsed));
			logField("Version", String(status.version));

			if (kloopRunId) {
				logField("Kloop", kloopRunId);
			}

			return;
		}

		logError(`Session ${id} not found in index.`);
		process.exit(1);
	}

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

	await runStatus(session.id, opts);
}
