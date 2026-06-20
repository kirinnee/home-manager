import { readConfig } from "../core/config";
import { getSessionByWorktree, listSessions } from "../core/db";
import { getGitRoot, getWorktree } from "../core/git";
import { readSessionMeta, type SessionMeta } from "../core/session-meta";
import type { Config } from "../core/types";

// ============================================================================
// Resolve which session a `next`/`complete`/`diff` call targets.
// Precedence: --session <id> → the cwd's worktree → the single running session.
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
		const row = getSessionByWorktree(repoPath, worktree);
		if (row) return row.id;
	} catch {
		// not in a git worktree
	}
	const running = listSessions();
	if (running.length === 1) return running[0].id;
	return null;
}
