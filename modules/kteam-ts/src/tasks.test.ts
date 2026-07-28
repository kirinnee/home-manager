import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, markerFile, type KTeamPaths } from './paths';
import { TaskService, type TaskDeps } from './tasks';
import type { TaskAssigneeView } from './tasks-live';
import { MAX_TASK_DESCRIPTION_LEN, MAX_TASK_LINKS_PER_FIELD, MAX_TASK_NOTE_LEN, TaskError } from './tasks-types';
import type { KTeamEvent } from './types';

let home: string;
let paths: KTeamPaths;
let fleet: TaskAssigneeView[];
let service: TaskService;

const deps: TaskDeps = { list: async () => fleet };

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-tasks-service-'));
  paths = createPaths(home);
  fleet = [session({ id: 'ms-lead', teammate: 'zelda' })];
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
    ask: {
      text: 'Please build a changes-first file browser.',
      source: 'kteam://messages/ms-lead/1',
    },
    actor: 'ms-lead',
    actorName: 'zelda',
    ...over,
  } as Parameters<TaskService['taskCreate']>[0]);
}

const completionEvent = (sessionId: string, turn = 3): KTeamEvent => ({
  sequence: 17,
  time: '2027-07-27T03:00:00.000Z',
  sessionId,
  turn,
  type: 'session.completed',
  source: 'daemon',
  data: { status: 'completed' },
});

describe('create', () => {
  test('assigns the board vocabulary id, defaults to todo, and opens the history', async () => {
    const task = await created();
    expect(task.id).toBe('F1');
    expect(task.status).toBe('todo');
    expect(task.phase).toBe('todo');
    expect(task.workflow).toBe('quick');
    expect(task.ask).toEqual({
      text: 'Please build a changes-first file browser.',
      source: 'kteam://messages/ms-lead/1',
    });
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
    await expect(created({ ask: { text: '   ', source: 'kteam://messages/ms-lead/1' } })).rejects.toThrow(
      'ask.text is required',
    );
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
      status: 'in_progress',
      reason: 'The ask is clear enough to start building.',
      note: 'Implementation began in the assigned session.',
      actor: 'ms-lead',
      actorName: 'zelda',
    });
    expect(updated.status).toBe('in_progress');
    expect(updated.phase).toBe('build');
    const detail = await service.taskDetail('F1');
    expect(detail?.activity.at(-1)).toMatchObject({
      seq: 2,
      type: 'status',
      actorName: 'zelda',
      data: {
        from: 'todo',
        to: 'in_progress',
        phaseFrom: 'todo',
        phaseTo: 'build',
        reason: 'The ask is clear enough to start building.',
        note: 'Implementation began in the assigned session.',
      },
    });
  });

  test('manual blocks and every phase move refuse to be set without a reason', async () => {
    await created();
    await expect(service.taskAct('F1', { action: 'status', status: 'blocked' })).rejects.toThrow('requires a reason');
    await expect(service.taskAct('F1', { action: 'status', status: 'dropped', reason: '  ' })).rejects.toThrow(
      'require a reason',
    );
    await expect(service.taskAct('F1', { action: 'status', status: 'in_progress' })).rejects.toMatchObject({
      code: 'reason-required',
    });
    // the refusal changed nothing
    expect((await service.taskDetail('F1'))?.task.status).toBe('todo');
    expect((await service.taskDetail('F1'))?.activity).toHaveLength(1);
  });

  test('leaving blocked clears the stale reason from the record but keeps it in history', async () => {
    await created();
    await service.taskAct('F1', { action: 'status', status: 'blocked', reason: 'needs the age key' });
    const back = await service.taskAct('F1', {
      action: 'status',
      status: 'todo',
      reason: 'The age key was supplied.',
    });
    expect(back.statusReason).toBeNull();
    const detail = await service.taskDetail('F1');
    expect(JSON.stringify(detail?.activity)).toContain('needs the age key');
  });

  test('an over-cap note is refused before anything is written', async () => {
    await created();
    await expect(
      service.taskAct('F1', {
        action: 'status',
        status: 'in_progress',
        reason: 'Start the build.',
        note: 'n'.repeat(MAX_TASK_NOTE_LEN + 1),
      }),
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

describe('v2 workflow, ask, DAG, and delegated completion', () => {
  test('clarifications preserve the later human words and their own source link', async () => {
    await created();
    const clarified = await service.taskAct('#f1', {
      action: 'clarify',
      text: 'Keep unchanged files hidden by default.',
      source: 'kteam://messages/ms-lead/2',
      actor: 'user',
    });
    expect(clarified.clarifications).toEqual([
      {
        text: 'Keep unchanged files hidden by default.',
        source: 'kteam://messages/ms-lead/2',
        at: expect.any(String),
        by: 'user',
        byName: 'user',
      },
    ]);
    expect((await service.taskDetail('F1'))?.activity.at(-1)).toMatchObject({
      type: 'clarification',
      data: {
        text: 'Keep unchanged files hidden by default.',
        source: 'kteam://messages/ms-lead/2',
      },
    });
  });

  test('research and design may be entered by an agent but only exited by the human', async () => {
    await created({ workflow: 'research-first' });
    await service.taskAct('F1', {
      action: 'phase',
      phase: 'research',
      reason: 'Investigate the viable APIs.',
      actor: 'ms-lead',
      actorName: 'zelda',
    });
    await expect(
      service.taskAct('F1', {
        action: 'phase',
        phase: 'design',
        reason: 'Research is complete.',
        actor: 'ms-lead',
        actorName: 'zelda',
      }),
    ).rejects.toMatchObject({ code: 'approval-required' });

    const designed = await service.taskAct('F1', {
      action: 'phase',
      phase: 'design',
      reason: 'The human approved the research.',
      actor: 'user',
    });
    expect(designed.phase).toBe('design');
    expect((await service.taskDetail('F1'))?.activity.at(-1)?.data).toMatchObject({ approvedByHuman: true });

    await expect(
      service.taskAct('F1', {
        action: 'phase',
        phase: 'build',
        reason: 'The design looks implementable.',
        actor: 'ms-lead',
      }),
    ).rejects.toMatchObject({ code: 'approval-required' });
    const building = await service.taskAct('F1', {
      action: 'phase',
      phase: 'build',
      reason: 'The human approved the design.',
      actor: 'user',
    });
    expect(building).toMatchObject({ phase: 'build', status: 'in_progress' });
    await expect(
      service.taskAct('F1', { action: 'phase', phase: 'live', reason: 'Skip the built checkpoint.', actor: 'user' }),
    ).rejects.toMatchObject({ code: 'transition' });
  });

  test('investigate ends at done after human research approval and never enters build', async () => {
    await created({ workflow: 'investigate' });
    await service.taskAct('F1', {
      action: 'phase',
      phase: 'research',
      reason: 'Collect evidence for the investigation.',
      actor: 'ms-lead',
    });
    await expect(
      service.taskAct('F1', { action: 'phase', phase: 'build', reason: 'Try to build it.', actor: 'user' }),
    ).rejects.toMatchObject({ code: 'transition' });
    const done = await service.taskAct('F1', {
      action: 'phase',
      phase: 'done',
      reason: 'The human accepted the investigation document.',
      actor: 'user',
    });
    expect(done).toMatchObject({ phase: 'done', status: 'done' });
  });

  test('dependencies block visibly, cycles are refused, and dependents prevent dropping', async () => {
    await created({ title: 'Foundation' });
    await created({ title: 'Consumer', dependsOn: ['#f1'] });

    const consumer = await service.taskDetail('F2');
    expect(consumer?.task).toMatchObject({
      blocked: true,
      blockedReason: 'Waiting on #F1',
      blockedBy: ['F1'],
    });
    await expect(service.taskAct('F1', { action: 'dependency', taskId: '#F2' })).rejects.toMatchObject({
      code: 'cycle',
    });
    await expect(
      service.taskAct('F1', { action: 'phase', phase: 'dropped', reason: 'No longer needed.' }),
    ).rejects.toMatchObject({ code: 'dependency-conflict' });

    await service.taskAct('F1', { action: 'phase', phase: 'build', reason: 'Start the dependency.' });
    await service.taskAct('F1', { action: 'phase', phase: 'built', reason: 'The dependency is built.' });
    expect((await service.taskDetail('F2'))?.task).toMatchObject({ blocked: false, blockedBy: [] });

    await service.taskAct('F2', { action: 'dependency', taskId: 'F1', remove: true });
    const dropped = await service.taskAct('F1', {
      action: 'phase',
      phase: 'dropped',
      reason: 'The consumer no longer depends on it.',
    });
    expect(dropped.phase).toBe('dropped');
  });

  test('a missing dependency is refused before the new task record is written', async () => {
    await expect(created({ dependsOn: ['#F99'] })).rejects.toMatchObject({ code: 'not-found' });
    expect((await service.taskList()).tasks).toHaveLength(0);
  });

  test('a completion claim advances active build only to built and is idempotent per turn', async () => {
    fleet.push(session({ id: 'ms-builder', teammate: 'builder', turn: 3 }));
    await created({ assignee: 'ms-builder', status: 'in_progress' });
    const event = completionEvent('ms-builder');

    // The exact stored session id remains enough even when the terminal
    // session has fallen out of a transient fleet listing.
    fleet = [];
    await service.recordSessionCompletion(event);
    await service.recordSessionCompletion(event);

    const detail = await service.taskDetail('F1');
    expect(detail?.task).toMatchObject({ phase: 'built', status: 'built' });
    expect(detail?.task.status).not.toBe('live');
    expect(detail?.activity.filter(entry => entry.type === 'session')).toHaveLength(1);
    expect(detail?.activity.filter(entry => entry.data['completionClaim'] === true)).toHaveLength(1);
    expect(detail?.activity.at(-1)?.data).toMatchObject({
      phaseFrom: 'build',
      phaseTo: 'built',
      completionClaim: true,
    });
  });

  test('a completion claim in research is recorded but cannot cross the approval gate', async () => {
    fleet.push(session({ id: 'ms-researcher', teammate: 'researcher', turn: 5 }));
    await created({
      assignee: 'ms-researcher',
      workflow: 'research-first',
      phase: 'research',
    });
    await service.recordSessionCompletion(completionEvent('ms-researcher', 5));

    const detail = await service.taskDetail('F1');
    expect(detail?.task).toMatchObject({
      phase: 'research',
      status: 'researched',
      blocked: true,
      blockedReason: 'Human approval is required to leave research.',
      blockedBy: [],
    });
    expect(detail?.activity.map(entry => entry.type)).toEqual(['created', 'session']);
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
    await service.taskAct('F1', { action: 'status', status: 'in_progress', reason: 'Implementation started.' });
    await service.taskAct('F1', { action: 'note', text: 'started' });
    await service.taskAct('F1', { action: 'order', order: 1 });
    const detail = await service.taskDetail('F1');
    expect(detail?.activity.map(entry => entry.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('advisory file claims', () => {
  test('files supplied at create are normalized, de-duped, persisted, and named in history', async () => {
    const task = await created({ files: ['  src/a.ts  ', 'src/a.ts', 'src/b.ts', '   '] });
    // Trimmed, blanks dropped, duplicates removed, spelling preserved.
    expect(task.files).toEqual(['src/a.ts', 'src/b.ts']);
    const detail = await service.taskDetail('F1');
    expect(detail?.task.files).toEqual(['src/a.ts', 'src/b.ts']);
    // alisa: the initial claim set is visible in authoritative history, not just the snapshot.
    expect(detail?.activity[0]).toMatchObject({ type: 'created', data: { files: ['src/a.ts', 'src/b.ts'] } });
  });

  test('a create with no files defaults to an empty claim set and omits it from history', async () => {
    const task = await created();
    expect(task.files).toEqual([]);
    const detail = await service.taskDetail('F1');
    expect(detail?.activity[0]?.data).not.toHaveProperty('files');
  });

  test('file add and remove update the set and append authoritative history naming path/operation/actor', async () => {
    await created();
    const added = await service.taskAct('F1', { action: 'file', path: '  src/api.ts ' });
    expect(added.files).toEqual(['src/api.ts']);
    const withTwo = await service.taskAct('F1', {
      action: 'file',
      path: 'src/store.ts',
      reason: 'store owns persistence',
      actor: 'ms-lead',
      actorName: 'ines',
    });
    expect(withTwo.files).toEqual(['src/api.ts', 'src/store.ts']);
    const removed = await service.taskAct('F1', { action: 'file', path: 'src/api.ts', remove: true });
    expect(removed.files).toEqual(['src/store.ts']);
    const detail = await service.taskDetail('F1');
    const fileEntries = detail?.activity.filter(entry => entry.type === 'file') ?? [];
    expect(fileEntries.map(entry => entry.data)).toEqual([
      { path: 'src/api.ts', operation: 'add' },
      { path: 'src/store.ts', operation: 'add', reason: 'store owns persistence' },
      { path: 'src/api.ts', operation: 'remove' },
    ]);
    // The actor who made the change is named on the authoritative entry.
    expect(fileEntries[1]).toMatchObject({ actor: 'ms-lead', actorName: 'ines' });
  });

  test('a reason on a file claim is optional — an add with none is accepted without friction', async () => {
    await created();
    const view = await service.taskAct('F1', { action: 'file', path: 'src/x.ts' });
    expect(view.files).toEqual(['src/x.ts']);
    const detail = await service.taskDetail('F1');
    const fileEntry = detail?.activity.find(entry => entry.type === 'file');
    expect(fileEntry?.data).toEqual({ path: 'src/x.ts', operation: 'add' });
    expect(fileEntry?.data).not.toHaveProperty('reason');
  });

  test('claiming the same path twice, or removing an unclaimed path, is refused', async () => {
    await created({ files: ['src/a.ts'] });
    await expect(service.taskAct('F1', { action: 'file', path: 'src/a.ts' })).rejects.toThrow('already claims');
    await expect(service.taskAct('F1', { action: 'file', path: 'src/z.ts', remove: true })).rejects.toThrow(
      'does not claim',
    );
    // a blank path is refused
    await expect(service.taskAct('F1', { action: 'file', path: '   ' })).rejects.toThrow('required');
  });

  test('file overlap is advisory ONLY — it derives no dependency, blocker, or Attention', async () => {
    const a = await created({ title: 'A', files: ['shared/config.ts'] });
    const b = await created({ title: 'B' });
    // B claims the very same file A already claims.
    const claimed = await service.taskAct(b.id, { action: 'file', path: 'shared/config.ts' });
    // No dependency edge is invented in either direction.
    expect(claimed.dependsOn).toEqual([]);
    expect((await service.taskDetail(a.id))?.task.dependsOn).toEqual([]);
    // No blocker is derived, and no dependency activity is written for a file claim.
    expect(claimed.blocked).toBe(false);
    const bDetail = await service.taskDetail(b.id);
    expect(bDetail?.activity.some(entry => entry.type === 'dependency')).toBe(false);
    expect(bDetail?.activity.filter(entry => entry.type === 'file')).toHaveLength(1);
  });
});

describe('concurrent actions on one task cannot lose an update', () => {
  // Regression: the read used to happen OUTSIDE the per-task lock, so a `note`
  // and a `status` posted in the same tick both read the old record and the
  // later write reverted the other's declared fields. Every action is now one
  // read→write→append transaction under a single hold of the task's lock.
  test('a note posted alongside a status change never reverts the status', async () => {
    await created({ status: 'in_progress' });
    await Promise.all([
      service.taskAct('F1', {
        action: 'status',
        status: 'built',
        reason: 'Focused gates are green.',
        note: 'gates green',
      }),
      service.taskAct('F1', { action: 'note', text: 'concurrent note' }),
    ]);
    const detail = await service.taskDetail('F1');
    expect(detail?.task.status).toBe('built');
    // Both events survive in whichever order reached the queue — scheduler
    // order is not the invariant; one mutation undoing the other would be.
    expect(
      detail?.activity
        .slice(1)
        .map(entry => entry.type)
        .sort(),
    ).toEqual(['note', 'status']);
    expect(detail?.activity.map(entry => entry.seq)).toEqual([1, 2, 3]);
    const stored = JSON.parse(await readFile(service.tasks.file('ms-lead'), 'utf8'));
    expect(stored.tasks.find((entry: { task: { id: string } }) => entry.task.id === 'F1').task.status).toBe('built');
  });

  test('a burst of different actions all land, and none clobbers another field', async () => {
    await created({ assignee: null });
    await Promise.all([
      service.taskAct('F1', {
        action: 'status',
        status: 'in_progress',
        reason: 'Implementation started.',
      }),
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
    await created({ status: 'in_progress' });
    await Promise.all([
      service.taskAct('F1', {
        action: 'status',
        status: 'built',
        reason: 'The build is complete.',
        actor: 'ms-lead',
        actorName: 'zelda',
      }),
      service.taskAct('F1', {
        action: 'status',
        status: 'live',
        reason: 'The built artifact was deployed.',
        actor: 'ms-lead',
        actorName: 'zelda',
      }),
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
    const raw = await readFile(service.tasks.file('ms-lead'), 'utf8');
    expect(raw).not.toContain('live');
    expect(raw).not.toContain('assignee-dead');
    expect(JSON.parse(raw).tasks[0].task.status).toBe('in_progress');
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
    const file = service.tasks.file('ms-lead');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.tasks.find((entry: { task: { id: string } }) => entry.task.id === 'F2').task.title = null;
    await writeFile(file, JSON.stringify(stored));
    const listed = await service.taskList();
    expect(listed.tasks.map(task => task.id)).toEqual(['F1']);
    expect(listed.parseErrors).toBe(1);
    expect(listed.parseErrorIds).toEqual(['ms-lead:F2']);
  });

  test('detail is undefined for an unknown or unreadable task', async () => {
    expect(await service.taskDetail('F9')).toBeUndefined();
    await created();
    const file = service.tasks.file('ms-lead');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.tasks.find((entry: { task: { id: string } }) => entry.task.id === 'F1').task.title = null;
    await writeFile(file, JSON.stringify(stored));
    expect(await service.taskDetail('F1')).toBeUndefined();
  });

  test('detail supports the incremental fetch and reports damaged history', async () => {
    await created();
    await service.taskAct('F1', { action: 'note', text: 'one' });
    await service.taskAct('F1', { action: 'note', text: 'two' });
    expect((await service.taskDetail('F1', 2))?.activity.map(entry => entry.seq)).toEqual([3]);
    const file = service.tasks.file('ms-lead');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.tasks.find((entry: { task: { id: string } }) => entry.task.id === 'F1').activity.push({ broken: true });
    await writeFile(file, JSON.stringify(stored));
    const detail = await service.taskDetail('F1');
    expect(detail?.activityParseErrors).toBe(1);
    expect(detail?.activity.map(entry => entry.seq)).toEqual([1, 2, 3]);
  });

  test('a lower-case id reference resolves', async () => {
    await created();
    expect((await service.taskDetail('f1'))?.task.id).toBe('F1');
  });
});

describe('session ownership, provenance, and live convergence', () => {
  test('an agent cannot write another session board', async () => {
    fleet.push(session({ id: 'ms-other', teammate: 'other' }));
    await expect(
      service.sessionTaskCreate(
        'ms-other',
        { kind: 'feature', title: 'forged target' },
        {
          actor: 'ms-lead',
          actorName: 'zelda',
        },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await service.sessionTaskList('ms-other')).tasks).toEqual([]);
  });

  test('human provenance is derived server-side and does not accept body actor fields', async () => {
    const task = await service.sessionTaskCreate(
      'ms-lead',
      { kind: 'feature', title: 'human task', actor: 'forged' } as unknown as Parameters<
        TaskService['sessionTaskCreate']
      >[1],
      { actor: 'user', actorName: 'forged-human-name' },
    );
    expect(task.createdBy).toBeNull();
    const detail = await service.sessionTaskDetail('ms-lead', task.id);
    expect(detail?.activity[0]).toMatchObject({ actor: 'user', actorName: 'user' });
  });

  test('each successful mutation emits a sequence-0 whole-board tasks.updated snapshot', async () => {
    const events: import('./types').KTeamEvent[] = [];
    const unsubscribe = service.subscribe(event => events.push(event));
    const task = await service.sessionTaskCreate(
      'ms-lead',
      { kind: 'feature', title: 'live event' },
      { actor: 'ms-lead', actorName: 'zelda' },
    );
    await service.sessionTaskAct(
      'ms-lead',
      task.id,
      { action: 'note', text: 'converge' },
      { actor: 'ms-lead', actorName: 'zelda' },
    );
    unsubscribe();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ sequence: 0, sessionId: 'ms-lead', type: 'tasks.updated' });
    expect((events[1]?.data as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  test('satisfying a dependency also refreshes a dependent task in another session', async () => {
    fleet.push(session({ id: 'ms-other', teammate: 'other' }));
    const events: KTeamEvent[] = [];
    const unsubscribe = service.subscribe(event => events.push(event));
    await created({ title: 'Shared foundation' });
    await service.sessionTaskCreate(
      'ms-other',
      {
        kind: 'feature',
        title: 'Cross-session consumer',
        ask: { text: 'Build the consumer.', source: 'kteam://messages/ms-other/1' },
        dependsOn: ['#F1'],
      },
      { actor: 'ms-other', actorName: 'other' },
    );
    events.length = 0;

    await service.taskAct('F1', {
      action: 'phase',
      phase: 'build',
      reason: 'Start the shared foundation.',
      actor: 'ms-lead',
    });
    events.length = 0;
    await service.taskAct('F1', {
      action: 'phase',
      phase: 'built',
      reason: 'The shared foundation is now available.',
      actor: 'ms-lead',
    });
    unsubscribe();

    expect(events.map(event => event.sessionId)).toEqual(['ms-lead', 'ms-other']);
    const dependent = events.find(event => event.sessionId === 'ms-other');
    expect((dependent?.data as { tasks: Array<{ id: string; blocked: boolean }> }).tasks).toContainEqual(
      expect.objectContaining({ id: 'F2', blocked: false }),
    );
  });

  test('records are session-local while fleet ids remain globally unique', async () => {
    fleet.push(session({ id: 'ms-other', teammate: 'other' }));
    const a = await service.sessionTaskCreate(
      'ms-lead',
      { kind: 'feature', title: 'a' },
      { actor: 'ms-lead', actorName: 'zelda' },
    );
    const b = await service.sessionTaskCreate(
      'ms-other',
      { kind: 'feature', title: 'b' },
      { actor: 'ms-other', actorName: 'other' },
    );
    expect([a.id, b.id]).toEqual(['F1', 'F2']);
    expect((await service.taskList()).tasks.map(task => task.id)).toEqual(['F1', 'F2']);
    expect((await service.taskDetail('F2'))?.sessionId).toBe('ms-other');
  });
});
