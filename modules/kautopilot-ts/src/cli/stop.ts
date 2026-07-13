import { rmSync } from "node:fs";
import { Command } from "commander";
import { sessionDir } from "../core/artifacts";
import { deleteSession, getSessionByFolder, getSessionById } from "../core/db";
import { checkLock, listLockKeys, releaseLock } from "../core/lock";
import { appendEvent } from "../core/log";
import {
	killWriterSessions,
	markWritersInterrupted,
} from "../core/writer/relay";
import { confirmAction } from "../llm/inquirer";
import { logError, logOk } from "../util/format";

export function createStopCommand(): Command {
	return new Command("stop")
		.argument("[id]", "Session ID (optional — defaults to local)")
		.option("--force", "Skip confirmation")
		.action(async (id: string | undefined, opts: { force?: boolean }) => {
			try {
				await runStop(id, opts);
			} catch (err) {
				logError(err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});
}

/**
 * SIGTERM (then SIGKILL after a grace period) the process holding `lockKey`.
 * Returns the number of kill signals delivered (for the stop:completed metadata).
 */
async function killLockKey(lockKey: string): Promise<number> {
	const lockInfo = checkLock(lockKey);
	if (!lockInfo.locked) return 0;
	const pid = lockInfo.pid;
	let killed = 0;
	try {
		process.kill(pid, "SIGTERM");
		killed++;

		// Wait up to 5 seconds for graceful shutdown
		for (let i = 0; i < 50; i++) {
			await new Promise((r) => setTimeout(r, 100));
			try {
				process.kill(pid, 0);
			} catch {
				// Process is dead
				break;
			}
		}

		// Force kill if still alive
		try {
			process.kill(pid, 0);
			process.kill(pid, "SIGKILL");
			killed++;
		} catch {
			// Already dead
		}
	} catch {
		// Kill failed
	}
	return killed;
}

async function runStop(
	id: string | undefined,
	opts: { force?: boolean },
): Promise<void> {
	let session: import("../core/types").SessionRow | null;
	const isGlobal = !!id;

	if (id) {
		session = getSessionById(id);
		if (!session) {
			logError(`Session ${id} not found in index.`);
			process.exit(1);
		}
	} else {
		session = getSessionByFolder(process.cwd());
		if (!session) {
			logError("No session found in this folder.");
			process.exit(1);
		}
	}

	// Check every current or legacy scope lock for the session, not just the
	// session lock. (MAJOR-1)
	const liveKeys = listLockKeys(session.id).filter(
		(key) => checkLock(key).locked,
	);
	if (liveKeys.length === 0) {
		// No live controller — but a SIGKILLed relay may have orphaned writer tmux
		// sessions (its try/finally never ran). Clean those up even here: they hold
		// a real Claude conversation and burn quota.
		const orphans = await killWriterSessions(session.id);
		markWritersInterrupted(session.id);
		logOk(
			orphans > 0
				? `Session is not running (cleaned ${orphans} orphaned writer tmux session(s)).`
				: "Session is not running.",
		);
		return;
	}

	// Confirm
	if (!opts.force && !isGlobal) {
		const confirmed = await confirmAction(`Stop session ${session.id}?`, false);
		if (!confirmed) return;
	}

	// Log stop start
	appendEvent(session.id, {
		ts: new Date().toISOString(),
		event: "stop:started",
	});

	// Kill + release every live scope lock.
	let processesKilled = 0;
	for (const key of liveKeys) {
		processesKilled += await killLockKey(key);
		releaseLock(key);
	}

	// SIGKILL skips the relay's try/finally tmux cleanup — kill any writer tmux
	// sessions ourselves, and mark running writers interrupted (re-attachable,
	// NOT terminal: the next `relay` re-attaches per the recovery matrix).
	const writersKilled = await killWriterSessions(session.id);
	markWritersInterrupted(session.id);
	if (writersKilled > 0) processesKilled += writersKilled;

	// Log stop completed BEFORE any deletion
	appendEvent(session.id, {
		ts: new Date().toISOString(),
		event: "stop:completed",
		metadata: { processesKilled },
	});

	// Global mode: prompt to delete
	if (isGlobal) {
		const doDelete =
			opts.force ||
			(await confirmAction(`Delete session directory and index entry?`, false));
		if (doDelete) {
			rmSync(sessionDir(session.id), { recursive: true, force: true });
			deleteSession(session.id);
			logOk(`Session ${session.id} stopped and removed.`);
			return;
		}
	}

	logOk(`Session ${session.id} stopped.`);
}
