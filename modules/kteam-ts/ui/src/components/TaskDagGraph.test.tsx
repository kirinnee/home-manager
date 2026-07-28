import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskStatus, TaskSummary } from '../lib/tasks';
import { filterTaskDag, type FilteredTaskDag } from '../lib/task-views';
import { fitTaskDagTransform, shouldNavigateTaskAgentLink, TaskDagGraph } from './TaskDagGraph';

const task = (id: string, status: TaskStatus, title: string): TaskSummary =>
  ({
    id,
    kind: 'feature',
    title,
    workflow: 'quick',
    phase: status === 'done' ? 'done' : status === 'blocked' ? 'build' : 'todo',
    dependsOn: [],
    status,
    statusReason: null,
    blocked: status === 'blocked',
    blockedReason: status === 'blocked' ? 'Waiting' : null,
    blockedSince: null,
    blockedBy: [],
    assignee: 'ms-ottis',
    repo: '/repo',
    links: { prs: [], branch: null, commits: [], docs: [] },
    order: null,
    createdAt: null,
    updatedAt: null,
    askChars: 0,
    askSource: null,
    clarificationCount: 0,
    sessionId: 'session-a',
    files: [],
    live: {
      assigneeStatus: 'running',
      assigneeHealth: 'active',
      assigneeDoneMarker: false,
      assigneeLastActivityAt: null,
      staleness: null,
      assigneeName: 'ottis',
      assigneeSessionId: 'ms4v5fu2-f2a89500',
    },
  }) as TaskSummary;

const dependency = task('F1', 'done', 'A deliberately long existing dependency title stays intact');
const dependent = task('F2', 'blocked', 'Fix graph rendering');
const filtered = filterTaskDag(
  {
    nodes: [
      { id: 'F1', task: dependency, sessionId: 'session-b', crossSession: true, seed: false, missing: false },
      { id: 'F2', task: dependent, sessionId: 'session-a', crossSession: false, seed: true, missing: false },
    ],
    edges: [{ from: 'F2', to: 'F1' }],
  },
  new Set(['blocked']),
);

describe('layered task DAG graph', () => {
  test('renders real SVG nodes, directed edges, explicit PATH context, zoom controls, and clickable teammate names', () => {
    const html = renderToStaticMarkup(
      <TaskDagGraph
        dag={filtered}
        conflicts={
          new Map([['F2', [{ taskId: 'F9', sessionId: 'session-z', files: ['src/shared.ts'], crossSession: true }]]])
        }
        onOpen={() => undefined}
      />,
    );

    expect(html).toContain('data-task-graph="layered-svg"');
    expect(html).toContain('<svg');
    expect(html).toContain('<marker');
    expect(html).toContain('data-task-edge="F2-&gt;F1"');
    expect(html).toContain('data-task-node="F1"');
    expect(html).toContain('data-task-node-hit="true"');
    expect(html).toContain('data-task-filter="context"');
    expect(html).toContain('>PATH · OTHER</text>');
    expect(html).toContain('A deliberately long existing dependency title stays intact');
    expect(html).toContain('A deliberately long existing…');
    expect(html).toContain('href="/session/ms4v5fu2-f2a89500"');
    expect(html).toContain('>ottis</text>');
    expect(html).toContain('data-task-conflicts="1"');
    expect(html).toContain('shares files with #F9');
    expect(html).toContain('>⚠ 1</text>');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('aria-label="Fit graph"');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('Dependencies flow down');
  });

  test('keeps a wide graph at a phone-readable scale and can recover an empty filter', () => {
    expect(fitTaskDagTransform({ width: 1200, height: 900 }, { width: 390, height: 520 })).toEqual({
      x: -105,
      y: 35,
      scale: 0.5,
    });
    const empty: FilteredTaskDag = { nodes: [], edges: [], matchCount: 0, contextCount: 0 };
    const html = renderToStaticMarkup(
      <TaskDagGraph dag={empty} onOpen={() => undefined} onShowAll={() => undefined} />,
    );
    expect(html).toContain('No task nodes match this status filter.');
    expect(html).toContain('>Show all</button>');
  });

  test('presents a derived blocker primarily as Blocked without changing raw-status filtering', () => {
    const derivedBlocked = {
      ...task('F3', 'in_progress', 'Wait for dependency'),
      phase: 'build' as const,
      blocked: true,
      blockedReason: 'Waiting on #F1',
      blockedBy: ['F1'],
    };
    const dag = filterTaskDag(
      {
        nodes: [
          {
            id: 'F3',
            task: derivedBlocked,
            sessionId: 'session-a',
            crossSession: false,
            seed: true,
            missing: false,
          },
        ],
        edges: [],
      },
      new Set(['in_progress']),
    );

    expect(dag.matchCount).toBe(1);
    const html = renderToStaticMarkup(<TaskDagGraph dag={dag} onOpen={() => undefined} />);
    expect(html).toContain('data-task-status="blocked"');
    expect(html).toContain('#F3: Wait for dependency — Blocked');
    expect(html).toContain('#F3 · BLOCKED');
    expect(html).toContain('--task-node-color:var(--err)');
    expect(html).not.toContain('#F3 · IN PROGRESS');
  });

  test('uses SPA navigation only for an unmodified primary click', () => {
    const click = { altKey: false, button: 0, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(shouldNavigateTaskAgentLink(click)).toBe(true);
    expect(shouldNavigateTaskAgentLink({ ...click, ctrlKey: true })).toBe(false);
    expect(shouldNavigateTaskAgentLink({ ...click, button: 1 })).toBe(false);
  });
});
