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
		.argument("<step>", "The step being completed")
		.option("--output <path>", "Path to the artifact the step produced")
		.option(
			"--metadata <json>",
			"JSON metadata (must match the parsed file and schema)",
		)
		.option("--repo <repo>", "Repo scope for the step")
		.option("--session <id>", "Target session id")
		.action(
			async (
				step: string,
				opts: {
					output?: string;
					metadata?: string;
					repo?: string;
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
					// Per-scope lock matching `next` — a repo's `complete` only contends
					// with that repo's driver, not the session timeline or other repos. (§12)
					const lockKey = scopeLockKey(sessionId, opts.repo ?? null);
					const lock = checkLock(lockKey);
					if (lock.locked) {
						logError(
							`Session ${sessionId}${opts.repo ? ` (repo ${opts.repo})` : ""} is busy (PID ${lock.pid}).`,
						);
						process.exit(1);
					}
					acquireLock(lockKey);
					let result: Awaited<ReturnType<typeof runComplete>>;
					try {
						result = await runComplete(sessionId, config, step, {
							output: opts.output,
							metadata,
							repo: opts.repo ?? null,
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
