import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SessionTaskDag,
  SessionTaskKanban,
  SessionTaskList,
  SessionTasksSurface,
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

test('the task detail surface threads code-reference opens without owning Files state', async () => {
  const source = await Bun.file(new URL('./SessionTasks.tsx', import.meta.url)).text();
  expect(source).toContain('onCodeReferenceOpen?:');
  expect(source).toContain('onCodeReferenceOpen={onCodeReferenceOpen}');
  expect(source).toContain('surfaceCwd={cwd}');
  expect(source).not.toContain('requestedCodeReference');
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
