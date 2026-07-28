import { describe, expect, test } from 'bun:test';
import type { TaskDag, TaskStatus, TaskSummary } from './tasks';
import {
  filterTaskDag,
  filterTasksByStatuses,
  layoutTaskDag,
  orderedTaskStatuses,
  taskFilterSummary,
  taskStatusCounts,
  taskTitlePreview,
  toggleTaskStatusFilter,
} from './task-views';

const task = (id: string, status: TaskStatus, dependsOn: string[] = []): TaskSummary => ({
  id,
  kind: 'feature',
  title: `Task ${id}`,
  workflow: 'quick',
  phase: status === 'done' ? 'done' : status === 'in_progress' ? 'build' : 'todo',
  dependsOn,
  status,
  statusReason: null,
  blocked: false,
  blockedReason: null,
  blockedSince: null,
  blockedBy: [],
  assignee: null,
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
    assigneeStatus: null,
    assigneeHealth: null,
    assigneeDoneMarker: false,
    assigneeLastActivityAt: null,
    staleness: null,
  },
});

const tasks = [task('ROOT', 'done'), task('PATH', 'in_progress', ['ROOT']), task('MATCH', 'blocked', ['PATH'])];
const dag: TaskDag = {
  nodes: [
    ...tasks.map(item => ({
      id: item.id,
      task: item,
      sessionId: item.sessionId,
      crossSession: false,
      seed: item.id === 'MATCH',
      missing: false,
    })),
    {
      id: 'OTHER',
      task: task('OTHER', 'done'),
      sessionId: 'session-a',
      crossSession: false,
      seed: true,
      missing: false,
    },
    { id: 'GONE', task: null, sessionId: null, crossSession: false, seed: false, missing: true },
  ],
  edges: [
    { from: 'MATCH', to: 'PATH' },
    { from: 'PATH', to: 'ROOT' },
    { from: 'ROOT', to: 'GONE' },
  ],
};

describe('task exact-status filtering', () => {
  test('isolates first selection, adds/removes more, and returns to All after the final removal', () => {
    let selected = toggleTaskStatusFilter(null, 'in_progress');
    expect([...selected!]).toEqual(['in_progress']);
    selected = toggleTaskStatusFilter(selected, 'blocked');
    expect([...selected!]).toEqual(['in_progress', 'blocked']);
    selected = toggleTaskStatusFilter(selected, 'in_progress');
    expect([...selected!]).toEqual(['blocked']);
    expect(toggleTaskStatusFilter(selected, 'blocked')).toBeNull();
  });

  test('counts exact statuses and keeps selected zero-count controls removable', () => {
    const counts = taskStatusCounts(tasks);
    expect(counts.get('done')).toBe(1);
    expect(filterTasksByStatuses(tasks, new Set(['blocked'])).map(item => item.id)).toEqual(['MATCH']);
    expect(orderedTaskStatuses(counts, new Set(['live']))).toEqual(['in_progress', 'live', 'done', 'blocked']);
  });
});

describe('filtered task DAG', () => {
  test('keeps every transitive dependency as PATH and prunes unrelated branches', () => {
    const filtered = filterTaskDag(dag, new Set(['blocked']));
    expect(filtered.matchCount).toBe(1);
    expect(filtered.contextCount).toBe(3);
    expect(filtered.nodes.map(node => node.id)).toEqual(['ROOT', 'PATH', 'MATCH', 'GONE']);
    expect(filtered.nodes.find(node => node.id === 'MATCH')?.matchesFilter).toBe(true);
    expect(filtered.nodes.filter(node => !node.matchesFilter).map(node => node.id)).toEqual(['ROOT', 'PATH', 'GONE']);
    expect(filtered.edges).toEqual(dag.edges);
    expect(JSON.stringify(filtered)).not.toContain('OTHER');
  });

  test('returns an honest empty graph when nothing matches', () => {
    expect(filterTaskDag(dag, new Set(['live']))).toEqual({ nodes: [], edges: [], matchCount: 0, contextCount: 0 });
    expect(taskFilterSummary(1, 1)).toBe('1 match · 1 path');
    expect(taskFilterSummary(3, 2)).toBe('3 matches · 2 paths');
  });

  test('lays dependencies above dependents and renders arrows in dependency-flow direction', () => {
    const layout = layoutTaskDag(filterTaskDag(dag, new Set(['blocked'])));
    const byId = new Map(layout.nodes.map(node => [node.id, node]));
    expect(byId.get('GONE')!.y).toBeLessThan(byId.get('ROOT')!.y);
    expect(byId.get('ROOT')!.y).toBeLessThan(byId.get('PATH')!.y);
    expect(byId.get('PATH')!.y).toBeLessThan(byId.get('MATCH')!.y);
    expect(layout.edges.find(edge => edge.dependentId === 'MATCH')).toMatchObject({
      dependencyId: 'PATH',
      fromId: 'PATH',
      toId: 'MATCH',
    });
  });

  test('truncates only the preview and leaves short titles untouched', () => {
    const full = 'A deliberately long existing task title remains available';
    expect(taskTitlePreview(full, 20)).toBe('A deliberately long…');
    expect(taskTitlePreview('Short title', 20)).toBe('Short title');
    expect(full).toBe('A deliberately long existing task title remains available');
  });
});
