import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { InitAttemptRow } from '../init-types';
import type { SessionRow } from '../types';

function createTestDb(): Database {
  const db = new Database(':memory:');
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
  return db;
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

describe('Database operations', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('inserts and retrieves a session', () => {
    const row: SessionRow = {
      id: 'test1234',
      repo_path: '/tmp/repo',
      worktree: '/tmp/repo',
      git_root: 'git@github.com:test-org/test-repo.git',
      git_root_host: 'github.com/test-org/test-repo',
      ticket_id: 'PE-1234',
      branch: 'feature/PE-1234',
      local: 0,
      state: 'ready',
      created_at: '2026-03-24T10:00:00Z',
      updated_at: '2026-03-24T10:00:00Z',
    };

    db.query(UPSERT_SQL).run(...rowToParams(row));

    const result = db.query('SELECT * FROM sessions WHERE id = $1').get(row.id) as SessionRow;
    expect(result).not.toBeNull();
    expect(result?.ticket_id).toBe('PE-1234');
    expect(result?.branch).toBe('feature/PE-1234');
    expect(result?.local).toBe(0);
    expect(result?.state).toBe('ready');
  });

  it('upserts a session', () => {
    const row: SessionRow = {
      id: 'test1234',
      repo_path: '/tmp/repo',
      worktree: '/tmp/repo',
      git_root: 'git@github.com:test-org/test-repo.git',
      git_root_host: 'github.com/test-org/test-repo',
      ticket_id: 'PE-1234',
      branch: 'feature/PE-1234',
      local: 0,
      state: 'init',
      created_at: '2026-03-24T10:00:00Z',
      updated_at: '2026-03-24T10:00:00Z',
    };

    db.query(UPSERT_SQL).run(...rowToParams(row));

    // Upsert with updated values
    const updated = {
      ...row,
      ticket_id: 'PE-5678',
      state: 'ready' as const,
      updated_at: '2026-03-24T11:00:00Z',
    };
    db.query(UPSERT_SQL).run(...rowToParams(updated));

    const result = db.query('SELECT * FROM sessions WHERE id = $1').get(row.id) as SessionRow;
    expect(result?.ticket_id).toBe('PE-5678');
    expect(result?.state).toBe('ready');
    expect(result?.updated_at).toBe('2026-03-24T11:00:00Z');
  });

  it('lists all sessions', () => {
    db.query(UPSERT_SQL).run(
      'a1',
      '/a',
      '/a',
      'x',
      'x',
      null,
      null,
      0,
      'ready',
      '2026-03-24T10:00:00Z',
      '2026-03-24T10:00:00Z',
    );
    db.query(UPSERT_SQL).run(
      'b2',
      '/b',
      '/b',
      'y',
      'y',
      null,
      null,
      0,
      'ready',
      '2026-03-24T10:00:00Z',
      '2026-03-24T10:00:00Z',
    );

    const results = db.query('SELECT * FROM sessions ORDER BY created_at DESC').all() as SessionRow[];
    expect(results).toHaveLength(2);
  });

  it('deletes a session', () => {
    db.query(UPSERT_SQL).run(
      'del1',
      '/d',
      '/d',
      'z',
      'z',
      null,
      null,
      0,
      'init',
      '2026-03-24T10:00:00Z',
      '2026-03-24T10:00:00Z',
    );

    db.query('DELETE FROM sessions WHERE id = $1').run('del1');
    const result = db.query('SELECT * FROM sessions WHERE id = $1').get('del1');
    expect(result).toBeNull();
  });

  it('defaults state to init', () => {
    db.query(UPSERT_SQL).run(
      's1',
      '/s',
      '/s',
      's',
      's',
      null,
      null,
      0,
      'init',
      '2026-03-24T10:00:00Z',
      '2026-03-24T10:00:00Z',
    );

    const result = db.query('SELECT * FROM sessions WHERE id = $1').get('s1') as SessionRow;
    expect(result.state).toBe('init');
  });

  it('allows multiple worktrees for the same repo path', () => {
    db.query(UPSERT_SQL).run(
      'main',
      '/repo',
      '/repo',
      'x',
      'x',
      null,
      null,
      0,
      'ready',
      '2026-03-24T10:00:00Z',
      '2026-03-24T10:00:00Z',
    );
    db.query(UPSERT_SQL).run(
      'wt1',
      '/repo',
      '/repo-wt',
      'x',
      'x',
      null,
      null,
      0,
      'ready',
      '2026-03-24T10:01:00Z',
      '2026-03-24T10:01:00Z',
    );

    const results = db
      .query('SELECT * FROM sessions WHERE repo_path = $1 ORDER BY worktree')
      .all('/repo') as SessionRow[];
    expect(results).toHaveLength(2);
    expect(results.map(r => r.worktree)).toEqual(['/repo', '/repo-wt']);
  });

  it('stores promotion provenance on init attempts', () => {
    const row: InitAttemptRow = {
      id: 'init1',
      repo_path: '/tmp/repo',
      worktree: '/tmp/repo',
      git_root: 'git@github.com:test-org/test-repo.git',
      git_root_host: 'github.com/test-org/test-repo',
      org: 'test-org',
      outcome: 'promoted',
      promoted_session_id: 'sess1',
      created_at: '2026-03-24T10:00:00Z',
      updated_at: '2026-03-24T10:00:00Z',
    };

    db.query(
      `INSERT INTO init_attempts (id, repo_path, worktree, git_root, git_root_host, org, outcome, promoted_session_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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

    const result = db
      .query('SELECT * FROM init_attempts WHERE promoted_session_id = $1')
      .get('sess1') as InitAttemptRow;
    expect(result.id).toBe('init1');
    expect(result.outcome).toBe('promoted');
  });

  it('getActiveInitForWorktree: returns active init with NULL outcome', () => {
    // Insert an active init (outcome = NULL)
    db.query(
      `INSERT INTO init_attempts (id, repo_path, worktree, git_root, git_root_host, org, outcome, promoted_session_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    ).run('active1', '/repo', '/repo', 'git@x', 'x', null, null, null, '2026-03-24T10:00:00Z', '2026-03-24T10:00:00Z');

    const result = db
      .query(
        'SELECT * FROM init_attempts WHERE repo_path = $1 AND worktree = $2 AND outcome IS NULL ORDER BY created_at DESC LIMIT 1',
      )
      .get('/repo', '/repo') as InitAttemptRow | null;
    expect(result).not.toBeNull();
    expect(result?.id).toBe('active1');
    expect(result?.outcome).toBeNull();
  });

  it('getActiveInitForWorktree: returns null when all inits have an outcome', () => {
    // Insert a resolved init (outcome = 'failed')
    db.query(
      `INSERT INTO init_attempts (id, repo_path, worktree, git_root, git_root_host, org, outcome, promoted_session_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    ).run(
      'resolved1',
      '/repo',
      '/repo',
      'git@x',
      'x',
      null,
      'failed',
      null,
      '2026-03-24T10:00:00Z',
      '2026-03-24T10:00:00Z',
    );

    const result = db
      .query(
        'SELECT * FROM init_attempts WHERE repo_path = $1 AND worktree = $2 AND outcome IS NULL ORDER BY created_at DESC LIMIT 1',
      )
      .get('/repo', '/repo') as InitAttemptRow | null;
    expect(result).toBeNull();
  });

  it('getActiveInitForWorktree: returns most recent active init', () => {
    // Insert an older resolved init and a newer active init
    db.query(
      `INSERT INTO init_attempts (id, repo_path, worktree, git_root, git_root_host, org, outcome, promoted_session_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    ).run(
      'old1',
      '/repo',
      '/repo',
      'git@x',
      'x',
      null,
      'abandoned',
      null,
      '2026-03-24T09:00:00Z',
      '2026-03-24T09:00:00Z',
    );
    db.query(
      `INSERT INTO init_attempts (id, repo_path, worktree, git_root, git_root_host, org, outcome, promoted_session_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    ).run('new1', '/repo', '/repo', 'git@x', 'x', null, null, null, '2026-03-24T11:00:00Z', '2026-03-24T11:00:00Z');

    const result = db
      .query(
        'SELECT * FROM init_attempts WHERE repo_path = $1 AND worktree = $2 AND outcome IS NULL ORDER BY created_at DESC LIMIT 1',
      )
      .get('/repo', '/repo') as InitAttemptRow | null;
    expect(result).not.toBeNull();
    expect(result?.id).toBe('new1');
  });
});
