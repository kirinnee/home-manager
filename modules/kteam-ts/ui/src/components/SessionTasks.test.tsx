import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SessionTaskDag,
  SessionTaskKanban,
  SessionTaskList,
  SessionTasksSurface,
  sessionTasksEmptyCopy,
} from './SessionTasks';
import { computeFileConflicts, type TaskStatus, type TaskSummary } from '../lib/tasks';

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
  expect(kanban).toContain('data-task-phase="research"');
  expect(kanban).not.toContain('Visible X7');
  expect(kanban).not.toContain('Visible N9');
});

test('the DAG closes recursively across sessions, links owning sessions, and marks a missing node', () => {
  const dag = renderToStaticMarkup(
    <SessionTaskDag fleet={fleet} sessionId="ms-a" conflicts={computeFileConflicts(fleet)} onOpen={() => undefined} />,
  );
  for (const id of ['#F1', '#B2', '#I3', '#X7']) expect(dag).toContain(id);
  expect(dag).not.toContain('#N9'); // an unrelated session is never pulled into the closure
  // The cross-session dependency is a real, marked node linked to its owning session.
  expect(dag).toContain('data-task-cross-session="true"');
  expect(dag).toContain('Owned by session');
  expect(dag).toContain('href="/session/ms-b"');
  // Edges are explicit — direct, transitive, and cross-session alike.
  expect(dag).toContain('data-task-edge="F1-&gt;GONE"');
  expect(dag).toContain('data-task-edge="B2-&gt;X7"');
  expect(dag).toContain('data-task-edge="I3-&gt;B2"');
  // A genuinely absent dependency is a distinct missing node, never the old (external) dead end.
  expect(dag).toContain('data-task-missing="GONE"');
  expect(dag).toContain('missing');
  expect(dag).not.toContain('(external)');
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
