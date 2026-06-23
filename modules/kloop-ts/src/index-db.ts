import * as path from 'path';
import type { FsService, Paths, TmuxService } from './deps';
import type { RunIndexRow, KloopRunState, KloopEvent, KloopRunStatus, MaterializedStatus } from './types';
import { EVENT_TYPES } from './types';
import { materialize, enrich, toRunState } from './status/materialize';

// ============================================================================
// SQLite Index DB
// ============================================================================

export class IndexDb {
  private db: any; // bun:sqlite Database

  constructor(
    private fs: FsService,
    private paths: Paths,
  ) {
    // Use dynamic import for bun:sqlite
    const { Database } = require('bun:sqlite') as { Database: any };
    const schema = `
      CREATE TABLE IF NOT EXISTS runs (
        id          TEXT PRIMARY KEY,
        workspace   TEXT NOT NULL,
        started_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
    `;
    try {
      // Normal (writable) path: ensure dir, create/open, init schema + WAL.
      this.fs.mkdir(path.dirname(this.paths.indexDb));
      this.db = new Database(this.paths.indexDb, { create: true });
      this.db.exec(schema);
      this.db.exec('PRAGMA journal_mode=WAL'); // better concurrent reads
    } catch {
      // Read-only store — `kloop dash` mounts ~/.kloop read-only, so mkdir/create/WAL
      // all fail. Open read-only WITHOUT touching the -wal/-shm sidecars. SQLite defers
      // the sidecar-access error to the first query, so we must PROBE before trusting a
      // handle; if every read-only open fails its probe, degrade to an empty in-memory
      // DB so the dashboard returns an empty list instead of 500-ing every request.
      this.db = this.openReadOnly(Database, schema);
    }
  }

  private openReadOnly(Database: any, schema: string): any {
    const candidates = [
      // immutable=1 reads the main DB as a frozen snapshot, skipping -wal/-shm entirely
      // (works on a read-only FS even when the sidecars are absent).
      () => new Database(`file:${this.paths.indexDb}?immutable=1`, { readonly: true }),
      () => new Database(this.paths.indexDb, { readonly: true }),
    ];
    for (const open of candidates) {
      try {
        const db = open();
        db.prepare('SELECT id FROM runs LIMIT 0').all(); // probe — surfaces deferred errors now
        return db;
      } catch {
        /* try the next strategy */
      }
    }
    const mem = new Database(':memory:');
    mem.exec(schema);
    return mem;
  }

  // --- CRUD ---

  async insertRun(row: RunIndexRow): Promise<void> {
    this.db
      .prepare('INSERT INTO runs (id, workspace, started_at) VALUES (?, ?, ?)')
      .run(row.id, row.workspace, row.started_at);
  }

  async getRun(runId: string): Promise<RunIndexRow | null> {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    return row ? (row as RunIndexRow) : null;
  }

  async getRunByWorkspace(workspace: string): Promise<RunIndexRow | null> {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE workspace = ? ORDER BY started_at DESC LIMIT 1')
      .get(workspace);
    return row ? (row as RunIndexRow) : null;
  }

  async listRuns(workspace?: string): Promise<RunIndexRow[]> {
    let query = 'SELECT * FROM runs';
    const params: any[] = [];
    if (workspace) {
      query += ' WHERE workspace = ?';
      params.push(workspace);
    }
    query += ' ORDER BY started_at DESC';
    const rows = this.db.prepare(query).all(...params);
    return rows as RunIndexRow[];
  }

  async removeRun(runId: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    return (result as any).changes > 0;
  }

  // --- Cleanup ---

  close(): void {
    this.db.close();
  }
}

// ============================================================================
// Event Log (events.jsonl)
// ============================================================================

export class EventLog {
  constructor(
    private fs: FsService,
    private paths: Paths,
  ) {}

  async append(runId: string, event: KloopEvent): Promise<void> {
    const line = JSON.stringify(event) + '\n';
    const { appendFile } = await import('fs/promises');
    await appendFile(this.paths.runEvents(runId), line, 'utf-8');
  }

  async readAll(runId: string): Promise<KloopEvent[]> {
    const filePath = this.paths.runEvents(runId);
    if (!(await this.fs.exists(filePath))) return [];
    const content = await this.fs.readFile(filePath);
    const events: KloopEvent[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
      }
    }
    return events;
  }

  async deriveStatus(runId: string, pid?: number): Promise<KloopRunState | null> {
    const status = await materialize(runId, this.fs, this.paths, pid);
    return toRunState(status);
  }

  /**
   * Get the full materialized status (richer than KloopRunState).
   * Use this for status/describe commands that need per-loop detail.
   */
  async materializeStatus(runId: string, pid?: number): Promise<MaterializedStatus> {
    return materialize(runId, this.fs, this.paths, pid);
  }

  /**
   * Enrich materialized status with verdict files and summary data.
   */
  async enrichStatus(status: MaterializedStatus, runId: string): Promise<MaterializedStatus> {
    return enrich(status, runId, this.fs, this.paths);
  }

  isTerminal(status: KloopRunStatus): boolean {
    return status !== 'running' && status !== 'pending';
  }
}

// ============================================================================
// PID Lock
// ============================================================================

interface LockInfo {
  pid: number;
  runId: string;
  workspace: string;
  createdAt: string;
}

export class PidLock {
  constructor(
    private fs: FsService,
    private paths: Paths,
  ) {}

  async acquire(runId: string, workspace: string): Promise<void> {
    const lockPath = this.paths.lockFile(runId);
    const info: LockInfo = {
      pid: process.pid,
      runId,
      workspace,
      createdAt: new Date().toISOString(),
    };
    await this.fs.writeJson(lockPath, info);
  }

  async read(runId: string): Promise<LockInfo | null> {
    const lockPath = this.paths.lockFile(runId);
    if (!(await this.fs.exists(lockPath))) return null;
    try {
      return (await this.fs.readJson<LockInfo>(lockPath))!;
    } catch {
      return null;
    }
  }

  async release(runId: string): Promise<void> {
    const lockPath = this.paths.lockFile(runId);
    if (await this.fs.exists(lockPath)) {
      await this.fs.unlink(lockPath);
    }
  }

  async isPidAlive(pid: number): Promise<boolean> {
    try {
      // kill -0 checks if process exists without sending a signal
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all lock files and their info. Returns only valid locks.
   */
  async listLocks(): Promise<LockInfo[]> {
    const home = this.paths.kloopHome;
    if (!(await this.fs.exists(home))) return [];

    const files = await this.fs.readdir(home);
    const locks: LockInfo[] = [];

    for (const file of files) {
      if (!file.endsWith('.lock')) continue;
      const lockPath = `${home}/${file}`;
      try {
        const info = await this.fs.readJson<LockInfo>(lockPath);
        if (info) locks.push(info);
      } catch {
        // Skip invalid lock files
      }
    }

    return locks;
  }
}

// ============================================================================
// Shared cleanup helpers
// ============================================================================

/** Kill all tmux sessions linked to a run */
export async function killRunTmuxSessions(tmux: TmuxService, runId: string): Promise<number> {
  const sessions = await tmux.listSessions();
  let killed = 0;
  for (const session of sessions) {
    const parsed = tmux.parseSessionName(session);
    if ((parsed && parsed.runId === runId) || session.includes(`kloop-${runId}`)) {
      if (await tmux.killSession(session)) {
        killed++;
      }
    }
  }
  return killed;
}

/** Fully reap a dead run: write crashed event, kill tmux sessions, release lock */
export async function reapDeadRun(
  runId: string,
  eventLog: EventLog,
  pidLock: PidLock,
  tmux: TmuxService,
): Promise<void> {
  // Kill tmux sessions
  try {
    const killed = await killRunTmuxSessions(tmux, runId);
    if (killed > 0) {
      console.log(`  Cleaned up ${killed} stale tmux session(s)`);
    }
  } catch {
    // tmux may not be available
  }

  // Write crashed event (idempotent — safe if already written)
  try {
    await eventLog.append(runId, {
      type: EVENT_TYPES.CRASHED,
      timestamp: new Date().toISOString(),
      exitCode: 1,
      signal: 'unknown',
      message: 'process terminated (detected dead PID)',
    } as KloopEvent);
  } catch {
    // Ignore
  }

  // Release lock
  try {
    await pidLock.release(runId);
  } catch {
    // Ignore
  }
}
