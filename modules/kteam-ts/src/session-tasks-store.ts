// Per-session task storage. The legacy global TaskStore remains in
// tasks-store.ts as a READ-ONLY migration source; every live write goes here.
//
// One session owns one `<sessionDir>/tasks.json` file containing both declared
// records and their activity histories. A per-session SerialQueue holds the
// complete read-modify-write transaction, and atomicJson writes temp+rename, so
// concurrent status/note/link changes cannot lose one another or tear the file.

import { existsSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import path from 'path';
import { atomicJson, now } from './io';
import { sessionDir, type KTeamPaths } from './paths';
import {
  SerialQueue,
  compareTasks,
  matchesTaskFilter,
  normalizeTaskId,
  parseTaskCounters,
  parseTaskActivity,
  parseTaskRecord,
  serializeTask,
  splitTaskId,
  type TaskFilter,
} from './tasks-store';
import {
  TASK_ID_PREFIX,
  TASK_SCHEMA_VERSION,
  TaskError,
  type Task,
  type TaskActivity,
  type TaskKind,
} from './tasks-types';

export const SESSION_TASK_FILE_VERSION = 1;

/** Same path-safety rule as pins. Real ids are `<base36>-<hex>`; dots and path
 *  separators are refused before a request value can reach path.join. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const isSafeTaskSessionId = (value: unknown): value is string =>
  typeof value === 'string' && SESSION_ID.test(value);

export function sessionTaskFile(paths: KTeamPaths, sessionId: string): string {
  return `${sessionDir(paths, sessionId)}/tasks.json`;
}

/** Task records are session-scoped; their human-facing ids remain fleet-global
 *  so `F21` still names one thing in aggregate reads and old links. This small
 *  daemon metadata file is a counter/index, never a task-data store. */
export function sessionTaskCounterFile(paths: KTeamPaths): string {
  return path.join(paths.daemon, 'session-task-counters.json');
}

/** One stored task plus the history that used to live beside global task.json. */
export interface StoredSessionTask {
  task: Task;
  activity: TaskActivity[];
}

/** The only task-data file written beneath a session. `migratedGlobalIds` is an
 *  idempotency/proof ledger: once a legacy id was copied successfully, a later
 *  restart never copies it again or mistakes an edited destination for a
 *  conflict. The legacy source is deliberately retained. */
export interface SessionTaskFile {
  v: number;
  sessionId: string;
  tasks: StoredSessionTask[];
  migratedGlobalIds: string[];
  updatedAt: string;
}

export interface ParsedSessionTaskFile {
  file: SessionTaskFile;
  /** Bad task entries plus a whole-file failure. */
  parseErrors: number;
  parseErrorIds: string[];
  /** Bad activity entries, keyed by the task whose history degraded. */
  activityParseErrors: Map<string, number>;
  /** A present file that cannot safely be used as the base of a rewrite. */
  fatal: boolean;
}

export interface SessionTaskRead extends ParsedSessionTaskFile {
  exists: boolean;
}

export interface SessionTaskWrite<T> {
  value: T;
  file: SessionTaskFile;
}

export interface LegacyTaskImport {
  task: Task;
  activity: TaskActivity[];
}

export interface LegacyImportResult {
  imported: string[];
  alreadyImported: string[];
  conflicts: string[];
  file: SessionTaskFile;
}

export type SessionTaskStoreRole = 'daemon' | 'reader';

export interface SessionTaskStoreOptions {
  role?: SessionTaskStoreRole;
}

export function emptySessionTaskFile(sessionId: string, at: string = now()): SessionTaskFile {
  return {
    v: SESSION_TASK_FILE_VERSION,
    sessionId,
    tasks: [],
    migratedGlobalIds: [],
    updatedAt: at,
  };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value : null);

function parseActivityList(value: unknown): { activity: TaskActivity[]; errors: number } {
  if (!Array.isArray(value)) return { activity: [], errors: value === undefined ? 0 : 1 };
  const activity: TaskActivity[] = [];
  const seen = new Set<number>();
  let errors = 0;
  for (const raw of value) {
    const entry = parseTaskActivity(raw);
    if (entry === null || seen.has(entry.seq)) {
      errors += 1;
      continue;
    }
    seen.add(entry.seq);
    activity.push(entry);
  }
  activity.sort((a, b) => a.seq - b.seq);
  return { activity, errors };
}

/** Field-by-field defensive parse. One malformed task/history degrades only
 *  that entry. A malformed WHOLE file is flagged fatal so a writer refuses to
 *  replace evidence it could not read with an apparently empty board. */
export function parseSessionTaskFile(rawText: string | null, expectedSessionId: string): ParsedSessionTaskFile {
  const empty = emptySessionTaskFile(expectedSessionId);
  if (rawText === null) {
    return { file: empty, parseErrors: 0, parseErrorIds: [], activityParseErrors: new Map(), fatal: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      file: empty,
      parseErrors: 1,
      parseErrorIds: ['<file>'],
      activityParseErrors: new Map(),
      fatal: true,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      file: empty,
      parseErrors: 1,
      parseErrorIds: ['<file>'],
      activityParseErrors: new Map(),
      fatal: true,
    };
  }
  const raw = parsed as Record<string, unknown>;
  if (
    raw['v'] !== SESSION_TASK_FILE_VERSION ||
    raw['sessionId'] !== expectedSessionId ||
    !Array.isArray(raw['tasks'])
  ) {
    return {
      file: empty,
      parseErrors: 1,
      parseErrorIds: ['<file>'],
      activityParseErrors: new Map(),
      fatal: true,
    };
  }

  const tasks: StoredSessionTask[] = [];
  const parseErrorIds: string[] = [];
  const activityParseErrors = new Map<string, number>();
  const seen = new Set<string>();
  for (const item of raw['tasks']) {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const task = entry === null ? null : parseTaskRecord(entry['task']);
    const hintedId =
      entry === null ? null : normalizeTaskId((entry['task'] as Record<string, unknown> | undefined)?.['id']);
    if (task === null || seen.has(task.id)) {
      parseErrorIds.push(hintedId ?? '<unknown>');
      continue;
    }
    seen.add(task.id);
    const parsedActivity = parseActivityList(entry?.['activity']);
    if (parsedActivity.errors > 0) activityParseErrors.set(task.id, parsedActivity.errors);
    tasks.push({ task, activity: parsedActivity.activity });
  }
  tasks.sort((a, b) => compareTasks(a.task, b.task));

  const migratedGlobalIds: string[] = [];
  if (Array.isArray(raw['migratedGlobalIds'])) {
    for (const value of raw['migratedGlobalIds']) {
      const id = normalizeTaskId(value);
      if (id !== null && !migratedGlobalIds.includes(id)) migratedGlobalIds.push(id);
    }
  }
  return {
    file: {
      v: SESSION_TASK_FILE_VERSION,
      sessionId: expectedSessionId,
      tasks,
      migratedGlobalIds,
      updatedAt: text(raw['updatedAt']) ?? now(),
    },
    parseErrors: parseErrorIds.length,
    parseErrorIds,
    activityParseErrors,
    fatal: false,
  };
}

function serializeActivity(entry: TaskActivity): TaskActivity {
  return {
    v: TASK_SCHEMA_VERSION,
    seq: entry.seq,
    time: entry.time,
    actor: entry.actor,
    actorName: entry.actorName,
    type: entry.type,
    data: { ...entry.data },
  };
}

function serializeStoredTask(entry: StoredSessionTask): StoredSessionTask {
  return {
    task: serializeTask(entry.task),
    activity: entry.activity.map(serializeActivity),
  };
}

export function serializeSessionTaskFile(file: SessionTaskFile): SessionTaskFile {
  return {
    v: SESSION_TASK_FILE_VERSION,
    sessionId: file.sessionId,
    tasks: file.tasks.map(serializeStoredTask),
    migratedGlobalIds: [
      ...new Set(file.migratedGlobalIds.map(normalizeTaskId).filter((id): id is string => id !== null)),
    ],
    updatedAt: file.updatedAt,
  };
}

function validateStoredEntry(entry: StoredSessionTask, expectedId?: string): StoredSessionTask {
  const task = parseTaskRecord(serializeTask(entry.task));
  if (task === null) throw new TaskError('invalid', `refusing to write an invalid task ${entry.task.id}`);
  if (expectedId !== undefined && task.id !== expectedId) {
    throw new TaskError('invalid', `a task transaction may not rename ${expectedId} to ${task.id}`);
  }
  const parsed = parseActivityList(entry.activity.map(serializeActivity));
  if (parsed.errors > 0) throw new TaskError('invalid', `refusing to write invalid activity for ${task.id}`);
  return { task, activity: parsed.activity };
}

export class SessionTaskStore {
  private readonly role: SessionTaskStoreRole;
  private readonly queue = new SerialQueue();
  private knownSessions: Set<string> | undefined;
  private sessionIndexSeed: Promise<void> | undefined;
  private counterSeed: Promise<void> | undefined;
  private counters: Partial<Record<TaskKind, number>> = {};

  constructor(
    private readonly paths: KTeamPaths,
    options: SessionTaskStoreOptions = {},
  ) {
    this.role = options.role ?? 'reader';
  }

  get writable(): boolean {
    return this.role === 'daemon';
  }

  file(sessionId: string): string {
    return sessionTaskFile(this.paths, sessionId);
  }

  private assertWritable(): void {
    if (!this.writable) {
      throw new TaskError(
        'read-only',
        'session task files are daemon-owned: send this write through /v1/sessions/:id/tasks',
      );
    }
  }

  private assertSessionId(sessionId: string): void {
    if (!isSafeTaskSessionId(sessionId)) {
      throw new TaskError('invalid', `not a valid session id: ${String(sessionId)}`);
    }
  }

  async read(sessionId: string): Promise<SessionTaskRead> {
    this.assertSessionId(sessionId);
    const filename = this.file(sessionId);
    const present = existsSync(filename);
    if (!present) return { ...parseSessionTaskFile(null, sessionId), exists: false };
    const body = await readFile(filename, 'utf8').catch(() => null);
    if (body === null) {
      const empty = emptySessionTaskFile(sessionId);
      return {
        file: empty,
        parseErrors: 1,
        parseErrorIds: ['<file>'],
        activityParseErrors: new Map(),
        fatal: true,
        exists: true,
      };
    }
    return { ...parseSessionTaskFile(body, sessionId), exists: true };
  }

  /** Sessions with a tasks.json, including terminal sessions not currently in
   *  the manager's live index. Non-session directories simply have no file. */
  async listSessionIds(): Promise<string[]> {
    if (this.sessionIndexSeed === undefined) {
      this.sessionIndexSeed = (async () => {
        const entries = await readdir(this.paths.sessions, { withFileTypes: true }).catch(() => []);
        this.knownSessions = new Set(
          entries
            .filter(
              entry => entry.isDirectory() && isSafeTaskSessionId(entry.name) && existsSync(this.file(entry.name)),
            )
            .map(entry => entry.name),
        );
      })();
    }
    await this.sessionIndexSeed;
    return [...(this.knownSessions ?? [])].sort();
  }

  async list(sessionId: string, filter: TaskFilter = {}): Promise<SessionTaskRead & { tasks: StoredSessionTask[] }> {
    const parsed = await this.read(sessionId);
    return {
      ...parsed,
      tasks: parsed.file.tasks.filter(entry => matchesTaskFilter(entry.task, filter)),
    };
  }

  async detail(sessionId: string, id: string): Promise<{ entry?: StoredSessionTask; read: SessionTaskRead }> {
    const canonical = normalizeTaskId(id);
    if (canonical === null) throw new TaskError('invalid', `not a task id: ${String(id)}`);
    const read = await this.read(sessionId);
    return { entry: read.file.tasks.find(candidate => candidate.task.id === canonical), read };
  }

  private async readForWrite(sessionId: string): Promise<SessionTaskRead> {
    const read = await this.read(sessionId);
    const activityErrors = [...read.activityParseErrors.values()].reduce((sum, count) => sum + count, 0);
    if (read.fatal || read.parseErrors > 0 || activityErrors > 0) {
      throw new TaskError('invalid', `refusing to overwrite unreadable ${this.file(sessionId)}`);
    }
    return read;
  }

  private async write(sessionId: string, base: SessionTaskFile): Promise<SessionTaskFile> {
    const file = serializeSessionTaskFile({ ...base, sessionId, updatedAt: now() });
    await atomicJson(this.file(sessionId), file);
    this.knownSessions?.add(sessionId);
    return file;
  }

  /** Seed the global id floor once per daemon lifetime from three independent
   *  sources: the new counter cache, retained legacy ids, and every existing
   *  session task file. Losing the counter therefore skips no ids and recycles
   *  none. Subsequent allocations are O(1) under the global allocator queue. */
  private async seedGlobalCounters(): Promise<void> {
    if (this.counterSeed === undefined) {
      this.counterSeed = (async () => {
        const counterText = await readFile(sessionTaskCounterFile(this.paths), 'utf8').catch(() => null);
        this.counters = { ...parseTaskCounters(counterText).counters };
        const observe = (id: string): void => {
          const split = splitTaskId(id);
          if (!split) return;
          const kind =
            split.prefix === 'B'
              ? 'bug'
              : split.prefix === 'F'
                ? 'feature'
                : split.prefix === 'I'
                  ? 'infra'
                  : split.prefix === 'C'
                    ? 'chore'
                    : null;
          if (kind !== null) this.counters[kind] = Math.max(this.counters[kind] ?? 0, split.number);
        };

        const legacyEntries = await readdir(this.paths.tasksDir).catch(() => [] as string[]);
        for (const entry of legacyEntries) {
          const id = normalizeTaskId(entry);
          if (id !== null) observe(id);
        }
        for (const sessionId of await this.listSessionIds()) {
          const read = await this.read(sessionId);
          for (const entry of read.file.tasks) observe(entry.task.id);
        }
      })();
    }
    await this.counterSeed;
  }

  async allocateId(kind: TaskKind): Promise<string> {
    this.assertWritable();
    return this.queue.run('__global_task_ids__', async () => {
      await this.seedGlobalCounters();
      const next = (this.counters[kind] ?? 0) + 1;
      this.counters[kind] = next;
      await atomicJson(sessionTaskCounterFile(this.paths), {
        v: TASK_SCHEMA_VERSION,
        counters: { ...this.counters },
      });
      return `${TASK_ID_PREFIX[kind]}${next}`;
    });
  }

  /** Allocate and create inside one hold of the per-session queue. */
  async create(
    sessionId: string,
    kind: TaskKind,
    build: (id: string) => StoredSessionTask | Promise<StoredSessionTask>,
  ): Promise<SessionTaskWrite<StoredSessionTask>> {
    this.assertWritable();
    this.assertSessionId(sessionId);
    // Allocate before taking the session lock. A failed create may leave a gap,
    // which is intentional: ids are never recycled.
    const id = await this.allocateId(kind);
    return this.queue.run(sessionId, async () => {
      const read = await this.readForWrite(sessionId);
      if (read.file.tasks.some(entry => entry.task.id === id)) {
        throw new TaskError('ambiguous', `global task id ${id} already exists in session ${sessionId}`);
      }
      const entry = validateStoredEntry(await build(id), id);
      const file = await this.write(sessionId, { ...read.file, tasks: [...read.file.tasks, entry] });
      return { value: entry, file };
    });
  }

  /** Read, replace one task+history, and rewrite once under the session lock. */
  async transact(
    sessionId: string,
    id: string,
    transform: (current: StoredSessionTask) => StoredSessionTask | Promise<StoredSessionTask>,
  ): Promise<SessionTaskWrite<StoredSessionTask>> {
    this.assertWritable();
    this.assertSessionId(sessionId);
    const canonical = normalizeTaskId(id);
    if (canonical === null) throw new TaskError('invalid', `not a task id: ${String(id)}`);
    return this.queue.run(sessionId, async () => {
      const read = await this.readForWrite(sessionId);
      const index = read.file.tasks.findIndex(entry => entry.task.id === canonical);
      if (index === -1) throw new TaskError('not-found', `unknown task ${canonical} in session ${sessionId}`);
      const entry = validateStoredEntry(await transform(read.file.tasks[index]!), canonical);
      const tasks = [...read.file.tasks];
      tasks[index] = entry;
      const file = await this.write(sessionId, { ...read.file, tasks });
      return { value: entry, file };
    });
  }

  /** Idempotent copy from the retained global store. A same-id destination that
   *  is not already marked imported is never overwritten: it is a conflict and
   *  the source stays visible in the aggregate legacy set. */
  async importLegacy(sessionId: string, incoming: readonly LegacyTaskImport[]): Promise<LegacyImportResult> {
    this.assertWritable();
    this.assertSessionId(sessionId);
    return this.queue.run(sessionId, async () => {
      const read = await this.readForWrite(sessionId);
      const tasks = [...read.file.tasks];
      const migrated = new Set(read.file.migratedGlobalIds);
      const imported: string[] = [];
      const alreadyImported: string[] = [];
      const conflicts: string[] = [];
      let changed = false;

      for (const raw of incoming) {
        const candidate = validateStoredEntry(raw, raw.task.id);
        if (migrated.has(candidate.task.id)) {
          // The ledger proves a copy only while the record is still present.
          // A clean-but-incomplete hand edit must not make migration report
          // `proven: true` for a destination that no longer contains the task.
          if (tasks.some(entry => entry.task.id === candidate.task.id)) {
            alreadyImported.push(candidate.task.id);
            continue;
          }
          migrated.delete(candidate.task.id);
          changed = true;
        }
        const existing = tasks.find(entry => entry.task.id === candidate.task.id);
        if (existing !== undefined) {
          if (JSON.stringify(serializeStoredTask(existing)) === JSON.stringify(serializeStoredTask(candidate))) {
            migrated.add(candidate.task.id);
            alreadyImported.push(candidate.task.id);
            changed = true;
          } else {
            conflicts.push(candidate.task.id);
          }
          continue;
        }
        tasks.push(candidate);
        migrated.add(candidate.task.id);
        imported.push(candidate.task.id);
        changed = true;
      }

      const base = { ...read.file, tasks, migratedGlobalIds: [...migrated] };
      const file = changed ? await this.write(sessionId, base) : read.file;
      return { imported, alreadyImported, conflicts, file };
    });
  }
}
