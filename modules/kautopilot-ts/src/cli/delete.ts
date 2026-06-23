import { rmSync } from "node:fs";
import { Command } from "commander";
import { sessionDir } from "../core/artifacts";
import {
	deleteSession,
	getSessionByFolder,
	getSessionById,
	listSessions,
} from "../core/db";
import { checkLock, listLockKeys, releaseLock } from "../core/lock";
import { confirmAction } from "../llm/inquirer";
import { logError, logOk } from "../util/format";

export function createDeleteCommand(): Command {
	return new Command("delete")
		.alias("rm")
		.argument("[id]", "Session ID (omit to delete current worktree session)")
		.option("-a, --all", "Delete all stopped sessions")
		.option("--force", "Skip confirmation")
		.option("--running", "Also delete running sessions (stops them first)")
		.action(
			async (
				id: string | undefined,
				opts: { all?: boolean; force?: boolean; running?: boolean },
			) => {
				try {
					await runDelete(id, opts);
				} catch (err) {
					logError(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}
			},
		);
}

/** Is ANY scope lock (session timeline or a repo driver) currently live? (MAJOR-1) */
function isSessionRunning(sessionId: string): boolean {
	return listLockKeys(sessionId).some((key) => checkLock(key).locked);
}

/**
 * Kill + release EVERY live scope lock for a session — the session timeline lock
 * plus each per-repo driver lock — so a delete never wipes the session dir out
 * from under a running `next --repo <r>` process. (MAJOR-1)
 */
async function stopAndCleanup(sessionId: string): Promise<boolean> {
	const liveKeys = listLockKeys(sessionId).filter(
		(key) => checkLock(key).locked,
	);
	for (const key of liveKeys) {
		const lockInfo = checkLock(key);
		if (lockInfo.locked) {
			try {
				process.kill(lockInfo.pid, "SIGTERM");
				for (let i = 0; i < 50; i++) {
					await new Promise((r) => setTimeout(r, 100));
					try {
						process.kill(lockInfo.pid, 0);
					} catch {
						break;
					}
				}
				try {
					process.kill(lockInfo.pid, "SIGKILL");
				} catch {}
			} catch {}
		}
		releaseLock(key);
	}
	return liveKeys.length > 0;
}

async function deleteSessionDir(sessionId: string): Promise<void> {
	rmSync(sessionDir(sessionId), { recursive: true, force: true });
	deleteSession(sessionId);
}

async function runDelete(
	id: string | undefined,
	opts: { all?: boolean; force?: boolean; running?: boolean },
): Promise<void> {
	if (opts.all) {
		const sessions = listSessions();
		const toDelete = sessions.filter(
			(s) => opts.running || !isSessionRunning(s.id),
		);

		if (toDelete.length === 0) {
			logOk("No sessions to delete.");
			return;
		}

		if (!opts.force) {
			const confirmed = await confirmAction(
				`Delete ${toDelete.length} session(s)?`,
				false,
			);
			if (!confirmed) return;
		}

		for (const s of toDelete) {
			await stopAndCleanup(s.id);
			deleteSessionDir(s.id);
			logOk(`Deleted ${s.id}`);
		}
		return;
	}

	// Single session
	let session: import("../core/types").SessionRow | null;

	if (id) {
		session = getSessionById(id);
		if (!session) {
			logError(`Session ${id} not found.`);
			process.exit(1);
		}
	} else {
		session = getSessionByFolder(process.cwd());
		if (!session) {
			logError("No session found in this folder.");
			process.exit(1);
		}
	}

	if (isSessionRunning(session.id) && !opts.running) {
		logError(
			`Session ${session.id} is running. Use --running to stop and delete.`,
		);
		process.exit(1);
	}

	// Confirm a single delete unless --force — for an explicit id too (deleting a
	// session by id is destructive and must not happen silently).
	if (!opts.force) {
		const confirmed = await confirmAction(
			`Delete session ${session.id}?`,
			false,
		);
		if (!confirmed) return;
	}

	const wasRunning = await stopAndCleanup(session.id);
	deleteSessionDir(session.id);
	logOk(`Session ${session.id} deleted${wasRunning ? " (was running)" : ""}.`);
}
