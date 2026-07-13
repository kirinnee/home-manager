import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'fs';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface SessionEvent<T extends JsonValue = JsonValue> {
  schemaVersion: 1;
  sequence: number;
  sessionId: string;
  time: string;
  type: string;
  data: T;
}

export interface AppendEventOptions {
  time?: string;
}

export interface ReplayOptions {
  afterSequence?: number;
  limit?: number;
}

export interface IndexedSession {
  id: string;
  directory: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSequence: number;
  config?: unknown;
  state?: unknown;
}

export interface JournalProblem {
  file: string;
  line: number;
  message: string;
}

export interface SyncResult {
  sessionId: string;
  eventCount: number;
  lastSequence: number;
  problems: JournalProblem[];
}

export interface RebuildResult {
  sessionCount: number;
  eventCount: number;
  problems: JournalProblem[];
}

export interface EventStoreOptions {
  home?: string;
  databasePath?: string;
  /** Clear the index before importing every session directory. */
  rebuild?: boolean;
  /** Import on-disk sessions when opening. Defaults to true. */
  importExisting?: boolean;
}

interface EventRow {
  event_json: string;
}

interface SessionRow {
  id: string;
  directory: string;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_sequence: number;
  config_json: string | null;
  state_json: string | null;
}

interface JournalScan {
  events: SessionEvent[];
  problems: JournalProblem[];
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_DIRECTORIES = new Set(['daemon', 'trash']);

function now(): string {
  return new Date().toISOString();
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId) || RESERVED_DIRECTORIES.has(sessionId)) {
    throw new Error(`invalid kteam session id ${JSON.stringify(sessionId)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string | undefined {
  const candidate = asRecord(value)?.[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function parseEvent(value: unknown, expectedSessionId: string): SessionEvent | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.schemaVersion !== 1) return undefined;
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1) return undefined;
  if (record.sessionId !== expectedSessionId) return undefined;
  if (typeof record.time !== 'string' || typeof record.type !== 'string' || record.type.length === 0) return undefined;
  if (!Object.hasOwn(record, 'data')) return undefined;
  return value as SessionEvent;
}

/** Atomically replace a JSON document in the same directory as its destination. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value, null, 2);
  if (encoded === undefined) throw new TypeError('value is not JSON serializable');
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${encoded}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function readJsonIfPresent(file: string): Promise<unknown | undefined> {
  try {
    return await readJsonFile<unknown>(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

async function scanJournal(file: string, expectedSessionId: string): Promise<JournalScan> {
  let contents: string;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], problems: [] };
    throw error;
  }

  const events: SessionEvent[] = [];
  const problems: JournalProblem[] = [];
  const lines = contents.split('\n');
  let lastSequence = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      problems.push({ file, line: index + 1, message: 'invalid JSON event record' });
      continue;
    }

    const event = parseEvent(parsed, expectedSessionId);
    if (!event) {
      problems.push({ file, line: index + 1, message: 'invalid event schema or session id' });
      continue;
    }
    if (event.sequence <= lastSequence) {
      problems.push({
        file,
        line: index + 1,
        message: `event sequence ${event.sequence} is not greater than ${lastSequence}`,
      });
      continue;
    }
    events.push(event);
    lastSequence = event.sequence;
  }
  return { events, problems };
}

async function needsLeadingNewline(file: string): Promise<boolean> {
  const info = await stat(file).catch(() => undefined);
  if (!info || info.size === 0) return false;
  const handle = await open(file, 'r');
  try {
    const byte = new Uint8Array(1);
    await handle.read(byte, 0, 1, info.size - 1);
    return byte[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

/**
 * Durable event journal plus a rebuildable SQLite query index.
 *
 * Event JSONL and config/state documents are authoritative. SQLite is updated only
 * after an event is synced to disk and may always be discarded and rebuilt.
 */
export class EventStore {
  readonly home: string;
  readonly databasePath: string;
  private readonly database: Database;
  private readonly appendQueues = new Map<string, Promise<void>>();
  private readonly lastSequences = new Map<string, number>();
  private closed = false;

  private constructor(home: string, databasePath: string) {
    this.home = path.resolve(home);
    this.databasePath = path.resolve(databasePath);
    mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(this.databasePath, { create: true, strict: true });
    chmodSync(this.databasePath, 0o600);
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.createSchema();
  }

  static async open(options: EventStoreOptions = {}): Promise<EventStore> {
    const home = options.home ?? process.env.KTEAM_HOME ?? path.join(os.homedir(), '.kteam');
    const databasePath = options.databasePath ?? path.join(home, 'daemon', 'kteam.sqlite');
    const store = new EventStore(home, databasePath);
    try {
      if (options.rebuild) await store.rebuildIndex();
      else if (options.importExisting !== false) await store.importFromDisk();
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  sessionDirectory(sessionId: string): string {
    validateSessionId(sessionId);
    return path.join(this.home, sessionId);
  }

  eventsFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), 'events.jsonl');
  }

  configFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), 'config.json');
  }

  stateFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), 'state.json');
  }

  async writeConfig(sessionId: string, config: unknown): Promise<void> {
    await this.serialized(sessionId, async () => {
      await writeJsonAtomic(this.configFile(sessionId), config);
      await this.indexSessionMetadata(sessionId);
    });
  }

  /** Atomically read, transform, and replace one session config document. */
  async updateConfig<T>(sessionId: string, transform: (current: T) => T | Promise<T>): Promise<T> {
    return await this.serialized(sessionId, async () => {
      const current = await readJsonFile<T>(this.configFile(sessionId));
      const next = await transform(current);
      await writeJsonAtomic(this.configFile(sessionId), next);
      await this.indexSessionMetadata(sessionId);
      return next;
    });
  }

  async writeState(sessionId: string, state: unknown): Promise<void> {
    await this.serialized(sessionId, async () => {
      await writeJsonAtomic(this.stateFile(sessionId), state);
      await this.indexSessionMetadata(sessionId);
    });
  }

  /** Atomically read, transform, and replace one session state document. */
  async updateState<T>(sessionId: string, transform: (current: T) => T | Promise<T>): Promise<T> {
    return await this.serialized(sessionId, async () => {
      const current = await readJsonFile<T>(this.stateFile(sessionId));
      const next = await transform(current);
      await writeJsonAtomic(this.stateFile(sessionId), next);
      await this.indexSessionMetadata(sessionId);
      return next;
    });
  }

  async readConfig<T>(sessionId: string): Promise<T> {
    return await readJsonFile<T>(this.configFile(sessionId));
  }

  async readState<T>(sessionId: string): Promise<T> {
    return await readJsonFile<T>(this.stateFile(sessionId));
  }

  async append<T extends JsonValue = JsonValue>(
    sessionId: string,
    type: string,
    data: T = {} as T,
    options: AppendEventOptions = {},
  ): Promise<SessionEvent<T>> {
    validateSessionId(sessionId);
    if (type.trim().length === 0) throw new Error('event type must not be empty');
    // Validate serializability before entering the queue or touching the journal.
    const encodedData = JSON.stringify(data);
    if (encodedData === undefined) throw new TypeError('event data is not JSON serializable');
    const canonicalData = JSON.parse(encodedData) as T;

    return await this.serialized(sessionId, async () => {
      this.assertOpen();
      await mkdir(this.sessionDirectory(sessionId), { recursive: true, mode: 0o700 });
      const previous = await this.lastSequence(sessionId);
      const event: SessionEvent<T> = {
        schemaVersion: 1,
        sequence: previous + 1,
        sessionId,
        time: options.time ?? now(),
        type,
        data: canonicalData,
      };
      const file = this.eventsFile(sessionId);
      const prefix = (await needsLeadingNewline(file)) ? '\n' : '';
      const handle = await open(file, 'a', 0o600);
      try {
        await handle.write(`${prefix}${JSON.stringify(event)}\n`, undefined, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      // From this point onward the append succeeded even if the disposable index
      // is later lost. Index synchronously so replay is immediately consistent.
      this.lastSequences.set(sessionId, event.sequence);
      this.insertEvent(event);
      await this.indexSessionMetadata(sessionId, event.sequence);
      return event;
    });
  }

  replay(sessionId: string, options: ReplayOptions = {}): SessionEvent[] {
    validateSessionId(sessionId);
    this.assertOpen();
    const after = options.afterSequence ?? 0;
    const limit = options.limit ?? 10_000;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('afterSequence must be a non-negative integer');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    const rows = this.database
      .query<EventRow, [string, number, number]>(
        `SELECT event_json
         FROM events
        WHERE session_id = ? AND sequence > ?
        ORDER BY sequence ASC
        LIMIT ?`,
      )
      .all(sessionId, after, limit);
    return rows.map(row => JSON.parse(row.event_json) as SessionEvent);
  }

  getSession(sessionId: string): IndexedSession | undefined {
    validateSessionId(sessionId);
    this.assertOpen();
    const row = this.database
      .query<SessionRow, [string]>(
        `SELECT id, directory, status, created_at, updated_at, last_sequence, config_json, state_json
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId);
    return row ? this.sessionFromRow(row) : undefined;
  }

  listSessions(): IndexedSession[] {
    this.assertOpen();
    const rows = this.database
      .query<SessionRow, []>(
        `SELECT id, directory, status, created_at, updated_at, last_sequence, config_json, state_json
         FROM sessions
        ORDER BY COALESCE(updated_at, created_at, id) DESC`,
      )
      .all();
    return rows.map(row => this.sessionFromRow(row));
  }

  async syncSession(sessionId: string): Promise<SyncResult> {
    return await this.serialized(sessionId, async () => {
      this.assertOpen();
      return await this.syncSessionUnlocked(sessionId);
    });
  }

  /** Import or refresh all direct session directories without deleting index rows. */
  async importFromDisk(): Promise<RebuildResult> {
    this.assertOpen();
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const sessionIds = await this.discoverSessionIds();
    const problems: JournalProblem[] = [];
    let eventCount = 0;
    for (const sessionId of sessionIds) {
      const result = await this.syncSession(sessionId);
      eventCount += result.eventCount;
      problems.push(...result.problems);
    }
    return { sessionCount: sessionIds.length, eventCount, problems };
  }

  /** Clear the disposable index and recreate it entirely from session files. */
  async rebuildIndex(): Promise<RebuildResult> {
    this.assertOpen();
    await this.waitForAppends();
    this.database.transaction(() => {
      this.database.exec('DELETE FROM events');
      this.database.exec('DELETE FROM sessions');
    })();
    this.lastSequences.clear();
    return await this.importFromDisk();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        status TEXT,
        created_at TEXT,
        updated_at TEXT,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        config_json TEXT,
        state_json TEXT,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS events_time_idx ON events(time);
      CREATE INDEX IF NOT EXISTS events_type_idx ON events(type);
      CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
    `);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('event store is closed');
  }

  private async serialized<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    validateSessionId(sessionId);
    const previous = this.appendQueues.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.appendQueues.set(sessionId, settled);
    try {
      return await result;
    } finally {
      if (this.appendQueues.get(sessionId) === settled) this.appendQueues.delete(sessionId);
    }
  }

  private async waitForAppends(): Promise<void> {
    while (this.appendQueues.size > 0) {
      await Promise.all([...this.appendQueues.values()]);
    }
  }

  private async lastSequence(sessionId: string): Promise<number> {
    const cached = this.lastSequences.get(sessionId);
    if (cached !== undefined) return cached;
    const scan = await scanJournal(this.eventsFile(sessionId), sessionId);
    const sequence = scan.events.at(-1)?.sequence ?? 0;
    this.lastSequences.set(sessionId, sequence);
    return sequence;
  }

  private insertEvent(event: SessionEvent): void {
    // Ensure the FK parent exists even when a caller appends before writing config.
    this.database
      .query(
        `INSERT INTO sessions (id, directory, last_sequence, indexed_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(id) DO NOTHING`,
      )
      .run(event.sessionId, this.sessionDirectory(event.sessionId), now());
    this.database
      .query(
        `INSERT INTO events (session_id, sequence, time, type, event_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, sequence) DO UPDATE SET
         time = excluded.time,
         type = excluded.type,
         event_json = excluded.event_json`,
      )
      .run(event.sessionId, event.sequence, event.time, event.type, JSON.stringify(event));
  }

  private async indexSessionMetadata(sessionId: string, knownLastSequence?: number): Promise<void> {
    const config = await readJsonIfPresent(this.configFile(sessionId));
    const state = await readJsonIfPresent(this.stateFile(sessionId));
    const lastSequence = knownLastSequence ?? (await this.lastSequence(sessionId));
    const status = stringField(state, 'status');
    const createdAt = stringField(config, 'createdAt') ?? stringField(state, 'startedAt');
    const updatedAt =
      stringField(config, 'updatedAt') ??
      stringField(state, 'finishedAt') ??
      stringField(state, 'lastActivityAt') ??
      createdAt;
    this.database
      .query(
        `INSERT INTO sessions (
         id, directory, status, created_at, updated_at, last_sequence,
         config_json, state_json, indexed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         directory = excluded.directory,
         status = excluded.status,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         last_sequence = excluded.last_sequence,
         config_json = excluded.config_json,
         state_json = excluded.state_json,
         indexed_at = excluded.indexed_at`,
      )
      .run(
        sessionId,
        this.sessionDirectory(sessionId),
        status ?? null,
        createdAt ?? null,
        updatedAt ?? null,
        lastSequence,
        config === undefined ? null : JSON.stringify(config),
        state === undefined ? null : JSON.stringify(state),
        now(),
      );
  }

  private async syncSessionUnlocked(sessionId: string): Promise<SyncResult> {
    const scan = await scanJournal(this.eventsFile(sessionId), sessionId);
    const lastSequence = scan.events.at(-1)?.sequence ?? 0;
    this.database.transaction(() => {
      this.database.query('DELETE FROM events WHERE session_id = ?').run(sessionId);
      // Parent must exist before journal rows because foreign keys are enabled.
      this.database
        .query(
          `INSERT INTO sessions (id, directory, last_sequence, indexed_at)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(id) DO NOTHING`,
        )
        .run(sessionId, this.sessionDirectory(sessionId), now());
      for (const event of scan.events) this.insertEvent(event);
    })();
    this.lastSequences.set(sessionId, lastSequence);
    await this.indexSessionMetadata(sessionId, lastSequence);
    return {
      sessionId,
      eventCount: scan.events.length,
      lastSequence,
      problems: scan.problems,
    };
  }

  private async discoverSessionIds(): Promise<string[]> {
    const entries = await readdir(this.home, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const sessions: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name) || RESERVED_DIRECTORIES.has(entry.name)) continue;
      const directory = path.join(this.home, entry.name);
      const hasSessionArtifact = ['config.json', 'state.json', 'events.jsonl'].some(file =>
        existsSync(path.join(directory, file)),
      );
      if (hasSessionArtifact) sessions.push(entry.name);
    }
    return sessions.sort();
  }

  private sessionFromRow(row: SessionRow): IndexedSession {
    return {
      id: row.id,
      directory: row.directory,
      status: row.status ?? undefined,
      createdAt: row.created_at ?? undefined,
      updatedAt: row.updated_at ?? undefined,
      lastSequence: row.last_sequence,
      config: row.config_json === null ? undefined : JSON.parse(row.config_json),
      state: row.state_json === null ? undefined : JSON.parse(row.state_json),
    };
  }
}
