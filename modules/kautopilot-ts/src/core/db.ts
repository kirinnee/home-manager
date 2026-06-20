import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRow } from "./types";

/** Resolved lazily so tests that swap $HOME get an isolated index. */
function dbPath(): string {
	return `${process.env.HOME}/.kautopilot/index.db`;
}

const UPSERT_SQL = `
  INSERT INTO sessions (id, repo_path, worktree, git_root, git_root_host, ticket_id, branch, local, state, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT(id) DO UPDATE SET
    repo_path = $2,
    worktree = $3,
    git_root = $4,
    git_root_host = $5,
    ticket_id = $6,
    branch = $7,
    local = $8,
    state = $9,
    updated_at = $11
`;

function rowToParams(row: SessionRow): (string | number | null)[] {
	return [
		row.id,
		row.repo_path,
		row.worktree,
		row.git_root,
		row.git_root_host,
		row.ticket_id,
		row.branch,
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
		db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id             TEXT PRIMARY KEY,
        repo_path      TEXT NOT NULL,
        worktree       TEXT NOT NULL,
        git_root       TEXT NOT NULL,
        git_root_host  TEXT NOT NULL,
        ticket_id      TEXT,
        branch         TEXT,
        local          INTEGER NOT NULL DEFAULT 0,
        state          TEXT NOT NULL DEFAULT 'init',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_worktree ON sessions(repo_path, worktree);
    `);
		// Migrate: add state column if missing (existing DBs)
		try {
			db.exec(
				"ALTER TABLE sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'init'",
			);
		} catch {
			// Column already exists — ignore
		}
		db.exec("PRAGMA journal_mode=WAL");
	}
	return db;
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

export function getSessionByWorktree(
	repoPath: string,
	worktree: string,
): SessionRow | null {
	const d = getDb();
	return d
		.query("SELECT * FROM sessions WHERE repo_path = $1 AND worktree = $2")
		.get(repoPath, worktree) as SessionRow | null;
}

export function listSessions(options?: { includeAll?: boolean }): SessionRow[] {
	const d = getDb();
	const sessions = d
		.query("SELECT * FROM sessions ORDER BY created_at DESC")
		.all() as SessionRow[];
	if (options?.includeAll) {
		return sessions;
	}
	return sessions.filter((s) => s.state === "running");
}

export function deleteSession(id: string): void {
	const d = getDb();
	d.query("DELETE FROM sessions WHERE id = $1").run(id);
}
