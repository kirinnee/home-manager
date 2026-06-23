import { readConfig } from "../core/config";
import { getSessionsByFolder, listSessions } from "../core/db";
import { readSessionMeta, type SessionMeta } from "../core/session-meta";
import { isSessionActive } from "../core/status";
import type { Config } from "../core/types";

// ============================================================================
// Resolve which session a `next`/`complete`/`diff` call targets. A folder can
// host MANY sessions, so cwd resolution only auto-picks when it's unambiguous.
// Precedence: --session <id> → the cwd folder's single (running) session →
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
	const here = getSessionsByFolder(process.cwd());
	// Prefer the single ACTIVE (in-progress) session in this folder; else, if there's
	// only one session here at all, use it. If the folder hosts several active ones,
	// don't guess — fall through. ("Active" is materialized status, not the dead DB
	// `state` column — see isSessionActive.)
	const activeHere = here.filter((s) => isSessionActive(s.id));
	if (activeHere.length === 1) return activeHere[0].id;
	if (activeHere.length === 0 && here.length === 1) return here[0].id;

	const active = listSessions().filter((s) => isSessionActive(s.id));
	if (active.length === 1) return active[0].id;
	return null;
}
