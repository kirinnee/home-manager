import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from 'fs';
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
  /** Events SCANNED during this sync — 0 when the journal was unchanged. */
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

/** Pointer-index schema generation. Version 2 replaced the fat `event_json`
 *  payload column with byte offsets into each session's own events.jsonl —
 *  the journal files are authoritative and the DB is derived, so an older
 *  database is simply deleted and rebuilt as the lean index (that one-time
 *  rebuild also collapses the multi-GB v1 file + WAL). */
const SCHEMA_VERSION = 2;

interface EventPointerRow {
  byte_offset: number;
  byte_length: number;
  sequence: number;
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

interface JournalSyncRow {
  last_sequence: number;
  journal_size: number | null;
  journal_mtime_ms: number | null;
}

interface ScannedEvent {
  event: SessionEvent;
  /** Byte offset of the event's JSON line within the journal file. */
  offset: number;
  /** Byte length of the JSON line, excluding the trailing newline. */
  length: number;
}

interface JournalScan {
  events: ScannedEvent[];
  problems: JournalProblem[];
  /** Absolute byte offset the scan consumed up to (= file size). */
  scannedTo: number;
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

/** Read a file's bytes from `offset` to EOF. Undefined when the file is missing. */
async function readBytesFrom(file: string, offset: number): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.size <= offset) return Buffer.alloc(0);
    const buffer = Buffer.alloc(info.size - offset);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/** Scan journal lines starting at a byte offset, tracking each event's byte
 *  position so the index can point back into the file instead of copying the
 *  payload. `fromSequence` continues monotonicity checks across an
 *  incremental (tail) scan. Line numbers in problems are relative to the
 *  scanned chunk when `fromOffset` > 0. */
function scanBuffer(
  buffer: Buffer,
  file: string,
  expectedSessionId: string,
  fromOffset = 0,
  fromSequence = 0,
): JournalScan {
  const events: ScannedEvent[] = [];
  const problems: JournalProblem[] = [];
  let lastSequence = fromSequence;
  let lineStart = 0;
  let lineNumber = 0;

  for (let index = 0; index <= buffer.length; index++) {
    if (index !== buffer.length && buffer[index] !== 0x0a) continue;
    const lineBytes = index - lineStart;
    lineNumber++;
    const start = lineStart;
    lineStart = index + 1;
    if (lineBytes === 0) continue;
    const text = buffer.toString('utf8', start, start + lineBytes);
    if (text.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      problems.push({ file, line: lineNumber, message: 'invalid JSON event record' });
      continue;
    }
    const event = parseEvent(parsed, expectedSessionId);
    if (!event) {
      problems.push({ file, line: lineNumber, message: 'invalid event schema or session id' });
      continue;
    }
    if (event.sequence <= lastSequence) {
      problems.push({
        file,
        line: lineNumber,
        message: `event sequence ${event.sequence} is not greater than ${lastSequence}`,
      });
      continue;
    }
    events.push({ event, offset: fromOffset + start, length: lineBytes });
    lastSequence = event.sequence;
  }
  return { events, problems, scannedTo: fromOffset + buffer.length };
}

async function scanJournal(
  file: string,
  expectedSessionId: string,
  fromOffset = 0,
  fromSequence = 0,
): Promise<JournalScan> {
  const buffer = await readBytesFrom(file, fromOffset);
  if (buffer === undefined) return { events: [], problems: [], scannedTo: fromOffset };
  return scanBuffer(buffer, file, expectedSessionId, fromOffset, fromSequence);
}

/**
 * Durable event journal plus a rebuildable SQLite POINTER index.
 *
 * Event JSONL and config/state documents are authoritative. SQLite stores only
 * session metadata and per-event byte offsets into each session's journal —
 * never the payload — and may always be discarded and rebuilt. Replay resolves
 * payloads by reading the journal file at the recorded offsets.
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
    this.database = this.openDatabase();
  }

  /** Open the index, refusing any database whose schema generation is not
   *  SCHEMA_VERSION. Fresh-slate ship decision (2026-07-22): there is NO
   *  automatic v1→v2 migration — the legacy fat DB is deleted operationally
   *  at ship time and boot builds the pointer index from session journals.
   *  An unexpected on-disk generation is an operator error, not something to
   *  silently rebuild over. */
  private openDatabase(): Database {
    const database = new Database(this.databasePath, { create: true, strict: true });
    const version = (
      database.query<{ user_version: number }, []>('PRAGMA user_version').get() as {
        user_version: number;
      }
    ).user_version;
    if (version !== SCHEMA_VERSION) {
      const hasTables =
        database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().length > 0;
      if (hasTables) {
        database.close();
        throw new Error(
          `kteam.sqlite has schema generation ${version}, expected ${SCHEMA_VERSION}; ` +
            'delete the old database file (it is a disposable index — journals are authoritative) and restart',
        );
      }
    }
    chmodSync(this.databasePath, 0o600);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        status TEXT,
        created_at TEXT,
        updated_at TEXT,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        config_json TEXT,
        state_json TEXT,
        journal_size INTEGER,
        journal_mtime_ms INTEGER,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        PRIMARY KEY (session_id, sequence),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS events_time_idx ON events(time);
      CREATE INDEX IF NOT EXISTS events_type_idx ON events(type);
      CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
    `);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return database;
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
      const size = (await stat(file).catch(() => undefined))?.size ?? 0;
      const needsNewline = size > 0 && (await this.lastByteIsNewline(file, size)) === false;
      const line = JSON.stringify(event);
      const offset = size + (needsNewline ? 1 : 0);
      const length = Buffer.byteLength(line, 'utf8');
      const handle = await open(file, 'a', 0o600);
      let journal: { size: number; mtimeMs: number };
      try {
        await handle.write(`${needsNewline ? '\n' : ''}${line}\n`, undefined, 'utf8');
        await handle.sync();
        const info = await handle.stat();
        journal = { size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
      } finally {
        await handle.close();
      }

      // From this point onward the append succeeded even if the disposable index
      // is later lost. Index synchronously so replay is immediately consistent.
      this.lastSequences.set(sessionId, event.sequence);
      this.insertEvent(event, offset, length);
      await this.indexSessionMetadata(sessionId, event.sequence, journal);
      return event;
    });
  }

  private async lastByteIsNewline(file: string, size: number): Promise<boolean> {
    const handle = await open(file, 'r');
    try {
      const byte = new Uint8Array(1);
      await handle.read(byte, 0, 1, size - 1);
      return byte[0] === 0x0a;
    } finally {
      await handle.close();
    }
  }

  replay(sessionId: string, options: ReplayOptions = {}): SessionEvent[] {
    validateSessionId(sessionId);
    this.assertOpen();
    const after = options.afterSequence ?? 0;
    const limit = options.limit ?? 10_000;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('afterSequence must be a non-negative integer');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    const first = this.replayFromIndex(sessionId, after, limit);
    if (first.ok) return first.events;
    // Pointer/identity mismatch: the journal was rewritten or truncated under
    // the index. Re-index THIS session from its journal synchronously and
    // serve from the fresh rows — never a wrong-but-parseable event.
    this.reindexSessionSync(sessionId);
    const second = this.replayFromIndex(sessionId, after, limit);
    if (second.ok) return second.events;
    throw new Error(
      `event index for ${sessionId} is inconsistent with its journal even after re-indexing (${second.mismatch})`,
    );
  }

  /** Read pointer rows and resolve payloads, verifying each parsed record's
   *  IDENTITY (schema, session id, sequence) against its pointer row. A
   *  journal rewrite can leave a different-but-valid event at a recorded
   *  offset — silently serving it corrupted replay history (review P1). */
  private replayFromIndex(
    sessionId: string,
    after: number,
    limit: number,
  ): { ok: true; events: SessionEvent[] } | { ok: false; mismatch: string } {
    const rows = this.database
      .query<EventPointerRow, [string, number, number]>(
        `SELECT byte_offset, byte_length, sequence
         FROM events
        WHERE session_id = ? AND sequence > ?
        ORDER BY sequence ASC
        LIMIT ?`,
      )
      .all(sessionId, after, limit);
    if (rows.length === 0) return { ok: true, events: [] };
    // A missing journal (archived/removed session data) degrades to an empty
    // replay rather than an error — the index rows are then dangling pointers
    // kept only for metadata.
    let descriptor: number;
    try {
      descriptor = openSync(this.eventsFile(sessionId), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, events: [] };
      throw error;
    }
    try {
      const events: SessionEvent[] = [];
      for (const row of rows) {
        const buffer = Buffer.alloc(row.byte_length);
        const read = readSync(descriptor, buffer, 0, row.byte_length, row.byte_offset);
        if (read !== row.byte_length) return { ok: false, mismatch: `short read at #${row.sequence}` };
        let parsed: unknown;
        try {
          parsed = JSON.parse(buffer.toString('utf8', 0, read));
        } catch {
          return { ok: false, mismatch: `unparseable bytes at #${row.sequence}` };
        }
        const event = parseEvent(parsed, sessionId);
        if (!event || event.sequence !== row.sequence) {
          return { ok: false, mismatch: `identity mismatch at #${row.sequence}` };
        }
        events.push(event);
      }
      return { ok: true, events };
    } finally {
      closeSync(descriptor);
    }
  }

  /** Synchronously rebuild one session's pointer rows from its journal —
   *  the mismatch-recovery path for replay(), which is a sync API. */
  private reindexSessionSync(sessionId: string): void {
    let buffer: Buffer;
    try {
      buffer = readFileSync(this.eventsFile(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      buffer = Buffer.alloc(0);
    }
    const scan = scanBuffer(buffer, this.eventsFile(sessionId), sessionId);
    this.database.transaction(() => {
      this.database.query('DELETE FROM events WHERE session_id = ?').run(sessionId);
      this.ensureSessionRow(sessionId);
      for (const scanned of scan.events) this.insertEvent(scanned.event, scanned.offset, scanned.length);
    })();
    this.lastSequences.set(sessionId, scan.events.at(-1)?.event.sequence ?? 0);
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

  /** Import or refresh all direct session directories without deleting index rows.
   *  Incremental: a session whose journal stat (size + mtime) matches the indexed
   *  values skips the event scan entirely, so a warm boot touches only deltas. */
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
    const indexed = this.database
      .query<
        JournalSyncRow,
        [string]
      >('SELECT last_sequence, journal_size, journal_mtime_ms FROM sessions WHERE id = ?')
      .get(sessionId);
    if (indexed) {
      const info = await stat(this.eventsFile(sessionId)).catch(() => undefined);
      const size = info?.size ?? 0;
      if (size === (indexed.journal_size ?? -1)) {
        this.lastSequences.set(sessionId, indexed.last_sequence);
        return indexed.last_sequence;
      }
    }
    const scan = await scanJournal(this.eventsFile(sessionId), sessionId);
    const sequence = scan.events.at(-1)?.event.sequence ?? 0;
    this.lastSequences.set(sessionId, sequence);
    return sequence;
  }

  private insertEvent(event: SessionEvent, offset: number, length: number): void {
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
        `INSERT INTO events (session_id, sequence, time, type, byte_offset, byte_length)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, sequence) DO UPDATE SET
         time = excluded.time,
         type = excluded.type,
         byte_offset = excluded.byte_offset,
         byte_length = excluded.byte_length`,
      )
      .run(event.sessionId, event.sequence, event.time, event.type, offset, length);
  }

  private async indexSessionMetadata(
    sessionId: string,
    knownLastSequence?: number,
    journal?: { size: number; mtimeMs: number },
  ): Promise<void> {
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
         config_json, state_json, journal_size, journal_mtime_ms, indexed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         directory = excluded.directory,
         status = excluded.status,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         last_sequence = excluded.last_sequence,
         config_json = excluded.config_json,
         state_json = excluded.state_json,
         journal_size = COALESCE(excluded.journal_size, sessions.journal_size),
         journal_mtime_ms = COALESCE(excluded.journal_mtime_ms, sessions.journal_mtime_ms),
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
        journal?.size ?? null,
        journal?.mtimeMs ?? null,
        now(),
      );
  }

  private async syncSessionUnlocked(sessionId: string): Promise<SyncResult> {
    const file = this.eventsFile(sessionId);
    const info = await stat(file).catch(() => undefined);
    const indexed = this.database
      .query<
        JournalSyncRow,
        [string]
      >('SELECT last_sequence, journal_size, journal_mtime_ms FROM sessions WHERE id = ?')
      .get(sessionId);

    // No journal on disk: an archived or config-only session. Keep any indexed
    // rows (metadata stays browsable; replay degrades to empty) and refresh
    // the config/state columns.
    if (!info) {
      const lastSequence = indexed?.last_sequence ?? 0;
      this.ensureSessionRow(sessionId);
      this.lastSequences.set(sessionId, lastSequence);
      await this.indexSessionMetadata(sessionId, lastSequence);
      return { sessionId, eventCount: 0, lastSequence, problems: [] };
    }

    const mtimeMs = Math.trunc(info.mtimeMs);
    // Unchanged journal (size + mtime match the index): skip the event scan —
    // this is what turns a warm boot from a full-history reimport into a stat.
    if (indexed && indexed.journal_size === info.size && indexed.journal_mtime_ms === mtimeMs) {
      this.lastSequences.set(sessionId, indexed.last_sequence);
      await this.indexSessionMetadata(sessionId, indexed.last_sequence, { size: info.size, mtimeMs });
      return { sessionId, eventCount: 0, lastSequence: indexed.last_sequence, problems: [] };
    }

    // Grown journal: scan only the appended tail. Any problem in the tail
    // (sequence regression, torn write) falls back to a full rescan below —
    // correctness beats the saved read.
    if (
      indexed &&
      indexed.journal_size !== null &&
      indexed.journal_size > 0 &&
      info.size > indexed.journal_size &&
      indexed.last_sequence > 0
    ) {
      const tail = await scanJournal(file, sessionId, indexed.journal_size, indexed.last_sequence);
      if (tail.problems.length === 0) {
        const lastSequence = tail.events.at(-1)?.event.sequence ?? indexed.last_sequence;
        this.database.transaction(() => {
          this.ensureSessionRow(sessionId);
          for (const scanned of tail.events) this.insertEvent(scanned.event, scanned.offset, scanned.length);
        })();
        this.lastSequences.set(sessionId, lastSequence);
        await this.indexSessionMetadata(sessionId, lastSequence, { size: info.size, mtimeMs });
        return { sessionId, eventCount: tail.events.length, lastSequence, problems: [] };
      }
    }

    // Full scan: new session, shrunk/rewritten journal, or a dirty tail.
    const scan = await scanJournal(file, sessionId);
    const lastSequence = scan.events.at(-1)?.event.sequence ?? 0;
    this.database.transaction(() => {
      this.database.query('DELETE FROM events WHERE session_id = ?').run(sessionId);
      // Parent must exist before journal rows because foreign keys are enabled.
      this.ensureSessionRow(sessionId);
      for (const scanned of scan.events) this.insertEvent(scanned.event, scanned.offset, scanned.length);
    })();
    this.lastSequences.set(sessionId, lastSequence);
    await this.indexSessionMetadata(sessionId, lastSequence, { size: info.size, mtimeMs });
    return {
      sessionId,
      eventCount: scan.events.length,
      lastSequence,
      problems: scan.problems,
    };
  }

  private ensureSessionRow(sessionId: string): void {
    this.database
      .query(
        `INSERT INTO sessions (id, directory, last_sequence, indexed_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(id) DO NOTHING`,
      )
      .run(sessionId, this.sessionDirectory(sessionId), now());
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
