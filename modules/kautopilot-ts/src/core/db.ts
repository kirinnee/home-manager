import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRow } from "./types";

/** Resolved lazily so tests that swap $HOME get an isolated index. */
function dbPath(): string {
	return `${process.env.HOME}/.kautopilot/index.db`;
}

const UPSERT_SQL = `
  INSERT INTO sessions (id, folder, ticket_id, local, state, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT(id) DO UPDATE SET
    folder = $2,
    ticket_id = $3,
    local = $4,
    state = $5,
    updated_at = $7
`;

function rowToParams(row: SessionRow): (string | number | null)[] {
	return [
		row.id,
		row.folder,
		row.ticket_id,
		row.local,
		row.state,
		row.created_at,
		row.updated_at,
	];
}

let db: Database | null = null;
let dbOpenedPath: string | null = null;

function getDb(): Database {
	const path = dbPath();
	// Reopen if $HOME changed (e.g. between tests with isolated temp homes).
	if (db && dbOpenedPath !== path) {
		db.close();
		db = null;
	}
	if (!db) {
		mkdirSync(dirname(path), { recursive: true });
		db = new Database(path);
		dbOpenedPath = path;
		// A session is associated with a FOLDER (where `kautopilot start` ran), never
		// a repo/worktree — those are per-repo details inside session.json. Fresh DBs
		// get this schema directly; legacy DBs are migrated below.
		db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        folder      TEXT NOT NULL,
        ticket_id   TEXT,
        local       INTEGER NOT NULL DEFAULT 0,
        state       TEXT NOT NULL DEFAULT 'init',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
		migrateLegacyToFolder(db);
		// A folder hosts MANY sessions — a plain lookup index, never unique.
		db.exec("DROP INDEX IF EXISTS idx_sessions_worktree");
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_sessions_folder ON sessions(folder)",
		);
		db.exec("PRAGMA journal_mode=WAL");
	}
	return db;
}

/**
 * Migrate a legacy `sessions` table (repo_path/worktree/git_root/git_root_host/branch
 * columns) to the folder-based schema. The session's folder is backfilled from the old
 * `repo_path` (the cwd `start` ran in, for hub launches) — falling back to `worktree`.
 * Idempotent: a no-op once the table already has `folder` and no `repo_path`.
 */
function migrateLegacyToFolder(d: Database): void {
	const cols = d.query("PRAGMA table_info(sessions)").all() as {
		name: string;
	}[];
	const names = new Set(cols.map((c) => c.name));
	if (names.has("folder") && !names.has("repo_path")) return; // already migrated
	if (!names.has("repo_path")) return; // unknown shape — leave it alone

	d.exec("BEGIN");
	try {
		// Self-heal: a prior migration hard-killed between RENAME and COMMIT could
		// leave an orphan sessions_legacy; drop it so the RENAME below doesn't collide.
		d.exec("DROP TABLE IF EXISTS sessions_legacy");
		d.exec("ALTER TABLE sessions RENAME TO sessions_legacy");
		d.exec(`
      CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        folder      TEXT NOT NULL,
        ticket_id   TEXT,
        local       INTEGER NOT NULL DEFAULT 0,
        state       TEXT NOT NULL DEFAULT 'init',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
		d.exec(`
      INSERT INTO sessions (id, folder, ticket_id, local, state, created_at, updated_at)
      SELECT id, COALESCE(repo_path, worktree), ticket_id, local, state, created_at, updated_at
      FROM sessions_legacy
    `);
		d.exec("DROP TABLE sessions_legacy");
		d.exec("COMMIT");
	} catch (err) {
		d.exec("ROLLBACK");
		throw err;
	}
}

export function upsertSession(row: SessionRow): void {
	const d = getDb();
	d.query(UPSERT_SQL).run(...rowToParams(row));
}

export function getSessionById(id: string): SessionRow | null {
	const d = getDb();
	return d
		.query("SELECT * FROM sessions WHERE id = $1")
		.get(id) as SessionRow | null;
}

/**
 * The single most relevant session in a folder: a running one wins, else the
 * most recently created. Since a folder hosts multiple sessions, this is a
 * best-effort convenience for commands that operate on "the session here"
 * (status/logs/stop/delete); the critical next/complete path uses
 * {@link getSessionsByFolder} to detect ambiguity instead of guessing.
 */
export function getSessionByFolder(folder: string): SessionRow | null {
	const d = getDb();
	// Most-recent wins. (The `state` column is not a liveness signal — see
	// isSessionActive in core/status.ts; callers needing "the live one" filter on that.)
	return d
		.query("SELECT * FROM sessions WHERE folder = $1 ORDER BY created_at DESC")
		.get(folder) as SessionRow | null;
}

/** Every session associated with a folder (a folder may host several). */
export function getSessionsByFolder(folder: string): SessionRow[] {
	const d = getDb();
	return d
		.query("SELECT * FROM sessions WHERE folder = $1")
		.all(folder) as SessionRow[];
}

/**
 * Every session, most-recent first. Liveness is NOT filtered here — the DB `state`
 * column is dead in the thin-controller model (always "running"). Callers that want
 * only in-progress sessions filter with `isSessionActive` (core/status.ts).
 */
export function listSessions(): SessionRow[] {
	const d = getDb();
	return d
		.query("SELECT * FROM sessions ORDER BY created_at DESC")
		.all() as SessionRow[];
}

export function deleteSession(id: string): void {
	const d = getDb();
	d.query("DELETE FROM sessions WHERE id = $1").run(id);
}
