import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SessionTaskDag,
  SessionTaskKanban,
  SessionTaskList,
  SessionTasksSurface,
  TaskProjectionView,
  coalesceLoads,
  sessionTasksEmptyCopy,
  taskDetailRequestIsCurrent,
  type TaskDetailRequestToken,
} from './SessionTasks';
import { buildTaskDag, computeFileConflicts, type TaskStatus, type TaskSummary } from '../lib/tasks';
import { filterTaskDag, filterTasksByStatuses, taskStatusCounts } from '../lib/task-views';
import { TaskStatusFilter } from './TaskStatusFilter';

const statusFor = (phase: TaskSummary['phase']): TaskStatus =>
  (
    ({
      todo: 'todo',
      research: 'researched',
      design: 'designed',
      build: 'in_progress',
      built: 'built',
      live: 'live',
      done: 'done',
      dropped: 'dropped',
    }) as const
  )[phase];
const taskFor = (id: string, phase: TaskSummary['phase'], over: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  kind: 'feature',
  title: `Visible ${id}`,
  workflow: 'quick',
  phase,
  dependsOn: [],
  status: statusFor(phase),
  statusReason: null,
  blocked: false,
  blockedReason: null,
  blockedSince: null,
  blockedBy: [],
  assignee: 'olivia',
  repo: '/repo',
  links: { prs: [], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
  askChars: 10,
  askSource: 'https://chat.example/ask',
  clarificationCount: 0,
  sessionId: 'ms-a',
  files: [],
  live: {
    assigneeStatus: 'running',
    assigneeHealth: 'active',
    assigneeDoneMarker: false,
    assigneeLastActivityAt: null,
    staleness: null,
  },
  ...over,
});

// A fleet spanning three sessions: ms-a (viewed), ms-b (a cross-session
// dependency owner), and ms-z (entirely unrelated — must never leak in).
const fleet: TaskSummary[] = [
  taskFor('F1', 'build', { sessionId: 'ms-a', dependsOn: ['GONE'] }),
  taskFor('B2', 'research', {
    sessionId: 'ms-a',
    blocked: true,
    blockedReason: 'Waiting for X7',
    blockedSince: '2026-07-19T00:00:00.000Z',
    blockedBy: ['X7'],
    dependsOn: ['X7'],
    files: ['src/shared.ts'],
  }),
  taskFor('I3', 'live', { sessionId: 'ms-a', dependsOn: ['B2'] }),
  taskFor('X7', 'build', { sessionId: 'ms-b', title: 'Cross session', files: ['src/shared.ts'] }),
  taskFor('N9', 'build', { sessionId: 'ms-z' }),
];
const mine = fleet.filter(task => task.sessionId === 'ms-a');

describe('session task empty states', () => {
  test('names version skew and errors honestly', () => {
    expect(sessionTasksEmptyCopy('absent')).toContain('does not serve per-session tasks');
    expect(sessionTasksEmptyCopy('error', 'HTTP 500')).toContain('HTTP 500');
    expect(sessionTasksEmptyCopy('empty')).toContain('kteam task create');
  });
});

test('the list and kanban read only the selected session, with files and advisory conflicts shown', () => {
  const conflicts = computeFileConflicts(fleet);
  const list = renderToStaticMarkup(<SessionTaskList tasks={mine} conflicts={conflicts} onOpen={() => undefined} />);
  for (const id of ['#F1', '#B2', '#I3']) expect(list).toContain(id);
  // Another session's task is not a row here (its id may still appear as a dep/conflict reference).
  expect(list).not.toContain('Visible X7');
  expect(list).not.toContain('Open #X7');
  expect(list).not.toContain('Visible N9');
  expect(list).toContain('src/shared.ts'); // claimed files are shown
  expect(list).toContain('Shares files with #X7'); // advisory cross-session overlap
  expect(list.indexOf('#B2')).toBeLessThan(list.indexOf('#F1')); // oldest blocked first
  expect(list.match(/data-task-status-badge/g)).toHaveLength(3); // mixed list rows still name their state
  expect(list).not.toContain('data-task-assignee'); // one repeated assignee carries no row-level signal
  const kanban = renderToStaticMarkup(
    <SessionTaskKanban tasks={mine} conflicts={conflicts} onOpen={() => undefined} />,
  );
  expect(kanban).toContain('data-task-lane="in_progress"');
  expect(kanban).not.toContain('data-task-lane="research"');
  expect(kanban).not.toContain('data-task-lane="design"');
  expect(kanban.match(/data-task-lane="in_progress"/g)).toHaveLength(1);
  expect(kanban).not.toContain('Visible X7');
  expect(kanban).not.toContain('Visible N9');
});

test('list and kanban speak the themed panel + status tone language', () => {
  const list = renderToStaticMarkup(<SessionTaskList tasks={mine} onOpen={() => undefined} />);
  // The container is a real themed panel, not a bespoke bordered box.
  expect(list).toContain('kt-panel');
  expect(list).not.toContain('rounded-md border border-border-soft');
  // Every row carries its state as a rail: I3 is live (ok), B2 blocked (err).
  expect(list.match(/kt-task-rail/g)).toHaveLength(mine.length);
  expect(list).toContain('data-tone="ok"');
  expect(list).toContain('data-tone="err"');

  const kanban = renderToStaticMarkup(<SessionTaskKanban tasks={mine} onOpen={() => undefined} />);
  // Each lane is one panel whose header wears the lane tone (dot + count ink);
  // the old panel-inside-panel nesting is gone.
  expect(kanban).toContain('kt-panel__header');
  expect(kanban).toContain('kt-task-tone-dot');
  expect(kanban).toContain('kt-task-tone-ink');
  expect(kanban).toMatch(/data-task-lane="live"[^>]*data-tone="ok"/u);
  expect(kanban).toMatch(/data-task-lane="in_progress"[^>]*data-tone="warn"/u);
  expect(kanban).not.toContain('bg-surface-2 p-2');
});

test('compact kanban stacks every count and task at full width without a horizontal board', () => {
  const html = renderToStaticMarkup(<SessionTaskKanban tasks={mine} onOpen={() => undefined} compact />);
  expect(html).toContain('data-task-layout="stacked"');
  expect(html).toContain('flex-col');
  expect(html).toContain('w-full');
  expect(html).not.toContain('min-w-max');
  for (const lane of ['todo', 'in_progress', 'built', 'live', 'done', 'dropped']) {
    expect(html).toContain(`data-task-lane="${lane}"`);
  }
  for (const id of ['#F1', '#B2', '#I3']) expect(html).toContain(id);
  expect(html.match(/aria-label="Open #B2: Visible B2"/g)).toHaveLength(1);
  expect(html).toContain('No tasks.');
});

test('kanban removes metadata repeated throughout a lane and preserves every title', () => {
  const titles = [
    'Mobile session controls stay readable',
    'Sent messages show delivery state',
    'Filter kanban without hiding context',
  ];
  const homogeneous = titles.map((title, index) =>
    taskFor(`B${14 + index}`, 'live', {
      title,
      assignee: 'zelda',
      createdBy: 'ms-agent-created',
      askSource: '/home/kirin/.kteam/ms-agent/turns/turn-001.md',
      live: {
        assigneeSessionId: 'ms-zelda',
        assigneeName: 'zelda',
        assigneeStatus: 'working',
        assigneeHealth: 'active',
        assigneeDoneMarker: false,
        assigneeLastActivityAt: null,
        staleness: null,
      },
    }),
  );
  const html = renderToStaticMarkup(<SessionTaskKanban tasks={homogeneous} onOpen={() => undefined} compact />);
  for (const title of titles) expect(html).toContain(title);
  expect(html).not.toContain('data-task-status-badge');
  expect(html).not.toContain('data-task-assignee');
  expect(html).not.toContain('data-task-ask-origin');
  expect(html).not.toContain('Agent-originated');

  const list = renderToStaticMarkup(<SessionTaskList tasks={homogeneous} onOpen={() => undefined} />);
  expect(list).not.toContain('data-task-status-badge');
});

test('kanban restores assignee and quiet ask provenance only where the visible board mixes them', () => {
  const mixed = [
    taskFor('B20', 'live', {
      assignee: 'zelda',
      createdBy: 'ms-agent-recorder',
      askSource: '/home/kirin/.kteam/ms-agent/turns/turn-001.md',
      live: {
        assigneeSessionId: 'ms-zelda',
        assigneeName: 'zelda',
        assigneeStatus: 'working',
        assigneeHealth: 'active',
        assigneeDoneMarker: false,
        assigneeLastActivityAt: null,
        staleness: null,
      },
    }),
    taskFor('B21', 'live', {
      assignee: 'miles',
      createdBy: 'ms-agent-recorder',
      askSource: 'chat 2026-07-28',
      live: {
        assigneeSessionId: 'ms-miles',
        assigneeName: 'miles',
        assigneeStatus: 'working',
        assigneeHealth: 'active',
        assigneeDoneMarker: false,
        assigneeLastActivityAt: null,
        staleness: null,
      },
    }),
  ];
  const html = renderToStaticMarkup(<SessionTaskKanban tasks={mixed} onOpen={() => undefined} compact />);
  expect(html.match(/data-task-assignee=/g)).toHaveLength(2);
  expect(html.match(/data-task-ask-origin="agent"/g)).toHaveLength(1);
  expect(html).toContain('Agent-originated');
  expect(html).not.toContain('data-task-status-badge');
});

test('assignee suppression compares the dot readers see, not stale reason internals', () => {
  const sameRenderedAssignee = [
    taskFor('B22', 'live', {
      live: { ...taskFor('seed', 'live').live, staleness: 'assignee-dead' },
    }),
    taskFor('B23', 'live', {
      live: { ...taskFor('seed', 'live').live, staleness: 'maybe-finished' },
    }),
  ];
  const html = renderToStaticMarkup(
    <SessionTaskKanban tasks={sameRenderedAssignee} onOpen={() => undefined} compact />,
  );
  expect(html).not.toContain('data-task-assignee');
});

test('the DAG closes recursively across sessions, links owning sessions, and marks a missing node', () => {
  const filtered = filterTaskDag(buildTaskDag(fleet, 'ms-a'), null);
  const dag = renderToStaticMarkup(
    <SessionTaskDag dag={filtered} conflicts={computeFileConflicts(fleet)} onOpen={() => undefined} />,
  );
  for (const id of ['#F1', '#B2', '#I3', '#X7']) expect(dag).toContain(id);
  expect(dag).not.toContain('#N9'); // an unrelated session is never pulled into the closure
  expect(dag).toContain('<svg');
  expect(dag).toContain('<marker');
  expect(dag).not.toContain('<ol data-task-view="dag"');
  // The cross-session dependency is a real, marked node whose activation is
  // routed to its owning session by SessionTaskDag.
  expect(dag).toContain('data-task-cross-session="true"');
  expect(dag).toContain('owned by another session');
  // Edges are explicit — direct, transitive, and cross-session alike.
  expect(dag).toContain('data-task-edge="F1-&gt;GONE"');
  expect(dag).toContain('data-task-edge="B2-&gt;X7"');
  expect(dag).toContain('data-task-edge="I3-&gt;B2"');
  // A genuinely absent dependency is a distinct missing node, never the old (external) dead end.
  expect(dag).toContain('data-task-missing="true"');
  expect(dag).toContain('missing');
  expect(dag).not.toContain('(external)');
});

test('exact status filters retain dependency PATH nodes and prune unrelated DAG branches', () => {
  const filtered = filterTaskDag(buildTaskDag(fleet, 'ms-a'), new Set<TaskStatus>(['live']));
  const dag = renderToStaticMarkup(<SessionTaskDag dag={filtered} onOpen={() => undefined} />);
  for (const id of ['#I3', '#B2', '#X7']) expect(dag).toContain(id);
  for (const id of ['#F1', '#N9', '#GONE']) expect(dag).not.toContain(id);
  expect(dag).toContain('PATH nodes keep matching tasks attached');
  expect(dag).toContain('data-task-filter="context"');
  expect(dag).toContain('>PATH<');
});

test('kanban filters exact raw statuses without undoing the collapsed in-progress lane', () => {
  const researched = filterTasksByStatuses(mine, new Set<TaskStatus>(['researched']));
  const html = renderToStaticMarkup(<SessionTaskKanban tasks={researched} onOpen={() => undefined} compact />);
  expect(html).toContain('Visible B2');
  expect(html).not.toContain('Visible F1');
  expect(html).toContain('data-task-lane="in_progress"');
  expect(html).not.toContain('data-task-lane="research"');
});

test('list projection uses the same exact multi-select status filter as kanban', () => {
  const html = renderToStaticMarkup(
    <TaskProjectionView
      view="list"
      tasks={mine}
      dag={filterTaskDag(buildTaskDag(fleet, 'ms-a'), null)}
      conflicts={computeFileConflicts(fleet)}
      onOpen={() => undefined}
      compact
      selectedStatuses={new Set<TaskStatus>(['live'])}
      onShowAll={() => undefined}
    />,
  );
  expect(html).toContain('data-task-view="list"');
  expect(html).toContain('Visible I3');
  expect(html).not.toContain('Visible F1');
  expect(html).not.toContain('Visible B2');

  const empty = renderToStaticMarkup(
    <TaskProjectionView
      view="list"
      tasks={mine}
      dag={filterTaskDag(buildTaskDag(fleet, 'ms-a'), null)}
      conflicts={computeFileConflicts(fleet)}
      onOpen={() => undefined}
      compact
      selectedStatuses={new Set<TaskStatus>(['dropped'])}
      onShowAll={() => undefined}
    />,
  );
  expect(empty).toContain('No matching tasks.');
});

test('status controls use the All-first, 44px multi-select vocabulary', () => {
  const html = renderToStaticMarkup(
    <TaskStatusFilter
      counts={taskStatusCounts(mine)}
      selected={null}
      onSelect={() => undefined}
      onShowAll={() => undefined}
    />,
  );
  expect(html.indexOf('>All ')).toBeLessThan(html.indexOf('>Researched '));
  expect(html).toContain('min-h-[44px]');
  expect(html).toContain('aria-pressed="true"');
});

test('the surface defaults to List and retains loading/version-safe controls', () => {
  const html = renderToStaticMarkup(<SessionTasksSurface sessionId="session-a" />);
  expect(html).toContain('Loading tasks…');
  expect(html).toContain('aria-label="Refresh tasks"');
  expect(html).toContain('aria-label="Task views"');
  expect(html).toContain('aria-selected="true"');
  expect(html).toContain('>List<');
  expect(html).not.toContain('autofocus');
});

test('the task detail surface threads every session opener without owning another surface', async () => {
  const source = await Bun.file(new URL('./SessionTasks.tsx', import.meta.url)).text();
  expect(source).toContain('onCodeReferenceOpen?:');
  expect(source).toContain('onCodeReferenceOpen={onCodeReferenceOpen}');
  expect(source).toContain('onAttentionOpen={onAttentionOpen}');
  expect(source).toContain('onPinOpen={onPinOpen}');
  expect(source).toContain('surfaceCwd={cwd}');
  expect(source).not.toContain('requestedCodeReference');
});

test('event storms coalesce into one follow-up load and every completed response is applied', async () => {
  // Regression: tasks.updated events arriving faster than one slow /v1/tasks
  // round trip used to supersede (and discard) every response, so the surface
  // never left "Loading tasks…" on a busy fleet.
  let started = 0;
  const applied: number[] = [];
  const gates: Array<() => void> = [];
  const load = coalesceLoads(async () => {
    const run = ++started;
    await new Promise<void>(resolve => gates.push(resolve));
    applied.push(run);
  });

  const first = load();
  // Five "events" land while the first request is still on the wire…
  const stormed = [load(), load(), load(), load(), load()];
  expect(started).toBe(1);
  gates.shift()!();
  await new Promise(resolve => setTimeout(resolve, 0));
  // …the first response was APPLIED, and the storm collapsed into ONE rerun
  // (already in flight; `first` settles only after its queued follow-up does).
  expect(applied).toEqual([1]);
  expect(started).toBe(2);
  gates.shift()!();
  await first;
  await Promise.all(stormed);
  expect(applied).toEqual([1, 2]);
  expect(started).toBe(2);

  // A quiet trigger afterwards runs immediately and applies too.
  const quiet = load();
  expect(started).toBe(3);
  gates.shift()!();
  await quiet;
  expect(applied).toEqual([1, 2, 3]);
});

test('a coalesced loader survives a failing run and releases the queue', async () => {
  let attempts = 0;
  const load = coalesceLoads(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient');
  });
  await expect(load()).rejects.toThrow('transient');
  await load();
  expect(attempts).toBe(2);
});

test('a late task-detail response cannot overwrite the latest task or cross a session switch', async () => {
  const a: TaskDetailRequestToken = { sequence: 1, sessionId: 'ms-a', taskId: 'F1' };
  const b: TaskDetailRequestToken = { sequence: 2, sessionId: 'ms-a', taskId: 'F2' };
  let current: TaskDetailRequestToken | null = a;
  let visible = '';
  let resolveA!: (value: string) => void;
  let resolveB!: (value: string) => void;
  const responseA = new Promise<string>(resolve => {
    resolveA = resolve;
  });
  const responseB = new Promise<string>(resolve => {
    resolveB = resolve;
  });
  const apply = async (request: TaskDetailRequestToken, response: Promise<string>) => {
    const value = await response;
    if (taskDetailRequestIsCurrent(current, request, 'ms-a')) visible = value;
  };

  const settlingA = apply(a, responseA);
  current = b;
  const settlingB = apply(b, responseB);
  resolveB('F2 activity');
  await settlingB;
  resolveA('F1 activity');
  await settlingA;

  expect(visible).toBe('F2 activity');
  expect(taskDetailRequestIsCurrent(current, b, 'ms-b')).toBe(false);
});
