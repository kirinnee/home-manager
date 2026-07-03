import { Command } from "commander";
import { runComplete } from "../core/driver";
import {
	acquireLock,
	checkLock,
	releaseLock,
	scopeLockKey,
} from "../core/lock";
import { logError } from "../util/format";
import { resolveSession } from "./resolve-session";

// ============================================================================
// `kautopilot complete <step>` — validate the pending step, validate the
// contract (output present, metadata), run finalize, append the canonical
// completionEvent. The next `next` advances. (CLI-CONTRACT §3)
// ============================================================================

export function createCompleteCommand(): Command {
	return new Command("complete")
		.description("Record completion of a yielded step and advance the machine")
		.argument(
			"[step]",
			"Optional assertion of the step being completed; if omitted, the binary completes whatever step is pending (the WAL cursor is the source of truth). If given and it does not match, the command fails as stale.",
		)
		.option("--output <path>", "Path to the artifact the step produced")
		.option(
			"--metadata <json>",
			"JSON metadata (must match the parsed file and schema)",
		)
		.option("--session <id>", "Target session id")
		.action(
			async (
				step: string | undefined,
				opts: {
					output?: string;
					metadata?: string;
					session?: string;
				},
			) => {
				try {
					const { sessionId, config } = resolveSession(opts.session);
					let metadata: Record<string, unknown> | undefined;
					if (opts.metadata) {
						try {
							metadata = JSON.parse(opts.metadata) as Record<string, unknown>;
						} catch {
							logError(`--metadata is not valid JSON: ${opts.metadata}`);
							process.exit(1);
						}
					}
					const lockKey = scopeLockKey(sessionId, null);
					const lock = checkLock(lockKey);
					if (lock.locked) {
						logError(`Session ${sessionId} is busy (PID ${lock.pid}).`);
						process.exit(1);
					}
					acquireLock(lockKey);
					let result: Awaited<ReturnType<typeof runComplete>>;
					try {
						result = await runComplete(sessionId, config, step, {
							output: opts.output,
							metadata,
						});
					} finally {
						releaseLock(lockKey);
					}
					process.stdout.write(`${JSON.stringify(result)}\n`);
					process.exit(result.ok ? 0 : 1);
				} catch (err) {
					logError(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}
			},
		);
}
