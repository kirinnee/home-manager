import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, type KTeamPaths } from './paths';
import {
  SESSION_TASK_FILE_VERSION,
  SessionTaskStore,
  parseSessionTaskFile,
  sessionTaskCounterFile,
  sessionTaskFile,
  type StoredSessionTask,
} from './session-tasks-store';
import { TASK_SCHEMA_VERSION, TaskError, emptyTaskLinks, type Task, type TaskActivity } from './tasks-types';

let home: string;
let paths: KTeamPaths;
let store: SessionTaskStore;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-session-tasks-'));
  paths = createPaths(home);
  store = new SessionTaskStore(paths, { role: 'daemon' });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const at = '2026-07-27T12:00:00.000Z';

function record(id: string, over: Partial<Task> = {}): Task {
  const kind = id.startsWith('B') ? 'bug' : id.startsWith('I') ? 'infra' : id.startsWith('C') ? 'chore' : 'feature';
  return {
    v: TASK_SCHEMA_VERSION,
    id,
    kind,
    title: `Task ${id}`,
    description: '',
    status: 'todo',
    statusReason: null,
    assignee: 'ms-a',
    repo: '/repo',
    links: emptyTaskLinks(),
    order: null,
    createdAt: at,
    createdBy: 'ms-a',
    updatedAt: at,
    ...over,
  };
}

function activity(seq: number, type: TaskActivity['type'] = 'note'): TaskActivity {
  return {
    v: TASK_SCHEMA_VERSION,
    seq,
    time: at,
    actor: 'ms-a',
    actorName: 'a',
    type,
    data: type === 'note' ? { text: `n${seq}` } : {},
  };
}

async function create(sessionId: string, title = 'new'): Promise<StoredSessionTask> {
  const result = await store.create(sessionId, 'feature', id => ({
    task: record(id, { title, assignee: sessionId, createdBy: sessionId }),
    activity: [activity(1, 'created')],
  }));
  return result.value;
}

describe('layout and defensive parsing', () => {
  test('the sole data file is <sessionDir>/tasks.json', async () => {
    await create('ms-a');
    expect(store.file('ms-a')).toBe(path.join(home, 'ms-a', 'tasks.json'));
    expect(sessionTaskFile(paths, 'ms-a')).toBe(store.file('ms-a'));
    expect(await readdir(path.join(home, 'ms-a'))).toEqual(['tasks.json']);
    const raw = JSON.parse(await readFile(store.file('ms-a'), 'utf8'));
    expect(raw).toMatchObject({ v: SESSION_TASK_FILE_VERSION, sessionId: 'ms-a' });
    expect(raw.tasks[0]).toHaveProperty('task');
    expect(raw.tasks[0]).toHaveProperty('activity');
  });

  test('one malformed task and activity degrade independently', () => {
    const parsed = parseSessionTaskFile(
      JSON.stringify({
        v: SESSION_TASK_FILE_VERSION,
        sessionId: 'ms-a',
        updatedAt: at,
        migratedGlobalIds: [],
        tasks: [
          { task: record('F1'), activity: [activity(1), { broken: true }] },
          { task: { ...record('F2'), title: null }, activity: [] },
        ],
      }),
      'ms-a',
    );
    expect(parsed.fatal).toBe(false);
    expect(parsed.file.tasks.map(entry => entry.task.id)).toEqual(['F1']);
    expect(parsed.parseErrorIds).toEqual(['F2']);
    expect(parsed.activityParseErrors.get('F1')).toBe(1);
  });

  test('a torn whole file is fatal and a mutation refuses to overwrite it', async () => {
    await create('ms-a');
    await writeFile(store.file('ms-a'), '{ torn');
    const before = await readFile(store.file('ms-a'), 'utf8');
    await expect(create('ms-a', 'must not land')).rejects.toMatchObject({ code: 'invalid' });
    expect(await readFile(store.file('ms-a'), 'utf8')).toBe(before);
  });

  test('path traversal-shaped session ids are rejected before I/O', async () => {
    await expect(create('../daemon')).rejects.toThrow('not a valid session id');
  });

  test('a reader can inspect but cannot write', async () => {
    await create('ms-a');
    const reader = new SessionTaskStore(paths);
    expect((await reader.read('ms-a')).file.tasks).toHaveLength(1);
    await expect(reader.create('ms-a', 'feature', id => ({ task: record(id), activity: [] }))).rejects.toMatchObject({
      code: 'read-only',
    });
  });
});

describe('per-session allocation and serialization', () => {
  test('records are session-scoped while ids remain globally monotonic', async () => {
    expect((await create('ms-a')).task.id).toBe('F1');
    expect((await create('ms-a')).task.id).toBe('F2');
    expect((await create('ms-b')).task.id).toBe('F3');
  });

  test('concurrent creates in one session never collide', async () => {
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) => create('ms-a', `T${index}`)));
    expect(new Set(created.map(entry => entry.task.id)).size).toBe(12);
    expect((await store.read('ms-a')).file.tasks).toHaveLength(12);
  });

  test('concurrent creates in different sessions share one global allocator', async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, index) => create(index % 2 === 0 ? 'ms-a' : 'ms-b', `T${index}`)),
    );
    expect(new Set(created.map(entry => entry.task.id)).size).toBe(20);
    expect(created.map(entry => Number(entry.task.id.slice(1))).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect((await store.read('ms-a')).file.tasks).toHaveLength(10);
    expect((await store.read('ms-b')).file.tasks).toHaveLength(10);
  });

  test('a new daemon store recovers the id floor when its counter file was deleted', async () => {
    expect((await create('ms-a')).task.id).toBe('F1');
    await rm(sessionTaskCounterFile(paths), { force: true });

    store = new SessionTaskStore(paths, { role: 'daemon' });
    expect((await create('ms-b')).task.id).toBe('F2');
  });

  test('concurrent transactions see one another and append gap-free activity', async () => {
    await create('ms-a');
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.transact('ms-a', 'F1', current => {
          const highest = current.activity.at(-1)?.seq ?? 0;
          return {
            task: { ...current.task, title: `last-${index}` },
            activity: [...current.activity, activity(highest + 1)],
          };
        }),
      ),
    );
    const { entry } = await store.detail('ms-a', 'F1');
    expect(entry?.activity.map(item => item.seq)).toEqual(Array.from({ length: 11 }, (_, index) => index + 1));
  });

  test('atomic rewrites leave no temp files behind', async () => {
    await create('ms-a');
    await store.transact('ms-a', 'F1', current => ({ ...current, task: { ...current.task, status: 'built' } }));
    expect((await readdir(path.join(home, 'ms-a'))).filter(name => name.includes('.tmp.'))).toEqual([]);
  });
});

describe('legacy import proof ledger', () => {
  test('copy is idempotent and records the source id', async () => {
    const incoming = { task: record('F9'), activity: [activity(1, 'created')] };
    const first = await store.importLegacy('ms-a', [incoming]);
    expect(first.imported).toEqual(['F9']);
    expect(first.file.migratedGlobalIds).toEqual(['F9']);
    const second = await store.importLegacy('ms-a', [incoming]);
    expect(second.imported).toEqual([]);
    expect(second.alreadyImported).toEqual(['F9']);
    expect(second.file.tasks).toHaveLength(1);
  });

  test('a same-id different destination is a conflict and is never overwritten', async () => {
    await create('ms-a', 'destination');
    const incoming = { task: record('F1', { title: 'legacy source' }), activity: [activity(1, 'created')] };
    const result = await store.importLegacy('ms-a', [incoming]);
    expect(result.conflicts).toEqual(['F1']);
    expect(result.file.migratedGlobalIds).toEqual([]);
    expect(result.file.tasks[0]?.task.title).toBe('destination');
  });

  test('an identical pre-existing copy is marked without duplication', async () => {
    const entry = await create('ms-a', 'same');
    const result = await store.importLegacy('ms-a', [entry]);
    expect(result.alreadyImported).toEqual(['F1']);
    expect(result.file.tasks).toHaveLength(1);
    expect(result.file.migratedGlobalIds).toEqual(['F1']);
  });

  test('a stale proof marker without its record is repaired by recopying', async () => {
    const incoming = { task: record('F9'), activity: [activity(1, 'created')] };
    await store.importLegacy('ms-a', [incoming]);
    const raw = JSON.parse(await readFile(store.file('ms-a'), 'utf8'));
    raw.tasks = [];
    await writeFile(store.file('ms-a'), JSON.stringify(raw));

    const repaired = await store.importLegacy('ms-a', [incoming]);
    expect(repaired.imported).toEqual(['F9']);
    expect(repaired.alreadyImported).toEqual([]);
    expect(repaired.file.tasks.map(entry => entry.task.id)).toEqual(['F9']);
    expect(repaired.file.migratedGlobalIds).toEqual(['F9']);
  });
});

test('the store exposes TaskError for caller mistakes', async () => {
  await expect(store.detail('ms-a', 'nope')).rejects.toBeInstanceOf(TaskError);
});
