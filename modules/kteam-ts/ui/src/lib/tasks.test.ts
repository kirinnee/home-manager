import { describe, expect, test } from 'bun:test';
import {
  buildTaskDag,
  computeFileConflicts,
  groupTasksByBoardLane,
  groupTasksByPhase,
  parseTaskActivity,
  parseTaskList,
  parseTaskListResponse,
  parseTaskRecord,
  parseTaskSummary,
  sortTasksForList,
  taskActivityText,
  taskReference,
  tasksForSession,
} from './tasks';

const raw = {
  id: 'F21',
  title: 'Tasks',
  kind: 'feature',
  status: 'in_progress',
  workflow: 'research-first',
  phase: 'build',
  dependsOn: ['B2'],
  blocked: true,
  blockedReason: 'Waiting for B2',
  blockedSince: '2026-07-20T00:00:00.000Z',
  blockedBy: ['B2'],
  assignee: 'ines',
  repo: '/repo',
  links: { prs: ['https://github.com/a/b/pull/7'] },
  askChars: 12,
  askSource: 'https://chat.example/messages/1',
  clarificationCount: 1,
  live: { assigneeStatus: 'failed', staleness: 'assignee-dead' },
};

describe('task-v2 UI parsing', () => {
  test('keeps v2 summary fields while dropping malformed and duplicate records', () => {
    const tasks = parseTaskList([
      {
        ...raw,
        createdBy: 'ms-agent-12345678',
        live: { ...raw.live, assigneeSessionId: 'ms-live-12345678', assigneeName: 'ines' },
      },
      { ...raw, title: 'duplicate' },
      { id: 'x', title: '', status: 'todo' },
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      phase: 'build',
      workflow: 'research-first',
      dependsOn: ['B2'],
      blockedBy: ['B2'],
      createdBy: 'ms-agent-12345678',
      live: { assigneeSessionId: 'ms-live-12345678', assigneeName: 'ines' },
    });
  });
  test('parses ask, clarifications, and the new activity types defensively', () => {
    const record = parseTaskRecord({
      ...raw,
      description: 3,
      ask: { text: 'Keep these exact words', source: 'https://chat.example/messages/1' },
      clarifications: [
        {
          text: 'And this one',
          source: 'https://chat.example/messages/2',
          at: '2026-07-21T00:00:00.000Z',
          by: 'user',
          byName: 'Kirin',
        },
      ],
    });
    expect(record?.ask.text).toBe('Keep these exact words');
    expect(record?.clarifications[0]).toMatchObject({ byName: 'Kirin', source: 'https://chat.example/messages/2' });
    expect(parseTaskActivity({ seq: 1, type: 'clarification', data: { text: 'keep it' } })?.type).toBe('clarification');
    expect(parseTaskActivity({ seq: 2, type: 'dependency', data: { taskId: 'B2' } })?.type).toBe('dependency');
    // File-claim history is a first-class activity type: parse it and format add/remove with an optional reason.
    expect(
      parseTaskActivity({ seq: 6, type: 'file', data: { path: 'src/api-server.ts', operation: 'add' } })?.type,
    ).toBe('file');
    expect(
      taskActivityText({
        v: 1,
        seq: 7,
        time: null,
        actor: 'agent',
        actorName: null,
        type: 'file',
        data: { path: 'src/api-server.ts', operation: 'add', reason: 'owns the route' },
      }),
    ).toBe('Claimed file src/api-server.ts: owns the route');
    expect(
      taskActivityText({
        v: 1,
        seq: 8,
        time: null,
        actor: 'agent',
        actorName: null,
        type: 'file',
        data: { path: 'src/api-server.ts', operation: 'remove' },
      }),
    ).toBe('Unclaimed file src/api-server.ts');
    expect(parseTaskRecord({ ...raw, phase: 'guessing' })?.phase).toBe('build');
    expect(parseTaskRecord({ ...raw, status: 'researched', phase: undefined, workflow: undefined })?.workflow).toBe(
      'investigate',
    );
    expect(
      taskActivityText({
        v: 1,
        seq: 3,
        time: '2026-07-21T00:00:00.000Z',
        actor: 'agent',
        actorName: null,
        type: 'dependency',
        data: { taskId: 'B2', operation: 'remove' },
      }),
    ).toBe('Removed dependency &B2');
  });
  test('preserves the daemon parse-error count without trusting malformed counts', () => {
    expect(parseTaskListResponse({ tasks: [raw], parseErrors: 2 })).toMatchObject({ parseErrors: 2 });
    expect(parseTaskListResponse({ tasks: [raw], parseErrors: -1 }).parseErrors).toBe(0);
  });
});

describe('task-v2 pure projections', () => {
  test('uses one id set while list prioritises blockers and kanban collapses active workflow phases', () => {
    const tasks = parseTaskList([
      { ...raw, id: 'F1', blockedSince: '2026-07-24T00:00:00.000Z' },
      { ...raw, id: 'B2', status: 'researched', phase: 'research', blockedSince: '2026-07-19T00:00:00.000Z' },
      {
        ...raw,
        id: 'C3',
        status: 'live',
        phase: 'live',
        blocked: false,
        blockedBy: [],
        blockedSince: null,
        blockedReason: null,
        live: {},
      },
    ]);
    expect(sortTasksForList(tasks).map(task => task.id)).toEqual(['B2', 'F1', 'C3']);
    const columns = groupTasksByBoardLane(tasks);
    expect(columns.find(column => column.lane === 'in_progress')?.tasks.map(task => task.id)).toEqual(['B2', 'F1']);
    expect(columns.some(column => (column.lane as string) === 'research')).toBe(false);
    expect(columns.some(column => (column.lane as string) === 'design')).toBe(false);
    expect(
      groupTasksByPhase(tasks)
        .find(column => column.phase === 'research')
        ?.tasks.map(task => task.id),
    ).toEqual(['B2']);
    expect(
      columns
        .flatMap(column => column.tasks)
        .map(task => task.id)
        .sort(),
    ).toEqual(['B2', 'C3', 'F1']);
  });
  test('formats stable & references and descriptive phase/claim history', () => {
    expect(taskReference('F12')).toBe('&F12');
    expect(
      taskActivityText({
        v: 2,
        seq: 1,
        time: '2026-07-21T00:00:00.000Z',
        actor: 'agent',
        actorName: null,
        type: 'status',
        data: { phaseFrom: 'research', phaseTo: 'design', reason: 'approved' },
      }),
    ).toBe('research → design: approved');
    expect(
      taskActivityText({
        v: 2,
        seq: 2,
        time: '2026-07-21T00:00:00.000Z',
        actor: 'agent',
        actorName: null,
        type: 'status',
        data: {
          phaseFrom: 'live',
          phaseTo: 'build',
          reason: 'broken after deploy',
          backward: true,
          reopened: true,
        },
      }),
    ).toBe('Reopened · live → build: broken after deploy');
    expect(
      taskActivityText({
        v: 2,
        seq: 3,
        time: '2026-07-21T00:00:00.000Z',
        actor: 'agent',
        actorName: null,
        type: 'session',
        data: { event: 'completion-claim', session: 'ms-a', turn: 4, phase: 'build' },
      }),
    ).toContain('Completion claim: ms-a');
  });
});

describe('fleet-record parser defaults and the status/phase invariant', () => {
  test('sessionId and files default safely and additive fields survive', () => {
    const bare = parseTaskSummary({ id: 'F1', title: 'x', status: 'todo' });
    expect(bare?.sessionId).toBeNull();
    expect(bare?.files).toEqual([]);
    expect(bare).not.toHaveProperty('createdBy');
    expect(parseTaskSummary({ id: 'F0', title: 'human', status: 'todo', createdBy: null })?.createdBy).toBeNull();
    const scoped = parseTaskSummary({
      id: 'F2',
      title: 'x',
      status: 'todo',
      sessionId: 'ms-a',
      files: ['src/a.ts', 'src/a.ts', 7, 'src/b.ts'],
    });
    expect(scoped?.sessionId).toBe('ms-a');
    expect(scoped?.files).toEqual(['src/a.ts', 'src/b.ts']); // deduped, non-strings dropped
  });
  test('a status/phase contradiction is repaired to the status-derived phase, never surfaced', () => {
    // in_progress cannot be phase "design"; the renderer must not see both.
    expect(parseTaskSummary({ id: 'F3', title: 'x', status: 'in_progress', phase: 'design' })?.phase).toBe('build');
    expect(parseTaskSummary({ id: 'F4', title: 'x', status: 'live', phase: 'todo' })?.phase).toBe('live');
    // blocked legitimately retains its pre-block phase.
    expect(parseTaskSummary({ id: 'F5', title: 'x', status: 'blocked', phase: 'build' })?.phase).toBe('build');
    // dropped must be phase dropped even if a stale phase is declared.
    expect(parseTaskSummary({ id: 'F6', title: 'x', status: 'dropped', phase: 'build' })?.phase).toBe('dropped');
  });
});

describe('fleet DAG and file-conflict projections', () => {
  const summary = (over: Record<string, unknown>) => ({
    id: 'X',
    title: 'x',
    status: 'todo',
    sessionId: 'ms-a',
    ...over,
  });
  const fleet = parseTaskList([
    summary({ id: 'F1', sessionId: 'ms-a', dependsOn: ['B2', 'C9'], files: ['src/shared.ts'] }),
    summary({ id: 'F2', sessionId: 'ms-a', dependsOn: [] }),
    summary({ id: 'B2', sessionId: 'ms-b', dependsOn: ['D4'], files: ['src/shared.ts'] }), // cross-session dep of F1
    summary({ id: 'D4', sessionId: 'ms-b', dependsOn: [] }), // reached only recursively through B2
    summary({ id: 'C9', sessionId: 'ms-a', dependsOn: [] }), // same-session seed, also a direct dep of F1
    summary({ id: 'Z9', sessionId: 'ms-c', dependsOn: [], files: ['src/other.ts'], repo: '/other' }),
  ]);

  test('List/Kanban read only the selected session', () => {
    expect(
      tasksForSession(fleet, 'ms-a')
        .map(t => t.id)
        .sort(),
    ).toEqual(['C9', 'F1', 'F2']);
    expect(
      tasksForSession(fleet, 'ms-b')
        .map(t => t.id)
        .sort(),
    ).toEqual(['B2', 'D4']);
  });

  test('the DAG closure crosses sessions recursively and distinguishes a missing node', () => {
    const dag = buildTaskDag(fleet, 'ms-a');
    const node = (id: string) => dag.nodes.find(n => n.id === id);
    // Seeds plus the complete recursive closure: B2 (cross-session), D4 (reached through B2), and missing C-... none.
    expect(dag.nodes.map(n => n.id).sort()).toEqual(['B2', 'C9', 'D4', 'F1', 'F2']);
    expect(node('B2')?.crossSession).toBe(true);
    expect(node('B2')?.sessionId).toBe('ms-b');
    expect(node('D4')?.crossSession).toBe(true); // pulled in transitively, still rendered as a real node
    expect(node('F1')?.seed).toBe(true);
    // Edges are explicit, including the cross-session and transitive ones.
    expect(dag.edges).toContainEqual({ from: 'F1', to: 'B2' });
    expect(dag.edges).toContainEqual({ from: 'B2', to: 'D4' });
  });

  test('a genuinely absent dependency is a distinct missing node, not dropped', () => {
    const withGap = parseTaskList([summary({ id: 'F1', sessionId: 'ms-a', dependsOn: ['GONE'] })]);
    const dag = buildTaskDag(withGap, 'ms-a');
    const gone = dag.nodes.find(n => n.id === 'GONE');
    expect(gone?.missing).toBe(true);
    expect(gone?.task).toBeNull();
    expect(dag.edges).toContainEqual({ from: 'F1', to: 'GONE' });
  });

  test('file overlaps are advisory across and within sessions, with no false positives', () => {
    const conflicts = computeFileConflicts(fleet);
    // F1 (ms-a) and B2 (ms-b) both claim src/shared.ts — a real cross-session overlap.
    expect(conflicts.get('F1')?.map(c => c.taskId)).toEqual(['B2']);
    expect(conflicts.get('F1')?.[0]).toMatchObject({ sessionId: 'ms-b', crossSession: true, files: ['src/shared.ts'] });
    expect(conflicts.get('B2')?.[0]?.crossSession).toBe(true);
    // Z9 claims a different file in a different repo — no conflict.
    expect(conflicts.has('Z9')).toBe(false);
    // Disjoint / empty / legacy file sets never conflict.
    expect(conflicts.has('F2')).toBe(false);
  });

  test('identical paths in provably different repos are not treated as the same file', () => {
    const repos = parseTaskList([
      { id: 'F1', title: 'x', status: 'todo', sessionId: 'ms-a', repo: '/repoA', files: ['src/x.ts'] },
      { id: 'F2', title: 'x', status: 'todo', sessionId: 'ms-b', repo: '/repoB', files: ['src/x.ts'] },
      { id: 'F3', title: 'x', status: 'todo', sessionId: 'ms-c', files: ['src/x.ts'] }, // unknown repo
    ]);
    const conflicts = computeFileConflicts(repos);
    expect(conflicts.has('F1')).toBe(true); // conflicts with F3 (unknown repo), not F2
    expect(conflicts.get('F1')?.map(c => c.taskId)).toEqual(['F3']);
    expect(conflicts.get('F2')?.map(c => c.taskId)).toEqual(['F3']);
  });

  test('terminal work keeps its claims as history without producing conflict noise', () => {
    const tasks = parseTaskList([
      { id: 'F1', title: 'active', status: 'in_progress', sessionId: 'ms-a', repo: '/repo', files: ['src/x.ts'] },
      { id: 'F2', title: 'built', status: 'built', sessionId: 'ms-b', repo: '/repo', files: ['src/x.ts'] },
      { id: 'F3', title: 'live', status: 'live', sessionId: 'ms-c', repo: '/repo', files: ['src/x.ts'] },
      { id: 'F4', title: 'done', status: 'done', sessionId: 'ms-d', repo: '/repo', files: ['src/x.ts'] },
      { id: 'F5', title: 'dropped', status: 'dropped', sessionId: 'ms-e', repo: '/repo', files: ['src/x.ts'] },
    ]);
    expect(tasks.every(task => task.files.includes('src/x.ts'))).toBe(true); // claims remain visible on the records
    expect(computeFileConflicts(tasks).size).toBe(0); // but completed/dropped work is not concurrent contention
  });
});
