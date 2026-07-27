import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, markerFile, type KTeamPaths } from './paths';
import { TaskService, type TaskDeps } from './tasks';
import type { TaskAssigneeView } from './tasks-live';
import { MAX_TASK_DESCRIPTION_LEN, MAX_TASK_LINKS_PER_FIELD, MAX_TASK_NOTE_LEN, TaskError } from './tasks-types';

let home: string;
let paths: KTeamPaths;
let fleet: TaskAssigneeView[];
let service: TaskService;

const deps: TaskDeps = { list: async () => fleet };

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-tasks-service-'));
  paths = createPaths(home);
  fleet = [];
  service = new TaskService(paths, deps);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const session = (over: { id: string; status?: string; teammate?: string; turn?: number }): TaskAssigneeView => ({
  config: { id: over.id, teammate: over.teammate ?? over.id, turn: over.turn ?? 1 },
  state: { status: over.status ?? 'running', turn: over.turn ?? 1, lastActivityAt: '2026-07-27T02:00:00.000Z' },
});

async function created(over: Record<string, unknown> = {}) {
  return service.taskCreate({
    kind: 'feature',
    title: 'File browser',
    description: '## Brief\nchanges-first viewer',
    actor: 'ms-lead',
    actorName: 'zelda',
    ...over,
  } as Parameters<TaskService['taskCreate']>[0]);
}

describe('create', () => {
  test('assigns the board vocabulary id, defaults to todo, and opens the history', async () => {
    const task = await created();
    expect(task.id).toBe('F1');
    expect(task.status).toBe('todo');
    expect(task.createdBy).toBe('ms-lead');
    const detail = await service.taskDetail('F1');
    expect(detail?.activity).toHaveLength(1);
    expect(detail?.activity[0]).toMatchObject({
      seq: 1,
      type: 'created',
      actor: 'ms-lead',
      actorName: 'zelda',
      data: { status: 'todo', kind: 'feature', title: 'File browser' },
    });
  });

  test('the brief is stored verbatim, not summarised', async () => {
    const description = '## Symptom\nStructured questions never reach the UI\n\n## Acceptance\n- renders\n';
    const task = await created({ description });
    expect((await service.taskDetail(task.id))?.task.description).toBe(description);
  });

  test('kinds map to their own counters', async () => {
    expect((await created({ kind: 'bug', title: 'Questions lost' })).id).toBe('B1');
    expect((await created({ kind: 'infra', title: 'Box backup' })).id).toBe('I1');
    expect((await created({ kind: 'chore', title: 'Bump deps' })).id).toBe('C1');
    expect((await created({ kind: 'bug', title: 'Second bug' })).id).toBe('B2');
  });

  test('concurrent creates get distinct ids and distinct records', async () => {
    const tasks = await Promise.all(Array.from({ length: 8 }, (_unused, index) => created({ title: `T${index}` })));
    expect(new Set(tasks.map(task => task.id)).size).toBe(8);
    const listed = await service.taskList();
    expect(listed.tasks).toHaveLength(8);
    expect(listed.parseErrors).toBe(0);
  });

  test('creating straight into blocked still requires a reason', async () => {
    await expect(created({ status: 'blocked' })).rejects.toThrow('requires a reason');
    const task = await created({ status: 'blocked', statusReason: 'needs an API key from the user' });
    expect(task.statusReason).toBe('needs an API key from the user');
  });

  test('an over-cap brief is REFUSED, never truncated', async () => {
    const attempt = created({ description: 'x'.repeat(MAX_TASK_DESCRIPTION_LEN + 1) });
    await expect(attempt).rejects.toThrow(TaskError);
    await expect(attempt).rejects.toThrow('not truncated');
    // and nothing was written
    expect((await service.taskList()).tasks).toHaveLength(0);
  });

  test('an invalid kind or a blank title is refused', async () => {
    await expect(created({ kind: 'epic' })).rejects.toThrow('kind must be one of');
    await expect(created({ title: '   ' })).rejects.toThrow('title is required');
  });

  test('links supplied at create time are validated and de-duplicated', async () => {
    const task = await created({
      links: { prs: ['https://gh/1', 'https://gh/1'], branch: 'feat/browser', commits: ['abc'], docs: ['~/brief.md'] },
    });
    expect(task.links).toEqual({
      prs: ['https://gh/1'],
      branch: 'feat/browser',
      commits: ['abc'],
      docs: ['~/brief.md'],
    });
  });
});

describe('status action', () => {
  test('records from → to with the note in the log, and bumps the record', async () => {
    await created();
    const updated = await service.taskAct('F1', {
      action: 'status',
      status: 'built',
      note: '590 tests green, not deployed',
      actor: 'ms-sasha',
      actorName: 'sasha',
    });
    expect(updated.status).toBe('built');
    const detail = await service.taskDetail('F1');
    expect(detail?.activity.at(-1)).toMatchObject({
      seq: 2,
      type: 'status',
      actorName: 'sasha',
      data: { from: 'todo', to: 'built', note: '590 tests green, not deployed' },
    });
  });

  test('blocked and dropped refuse to be set without a reason', async () => {
    await created();
    await expect(service.taskAct('F1', { action: 'status', status: 'blocked' })).rejects.toThrow('requires a reason');
    await expect(service.taskAct('F1', { action: 'status', status: 'dropped', reason: '  ' })).rejects.toThrow(
      'requires a reason',
    );
    // the refusal changed nothing
    expect((await service.taskDetail('F1'))?.task.status).toBe('todo');
    expect((await service.taskDetail('F1'))?.activity).toHaveLength(1);
  });

  test('leaving blocked clears the stale reason from the record but keeps it in history', async () => {
    await created();
    await service.taskAct('F1', { action: 'status', status: 'blocked', reason: 'needs the age key' });
    const back = await service.taskAct('F1', { action: 'status', status: 'in_progress' });
    expect(back.statusReason).toBeNull();
    const detail = await service.taskDetail('F1');
    expect(JSON.stringify(detail?.activity)).toContain('needs the age key');
  });

  test('an over-cap note is refused before anything is written', async () => {
    await created();
    await expect(
      service.taskAct('F1', { action: 'status', status: 'built', note: 'n'.repeat(MAX_TASK_NOTE_LEN + 1) }),
    ).rejects.toThrow('not truncated');
    expect((await service.taskDetail('F1'))?.task.status).toBe('todo');
  });

  test('an unknown status is refused', async () => {
    await created();
    await expect(service.taskAct('F1', { action: 'status', status: 'shipped' as 'built' })).rejects.toThrow(
      'status must be one of',
    );
  });
});

describe('note, link, assign and order actions', () => {
  test('notes and feedback append history and touch updatedAt without changing status', async () => {
    const task = await created();
    await service.taskAct('F1', { action: 'note', text: 'fs API needs a path-escape guard' });
    const view = await service.taskAct('F1', {
      action: 'feedback',
      text: 'diff view should default to changes-only',
      actor: 'user',
      actorName: 'user',
    });
    expect(view.status).toBe(task.status);
    const detail = await service.taskDetail('F1');
    expect(detail?.activity.map(entry => entry.type)).toEqual(['created', 'note', 'feedback']);
    expect(Date.parse(view.updatedAt)).toBeGreaterThanOrEqual(Date.parse(task.updatedAt));
  });

  test('a blank note is refused', async () => {
    await created();
    await expect(service.taskAct('F1', { action: 'note', text: '  ' })).rejects.toThrow('may not be blank');
  });

  test('links append, dedupe, and branch is last-write-wins', async () => {
    await created();
    await service.taskAct('F1', { action: 'link', field: 'pr', value: 'https://github.com/o/r/pull/1' });
    await service.taskAct('F1', { action: 'link', field: 'pr', value: 'https://github.com/o/r/pull/1' });
    await service.taskAct('F1', { action: 'link', field: 'commit', value: '1cdc820' });
    await service.taskAct('F1', { action: 'link', field: 'doc', value: '~/.kteam/x/brief.md' });
    await service.taskAct('F1', { action: 'link', field: 'branch', value: 'feat/a' });
    const view = await service.taskAct('F1', { action: 'link', field: 'branch', value: 'feat/b' });
    expect(view.links).toEqual({
      prs: ['https://github.com/o/r/pull/1'],
      branch: 'feat/b',
      commits: ['1cdc820'],
      docs: ['~/.kteam/x/brief.md'],
    });
  });

  test('a full link list is refused, not silently dropped', async () => {
    await created();
    for (let index = 0; index < MAX_TASK_LINKS_PER_FIELD; index += 1) {
      await service.taskAct('F1', { action: 'link', field: 'commit', value: `sha-${index}` });
    }
    await expect(service.taskAct('F1', { action: 'link', field: 'commit', value: 'one-too-many' })).rejects.toThrow(
      'the maximum is',
    );
  });

  test('assign and unassign are both recorded', async () => {
    await created({ assignee: 'ines' });
    const reassigned = await service.taskAct('F1', { action: 'assign', assignee: 'sasha' });
    expect(reassigned.assignee).toBe('sasha');
    const unassigned = await service.taskAct('F1', { action: 'assign', assignee: null });
    expect(unassigned.assignee).toBeNull();
    const detail = await service.taskDetail('F1');
    expect(detail?.activity.slice(-2).map(entry => entry.data)).toEqual([
      { from: 'ines', to: 'sasha' },
      { from: 'sasha', to: null },
    ]);
  });

  test('order ranks and unranks, and refuses junk', async () => {
    await created();
    expect((await service.taskAct('F1', { action: 'order', order: 3 })).order).toBe(3);
    expect((await service.taskAct('F1', { action: 'order', order: null })).order).toBeNull();
    await expect(service.taskAct('F1', { action: 'order', order: -2 })).rejects.toThrow('non-negative');
  });

  test('acting on a missing task is a not-found TaskError', async () => {
    await expect(service.taskAct('F9', { action: 'note', text: 'x' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(service.taskAct('nonsense', { action: 'note', text: 'x' })).rejects.toMatchObject({ code: 'invalid' });
  });

  test('an unknown action never silently no-ops', async () => {
    await created();
    await expect(
      service.taskAct('F1', { action: 'promote' } as unknown as { action: 'note'; text: string }),
    ).rejects.toThrow('unknown task action');
  });

  test('every mutation keeps the activity sequence gap-free', async () => {
    await created();
    await service.taskAct('F1', { action: 'assign', assignee: 'ines' });
    await service.taskAct('F1', { action: 'status', status: 'in_progress' });
    await service.taskAct('F1', { action: 'note', text: 'started' });
    await service.taskAct('F1', { action: 'order', order: 1 });
    const detail = await service.taskDetail('F1');
    expect(detail?.activity.map(entry => entry.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('concurrent actions on one task cannot lose an update', () => {
  // Regression: the read used to happen OUTSIDE the per-task lock, so a `note`
  // and a `status` posted in the same tick both read the old record and the
  // later write reverted the other's declared fields. Every action is now one
  // read→write→append transaction under a single hold of the task's lock.
  test('a note posted alongside a status change never reverts the status', async () => {
    await created();
    const [, noted] = await Promise.all([
      service.taskAct('F1', { action: 'status', status: 'built', note: 'gates green' }),
      service.taskAct('F1', { action: 'note', text: 'concurrent note' }),
    ]);
    expect(noted.status).toBe('built');
    const detail = await service.taskDetail('F1');
    expect(detail?.task.status).toBe('built');
    // Both events survive — the log is the audit trail that makes last-write-wins
    // acceptable (design §6).
    expect(detail?.activity.map(entry => entry.type)).toEqual(['created', 'status', 'note']);
    expect(detail?.activity.map(entry => entry.seq)).toEqual([1, 2, 3]);
    expect(JSON.parse(await readFile(service.tasks.recordFile('F1'), 'utf8')).status).toBe('built');
  });

  test('a burst of different actions all land, and none clobbers another field', async () => {
    await created({ assignee: null });
    await Promise.all([
      service.taskAct('F1', { action: 'status', status: 'in_progress' }),
      service.taskAct('F1', { action: 'assign', assignee: 'ines' }),
      service.taskAct('F1', { action: 'order', order: 2 }),
      service.taskAct('F1', { action: 'link', field: 'branch', value: 'feat/browser' }),
      service.taskAct('F1', { action: 'note', text: 'one' }),
      service.taskAct('F1', { action: 'feedback', text: 'two' }),
    ]);
    const detail = await service.taskDetail('F1');
    expect(detail?.task).toMatchObject({
      status: 'in_progress',
      assignee: 'ines',
      order: 2,
      links: { branch: 'feat/browser' },
    });
    expect(detail?.activity.map(entry => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(detail?.activityParseErrors).toBeUndefined();
  });

  test('two status writes both appear in history and the LAST one is declared', async () => {
    await created();
    await Promise.all([
      service.taskAct('F1', { action: 'status', status: 'built', actor: 'ms-a', actorName: 'ines' }),
      service.taskAct('F1', { action: 'status', status: 'live', actor: 'ms-b', actorName: 'sasha' }),
    ]);
    const detail = await service.taskDetail('F1');
    const statuses = detail?.activity.filter(entry => entry.type === 'status') ?? [];
    expect(statuses).toHaveLength(2);
    // The second transaction read the first one's result, so the log chains
    // correctly instead of both claiming to have started from `todo`.
    expect(statuses[1]?.data['from']).toBe(statuses[0]?.data['to']);
    expect(detail?.task.status as string).toBe(String(statuses[1]?.data['to']));
  });

  test('a refused action inside the transaction writes nothing at all', async () => {
    await created();
    const [refused, accepted] = await Promise.allSettled([
      service.taskAct('F1', { action: 'status', status: 'blocked' }),
      service.taskAct('F1', { action: 'note', text: 'still fine' }),
    ]);
    expect(refused.status).toBe('rejected');
    expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: 'reason-required' });
    // A refusal must not poison the queue: the queued note still ran.
    expect(accepted.status).toBe('fulfilled');
    const detail = await service.taskDetail('F1');
    expect(detail?.task.status).toBe('todo');
    expect(detail?.activity.map(entry => entry.type)).toEqual(['created', 'note']);
  });
});

describe('reads join derived liveness without ever storing it', () => {
  test('a task whose assignee failed is flagged, and its declared status is untouched', async () => {
    await created({ assignee: 'ines', status: 'in_progress' });
    fleet = [session({ id: 'ms-ines', teammate: 'ines', status: 'failed' })];
    const detail = await service.taskDetail('F1');
    expect(detail?.task.status).toBe('in_progress');
    expect(detail?.task.live).toMatchObject({
      assigneeStatus: 'failed',
      assigneeHealth: 'dead',
      staleness: 'assignee-dead',
    });
    // The file on disk carries no derived verdict at all.
    const raw = await readFile(service.tasks.recordFile('F1'), 'utf8');
    expect(raw).not.toContain('live');
    expect(raw).not.toContain('assignee-dead');
    expect(JSON.parse(raw).status).toBe('in_progress');
  });

  test('a done marker surfaces as maybe-finished, and the status still does not move', async () => {
    await created({ assignee: 'ms-ines', status: 'in_progress' });
    fleet = [session({ id: 'ms-ines', status: 'running', turn: 4 })];
    const file = markerFile(paths, 'ms-ines', 'done');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ turn: 4, at: '2026-07-27T03:00:00.000Z' }));
    const detail = await service.taskDetail('F1');
    expect(detail?.task.live.assigneeDoneMarker).toBe(true);
    expect(detail?.task.live.staleness).toBe('maybe-finished');
    expect(detail?.task.status).toBe('in_progress');
  });

  test('a fleet listing failure degrades to unannotated rows instead of failing the read', async () => {
    await created({ assignee: 'ines', status: 'in_progress' });
    const broken = new TaskService(paths, {
      list: async () => {
        throw new Error('daemon busy');
      },
    });
    const listed = await broken.taskList();
    expect(listed.tasks[0]?.live.staleness).toBe('assignee-dead');
    expect(listed.tasks[0]?.status).toBe('in_progress');
  });
});

describe('list and detail shapes', () => {
  test('list rows omit the brief but report its size', async () => {
    await created({ description: 'x'.repeat(1000) });
    const listed = await service.taskList();
    expect(listed.tasks[0]).not.toHaveProperty('description');
    expect(listed.tasks[0]?.descriptionChars).toBe(1000);
    expect(listed.parseErrors).toBe(0);
  });

  test('list filters by repo, status, assignee and kind', async () => {
    await created({ repo: '/a', assignee: 'ines' });
    await created({ repo: '/b', assignee: 'sasha' });
    await created({ kind: 'bug', title: 'Questions lost', repo: '/a', assignee: 'ines' });
    expect((await service.taskList({ repo: '/a' })).tasks.map(task => task.id).sort()).toEqual(['B1', 'F1']);
    expect((await service.taskList({ assignee: 'sasha' })).tasks.map(task => task.id)).toEqual(['F2']);
    expect((await service.taskList({ kind: 'bug' })).tasks.map(task => task.id)).toEqual(['B1']);
    expect((await service.taskList({ status: 'built' })).tasks).toHaveLength(0);
  });

  test('a corrupt record costs one row and is counted, never thrown', async () => {
    await created();
    await created({ title: 'Second' });
    await writeFile(service.tasks.recordFile('F2'), '{ torn write');
    const listed = await service.taskList();
    expect(listed.tasks.map(task => task.id)).toEqual(['F1']);
    expect(listed.parseErrors).toBe(1);
    expect(listed.parseErrorIds).toEqual(['F2']);
  });

  test('detail is undefined for an unknown or unreadable task', async () => {
    expect(await service.taskDetail('F9')).toBeUndefined();
    await created();
    await writeFile(service.tasks.recordFile('F1'), 'nope');
    expect(await service.taskDetail('F1')).toBeUndefined();
  });

  test('detail supports the incremental fetch and reports damaged history', async () => {
    await created();
    await service.taskAct('F1', { action: 'note', text: 'one' });
    await service.taskAct('F1', { action: 'note', text: 'two' });
    expect((await service.taskDetail('F1', 2))?.activity.map(entry => entry.seq)).toEqual([3]);
    await writeFile(service.tasks.activityFile('F1'), '{ broken\n');
    const detail = await service.taskDetail('F1');
    expect(detail?.activityParseErrors).toBe(1);
    expect(detail?.activity).toEqual([]);
  });

  test('a lower-case id reference resolves', async () => {
    await created();
    expect((await service.taskDetail('f1'))?.task.id).toBe('F1');
  });
});
