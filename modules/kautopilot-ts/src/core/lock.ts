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

/**
 * Heartbeat TTL: a lock whose heartbeat hasn't been refreshed within this window is
 * treated as stale even if its PID is still alive. This is the backstop for a
 * wedged-but-alive holder (e.g. a `next` blocked inside a hung child process) that
 * PID-liveness alone can't detect — without it such a holder kept the lock indefinitely
 * (observed as an ~8h stall). The driver refreshes the heartbeat between steps (see
 * `touchLock`), so a healthy long run never goes stale, but a process making no progress
 * for longer than the TTL releases its claim to the next invocation. Override with
 * `KAUTOPILOT_LOCK_TTL_MS`. (Default 30 min — far above any healthy inline code step,
 * far below a real hang.)
 *
 * INVARIANT (keep these knobs coupled): the TTL must exceed the worst-case duration of
 * any single inline step the heartbeat can't refresh mid-flight — in practice that's
 * `seed`, which runs a handful of `KAUTOPILOT_SEED_STEP_TIMEOUT_MS`-bounded subprocesses
 * (worktree provisioning, then branch checkout + seed commit). Each is individually
 * bounded, but they run sequentially with no heartbeat between them, so keep `lockTtlMs`
 * comfortably ABOVE their worst-case sum (defaults: ~8min timeout, 30min TTL — ample
 * margin for the realistic case where at most one subprocess wedges). If you raise the
 * seed timeout, raise this too, or a concurrent `next` could reclaim the lock mid-seed.
 * Reclaim is otherwise safe: the
 * exit/release guards only unlink a lock whose stored PID is still this process, so a
 * wedged holder that later un-wedges can't delete the reclaimer's lock (it just finds its
 * own claim gone). It is NOT actively aborted, so a >TTL wedge that resumes could do
 * concurrent work — the seed timeout (< TTL) is what prevents that in practice.
 */
function lockTtlMs(): number {
	const raw = Number(process.env.KAUTOPILOT_LOCK_TTL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
}

/** Parsed lock file: the owning PID and the last heartbeat (ms epoch, if recorded). */
function readLockFile(path: string): { pid: number; heartbeat: number | null } {
	const [pidLine, hbLine] = readFileSync(path, "utf-8").split("\n");
	const pid = parseInt((pidLine ?? "").trim(), 10);
	// A legacy one-line lock (no heartbeat) — and a trailing-newline-only second line —
	// must read as "no heartbeat" (PID-only staleness), NOT heartbeat 0 (always stale).
	const hbTrim = (hbLine ?? "").trim();
	const hb = hbTrim === "" ? NaN : Number(hbTrim);
	return { pid, heartbeat: Number.isFinite(hb) ? hb : null };
}

/** Write the lock file as `<pid>\n<heartbeat-ms>` (newer two-line format). */
function writeLockFile(path: string): void {
	writeFileSync(path, `${process.pid}\n${Date.now()}`);
}

/**
 * Whether an existing lock is stale (reclaimable): its owner is dead, OR it carries a
 * heartbeat that's older than the TTL. A lock with no heartbeat (legacy one-line format)
 * is judged by PID-liveness only, preserving old behavior.
 */
function lockStale(info: { pid: number; heartbeat: number | null }): {
	stale: boolean;
	reason: string;
} {
	if (!isProcessAlive(info.pid))
		return { stale: true, reason: `PID ${info.pid} not alive` };
	if (info.heartbeat != null && Date.now() - info.heartbeat > lockTtlMs())
		return {
			stale: true,
			reason: `PID ${info.pid} alive but heartbeat stale (no progress for ${Math.round(
				(Date.now() - info.heartbeat) / 1000,
			)}s > TTL ${Math.round(lockTtlMs() / 1000)}s)`,
		};
	return { stale: false, reason: "" };
}

export function acquireLock(id: string): void {
	const path = lockPath(id);
	mkdirSync(dirname(path), { recursive: true });

	if (existsSync(path)) {
		const info = readLockFile(path);
		const { stale, reason } = lockStale(info);
		if (!stale) {
			throw new Error(
				`Session is already running (PID ${info.pid}). Use \`kautopilot stop\` first.`,
			);
		}
		console.warn(`Warning: Stale lock detected (${reason}). Auto-cleaning.`);
		unlinkSync(path);
	}

	writeLockFile(path);

	// Install signal handlers to release lock on exit
	const cleanup = () => {
		try {
			if (existsSync(path)) {
				const storedPid = readLockFile(path).pid;
				if (storedPid === process.pid) {
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

	const info = readLockFile(path);
	const { stale, reason } = lockStale(info);

	if (stale) {
		// Stale lock (dead owner, or alive-but-heartbeat-expired) — auto-cleanup.
		console.warn(`Warning: Stale lock detected (${reason}). Auto-cleaning.`);
		try {
			unlinkSync(path);
		} catch {
			// Ignore
		}
		return { locked: false, pid: info.pid, alive: isProcessAlive(info.pid) };
	}

	return { locked: true, pid: info.pid, alive: true };
}

/**
 * Refresh this process's heartbeat on a lock it owns, proving it's still making
 * progress so `checkLock`/`acquireLock` don't reclaim it under the TTL. No-op if the
 * lock is missing or owned by another PID. The driver calls this between steps.
 */
export function touchLock(id: string): void {
	const path = lockPath(id);
	try {
		if (existsSync(path) && readLockFile(path).pid === process.pid) {
			writeLockFile(path);
		}
	} catch {
		// Ignore — a missing/garbled lock just means nothing to refresh.
	}
}

export function releaseLock(id: string): void {
	const path = lockPath(id);
	try {
		if (existsSync(path)) {
			const storedPid = readLockFile(path).pid;
			if (storedPid === process.pid) {
				unlinkSync(path);
			}
		}
	} catch {
		// Ignore errors during release
	}
}
