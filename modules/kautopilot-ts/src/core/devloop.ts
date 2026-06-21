export interface DevloopRunResult {
	exitCode: number;
	status: "completed" | "max_iterations" | "conflict" | "crash";
	runId?: string;
}

/**
 * Authoritative kloop outcome derived from kloop's OWN state — the binary uses
 * this to verify what an agent reported (it never trusts the agent's claim that
 * a run "completed"). `unavailable` = kloop/status couldn't be queried (test
 * sandbox); `running` = not finished yet.
 */
export type KloopOutcome =
	| "completed"
	| "max_iterations"
	| "conflict"
	| "crash"
	| "running"
	| "unavailable";

/** Strip ANSI color escapes so a colorized `Run ID:` line still parses. */
function stripAnsi(s: string): string {
	const esc = String.fromCharCode(27);
	return s.replaceAll(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

/** kloop spawn env with color forced off (so piped output is plain). */
function plainEnv(): Record<string, string> {
	return { ...(process.env as Record<string, string>), NO_COLOR: "1" };
}

/**
 * Verify a kloop run's outcome by querying `kloop status <id> --json` — the
 * binary's source of truth for routing (completed→commit, conflict/max_iter→
 * resolve, crash→retry). Returns `unavailable` when kloop can't be reached.
 */
export function devloopVerify(kloopRunId: string): KloopOutcome {
	let proc: ReturnType<typeof Bun.spawnSync>;
	try {
		proc = Bun.spawnSync({
			cmd: ["kloop", "status", kloopRunId, "--json"],
			stdout: "pipe",
			stderr: "pipe",
			env: plainEnv(),
		});
	} catch {
		return "unavailable"; // kloop binary missing (sandbox)
	}
	if (proc.exitCode !== 0) return "crash"; // a reported run that kloop can't find = real failure
	try {
		const data = JSON.parse((proc.stdout?.toString() ?? "").trim());
		const status = String(data.status ?? "");
		if (data.exitReason === "max_iterations") return "max_iterations";
		if (status === "running") return "running";
		if (status === "conflict") return "conflict";
		if (status === "completed") return "completed";
		if (status === "failed" || status === "cancelled") return "crash";
		// Unknown / pending / empty — do NOT fake success.
		return "crash";
	} catch {
		return "unavailable";
	}
}

export interface DevloopStatus {
	running: boolean;
	pid?: number;
	lastStatus?: string;
	exitReason?: string;
}

/**
 * Initialize a kloop run with a spec file.
 * Uses kloop's global storage and its own native config:
 *   kloop init --workspace <ws> --spec <spec>
 * Returns the kloop runId on success.
 */
export function devloopInit(workspace: string, specPath: string): string {
	const args = ["kloop", "init", "--workspace", workspace, "--spec", specPath];

	const proc = Bun.spawnSync({
		cmd: args,
		stdout: "pipe",
		stderr: "pipe",
		env: plainEnv(),
	});

	if (proc.exitCode !== 0) {
		const stderr = proc.stderr.toString().trim();
		throw new Error(`kloop init failed (exit ${proc.exitCode}): ${stderr}`);
	}

	// Parse runId from kloop init output (looks for "Run ID:     <id>"); strip any
	// ANSI color so a colorized id doesn't leak escape codes into the run id.
	const stdout = stripAnsi(proc.stdout.toString());
	const match = stdout.match(/Run ID:\s+(\S+)/);
	if (!match) {
		throw new Error(`Could not parse kloop run ID from output: ${stdout}`);
	}

	return match[1];
}

/**
 * Run a kloop run by ID.
 * Captures exit code and determines status.
 * Trusts kloop's internal runTimeout — no external timeout wrapper.
 */
export async function devloopRun(
	kloopRunId: string,
): Promise<DevloopRunResult> {
	const proc = Bun.spawn({
		cmd: ["kloop", "run", kloopRunId],
		stdout: "inherit",
		stderr: "inherit",
	});

	const exitCode = await proc.exited;

	// Determine status based on exit code and post-run status check
	// Maps to spec-defined outcomes: completed, max_iterations, conflict, crash
	let status: DevloopRunResult["status"];

	if (exitCode === 0) {
		const postStatus = devloopGetStatus(kloopRunId);
		status = postStatus.status;
	} else if (exitCode === 2) {
		status = "conflict";
	} else {
		// Exit codes 1 (error), 3 (agent_failure), or anything else → crash
		status = "crash";
	}

	return { exitCode, status, runId: kloopRunId };
}

/**
 * Query kloop status for a run to determine the actual outcome.
 */
interface PostRunResult {
	status: "completed" | "max_iterations";
}

function devloopGetStatus(kloopRunId: string): PostRunResult {
	try {
		const proc = Bun.spawnSync({
			cmd: ["kloop", "status", kloopRunId, "--json"],
			stdout: "pipe",
			stderr: "pipe",
		});

		if (proc.exitCode === 0) {
			const output = proc.stdout.toString().trim();
			const data = JSON.parse(output);

			// kloop reports max_iterations when the loop hit the iteration limit
			if (data.exitReason === "max_iterations") {
				return { status: "max_iterations" };
			}
			return { status: "completed" };
		}
	} catch {
		// Fallback: assume completed if status check fails
	}
	return { status: "completed" };
}

/**
 * Run `kloop describe` to gather durable loop evidence for rewrite analysis.
 * Returns the describe output as a string.
 */
export function devloopDescribe(kloopRunId: string): string {
	try {
		const proc = Bun.spawnSync({
			cmd: ["kloop", "describe", kloopRunId],
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode === 0) {
			return proc.stdout.toString().trim();
		}
		return `(kloop describe failed: exit ${proc.exitCode})`;
	} catch {
		return "(kloop describe unavailable)";
	}
}

/**
 * Check if a kloop run is currently running
 */
export function devloopStatus(kloopRunId: string): DevloopStatus {
	try {
		const proc = Bun.spawnSync({
			cmd: ["kloop", "status", kloopRunId, "--json"],
			stdout: "pipe",
			stderr: "pipe",
		});

		if (proc.exitCode === 0) {
			const output = proc.stdout.toString().trim();
			const data = JSON.parse(output);
			return {
				running: data.status === "running",
				lastStatus: data.status,
				exitReason: data.exitReason,
			};
		}
		return { running: false };
	} catch {
		return { running: false };
	}
}

/**
 * Cancel a running kloop run
 */
export function devloopCancel(kloopRunId: string): boolean {
	try {
		const proc = Bun.spawnSync({
			cmd: ["kloop", "cancel", kloopRunId],
			stdout: "inherit",
			stderr: "inherit",
		});
		return proc.exitCode === 0;
	} catch {
		return false;
	}
}
