import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, type KTeamPaths } from './paths';
import {
  SerialQueue,
  TaskStore,
  compareTasks,
  isTaskId,
  normalizeTaskId,
  parseTaskActivity,
  parseTaskActivityLog,
  parseTaskCounters,
  parseTaskLinks,
  parseTaskRecord,
  resolveStatusReason,
  serializeTask,
  taskPaths,
  validateTaskDescription,
  validateTaskNote,
  validateTaskOrder,
  validateTaskTitle,
} from './tasks-store';
import {
  MAX_TASK_DESCRIPTION_LEN,
  MAX_TASK_NOTE_LEN,
  MAX_TASK_TITLE_LEN,
  TASK_SCHEMA_VERSION,
  TaskError,
  type Task,
} from './tasks-types';
import { taskPhaseFromStatus } from './tasks-workflow';

let home: string;
let paths: KTeamPaths;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-tasks-store-'));
  paths = createPaths(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const record = (over: Partial<Task> = {}): Task => {
  const base: Task = {
    v: TASK_SCHEMA_VERSION,
    id: 'F1',
    kind: 'feature',
    title: 'File browser',
    description: '## Brief',
    ask: { text: 'Build a file browser', source: 'ms1lhymf-c4051f31:msg-1' },
    clarifications: [],
    workflow: 'quick',
    phase: 'build',
    dependsOn: [],
    files: [],
    status: 'in_progress',
    statusReason: null,
    assignee: 'ines',
    repo: '/repo',
    links: { prs: [], branch: null, commits: [], docs: [] },
    order: null,
    createdAt: '2026-07-26T12:00:00.000Z',
    createdBy: 'ms1lhymf-c4051f31',
    updatedAt: '2026-07-26T12:00:00.000Z',
    ...over,
  };
  // A status override without an explicit phase would otherwise leave the default
  // phase ('build') contradicting the new status — which the v2 parser now rightly
  // rejects. Keep fixtures internally consistent by deriving the phase from the
  // status (blocked is exempt: it retains its prior phase, so leave it alone).
  if (over.phase === undefined && over.status !== undefined && over.status !== 'blocked') {
    base.phase = taskPhaseFromStatus(over.status);
  }
  return base;
};

async function seed(store: TaskStore, task: Task): Promise<void> {
  await mkdir(path.dirname(store.recordFile(task.id)), { recursive: true });
  await writeFile(store.recordFile(task.id), JSON.stringify(task));
}

describe('record parsing degrades, never throws', () => {
  test('a well-formed record round-trips', () => {
    const parsed = parseTaskRecord(JSON.parse(JSON.stringify(record())));
    expect(parsed).toEqual(record());
  });

  test.each([
    ['not an object', 42],
    ['a wrong schema version (migration point)', { ...record(), v: 2 }],
    ['a malformed id', { ...record(), id: '../escape' }],
    ['an unknown kind', { ...record(), kind: 'epic' }],
    ['an id whose prefix disagrees with the kind', { ...record(), id: 'B1', kind: 'feature' }],
    ['a blank title', { ...record(), title: '   ' }],
    ['an unknown status', { ...record(), status: 'shipped' }],
    ['a missing createdAt', { ...record(), createdAt: null }],
    ['blocked with no reason', { ...record(), status: 'blocked', statusReason: null }],
    ['dropped with no reason', { ...record(), status: 'dropped', statusReason: '  ' }],
  ])('skips %s', (_label, value) => {
    expect(parseTaskRecord(value)).toBeNull();
  });

  test('refuses an over-cap description on READ too, so a hand-edited file cannot smuggle one in', () => {
    const oversized = { ...record(), description: 'x'.repeat(MAX_TASK_DESCRIPTION_LEN + 1) };
    expect(parseTaskRecord(oversized)).toBeNull();
    // Exactly at the cap is fine — the cap is inclusive.
    expect(parseTaskRecord({ ...record(), description: 'x'.repeat(MAX_TASK_DESCRIPTION_LEN) })).not.toBeNull();
  });

  test('degrades individual soft fields instead of losing the record', () => {
    const parsed = parseTaskRecord({
      ...record(),
      description: 12,
      assignee: '   ',
      repo: null,
      order: -1,
      updatedAt: undefined,
      links: 'nope',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.description).toBe('');
    expect(parsed?.assignee).toBeNull();
    expect(parsed?.order).toBeNull();
    expect(parseTaskRecord({ ...record(), order: 1.5 })?.order).toBeNull();
    // updatedAt falls back to createdAt rather than to "now" — a record must not
    // look freshly touched because it was read.
    expect(parsed?.updatedAt).toBe(record().createdAt);
    expect(parsed?.links).toEqual({ prs: [], branch: null, commits: [], docs: [] });
  });

  test('canonicalises a lower-case id reference', () => {
    expect(normalizeTaskId(' f21 ')).toBe('F21');
    expect(normalizeTaskId('F21/../..')).toBeNull();
    expect(isTaskId('B7')).toBe(true);
    expect(isTaskId('X7')).toBe(false);
  });

  test('links are de-duplicated, capped, and cleaned of junk entries', () => {
    const links = parseTaskLinks({
      prs: ['https://x/1', 'https://x/1', 42, '  ', 'y'.repeat(9999)],
      branch: '   ',
      commits: ['abc'],
      docs: null,
    });
    expect(links).toEqual({ prs: ['https://x/1'], branch: null, commits: ['abc'], docs: [] });
  });
});

describe('v2 fields parse additively and round-trip exactly', () => {
  // A pre-v2 file on disk carried none of ask/clarifications/workflow/phase/
  // dependsOn. Reading it must fill honest defaults, never fail the record.
  test('a v1 record with none of the v2 fields fills defaults instead of failing', () => {
    const v1 = {
      v: TASK_SCHEMA_VERSION,
      id: 'F1',
      kind: 'feature',
      title: 'Legacy row',
      description: 'the old brief',
      status: 'in_progress',
      statusReason: null,
      assignee: null,
      repo: null,
      links: { prs: [], branch: null, commits: [], docs: [] },
      order: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      createdBy: null,
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    const parsed = parseTaskRecord(v1);
    expect(parsed).not.toBeNull();
    // phase is derived from the declared status; workflow is inferred from phase.
    expect(parsed?.phase).toBe('build');
    expect(parsed?.workflow).toBe('quick');
    expect(parsed?.clarifications).toEqual([]);
    expect(parsed?.dependsOn).toEqual([]);
    // ask is synthesised from the brief with a legacy source when none existed.
    expect(parsed?.ask).toEqual({ text: 'the old brief', source: 'legacy:F1' });
  });

  test('creation enforces five words without rejecting a legacy stored title', () => {
    expect(validateTaskTitle('One two three four five')).toBe('One two three four five');
    expect(() => validateTaskTitle('One two three four five six')).toThrow(/6 words.*description/);
    const legacyTitle = 'A deliberately long existing task title remains available';
    expect(parseTaskRecord({ ...record(), title: legacyTitle })?.title).toBe(legacyTitle);
  });

  test('v1 inference walks status → phase → workflow for the other lanes', () => {
    expect(parseTaskRecord({ ...record(), phase: undefined, workflow: undefined, status: 'designed' })?.phase).toBe(
      'design',
    );
    expect(parseTaskRecord({ ...record(), phase: undefined, workflow: undefined, status: 'designed' })?.workflow).toBe(
      'design-first',
    );
    expect(
      parseTaskRecord({ ...record(), phase: undefined, workflow: undefined, status: 'researched' })?.workflow,
    ).toBe('investigate');
  });

  test('a non-blocked record whose stored phase contradicts its status is rejected', () => {
    // status 'built' must derive phase 'built'; a record that stored phase 'todo'
    // alongside it is internally incoherent and the parser refuses it (P1).
    expect(parseTaskRecord({ ...record(), status: 'built', phase: 'todo' })).toBeNull();
    expect(parseTaskRecord({ ...record(), status: 'in_progress', phase: 'live' })).toBeNull();
    // The coherent form of the same record is accepted.
    expect(parseTaskRecord({ ...record(), status: 'built', phase: 'built' })?.phase).toBe('built');
  });

  test('blocked is the sole exception — it retains a prior phase without contradiction', () => {
    // A task blocked mid-build keeps phase 'build' even though blocked derives 'todo';
    // this is legal, not a contradiction, so the record parses.
    const parsed = parseTaskRecord({
      ...record(),
      status: 'blocked',
      statusReason: 'waiting on an API key',
      phase: 'build',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe('blocked');
    expect(parsed?.phase).toBe('build');
  });

  test('a v1 ask falls back to the title and first doc link when there is no brief', () => {
    const parsed = parseTaskRecord({
      ...record(),
      ask: undefined,
      description: '',
      links: { prs: [], branch: null, commits: [], docs: ['~/.kteam/x/brief-1.md'] },
    });
    expect(parsed?.ask).toEqual({ text: 'File browser', source: '~/.kteam/x/brief-1.md' });
  });

  test('a full v2 record survives serialize → parse byte-for-byte', () => {
    const full = record({
      ask: { text: 'Original ask, verbatim', source: 'https://msg/1' },
      clarifications: [
        {
          text: 'actually scope it down',
          source: 'https://msg/2',
          at: '2026-07-27T00:00:00.000Z',
          by: 'ms-abc',
          byName: 'ines',
        },
      ],
      workflow: 'research-first',
      phase: 'design',
      dependsOn: ['F2', 'F3'],
      status: 'designed',
    });
    const parsed = parseTaskRecord(JSON.parse(JSON.stringify(serializeTask(full))));
    expect(parsed).toEqual(full);
  });

  test('a clarification missing its provenance is dropped, not half-stored', () => {
    const parsed = parseTaskRecord({
      ...record(),
      clarifications: [
        { text: 'keeps', source: 'https://msg/9', at: '2026-07-27T00:00:00.000Z', by: 'ms-abc', byName: null },
        { text: 'no when/who', source: 'https://msg/10' },
      ],
    });
    expect(parsed?.clarifications).toEqual([
      { text: 'keeps', source: 'https://msg/9', at: '2026-07-27T00:00:00.000Z', by: 'ms-abc', byName: null },
    ]);
  });

  test('#F12 references normalise to F12 while storage stays sigil-free', () => {
    expect(normalizeTaskId('#F12')).toBe('F12');
    expect(normalizeTaskId(' #f12 ')).toBe('F12');
    // The stored form never carries the sigil, so the raw guard rejects it.
    expect(isTaskId('#F12')).toBe(false);
    expect(isTaskId('F12')).toBe(true);
    // Dependencies supplied with a sigil or lower-cased are normalised and de-duped.
    const parsed = parseTaskRecord({ ...record(), dependsOn: ['#f12', 'F12', '#F13', 'F1'] });
    // F1 is self and is dropped; the rest normalise to canonical sigil-free ids.
    expect(parsed?.dependsOn).toEqual(['F12', 'F13']);
  });
});

describe('serialization protects the declared/derived split', () => {
  test('a derived `live` block handed to the serializer never reaches disk', () => {
    const withLive = { ...record(), live: { staleness: 'assignee-dead' } } as unknown as Task;
    const written = serializeTask(withLive);
    expect(Object.keys(written)).not.toContain('live');
    expect(JSON.stringify(written)).not.toContain('assignee-dead');
  });

  test('unknown extra fields are dropped rather than persisted forever', () => {
    const written = serializeTask({ ...record(), hacked: true } as unknown as Task);
    expect(Object.keys(written)).not.toContain('hacked');
  });
});

describe('activity log parsing', () => {
  test('orders by seq, skips corrupt lines and counts them', () => {
    const line = (seq: number) => JSON.stringify({ v: 1, seq, time: `t${seq}`, actor: 'a', type: 'note', data: {} });
    const text = [line(2), '{ not json', line(1), '', JSON.stringify({ v: 1, seq: 0, time: 't', type: 'note' })].join(
      '\n',
    );
    const parsed = parseTaskActivityLog(text);
    expect(parsed.activity.map(entry => entry.seq)).toEqual([1, 2]);
    expect(parsed.parseErrors).toBe(2);
    expect(parsed.lines).toBe(4);
  });

  test.each([
    ['a wrong version', { v: 9, seq: 1, time: 't', type: 'note', data: {} }],
    ['a zero seq', { v: 1, seq: 0, time: 't', type: 'note', data: {} }],
    ['a missing time', { v: 1, seq: 1, type: 'note', data: {} }],
    ['an unknown type', { v: 1, seq: 1, time: 't', type: 'promoted', data: {} }],
  ])('skips %s', (_label, value) => {
    expect(parseTaskActivity(value)).toBeNull();
  });

  test('a missing actor reads as unknown rather than as somebody', () => {
    const entry = parseTaskActivity({ v: 1, seq: 1, time: 't', type: 'note', data: { text: 'x' } });
    expect(entry?.actor).toBe('unknown');
    expect(entry?.actorName).toBeNull();
  });
});

describe('validators refuse, never truncate', () => {
  test('over-cap text is refused with the cap and the real length in the message', () => {
    const attempt = () => validateTaskNote('n'.repeat(MAX_TASK_NOTE_LEN + 5));
    expect(attempt).toThrow(TaskError);
    expect(attempt).toThrow(`${MAX_TASK_NOTE_LEN + 5} characters`);
    expect(attempt).toThrow('not truncated');
  });

  test('titles and descriptions have their own caps', () => {
    expect(() => validateTaskTitle('t'.repeat(MAX_TASK_TITLE_LEN + 1))).toThrow(TaskError);
    expect(validateTaskTitle('  Fix questions  ')).toBe('Fix questions');
    expect(validateTaskDescription(undefined)).toBe('');
    expect(() => validateTaskDescription('d'.repeat(MAX_TASK_DESCRIPTION_LEN + 1))).toThrow('not truncated');
  });

  test('blocked and dropped REQUIRE a reason; others do not', () => {
    expect(() => resolveStatusReason('blocked', undefined)).toThrow('requires a reason');
    expect(() => resolveStatusReason('dropped', '  ')).toThrow('requires a reason');
    expect(resolveStatusReason('blocked', 'needs an API key from the user')).toBe('needs an API key from the user');
    expect(resolveStatusReason('built', undefined)).toBeNull();
    expect(resolveStatusReason('built', 'gates green')).toBe('gates green');
  });

  test('order must be a whole non-negative rank or null', () => {
    expect(validateTaskOrder(null)).toBeNull();
    expect(validateTaskOrder(3)).toBe(3);
    expect(() => validateTaskOrder(1.5)).toThrow(TaskError);
    expect(() => validateTaskOrder(-1)).toThrow(TaskError);
    expect(() => validateTaskOrder('3')).toThrow(TaskError);
  });
});

describe('board ordering is total and deterministic', () => {
  test('status group, then rank, then id number', () => {
    const tasks = [
      record({ id: 'F9', kind: 'feature', status: 'todo' }),
      record({ id: 'F2', kind: 'feature', status: 'live' }),
      record({ id: 'F10', kind: 'feature', status: 'live', order: 1 }),
      record({ id: 'B1', kind: 'bug', status: 'blocked', statusReason: 'needs the user' }),
    ];
    expect([...tasks].sort(compareTasks).map(task => task.id)).toEqual(['F10', 'F2', 'F9', 'B1']);
  });
});

describe('the store is daemon-only for writes', () => {
  test('a reader store refuses every write and says where to send it', async () => {
    const reader = new TaskStore(paths);
    expect(reader.writable).toBe(false);
    await expect(reader.writeTask(record())).rejects.toThrow('/v1/tasks');
    await expect(reader.appendActivity('F1', { type: 'note' })).rejects.toThrow(TaskError);
    await expect(reader.allocateId('bug')).rejects.toThrow('daemon-owned');
  });

  test('a reader store can still READ everything', async () => {
    const daemon = new TaskStore(paths, { role: 'daemon' });
    await daemon.writeTask(record());
    const reader = new TaskStore(paths);
    expect((await reader.readTask('f1'))?.title).toBe('File browser');
  });
});

describe('ids are monotonic per kind and never recycled', () => {
  test('allocation is per-kind and matches the board vocabulary', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    expect(await store.allocateId('bug')).toBe('B1');
    expect(await store.allocateId('bug')).toBe('B2');
    expect(await store.allocateId('feature')).toBe('F1');
    expect(await store.allocateId('infra')).toBe('I1');
    expect(await store.allocateId('chore')).toBe('C1');
  });

  test('concurrent allocations never collide', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    const ids = await Promise.all(Array.from({ length: 12 }, () => store.allocateId('feature')));
    expect(new Set(ids).size).toBe(12);
    expect([...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).at(-1)).toBe('F12');
  });

  test('a lost counters.json self-heals from the directories on disk', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    await store.writeTask(record({ id: 'F7' }));
    await rm(taskPaths(paths).counters, { force: true });
    expect(await store.allocateId('feature')).toBe('F8');
  });

  test('a deleted task does not hand its id to the next task', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    expect(await store.allocateId('feature')).toBe('F1');
    expect(await store.allocateId('feature')).toBe('F2');
    await rm(taskPaths(paths).taskDir('F2'), { recursive: true, force: true });
    expect(await store.allocateId('feature')).toBe('F3');
  });

  test('a damaged counters file degrades to the directory scan', () => {
    expect(parseTaskCounters('{ not json')).toEqual({ v: TASK_SCHEMA_VERSION, counters: {} });
    expect(parseTaskCounters(JSON.stringify({ v: 99, counters: { bug: 4 } })).counters).toEqual({});
    expect(parseTaskCounters(JSON.stringify({ v: 1, counters: { bug: 4, feature: 'x' } })).counters).toEqual({
      bug: 4,
    });
  });
});

describe('activity appends are gap-free', () => {
  test('seq starts at 1 and increments with no gaps under concurrency', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    await store.writeTask(record());
    await Promise.all(
      Array.from({ length: 25 }, (_unused, index) => store.appendActivity('F1', { type: 'note', data: { index } })),
    );
    const { activity, parseErrors } = await store.readActivity('F1');
    expect(parseErrors).toBe(0);
    expect(activity.map(entry => entry.seq)).toEqual(Array.from({ length: 25 }, (_unused, index) => index + 1));
  });

  test('a fresh daemon process continues the sequence from disk', async () => {
    const first = new TaskStore(paths, { role: 'daemon' });
    await first.appendActivity('F1', { type: 'created', data: {} });
    await first.appendActivity('F1', { type: 'note', data: {} });
    const restarted = new TaskStore(paths, { role: 'daemon' });
    expect((await restarted.appendActivity('F1', { type: 'note', data: {} })).seq).toBe(3);
  });

  test('a corrupt line cannot cause a duplicate seq', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    await store.appendActivity('F1', { type: 'created', data: {} });
    await store.appendActivity('F1', { type: 'note', data: {} });
    // Damage the tail the way a torn tail would, then restart the process.
    await appendFile(store.activityFile('F1'), '{"v":1,"seq":3,"time":\n');
    const restarted = new TaskStore(paths, { role: 'daemon' });
    const appended = await restarted.appendActivity('F1', { type: 'note', data: {} });
    expect(appended.seq).toBe(4);
    const { activity, parseErrors } = await restarted.readActivity('F1');
    expect(parseErrors).toBe(1);
    expect(new Set(activity.map(entry => entry.seq)).size).toBe(activity.length);
  });

  test('appends are one line each, so history can only lose a tail', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    await store.appendActivity('F1', { type: 'note', data: { text: 'multi\nline\nnote' } });
    const text = await readFile(store.activityFile('F1'), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });

  test('`after` serves the incremental fetch', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    for (const index of [1, 2, 3, 4]) await store.appendActivity('F1', { type: 'note', data: { index } });
    expect((await store.readActivity('F1', 2)).activity.map(entry => entry.seq)).toEqual([3, 4]);
  });
});

describe('listing degrades one row at a time', () => {
  test('a corrupt record costs its own row and is reported, never thrown', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    await store.writeTask(record({ id: 'F1' }));
    await store.writeTask(record({ id: 'F2', title: 'Second' }));
    await writeFile(store.recordFile('F2'), '{ torn write');
    const listed = await store.listTasks();
    expect(listed.tasks.map(task => task.id)).toEqual(['F1']);
    expect(listed.parseErrors).toBe(1);
    expect(listed.parseErrorIds).toEqual(['F2']);
  });

  test('an unversioned record is skipped rather than misread', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    await seed(store, { ...record({ id: 'F3' }), v: 2 });
    const listed = await store.listTasks();
    expect(listed.tasks).toHaveLength(0);
    expect(listed.parseErrors).toBe(1);
  });

  test('non-task directories are ignored, not counted as damage', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    await store.writeTask(record());
    await mkdir(path.join(store.dir, 'not-a-task'), { recursive: true });
    const listed = await store.listTasks();
    expect(listed.tasks).toHaveLength(1);
    expect(listed.parseErrors).toBe(0);
  });

  test('an id directory with no record yet is not damage either', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    await mkdir(taskPaths(paths).taskDir('F4'), { recursive: true });
    const listed = await store.listTasks();
    expect(listed.parseErrors).toBe(0);
  });

  test('filters AND together', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    await store.writeTask(record({ id: 'F1', repo: '/a', assignee: 'ines', status: 'built' }));
    await store.writeTask(record({ id: 'F2', repo: '/b', assignee: 'ines', status: 'built' }));
    await store.writeTask(record({ id: 'B1', kind: 'bug', repo: '/a', assignee: 'sasha', status: 'live' }));
    expect((await store.listTasks({ repo: '/a' })).tasks.map(task => task.id)).toEqual(['B1', 'F1']);
    expect((await store.listTasks({ assignee: 'ines', status: 'built' })).tasks.map(task => task.id)).toEqual([
      'F1',
      'F2',
    ]);
    expect((await store.listTasks({ kind: 'bug' })).tasks.map(task => task.id)).toEqual(['B1']);
    expect((await store.listTasks({ status: ['live', 'built'], repo: '/b' })).tasks.map(task => task.id)).toEqual([
      'F2',
    ]);
  });

  test('an unreadable task reads as absent, never as a throw', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    expect(await store.readTask('F99')).toBeUndefined();
    expect(await store.readTask('nonsense')).toBeUndefined();
    expect(await store.readActivity('nonsense')).toEqual({ activity: [], parseErrors: 0, lines: 0 });
  });
});

describe('write serialisation', () => {
  test('records are replaced atomically — a reader never sees a partial file', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    await store.writeTask(record());
    // atomicJson leaves no stray temp files behind after the rename.
    const { readdir } = await import('fs/promises');
    const entries = await readdir(taskPaths(paths).taskDir('F1'));
    expect(entries.filter(entry => entry.includes('.tmp.'))).toHaveLength(0);
    expect(JSON.parse(await readFile(store.recordFile('F1'), 'utf8')).title).toBe('File browser');
  });

  test('writes to the same task run in order, and a failure does not poison the queue', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const slow = queue.run('k', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      order.push('first');
    });
    const failing = queue.run('k', async () => {
      order.push('second');
      throw new Error('boom');
    });
    const after = queue.run('k', async () => {
      order.push('third');
    });
    await slow;
    await expect(failing).rejects.toThrow('boom');
    await after;
    expect(order).toEqual(['first', 'second', 'third']);
  });

  test('the queue does not leak a chain per key forever', async () => {
    const queue = new SerialQueue();
    await Promise.all(Array.from({ length: 5 }, (_unused, index) => queue.run(`k${index}`, async () => index)));
    await Promise.resolve();
    expect(queue.size).toBe(0);
  });

  test('transact holds the lock across read → write → append', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    await store.writeTask(record({ status: 'todo' }));
    const seen: (string | undefined)[] = [];
    // Two transactions issued in the same tick. The second must observe the
    // first one's record, which is the whole point: with the read outside the
    // lock both saw `todo` and the later write reverted the other.
    await Promise.all([
      store.transact('F1', async mutation => {
        seen.push(mutation.current?.status);
        await new Promise(resolve => setTimeout(resolve, 10));
        await mutation.write(record({ status: 'built' }));
        await mutation.append({ type: 'status', data: { to: 'built' } });
      }),
      store.transact('F1', async mutation => {
        seen.push(mutation.current?.status);
        await mutation.write({ ...(mutation.current ?? record()) });
        await mutation.append({ type: 'note', data: { text: 'concurrent' } });
      }),
    ]);
    expect(seen).toEqual(['todo', 'built']);
    expect((await store.readTask('F1'))?.status).toBe('built');
    expect((await store.readActivity('F1')).activity.map(entry => entry.seq)).toEqual([1, 2]);
  });

  test('transact reports a missing task as `current: undefined` rather than inventing one', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    expect(await store.transact('F5', async mutation => mutation.current)).toBeUndefined();
  });

  test('a reader store cannot open a transaction at all', async () => {
    const reader = new TaskStore(paths);
    await expect(reader.transact('F1', async () => undefined)).rejects.toThrow('daemon-owned');
  });

  test('writeTask stamps updatedAt and keeps createdAt', async () => {
    const store = new TaskStore(paths, { role: 'daemon' });
    const written = await store.writeTask(record(), { updatedAt: '2026-07-27T05:00:00.000Z' });
    expect(written.updatedAt).toBe('2026-07-27T05:00:00.000Z');
    expect(written.createdAt).toBe(record().createdAt);
    const stamped = await store.writeTask(record());
    expect(Date.parse(stamped.updatedAt)).toBeGreaterThan(Date.parse(record().createdAt));
  });
});
