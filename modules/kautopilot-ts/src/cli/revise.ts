import { Command } from "commander";
import { runRevise } from "../core/driver";
import {
	acquireLock,
	checkLock,
	releaseLock,
	scopeLockKey,
} from "../core/lock";
import { logError } from "../util/format";
import { resolveSession } from "./resolve-session";

// ============================================================================
// `kautopilot revise` — mint the next version of the current interactive writer
// artifact (copy latest → vN+1) and return the file to edit + the viewer link.
// Call this once per user-facing presentation: revise → edit → present the link.
// The binary owns version numbers; the harness never hand-builds a version URL.
// ============================================================================

export function createReviseCommand(): Command {
	return new Command("revise")
		.description(
			"Mint the next version of the current writer artifact (copy latest → vN+1); returns the path to edit + the viewer link",
		)
		.option("--repo <repo>", "Repo scope (for plan revisions)")
		.option("--session <id>", "Target session id")
		.action(async (opts: { repo?: string; session?: string }) => {
			try {
				const { sessionId, config } = resolveSession(opts.session);
				const lockKey = scopeLockKey(sessionId, opts.repo ?? null);
				const lock = checkLock(lockKey);
				if (lock.locked) {
					logError(
						`Session ${sessionId}${opts.repo ? ` (repo ${opts.repo})` : ""} is busy (PID ${lock.pid}).`,
					);
					process.exit(1);
				}
				acquireLock(lockKey);
				let result: Awaited<ReturnType<typeof runRevise>>;
				try {
					result = await runRevise(sessionId, config, opts.repo ?? null);
				} finally {
					releaseLock(lockKey);
				}
				process.stdout.write(`${JSON.stringify(result)}\n`);
				process.exit(result.ok ? 0 : 1);
			} catch (err) {
				logError(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});
}
