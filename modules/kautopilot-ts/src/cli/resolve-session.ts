import { readConfig } from "../core/config";
import { getSessionsByWorktree, listSessions } from "../core/db";
import { getGitRoot, getWorktree } from "../core/git";
import { readSessionMeta, type SessionMeta } from "../core/session-meta";
import type { Config } from "../core/types";

// ============================================================================
// Resolve which session a `next`/`complete`/`diff` call targets. A worktree can
// host MANY sessions, so cwd resolution only auto-picks when it's unambiguous.
// Precedence: --session <id> → the cwd worktree's single (running) session →
// the single running session anywhere. Ambiguous → require --session.
// ============================================================================

export interface ResolvedSession {
	sessionId: string;
	meta: SessionMeta;
	config: Config;
}

export function resolveSession(sessionIdArg?: string): ResolvedSession {
	const sessionId = sessionIdArg ?? resolveFromContext();
	if (!sessionId) {
		throw new Error(
			"No session found. Pass --session <id> or run inside a session worktree.",
		);
	}
	const meta = readSessionMeta(sessionId);
	if (!meta)
		throw new Error(
			`Session ${sessionId} has no session.json (not a host-driven session).`,
		);
	const config = readConfig(sessionId);
	if (!config) throw new Error(`Session ${sessionId} has no config.yaml.`);
	return { sessionId, meta, config };
}

function resolveFromContext(): string | null {
	try {
		const repoPath = getGitRoot();
		const worktree = getWorktree();
		const here = getSessionsByWorktree(repoPath, worktree);
		// Prefer a single running session in this worktree; else a single session
		// total here. If the folder hosts several, don't guess — fall through.
		const runningHere = here.filter((s) => s.state === "running");
		if (runningHere.length === 1) return runningHere[0].id;
		if (runningHere.length === 0 && here.length === 1) return here[0].id;
	} catch {
		// not in a git worktree
	}
	const running = listSessions();
	if (running.length === 1) return running[0].id;
	return null;
}
