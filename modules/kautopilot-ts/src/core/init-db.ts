import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InitAttemptRow, InitOutcome } from './init-types';

const DB_PATH = `${process.env.HOME}/.kautopilot/index.db`;

let db: Database | null = null;

function getDb(): Database {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS init_attempts (
        id                  TEXT PRIMARY KEY,
        repo_path           TEXT NOT NULL,
        worktree            TEXT NOT NULL,
        git_root            TEXT NOT NULL,
        git_root_host       TEXT NOT NULL,
        org                 TEXT,
        outcome             TEXT,
        promoted_session_id TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_init_worktree ON init_attempts(repo_path, worktree);
    `);
  }
  return db;
}

export function upsertInitAttempt(row: InitAttemptRow): void {
  const d = getDb();
  d.query(
    `INSERT INTO init_attempts (id, repo_path, worktree, git_root, git_root_host, org, outcome, promoted_session_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(id) DO UPDATE SET
       outcome = $7,
       promoted_session_id = $8,
       updated_at = $10`,
  ).run(
    row.id,
    row.repo_path,
    row.worktree,
    row.git_root,
    row.git_root_host,
    row.org,
    row.outcome,
    row.promoted_session_id,
    row.created_at,
    row.updated_at,
  );
}

export function updateInitOutcome(id: string, outcome: InitOutcome, promotedSessionId?: string): void {
  const d = getDb();
  d.query('UPDATE init_attempts SET outcome = $1, promoted_session_id = $2, updated_at = $3 WHERE id = $4').run(
    outcome,
    promotedSessionId ?? null,
    new Date().toISOString(),
    id,
  );
}

export function getInitAttemptById(id: string): InitAttemptRow | null {
  const d = getDb();
  return d.query('SELECT * FROM init_attempts WHERE id = $1').get(id) as InitAttemptRow | null;
}

export function getInitAttemptByPromotedSessionId(sessionId: string): InitAttemptRow | null {
  const d = getDb();
  return d
    .query('SELECT * FROM init_attempts WHERE promoted_session_id = $1 ORDER BY created_at DESC LIMIT 1')
    .get(sessionId) as InitAttemptRow | null;
}

/**
 * Get the active init attempt for a worktree.
 * "Active" means outcome is NULL (not yet resolved).
 */
export function getActiveInitForWorktree(repoPath: string, worktree: string): InitAttemptRow | null {
  const d = getDb();
  return d
    .query(
      'SELECT * FROM init_attempts WHERE repo_path = $1 AND worktree = $2 AND outcome IS NULL ORDER BY created_at DESC LIMIT 1',
    )
    .get(repoPath, worktree) as InitAttemptRow | null;
}

/**
 * List all init attempts for a worktree, including completed/failed ones.
 */
export function listInitAttemptsForWorktree(repoPath: string, worktree: string): InitAttemptRow[] {
  const d = getDb();
  return d
    .query('SELECT * FROM init_attempts WHERE repo_path = $1 AND worktree = $2 ORDER BY created_at DESC')
    .all(repoPath, worktree) as InitAttemptRow[];
}
