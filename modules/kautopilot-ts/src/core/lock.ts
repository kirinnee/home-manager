import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { LockInfo } from "./types";

/**
 * A lock key is either a bare session id (`k7f3a9`, the session-timeline scope) or
 * a scoped key `sessionId:scope` (e.g. `k7f3a9:api`). The lock FILE always lives
 * inside the session dir so a scoped key never spawns a bogus directory: the
 * session scope uses `lock.pid`; a repo scope uses `lock-<scope>.pid`.
 */
function lockPath(id: string): string {
	const sep = id.indexOf(":");
	if (sep === -1) {
		return `${process.env.HOME}/.kautopilot/${id}/lock.pid`;
	}
	const sessionId = id.slice(0, sep);
	const scope = id.slice(sep + 1);
	return `${process.env.HOME}/.kautopilot/${sessionId}/lock-${scope}.pid`;
}

/**
 * Compose a per-scope lock key from a session id and the `--repo` arg. `next`/
 * `complete` lock on this so two repo drivers (`--repo api` / `--repo infra`) run
 * concurrently and a blocking session-timeline `poll` doesn't block them — each
 * scope gets its own lock file. Read-only commands (`status`/`diff`) never
 * acquire it, so they stay responsive during a repo's blocking poll. (CLI-CONTRACT §12)
 */
export function scopeLockKey(sessionId: string, repo?: string | null): string {
	return repo ? `${sessionId}:${repo}` : sessionId;
}

/**
 * Every lock KEY currently present on disk for a session: the bare session id
 * (if `lock.pid` exists) plus a scoped key `sessionId:<scope>` for each
 * `lock-<scope>.pid` repo lock file in the session dir. The returned keys are
 * exactly what `checkLock`/`acquireLock`/`releaseLock` consume, so `stop`/`delete`
 * can enumerate and act on every running scope (session timeline + repo drivers),
 * not just the session lock. (MAJOR-1)
 */
export function listLockKeys(sessionId: string): string[] {
	const dir = `${process.env.HOME}/.kautopilot/${sessionId}`;
	const keys: string[] = [];
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return keys;
	}
	for (const file of files) {
		if (file === "lock.pid") {
			keys.push(sessionId);
		} else {
			const m = /^lock-(.+)\.pid$/.exec(file);
			if (m) keys.push(scopeLockKey(sessionId, m[1]));
		}
	}
	return keys;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function acquireLock(id: string): void {
	const path = lockPath(id);
	mkdirSync(dirname(path), { recursive: true });

	if (existsSync(path)) {
		const existingPid = parseInt(readFileSync(path, "utf-8").trim(), 10);
		if (isProcessAlive(existingPid)) {
			throw new Error(
				`Session is already running (PID ${existingPid}). Use \`kautopilot stop\` first.`,
			);
		}
		// Stale lock — auto-cleanup
		console.warn(
			`Warning: Stale lock detected (PID ${existingPid} not alive). Auto-cleaning.`,
		);
		unlinkSync(path);
	}

	writeFileSync(path, String(process.pid));

	// Install signal handlers to release lock on exit
	const cleanup = () => {
		try {
			if (existsSync(path)) {
				const storedPid = readFileSync(path, "utf-8").trim();
				if (storedPid === String(process.pid)) {
					unlinkSync(path);
				}
			}
		} catch {
			// Ignore errors during cleanup
		}
	};

	process.on("SIGINT", () => {
		cleanup();
		process.exit(130);
	});

	process.on("SIGTERM", () => {
		cleanup();
		process.exit(143);
	});

	process.on("exit", cleanup);
}

export function checkLock(id: string): LockInfo {
	const path = lockPath(id);

	if (!existsSync(path)) {
		return { locked: false, pid: 0, alive: false };
	}

	const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
	const alive = isProcessAlive(pid);

	if (!alive) {
		// Stale lock — auto-cleanup
		console.warn(
			`Warning: Stale lock detected (PID ${pid} not alive). Auto-cleaning.`,
		);
		try {
			unlinkSync(path);
		} catch {
			// Ignore
		}
		return { locked: false, pid, alive: false };
	}

	return { locked: true, pid, alive: true };
}

export function releaseLock(id: string): void {
	const path = lockPath(id);
	try {
		if (existsSync(path)) {
			const storedPid = readFileSync(path, "utf-8").trim();
			if (storedPid === String(process.pid)) {
				unlinkSync(path);
			}
		}
	} catch {
		// Ignore errors during release
	}
}
