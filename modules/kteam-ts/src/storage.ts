import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from 'fs';
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

/** Retention policy for the hot-store archival pass (B3). Storage owns the
 *  mechanism (which rows leave the cache); the caller owns the policy inputs —
 *  crucially `isProtected`, since only the session manager knows which sessions
 *  are warden targets or have a live monitor and must never be archived. */
export interface ArchivalPolicy {
  /** Terminal sessions whose last activity is older than this many days are
   *  archived. `<= 0` disables the pass entirely (returns no candidates). */
  retentionDays: number;
  /** Injectable wall-clock 'now' in ms for the age cutoff. Defaults to Date.now(). */
  nowMs?: number;
  /** Status values that count as terminal. Defaults to the session manager's
   *  terminal set (completed/failed/stalled/stopped). */
  terminalStatuses?: readonly string[];
  /** Never-archive predicate supplied by the caller: warden targets, sessions
   *  with a live monitor, or anything else the daemon still holds. */
  isProtected?: (id: string) => boolean;
  /** Cap on how many sessions a single pass archives, so retention never
   *  competes with launches or event delivery. Defaults to 50. */
  limit?: number;
}

const DEFAULT_TERMINAL_STATUSES: readonly string[] = ['completed', 'failed', 'stalled', 'stopped'];

/** Pointer-index schema generation.
 *
 *  v2 replaced the fat `event_json` payload column with byte offsets into each
 *  session's own events.jsonl. v3 DROPPED `global_sequence`: a single
 *  fleet-wide counter forced every event of every session through one
 *  serialized chain (plus an atomic file write per event) to hand out numbers
 *  that only the id-less `kteam stream` ever read. Sessions are independent —
 *  per-session `sequence` is the authoritative order, and the fleet view is
 *  merged by TIME at read time off `events_fleet_idx`.
 *
 *  v4 added `chat_pointers`: harness-derived chat records are INDEXED where the
 *  harness already wrote them instead of being re-encoded into events.jsonl and
 *  chat.jsonl. One real session held 8.2 MB of events.jsonl + 6.2 MB of
 *  chat.jsonl against a 9.6 MB harness transcript — 14 MB of derived copies of
 *  a file we already have. Now kteam journals only what the harness does NOT
 *  record (its own control/lifecycle events) and transforms the rest on read.
 *
 *  The journals are authoritative and the DB is derived, so a database from an
 *  older generation is deleted and rebuilt rather than migrated. */
const SCHEMA_VERSION = 4;

interface EventPointerRow {
  byte_offset: number;
  byte_length: number;
  sequence: number;
}

interface FleetPointerRow extends EventPointerRow {
  session_id: string;
  time: string;
}

/** Cursor into the time-merged fleet feed. Ordering key is
 *  (time, session_id, sequence) — `time` alone is not unique across sessions,
 *  and a cursor that could not break a tie would drop or repeat events. */
export interface FleetCursor {
  time: string;
  sessionId: string;
  sequence: number;
}

/** One page of the cross-session feed: the events that RESOLVED, plus how many
 *  index rows the page covered and the cursor it reached. */
export interface FleetPage {
  events: SessionEvent[];
  rows: number;
  cursor?: FleetCursor;
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

export interface ChatPointerRow {
  ordinal: number;
  time: string;
  type: string;
  turn: number;
  source_file: string;
  byte_offset: number;
  byte_length: number;
  record_index: number;
  event_fingerprint: string;
}

/** Strong identity for one normalized harness event. A type check alone is
 *  insufficient: after compaction, a different assistant-text record can sit
 *  at the exact same offset and length. */
export function chatEventFingerprint(event: unknown): string {
  const encoded = JSON.stringify(event);
  if (encoded === undefined) throw new TypeError('chat event is not JSON serializable');
  return createHash('sha256').update(encoded).digest('base64url');
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
/** Directories that live in the kteam home but are NOT sessions.
 *
 *  `SESSION_ID` accepts any ordinary directory name, so anything the daemon
 *  keeps beside its sessions would otherwise be scanned as one — and a session
 *  could be created with that name and collide with it. `models` joined this
 *  list when speech-to-text began storing model weights under
 *  `~/.kteam/models`: nothing misdetects today, but the namespace is shared and
 *  the failure would be silent. Anything else the daemon parks here belongs
 *  here too. */
const RESERVED_DIRECTORIES = new Set(['daemon', 'trash', 'models']);

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
  /** Parsed session metadata, served instead of re-querying + re-parsing the
   *  whole `sessions` table. `listSessions()` used to cost ~150 ms per call on
   *  a 1000-session fleet (an 80 ms indexed scan of ~16 MB of config/state
   *  blobs plus a 67 ms JSON.parse of all of them) and sits behind
   *  `resolveRef()` — i.e. behind EVERY session operation, including each
   *  monitor tick. That one query was the daemon's 87%-CPU burner. The daemon
   *  is the only writer of this database, so an in-process cache is
   *  authoritative between writes. */
  private readonly sessionCache = new Map<string, IndexedSession>();
  /** Ids of sessions archived out of the hot cache (B3). An in-process mirror of
   *  the `archived_sessions` table so the hot write path can tell in O(1) whether
   *  a metadata write needs to clear a persisted archive marker, without a DB
   *  round-trip on every index. */
  private readonly archivedIds = new Set<string>();
  /** Journal tail state per session, so a warm append skips the stat + the
   *  last-byte read it used to pay on every single event. */
  private readonly journalTails = new Map<string, { size: number; endsWithNewline: boolean }>();
  /** Session directories this process has already created. */
  private readonly knownDirectories = new Set<string>();
  private closed = false;

  private constructor(home: string, databasePath: string) {
    this.home = path.resolve(home);
    this.databasePath = path.resolve(databasePath);
    mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.database = this.openDatabase();
    this.loadSessionCache();
  }

  /** Fill the metadata cache from the index in ONE query, EXCLUDING archived
   *  sessions (B3) — the whole point of archival is to keep them off the hot
   *  path, so the boot-time parse never pays for aged terminal history. */
  private loadSessionCache(): void {
    this.sessionCache.clear();
    this.archivedIds.clear();
    for (const { id } of this.database.query<{ id: string }, []>(`SELECT id FROM archived_sessions`).all()) {
      this.archivedIds.add(id);
    }
    const rows = this.database
      .query<
        SessionRow,
        []
      >(`SELECT id, directory, status, created_at, updated_at, last_sequence, config_json, state_json FROM sessions WHERE id NOT IN (SELECT id FROM archived_sessions)`)
      .all();
    for (const row of rows) {
      try {
        this.sessionCache.set(row.id, this.sessionFromRow(row));
      } catch {
        // A row with unparseable JSON is skipped, not fatal: the journals are
        // authoritative and syncSession rewrites it on the next import.
      }
    }
  }

  /** Open the index, DISCARDING any database from another schema generation.
   *  This file holds nothing that is not derivable from the session journals
   *  (metadata + byte offsets), so rebuilding is always safe and is strictly
   *  better than the old behaviour of refusing to boot and asking an operator
   *  to delete the file by hand. */
  private openDatabase(): Database {
    let database = new Database(this.databasePath, { create: true, strict: true });
    const version = (
      database.query<{ user_version: number }, []>('PRAGMA user_version').get() as {
        user_version: number;
      }
    ).user_version;
    // v3 → v4 is additive (chat_pointers only), so keep the expensive event
    // pointer index in place. On the measured 707-session / 961 MB store,
    // throwing v3 away made this rollout spend 23.5 s rebuilding bytes that
    // are unchanged. Older/unknown generations still take the proven clean
    // rebuild path below.
    const canMigrateInPlace = version === 3 && SCHEMA_VERSION === 4;
    if (version !== SCHEMA_VERSION && !canMigrateInPlace) {
      const hasTables =
        database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().length > 0;
      if (hasTables) {
        database.close();
        console.error(
          `kteamd: kteam.sqlite is schema generation ${version}, expected ${SCHEMA_VERSION}; ` +
            'discarding the disposable pointer index and rebuilding it from the journals',
        );
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${this.databasePath}${suffix}`, { force: true });
        database = new Database(this.databasePath, { create: true, strict: true });
      }
    }
    chmodSync(this.databasePath, 0o600);
    database.exec('PRAGMA journal_mode = WAL');
    // The JSONL journal is fsynced first and is authoritative; SQLite stores
    // disposable byte pointers. FULL made every event pay two additional DB
    // syncs (measured total: 3.01 fsync/event). WAL+NORMAL remains
    // crash-consistent while allowing the index to be rebuilt after lost
    // recent transactions, leaving the one durability sync that matters.
    database.exec('PRAGMA synchronous = NORMAL');
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
      CREATE INDEX IF NOT EXISTS events_type_idx ON events(type);
      CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
      CREATE TABLE IF NOT EXISTS chat_pointers (
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        turn INTEGER NOT NULL,
        /** The HARNESS's own transcript file — kteam never wrote these bytes. */
        source_file TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        /** Which normalized event within that one JSONL record (an assistant
         *  message with three content blocks yields three). */
        record_index INTEGER NOT NULL,
        /** SHA-256 of the exact normalized event. Type alone cannot detect a
         *  same-shaped record moved into this offset by compaction. */
        event_fingerprint TEXT NOT NULL,
        PRIMARY KEY (session_id, ordinal)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS chat_pointer_identity_idx
        ON chat_pointers(session_id, source_file, byte_offset, record_index, event_fingerprint);
      CREATE TABLE IF NOT EXISTS chat_sources (
        session_id TEXT NOT NULL,
        source_file TEXT NOT NULL,
        device TEXT NOT NULL,
        inode TEXT NOT NULL,
        source_size INTEGER NOT NULL,
        source_mtime_ms INTEGER NOT NULL,
        pointer_count INTEGER NOT NULL,
        PRIMARY KEY (session_id, source_file),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      /** Hot-store retention (B3). A terminal session older than the retention
       *  window is ARCHIVED — its metadata row and journals stay on disk, but it
       *  is kept OUT of the in-process sessionCache so it no longer costs a parse
       *  at every boot nor a scan on every consistency sweep. This is purely a
       *  hot-path exclusion marker; it holds nothing that is not re-derivable, so
       *  it is intentionally NOT recreated by a journal rebuild (an un-archive on
       *  rebuild is harmless — the next retention pass re-archives). Additive via
       *  IF NOT EXISTS, so it needs no SCHEMA_VERSION bump and never forces the
       *  live store to rebuild. */
      CREATE TABLE IF NOT EXISTS archived_sessions (
        id TEXT PRIMARY KEY,
        archived_at TEXT NOT NULL,
        FOREIGN KEY (id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);
    // The fleet feed's ONLY ordering index. (time, session_id, sequence) is the
    // full ordering key, so the merged cross-session page is answered by an
    // index walk with no temp b-tree and no fleet-wide counter behind it.
    database.exec('CREATE INDEX IF NOT EXISTS events_fleet_idx ON events(time, session_id, sequence)');
    database.exec('DROP INDEX IF EXISTS events_time_idx');
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
      await this.indexSessionMetadata(sessionId, { config });
    });
  }

  /** Atomically read, transform, and replace one session config document. */
  async updateConfig<T>(sessionId: string, transform: (current: T) => T | Promise<T>): Promise<T> {
    return await this.serialized(sessionId, async () => {
      const current = await readJsonFile<T>(this.configFile(sessionId));
      const next = await transform(current);
      await writeJsonAtomic(this.configFile(sessionId), next);
      await this.indexSessionMetadata(sessionId, { config: next });
      return next;
    });
  }

  async writeState(sessionId: string, state: unknown): Promise<void> {
    await this.serialized(sessionId, async () => {
      await writeJsonAtomic(this.stateFile(sessionId), state);
      await this.indexSessionMetadata(sessionId, { state });
    });
  }

  /** Atomically read, transform, and replace one session state document. */
  async updateState<T>(sessionId: string, transform: (current: T) => T | Promise<T>): Promise<T> {
    return await this.serialized(sessionId, async () => {
      const current = await readJsonFile<T>(this.stateFile(sessionId));
      const next = await transform(current);
      await writeJsonAtomic(this.stateFile(sessionId), next);
      await this.indexSessionMetadata(sessionId, { state: next });
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
      if (!this.knownDirectories.has(sessionId)) {
        await mkdir(this.sessionDirectory(sessionId), { recursive: true, mode: 0o700 });
        this.knownDirectories.add(sessionId);
      }
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
      // Warm path: this process appended to the journal already, so its size and
      // trailing byte are known. The cold path pays the stat + one-byte read
      // exactly once per session per daemon lifetime instead of per event.
      let tail = this.journalTails.get(sessionId);
      if (!tail) {
        const size = (await stat(file).catch(() => undefined))?.size ?? 0;
        tail = { size, endsWithNewline: size === 0 || (await this.lastByteIsNewline(file, size)) };
      }
      const needsNewline = !tail.endsWithNewline;
      const line = JSON.stringify(event);
      const offset = tail.size + (needsNewline ? 1 : 0);
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
      this.journalTails.set(sessionId, { size: journal.size, endsWithNewline: true });

      // From this point onward the append succeeded even if the disposable index
      // is later lost. Index synchronously so replay is immediately consistent.
      this.lastSequences.set(sessionId, event.sequence);
      this.insertEvent(event, offset, length);
      // Sequence/journal bump ONLY. Re-reading config.json + state.json and
      // re-serializing both into the index on every event was pure waste: a
      // config is ~44 KB on a codex session (harnessSessionBaseline), so a
      // chatty turn rewrote megabytes of unchanged blob per second.
      this.indexJournalProgress(sessionId, event.sequence, journal);
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
    this.reindexSessionFromBuffer(sessionId, buffer);
  }

  /** Replace one session's pointer rows from journal bytes already in hand. */
  private reindexSessionFromBuffer(sessionId: string, buffer: Buffer): void {
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
    return this.sessionCache.get(sessionId);
  }

  /** All indexed sessions, newest activity first. Served from the in-process
   *  cache — see `sessionCache`. This is on the hot path of literally every
   *  session operation (`resolveRef`), so it must never touch the database. */
  listSessions(): IndexedSession[] {
    this.assertOpen();
    return [...this.sessionCache.values()].sort((left, right) => {
      const a = left.updatedAt ?? left.createdAt ?? left.id;
      const b = right.updatedAt ?? right.createdAt ?? right.id;
      return a < b ? 1 : a > b ? -1 : 0;
    });
  }

  /** Drop a removed session from the index and the cache. Without this the
   *  index kept a row (and the cache an entry) for every session ever removed
   *  — the live fleet carried 1036 rows against 700 directories on disk. */
  forgetSession(sessionId: string): void {
    validateSessionId(sessionId);
    this.assertOpen();
    this.database.query('DELETE FROM chat_pointers WHERE session_id = ?').run(sessionId);
    this.database.query('DELETE FROM chat_sources WHERE session_id = ?').run(sessionId);
    // archived_sessions.id CASCADEs off sessions, but the pragma only fires when
    // enabled for THIS connection — delete explicitly so the mirror stays exact.
    this.database.query('DELETE FROM archived_sessions WHERE id = ?').run(sessionId);
    this.database.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    this.sessionCache.delete(sessionId);
    this.archivedIds.delete(sessionId);
    this.lastSequences.delete(sessionId);
    this.journalTails.delete(sessionId);
    this.knownDirectories.delete(sessionId);
  }

  /** Is this session currently archived out of the hot cache? (B3) */
  isArchived(sessionId: string): boolean {
    this.assertOpen();
    return this.archivedIds.has(sessionId);
  }

  /** Ids of every archived session, for `kteam ps -a` and diagnostics. (B3) */
  archivedSessionIds(): string[] {
    this.assertOpen();
    return [...this.archivedIds].sort();
  }

  /** Archive one terminal session: keep its row and journals on disk but drop it
   *  from the hot cache so it stops costing a parse per boot and a scan per
   *  sweep. Returns false (a no-op) if the session is unknown or already gone —
   *  callers decide the policy; this is only the mechanism. (B3) */
  archiveSession(sessionId: string): boolean {
    validateSessionId(sessionId);
    this.assertOpen();
    const known = this.database.query<{ id: string }, [string]>('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!known) return false;
    this.database
      .query('INSERT INTO archived_sessions (id, archived_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
      .run(sessionId, now());
    this.archivedIds.add(sessionId);
    this.sessionCache.delete(sessionId);
    return true;
  }

  /** Bring an archived session back into the hot cache from its persisted row.
   *  Idempotent; returns false if the session was not archived. (B3) */
  unarchiveSession(sessionId: string): boolean {
    validateSessionId(sessionId);
    this.assertOpen();
    if (!this.archivedIds.delete(sessionId)) return false;
    this.database.query('DELETE FROM archived_sessions WHERE id = ?').run(sessionId);
    const row = this.database
      .query<
        SessionRow,
        [string]
      >(`SELECT id, directory, status, created_at, updated_at, last_sequence, config_json, state_json FROM sessions WHERE id = ?`)
      .get(sessionId);
    if (row) {
      try {
        this.sessionCache.set(sessionId, this.sessionFromRow(row));
      } catch {
        // Unparseable row: leave it out of the cache; a syncSession rewrites it.
      }
    }
    return true;
  }

  /** Resolve a session by id whether or not it is archived, un-archiving it as a
   *  side effect (the "lazy-load on demand" contract for `resolveRef`/`resume`:
   *  touching an archived session revives it). Live sessions come straight from
   *  the cache; an archived one is read from its persisted row. (B3) */
  resolveIncludingArchived(sessionId: string): IndexedSession | undefined {
    validateSessionId(sessionId);
    this.assertOpen();
    const live = this.sessionCache.get(sessionId);
    if (live) return live;
    if (!this.archivedIds.has(sessionId)) return undefined;
    this.unarchiveSession(sessionId);
    return this.sessionCache.get(sessionId);
  }

  /** The retention pass (B3). Archive terminal sessions whose last activity is
   *  older than `retentionDays`, skipping anything the caller marks protected
   *  (warden targets, live monitors) and anything younger than the window.
   *  Oldest-first up to `limit`. Returns the ids it archived. A `retentionDays`
   *  of `<= 0` disables it (returns []), which is how the feature ships OFF by
   *  default. Only ever moves cache membership — never deletes data. */
  archiveStaleTerminalSessions(policy: ArchivalPolicy): string[] {
    this.assertOpen();
    if (!(policy.retentionDays > 0)) return [];
    const nowMs = policy.nowMs ?? Date.now();
    const cutoffMs = nowMs - policy.retentionDays * 86_400_000;
    const terminal = new Set(policy.terminalStatuses ?? DEFAULT_TERMINAL_STATUSES);
    const limit = policy.limit ?? 50;
    const candidates: { id: string; ageKey: number }[] = [];
    for (const session of this.sessionCache.values()) {
      if (!session.status || !terminal.has(session.status)) continue;
      if (policy.isProtected?.(session.id)) continue;
      const stamp = session.updatedAt ?? session.createdAt;
      const stampMs = stamp ? Date.parse(stamp) : NaN;
      // No parseable activity stamp ⇒ cannot prove it is old ⇒ never archive.
      if (!Number.isFinite(stampMs) || stampMs >= cutoffMs) continue;
      candidates.push({ id: session.id, ageKey: stampMs });
    }
    candidates.sort((a, b) => a.ageKey - b.ageKey);
    const archived: string[] = [];
    for (const candidate of candidates) {
      if (archived.length >= limit) break;
      if (this.archiveSession(candidate.id)) archived.push(candidate.id);
    }
    return archived;
  }

  /** Bounded CROSS-SESSION feed, merged by TIME at read time.
   *
   *  There is no fleet-wide counter behind this any more. Sessions are
   *  independent: each journal is append-only and its own `sequence` is the
   *  authoritative order, and `events_fleet_idx (time, session_id, sequence)`
   *  merges them on demand. What this gives up is a dense total order across
   *  sessions — cross-session ordering is now by wall-clock timestamp, with
   *  (session_id, sequence) breaking ties deterministically. Nothing consumed
   *  the old total order: every UI/CLI reader is per-session except the id-less
   *  `kteam stream`, which only wants "recent, then live".
   *
   *  Rows whose journal bytes no longer match their pointer are re-indexed
   *  once and then skipped: one rewritten journal must never wedge the feed. */
  replayFleet(after: FleetCursor | undefined, limit: number): FleetPage {
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    const rows = after
      ? this.database
          .query<FleetPointerRow, [string, string, string, string, number, number]>(
            `SELECT session_id, sequence, time, byte_offset, byte_length
               FROM events
              WHERE time > ? OR (time = ? AND (session_id > ? OR (session_id = ? AND sequence > ?)))
              ORDER BY time ASC, session_id ASC, sequence ASC
              LIMIT ?`,
          )
          .all(after.time, after.time, after.sessionId, after.sessionId, after.sequence, limit)
      : this.database
          .query<FleetPointerRow, [number]>(
            `SELECT session_id, sequence, time, byte_offset, byte_length
               FROM events
              ORDER BY time ASC, session_id ASC, sequence ASC
              LIMIT ?`,
          )
          .all(limit);
    // ROWS, not resolved events: a row this scan had to skip (torn journal
    // line, missing file) must not read as "end of backlog" to a paging
    // caller, or the rest of the replay is silently truncated.
    const last = rows.at(-1);
    return {
      events: this.resolvePointerRows(rows),
      rows: rows.length,
      cursor: last ? { time: last.time, sessionId: last.session_id, sequence: last.sequence } : after,
    };
  }

  /** The most recent `limit` events across the whole fleet, oldest-first. */
  tailFleet(limit: number): SessionEvent[] {
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    const rows = this.database
      .query<FleetPointerRow, [number]>(
        `SELECT session_id, sequence, time, byte_offset, byte_length
           FROM events
          ORDER BY time DESC, session_id DESC, sequence DESC
          LIMIT ?`,
      )
      .all(limit);
    return this.resolvePointerRows(rows.reverse());
  }

  /** The most recent `limit` events of ONE session, oldest-first. */
  tailSession(sessionId: string, limit: number): SessionEvent[] {
    validateSessionId(sessionId);
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    const rows = this.database
      .query<FleetPointerRow, [string, number]>(
        `SELECT session_id, sequence, time, byte_offset, byte_length
           FROM events
          WHERE session_id = ?
          ORDER BY sequence DESC
          LIMIT ?`,
      )
      .all(sessionId, limit);
    return this.resolvePointerRows(rows.reverse());
  }

  // ── Harness-transcript chat pointers ──────────────────────────────────────
  //
  // kteam does not copy the harness's transcript. It records WHERE each chat
  // record lives in the harness's own file and re-normalizes on read, using the
  // same parsers the live watcher uses.
  //
  // DOCUMENTED TRADEOFF: the harness owns those files and may compact, rotate,
  // or delete them. Resolution therefore verifies identity (the bytes must
  // still parse into a record whose normalized event at `record_index` has the
  // recorded type) and SKIPS anything that no longer matches. If a harness file
  // disappears, that session's chat history is best-effort and may be short or
  // empty — kteam's own control/lifecycle journal is unaffected and remains
  // fully authoritative.

  /** Record pointer rows for the normalized events of ONE harness record. */
  appendChatPointers(
    sessionId: string,
    entries: readonly {
      time: string;
      type: string;
      turn: number;
      sourceFile: string;
      byteOffset: number;
      byteLength: number;
      recordIndex: number;
      fingerprint: string;
    }[],
  ): void {
    validateSessionId(sessionId);
    this.assertOpen();
    if (entries.length === 0) return;
    const insert = this.database.query(
      `INSERT INTO chat_pointers
         (session_id, ordinal, time, type, turn, source_file, byte_offset, byte_length, record_index, event_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    this.database.transaction(() => {
      this.ensureSessionRow(sessionId);
      let ordinal =
        this.database
          .query<
            { value: number },
            [string]
          >('SELECT COALESCE(MAX(ordinal), 0) AS value FROM chat_pointers WHERE session_id = ?')
          .get(sessionId)?.value ?? 0;
      for (const entry of entries) {
        const nextOrdinal = ordinal + 1;
        const result = insert.run(
          sessionId,
          nextOrdinal,
          entry.time,
          entry.type,
          entry.turn,
          entry.sourceFile,
          entry.byteOffset,
          entry.byteLength,
          entry.recordIndex,
          entry.fingerprint,
        );
        // A replayed transcript line hits the identity unique index and writes
        // nothing. Reuse that ordinal for the next genuinely-new record so
        // pagination remains dense.
        if (result.changes > 0) ordinal = nextOrdinal;
      }
    })();
  }

  chatPointerCount(sessionId: string): number {
    validateSessionId(sessionId);
    this.assertOpen();
    const row = this.database
      .query<{ value: number }, [string]>('SELECT COUNT(*) AS value FROM chat_pointers WHERE session_id = ?')
      .get(sessionId);
    return row?.value ?? 0;
  }

  /** Whether a previous complete reconstruction covered these exact harness
   *  bytes. This is a skip hint only: pointer resolution still verifies every
   *  event fingerprint before serving it. */
  chatSourceCurrent(
    sessionId: string,
    sourceFile: string,
    info: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number },
  ): boolean {
    validateSessionId(sessionId);
    this.assertOpen();
    const row = this.database
      .query<
        {
          device: string;
          inode: string;
          source_size: number;
          source_mtime_ms: number;
          pointer_count: number;
        },
        [string, string]
      >(
        `SELECT device, inode, source_size, source_mtime_ms, pointer_count
           FROM chat_sources WHERE session_id = ? AND source_file = ?`,
      )
      .get(sessionId, sourceFile);
    if (
      !row ||
      row.device !== info.dev.toString() ||
      row.inode !== info.ino.toString() ||
      row.source_size !== info.size ||
      row.source_mtime_ms !== Math.trunc(info.mtimeMs)
    )
      return false;
    const actual =
      this.database
        .query<
          { value: number },
          [string, string]
        >('SELECT COUNT(*) AS value FROM chat_pointers WHERE session_id = ? AND source_file = ?')
        .get(sessionId, sourceFile)?.value ?? 0;
    return actual >= row.pointer_count;
  }

  chatSourceKnown(sessionId: string, sourceFile: string): boolean {
    validateSessionId(sessionId);
    this.assertOpen();
    return (
      this.database
        .query<
          { value: number },
          [string, string]
        >('SELECT 1 AS value FROM chat_sources WHERE session_id = ? AND source_file = ?')
        .get(sessionId, sourceFile) !== null
    );
  }

  /** Drop an unverified source's rows before its first complete reconstruction.
   *  A live watcher may have indexed NEW tail records before the lazy scan;
   *  retaining those ordinals would put the old prefix after the new tail. */
  forgetChatSourcePointers(sessionId: string, sourceFile: string): void {
    validateSessionId(sessionId);
    this.assertOpen();
    this.database
      .query('DELETE FROM chat_pointers WHERE session_id = ? AND source_file = ?')
      .run(sessionId, sourceFile);
    this.database.query('DELETE FROM chat_sources WHERE session_id = ? AND source_file = ?').run(sessionId, sourceFile);
  }

  markChatSource(
    sessionId: string,
    sourceFile: string,
    info: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number },
  ): void {
    validateSessionId(sessionId);
    this.assertOpen();
    const pointerCount =
      this.database
        .query<
          { value: number },
          [string, string]
        >('SELECT COUNT(*) AS value FROM chat_pointers WHERE session_id = ? AND source_file = ?')
        .get(sessionId, sourceFile)?.value ?? 0;
    this.database
      .query(
        `INSERT INTO chat_sources
           (session_id, source_file, device, inode, source_size, source_mtime_ms, pointer_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, source_file) DO UPDATE SET
           device = excluded.device,
           inode = excluded.inode,
           source_size = excluded.source_size,
           source_mtime_ms = excluded.source_mtime_ms,
           pointer_count = excluded.pointer_count`,
      )
      .run(
        sessionId,
        sourceFile,
        info.dev.toString(),
        info.ino.toString(),
        info.size,
        Math.trunc(info.mtimeMs),
        pointerCount,
      );
  }

  /** A window of chat pointer rows, oldest-first. */
  chatPointers(sessionId: string, offset: number, limit: number): ChatPointerRow[] {
    validateSessionId(sessionId);
    this.assertOpen();
    return this.database
      .query<ChatPointerRow, [string, number, number]>(
        `SELECT ordinal, time, type, turn, source_file, byte_offset, byte_length, record_index, event_fingerprint
           FROM chat_pointers
          WHERE session_id = ?
          ORDER BY ordinal ASC
          LIMIT ? OFFSET ?`,
      )
      .all(sessionId, limit, Math.max(0, offset));
  }

  /** Resolve pointer rows into normalized chat records using `normalize`, which
   *  the caller supplies (the harness parser for this session). Rows whose bytes
   *  no longer produce a matching record are SKIPPED and counted — that is the
   *  compaction/rotation path, and it degrades the view instead of failing it. */
  resolveChatPointers(
    rows: readonly ChatPointerRow[],
    normalize: (line: string) => unknown[],
  ): { records: unknown[]; skipped: number } {
    const records: unknown[] = [];
    let skipped = 0;
    const descriptors = new Map<string, number | undefined>();
    try {
      for (const row of rows) {
        if (!descriptors.has(row.source_file)) {
          let descriptor: number | undefined;
          try {
            descriptor = openSync(row.source_file, 'r');
          } catch {
            descriptor = undefined;
          }
          descriptors.set(row.source_file, descriptor);
        }
        const descriptor = descriptors.get(row.source_file);
        if (descriptor === undefined) {
          skipped += 1;
          continue;
        }
        const buffer = Buffer.alloc(row.byte_length);
        let read = 0;
        try {
          read = readSync(descriptor, buffer, 0, row.byte_length, row.byte_offset);
        } catch {
          skipped += 1;
          continue;
        }
        if (read !== row.byte_length) {
          skipped += 1;
          continue;
        }
        let normalized: unknown[];
        try {
          normalized = normalize(buffer.toString('utf8', 0, read));
        } catch {
          skipped += 1;
          continue;
        }
        const record = normalized[row.record_index] as { type?: string } | undefined;
        // IDENTITY CHECK, same contract as readPointer: a compacted file can
        // hold a different-but-valid record at this offset, and serving it would
        // be silent corruption of the history.
        if (!record || record.type !== row.type || chatEventFingerprint(record) !== row.event_fingerprint) {
          skipped += 1;
          continue;
        }
        records.push(record);
      }
    } finally {
      for (const descriptor of descriptors.values()) if (descriptor !== undefined) closeSync(descriptor);
    }
    return { records, skipped };
  }

  /** Drop a session's chat pointers (harness file rotated — re-index instead). */
  forgetChatPointers(sessionId: string): void {
    validateSessionId(sessionId);
    this.assertOpen();
    this.database.query('DELETE FROM chat_pointers WHERE session_id = ?').run(sessionId);
    this.database.query('DELETE FROM chat_sources WHERE session_id = ?').run(sessionId);
  }

  /** The newest indexed event of the fleet, as a feed cursor. */
  latestFleetCursor(): FleetCursor | undefined {
    this.assertOpen();
    const row = this.database
      .query<
        { time: string; session_id: string; sequence: number },
        []
      >(`SELECT time, session_id, sequence FROM events ORDER BY time DESC, session_id DESC, sequence DESC LIMIT 1`)
      .get();
    return row ? { time: row.time, sessionId: row.session_id, sequence: row.sequence } : undefined;
  }

  private resolvePointerRows(rows: readonly FleetPointerRow[]): SessionEvent[] {
    const events: SessionEvent[] = [];
    const descriptors = new Map<string, number | undefined>();
    /** Sessions re-indexed during this resolve → their refreshed pointers. */
    const refreshed = new Map<string, Map<number, FleetPointerRow>>();
    try {
      for (const row of rows) {
        // Once a session has been re-indexed, EVERY later row of that session
        // in this window is stale too — use the refreshed pointer, not the
        // one the original query handed us.
        const current = refreshed.get(row.session_id)?.get(row.sequence) ?? row;
        let event = this.readPointer(descriptors, current);
        if (!event && !refreshed.has(row.session_id)) {
          // Pointer/identity mismatch: the journal was rewritten under the
          // index. Re-index that session once and retry from fresh pointers.
          this.reindexSessionSync(row.session_id);
          const fresh = this.database
            .query<FleetPointerRow, [string]>(
              `SELECT session_id, sequence, time, byte_offset, byte_length
                 FROM events WHERE session_id = ?`,
            )
            .all(row.session_id);
          refreshed.set(row.session_id, new Map(fresh.map(item => [item.sequence, item])));
          const handle = descriptors.get(row.session_id);
          if (handle !== undefined) closeSync(handle);
          descriptors.delete(row.session_id);
          const retry = refreshed.get(row.session_id)!.get(row.sequence);
          if (retry) event = this.readPointer(descriptors, retry);
        }
        if (event) events.push(event);
      }
    } finally {
      for (const descriptor of descriptors.values()) if (descriptor !== undefined) closeSync(descriptor);
    }
    return events;
  }

  /** Read and identity-verify one pointer row, reusing an open descriptor per
   *  session. `undefined` means the row is unusable (missing journal, short
   *  read, unparseable bytes, or an identity mismatch). */
  private readPointer(descriptors: Map<string, number | undefined>, row: FleetPointerRow): SessionEvent | undefined {
    if (!descriptors.has(row.session_id)) {
      let descriptor: number | undefined;
      try {
        descriptor = openSync(this.eventsFile(row.session_id), 'r');
      } catch {
        descriptor = undefined;
      }
      descriptors.set(row.session_id, descriptor);
    }
    const descriptor = descriptors.get(row.session_id);
    if (descriptor === undefined) return undefined;
    const buffer = Buffer.alloc(row.byte_length);
    const read = readSync(descriptor, buffer, 0, row.byte_length, row.byte_offset);
    if (read !== row.byte_length) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString('utf8', 0, read));
    } catch {
      return undefined;
    }
    const event = parseEvent(parsed, row.session_id);
    return event && event.sequence === row.sequence ? event : undefined;
  }

  /** Session directories present on disk — the authority the disposable index
   *  is checked against (daemon post-wedge consistency check). */
  async sessionIdsOnDisk(): Promise<string[]> {
    return await this.discoverSessionIds();
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
    let imported = 0;
    for (const sessionId of sessionIds) {
      // Archived sessions (B3) stay OUT of the boot import — that skip IS the
      // retention payoff: their aged journals are never re-scanned and their
      // metadata never re-parsed into the hot cache. They remain resolvable on
      // demand (resolveIncludingArchived) and revive on the next real write.
      // (A full rebuildIndex still processes them — see its note.)
      if (this.archivedIds.has(sessionId)) continue;
      const result = await this.syncSession(sessionId);
      eventCount += result.eventCount;
      imported += 1;
      problems.push(...result.problems);
    }
    return { sessionCount: imported, eventCount, problems };
  }

  /** Clear the disposable index and recreate it entirely from session files. */
  async rebuildIndex(): Promise<RebuildResult> {
    this.assertOpen();
    await this.waitForAppends();
    this.database.transaction(() => {
      this.database.exec('DELETE FROM chat_sources');
      this.database.exec('DELETE FROM chat_pointers');
      this.database.exec('DELETE FROM events');
      this.database.exec('DELETE FROM sessions');
    })();
    this.lastSequences.clear();
    this.sessionCache.clear();
    this.journalTails.clear();
    this.knownDirectories.clear();
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

  /** Journal-progress bump ONLY — the per-append hot path. Touches four
   *  integer/text columns and the cached entry; never re-reads or re-serializes
   *  the config/state documents. */
  private indexJournalProgress(
    sessionId: string,
    lastSequence: number,
    journal: { size: number; mtimeMs: number },
  ): void {
    this.database
      .query(
        `UPDATE sessions
            SET last_sequence = ?, journal_size = ?, journal_mtime_ms = ?, indexed_at = ?
          WHERE id = ?`,
      )
      .run(lastSequence, journal.size, journal.mtimeMs, now(), sessionId);
    const cached = this.sessionCache.get(sessionId);
    if (cached) cached.lastSequence = lastSequence;
    // A journal can legitimately exist before config.json does (append-first
    // callers, and `insertEvent` seeds the FK parent row). Seed the cache too,
    // or `getSession` reports the session missing until something writes a
    // document.
    else
      this.sessionCache.set(sessionId, {
        id: sessionId,
        directory: this.sessionDirectory(sessionId),
        lastSequence,
      });
  }

  /** Re-read a session's config/state from disk. Used by the import/reconcile
   *  path, where the files are the authority and may have changed underneath
   *  the cache. */
  private async readDocuments(sessionId: string): Promise<{ config?: unknown; state?: unknown }> {
    const [config, state] = await Promise.all([
      readJsonIfPresent(this.configFile(sessionId)),
      readJsonIfPresent(this.stateFile(sessionId)),
    ]);
    return { config, state };
  }

  /** Refresh the indexed metadata for one session. `documents` carries the
   *  config/state the caller just wrote, so the common path never re-reads
   *  from disk what it already has in hand. */
  private async indexSessionMetadata(
    sessionId: string,
    documents: { config?: unknown; state?: unknown } = {},
    knownLastSequence?: number,
    journal?: { size: number; mtimeMs: number },
  ): Promise<void> {
    // A metadata write means the session is live again (resume, a late event):
    // un-archive it so it rejoins the hot cache and its exclusion does not
    // survive across the next boot. Guarded on the in-memory mirror so the DB
    // is touched only when a marker actually exists — the hot path pays nothing.
    if (this.archivedIds.size && this.archivedIds.delete(sessionId)) {
      this.database.query('DELETE FROM archived_sessions WHERE id = ?').run(sessionId);
    }
    const cached = this.sessionCache.get(sessionId);
    // Key PRESENCE decides, not the value: the import path legitimately passes
    // `{ config: undefined }` for a session whose config.json is gone, and that
    // must clear the indexed document rather than fall back to a stale cache.
    const config = 'config' in documents ? documents.config : (cached?.config ?? undefined);
    const state = 'state' in documents ? documents.state : (cached?.state ?? undefined);
    const lastSequence = knownLastSequence ?? cached?.lastSequence ?? (await this.lastSequence(sessionId));
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
    this.sessionCache.set(sessionId, {
      id: sessionId,
      directory: this.sessionDirectory(sessionId),
      status,
      createdAt,
      updatedAt,
      lastSequence,
      config,
      state,
    });
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
      await this.indexSessionMetadata(sessionId, await this.readDocuments(sessionId), lastSequence);
      return { sessionId, eventCount: 0, lastSequence, problems: [] };
    }

    const mtimeMs = Math.trunc(info.mtimeMs);
    // Unchanged journal (size + mtime match the index): skip the event scan —
    // this is what turns a warm boot from a full-history reimport into a stat.
    if (indexed && indexed.journal_size === info.size && indexed.journal_mtime_ms === mtimeMs) {
      this.lastSequences.set(sessionId, indexed.last_sequence);
      await this.indexSessionMetadata(sessionId, await this.readDocuments(sessionId), indexed.last_sequence, {
        size: info.size,
        mtimeMs,
      });
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
        await this.indexSessionMetadata(sessionId, await this.readDocuments(sessionId), lastSequence, {
          size: info.size,
          mtimeMs,
        });
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
    await this.indexSessionMetadata(sessionId, await this.readDocuments(sessionId), lastSequence, {
      size: info.size,
      mtimeMs,
    });
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
      // One directory listing instead of three blocking existsSync stats per
      // candidate (this runs twice per consistency pass over ~700 directories):
      // a single async readdir yields every artifact name at once, and a
      // directory read failure is treated as "no artifacts", exactly as three
      // failed existsSync calls were. Semantics are unchanged — a session dir
      // still qualifies iff it holds any of the three artifacts.
      const contents = await readdir(path.join(this.home, entry.name)).catch(() => [] as string[]);
      const hasSessionArtifact = contents.some(
        name => name === 'config.json' || name === 'state.json' || name === 'events.jsonl',
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
