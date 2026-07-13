import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
	acquireLock,
	checkLock,
	releaseLock,
	scopeLockKey,
} from "../core/lock";
import { runRelay } from "../core/writer/relay";
import { logError } from "../util/format";
import { resolveSession } from "./resolve-session";

// ============================================================================
// `kautopilot relay` — one writer-session turn for the current deferred writer
// step: send the user's message, park on the sentinel, validate + enrich the
// envelope, print it. The relay can block for many minutes (turnTimeoutMins ×
// retries) — the caller runs it in the background and wakes on process exit.
// (specs/deferred-writer-relay.md §4)
// ============================================================================

export function createRelayCommand(): Command {
	return new Command("relay")
		.description(
			"Run one writer-session turn for the current deferred writer step (prints the enriched envelope)",
		)
		.option("--message <text>", "The user's answers/feedback for this turn")
		.option("--message-file <path>", "Read the message from a file")
		.option(
			"--approval",
			"The user approved — run the final consistency turn (no revision expected)",
		)
		.option(
			"--fallback-inline",
			"Escape hatch: flip the REST of the session to inline writer mode (irreversible this session)",
		)
		.option("--session <id>", "Target session id")
		.option("--json", "Emit the result as JSON (default)")
		.action(
			async (opts: {
				message?: string;
				messageFile?: string;
				approval?: boolean;
				fallbackInline?: boolean;
				session?: string;
				json?: boolean;
			}) => {
				try {
					const { sessionId, config } = resolveSession(opts.session);
					if (opts.message && opts.messageFile) {
						logError("Pass either --message or --message-file, not both.");
						process.exit(1);
					}
					const message = opts.messageFile
						? readFileSync(opts.messageFile, "utf-8")
						: opts.message;

					const lockKey = scopeLockKey(sessionId, null);
					const lock = checkLock(lockKey);
					if (lock.locked) {
						logError(`Session ${sessionId} is busy (PID ${lock.pid}).`);
						process.exit(1);
					}
					acquireLock(lockKey);
					let result: Awaited<ReturnType<typeof runRelay>>;
					try {
						result = await runRelay(sessionId, config, {
							message,
							approval: opts.approval,
							fallbackInline: opts.fallbackInline,
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
