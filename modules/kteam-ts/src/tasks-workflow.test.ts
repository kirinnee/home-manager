import { describe, expect, test } from 'bun:test';
import {
  assertTaskCanDrop,
  assertTaskDag,
  assertTaskPhaseInWorkflow,
  assertTaskPhaseTransition,
  compareTaskViews,
  completionTarget,
  computeTaskBlocking,
  dependencySatisfied,
  inferTaskWorkflow,
  taskDependents,
  taskPhaseFromStatus,
  taskStatusFromPhase,
  taskWorkflowPath,
  withTaskBlocking,
} from './tasks-workflow';
import {
  TASK_SCHEMA_VERSION,
  TASK_WORKFLOW_PATHS,
  TaskError,
  emptyTaskLinks,
  unknownTaskLive,
  type Task,
  type TaskActivity,
  type TaskPhase,
  type TaskView,
  type TaskWorkflow,
} from './tasks-types';

// A minimal, valid v2 record. Every test overrides only what it exercises.
const task = (over: Partial<Task> = {}): Task => ({
  v: TASK_SCHEMA_VERSION,
  id: 'F1',
  kind: 'feature',
  title: 'A task',
  description: '',
  ask: { text: 'do the thing', source: 'msg:1' },
  clarifications: [],
  workflow: 'quick',
  phase: 'todo',
  dependsOn: [],
  files: [],
  status: 'todo',
  statusReason: null,
  assignee: null,
  repo: null,
  links: emptyTaskLinks(),
  order: null,
  createdAt: '2026-07-26T12:00:00.000Z',
  createdBy: null,
  updatedAt: '2026-07-26T12:00:00.000Z',
  ...over,
});

const activity = (over: Partial<TaskActivity> = {}): TaskActivity => ({
  v: TASK_SCHEMA_VERSION,
  seq: 1,
  time: '2026-07-26T12:00:00.000Z',
  actor: 'user',
  actorName: null,
  type: 'note',
  data: {},
  ...over,
});

const view = (over: Partial<TaskView> = {}): TaskView => ({
  ...task(over as Partial<Task>),
  live: unknownTaskLive(),
  blocked: false,
  blockedReason: null,
  blockedSince: null,
  blockedBy: [],
  ...over,
});

describe('status ↔ phase mapping is a stable round-trip', () => {
  test('every declared status maps to a phase and back to a status', () => {
    expect(taskPhaseFromStatus('in_progress')).toBe('build');
    expect(taskPhaseFromStatus('built')).toBe('built');
    expect(taskPhaseFromStatus('researched')).toBe('research');
    expect(taskStatusFromPhase('build')).toBe('in_progress');
    expect(taskStatusFromPhase('built')).toBe('built');
    // A manual block keeps no phase memory, so it degrades to todo.
    expect(taskPhaseFromStatus('blocked')).toBe('todo');
  });

  test('workflow inference is best-effort from a parsed phase', () => {
    expect(inferTaskWorkflow('research')).toBe('investigate');
    expect(inferTaskWorkflow('done')).toBe('investigate');
    expect(inferTaskWorkflow('design')).toBe('design-first');
    expect(inferTaskWorkflow('build')).toBe('quick');
    expect(inferTaskWorkflow('todo')).toBe('quick');
  });
});

describe('the four fixed workflow paths', () => {
  test('each workflow is exactly its canonical phase sequence', () => {
    expect(taskWorkflowPath('quick')).toEqual(['todo', 'build', 'built', 'live']);
    expect(taskWorkflowPath('design-first')).toEqual(['todo', 'design', 'build', 'built', 'live']);
    expect(taskWorkflowPath('research-first')).toEqual(['todo', 'research', 'design', 'build', 'built', 'live']);
    expect(taskWorkflowPath('investigate')).toEqual(['todo', 'research', 'done']);
  });

  test('built is its own checkpoint, distinct from live, in every build lane', () => {
    for (const workflow of ['quick', 'design-first', 'research-first'] as TaskWorkflow[]) {
      const path = TASK_WORKFLOW_PATHS[workflow];
      expect(path.indexOf('built')).toBeGreaterThanOrEqual(0);
      expect(path.indexOf('live')).toBe(path.indexOf('built') + 1);
    }
  });

  test('assertTaskPhaseInWorkflow admits a lane member and refuses an outsider', () => {
    expect(() => assertTaskPhaseInWorkflow('quick', 'build')).not.toThrow();
    expect(() => assertTaskPhaseInWorkflow('investigate', 'done')).not.toThrow();
    // dropped is orthogonal to every lane and is always admitted.
    expect(() => assertTaskPhaseInWorkflow('quick', 'dropped')).not.toThrow();
    expect(() => assertTaskPhaseInWorkflow('quick', 'design')).toThrow(TaskError);
    expect(() => assertTaskPhaseInWorkflow('investigate', 'build')).toThrow('not part of the investigate workflow');
  });
});

describe('phase transitions are adjacent-only', () => {
  test('the one legal step forward is allowed; a skip or a rewind is refused', () => {
    const t = task({ workflow: 'quick', phase: 'todo', status: 'todo' });
    expect(() => assertTaskPhaseTransition(t, 'build', false)).not.toThrow();
    // skipping built is a two-step jump
    expect(() => assertTaskPhaseTransition(t, 'built', false)).toThrow('cannot move todo → built');
    // build → built is the next adjacent step and needs no human (not a gate)
    expect(() =>
      assertTaskPhaseTransition(task({ phase: 'build', status: 'in_progress' }), 'built', false),
    ).not.toThrow();
    // built → live is adjacent and deployment is always its own explicit step
    expect(() => assertTaskPhaseTransition(task({ phase: 'built', status: 'built' }), 'live', false)).not.toThrow();
  });

  test('a self-edge, a rewind, and advancing a dropped task are all refused', () => {
    expect(() => assertTaskPhaseTransition(task({ phase: 'build', status: 'in_progress' }), 'build', true)).toThrow(
      'already in build',
    );
    expect(() => assertTaskPhaseTransition(task({ phase: 'built', status: 'built' }), 'build', true)).toThrow(
      'cannot move built → build',
    );
    expect(() => assertTaskPhaseTransition(task({ phase: 'dropped', status: 'dropped' }), 'live', true)).toThrow(
      'was dropped and cannot advance',
    );
  });

  test('dropping is reachable from any phase without an adjacency check', () => {
    expect(() => assertTaskPhaseTransition(task({ phase: 'todo', status: 'todo' }), 'dropped', false)).not.toThrow();
    expect(() =>
      assertTaskPhaseTransition(task({ phase: 'build', status: 'in_progress' }), 'dropped', false),
    ).not.toThrow();
  });
});

describe('research and design are human approval gates', () => {
  test('an agent may enter research and design but only a human may leave them', () => {
    const rf = { workflow: 'research-first' as const };
    // todo → research: entering the gate is not itself gated
    expect(() =>
      assertTaskPhaseTransition(task({ ...rf, phase: 'todo', status: 'todo' }), 'research', false),
    ).not.toThrow();
    // research → design: an agent is refused, a human is allowed
    const inResearch = task({ ...rf, phase: 'research', status: 'researched' });
    expect(() => assertTaskPhaseTransition(inResearch, 'design', false)).toThrow('until the human approves');
    expect(() => assertTaskPhaseTransition(inResearch, 'design', false)).toThrow(TaskError);
    expect(() => assertTaskPhaseTransition(inResearch, 'design', true)).not.toThrow();
    // design → build: same gate on exit
    const inDesign = task({ ...rf, phase: 'design', status: 'designed' });
    expect(() => assertTaskPhaseTransition(inDesign, 'build', false)).toThrow('until the human approves');
    expect(() => assertTaskPhaseTransition(inDesign, 'build', true)).not.toThrow();
  });

  test('the approval-required error carries that specific code, not a plain transition error', () => {
    const inResearch = task({ workflow: 'research-first', phase: 'research', status: 'researched' });
    try {
      assertTaskPhaseTransition(inResearch, 'design', false);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskError);
      expect((error as TaskError).code).toBe('approval-required');
    }
  });

  test('investigate runs research straight to done, still gated on the human', () => {
    const inResearch = task({ workflow: 'investigate', phase: 'research', status: 'researched' });
    expect(() => assertTaskPhaseTransition(inResearch, 'done', false)).toThrow('until the human approves');
    expect(() => assertTaskPhaseTransition(inResearch, 'done', true)).not.toThrow();
  });
});

describe('a completion claim advances build work only', () => {
  test('a done signal moves build → built but never skips or deploys', () => {
    expect(completionTarget(task({ phase: 'build', status: 'in_progress' }))).toBe('built');
    // built, live, todo, research, design all yield no auto-advance target
    expect(completionTarget(task({ phase: 'built', status: 'built' }))).toBeNull();
    expect(completionTarget(task({ phase: 'todo', status: 'todo' }))).toBeNull();
    expect(completionTarget(task({ phase: 'research', status: 'researched' }))).toBeNull();
    expect(completionTarget(task({ phase: 'live', status: 'live' }))).toBeNull();
  });
});

describe('the dependency graph is validated as a whole', () => {
  test('a valid DAG including a diamond passes', () => {
    const tasks = [
      task({ id: 'F1', dependsOn: [] }),
      task({ id: 'F2', dependsOn: ['F1'] }),
      task({ id: 'F3', dependsOn: ['F1'] }),
      task({ id: 'F4', dependsOn: ['F2', 'F3'] }),
    ];
    expect(() => assertTaskDag(tasks)).not.toThrow();
  });

  test('a self cycle is refused with the concrete # path', () => {
    const tasks = [task({ id: 'F1', dependsOn: ['F1'] })];
    expect(() => assertTaskDag(tasks)).toThrow('#F1 → #F1');
  });

  test('a direct two-node cycle is refused with the concrete # path', () => {
    const tasks = [task({ id: 'F1', dependsOn: ['F2'] }), task({ id: 'F2', dependsOn: ['F1'] })];
    expect(() => assertTaskDag(tasks)).toThrow(TaskError);
    expect(() => assertTaskDag(tasks)).toThrow(/#F1 → #F2 → #F1|#F2 → #F1 → #F2/);
  });

  test('a long cycle is refused and the error names its code', () => {
    const tasks = [
      task({ id: 'F1', dependsOn: ['F2'] }),
      task({ id: 'F2', dependsOn: ['F3'] }),
      task({ id: 'F3', dependsOn: ['F1'] }),
    ];
    try {
      assertTaskDag(tasks);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskError);
      expect((error as TaskError).code).toBe('cycle');
      expect((error as TaskError).message).toContain('#F1');
      expect((error as TaskError).message).toContain('#F3');
    }
  });

  test('a dependency on a task not in the set is refused as not-found', () => {
    const tasks = [task({ id: 'F1', dependsOn: ['F9'] })];
    expect(() => assertTaskDag(tasks)).toThrow('#F1 depends on missing task #F9');
  });
});

describe('dropping respects live dependents', () => {
  test('a drop is refused while a non-dropped task still depends on it', () => {
    const tasks = [task({ id: 'F1' }), task({ id: 'F2', dependsOn: ['F1'] })];
    expect(taskDependents(tasks, 'F1').map(t => t.id)).toEqual(['F2']);
    expect(() => assertTaskCanDrop(tasks, 'F1')).toThrow('depended on by #F2');
  });

  test('a drop is allowed once every dependent is itself dropped', () => {
    const tasks = [task({ id: 'F1' }), task({ id: 'F2', dependsOn: ['F1'], phase: 'dropped', status: 'dropped' })];
    expect(() => assertTaskCanDrop(tasks, 'F1')).not.toThrow();
  });
});

describe('derived dependency blocking', () => {
  test('a dependency satisfies only at built, live, or done', () => {
    expect(dependencySatisfied(undefined)).toBe(false);
    expect(dependencySatisfied(task({ phase: 'build' }))).toBe(false);
    expect(dependencySatisfied(task({ phase: 'built' }))).toBe(true);
    expect(dependencySatisfied(task({ phase: 'live' }))).toBe(true);
    expect(dependencySatisfied(task({ phase: 'done' }))).toBe(true);
  });

  test('an unmet dependency blocks and populates blockedBy; it clears at built/live/done', () => {
    const dependent = task({ id: 'F2', dependsOn: ['F1'] });
    const edge = activity({
      type: 'dependency',
      time: '2026-07-26T13:00:00.000Z',
      data: { taskId: 'F1', operation: 'add' },
    });

    const blocked = computeTaskBlocking(dependent, [edge], [dependent, task({ id: 'F1', phase: 'build' })]);
    expect(blocked.blocked).toBe(true);
    expect(blocked.blockedBy).toEqual(['F1']);
    expect(blocked.blockedReason).toBe('Waiting on #F1');
    // blockedSince is dated from the edge that introduced the dependency.
    expect(blocked.blockedSince).toBe('2026-07-26T13:00:00.000Z');

    for (const phase of ['built', 'live', 'done'] as TaskPhase[]) {
      const cleared = computeTaskBlocking(dependent, [edge], [dependent, task({ id: 'F1', phase })]);
      expect(cleared.blocked).toBe(false);
      expect(cleared.blockedBy).toEqual([]);
    }
  });
});

describe('approval blocking is separate from dependency blocking', () => {
  test('an approval blocker fires only after a completion-claim in research or design', () => {
    const inResearch = task({ workflow: 'research-first', phase: 'research', status: 'researched' });
    // No claim yet — working in the gate is not itself a blocker.
    expect(computeTaskBlocking(inResearch, [], [inResearch]).blocked).toBe(false);

    const claim = activity({
      seq: 2,
      type: 'session',
      time: '2026-07-27T00:00:00.000Z',
      data: { event: 'completion-claim', phase: 'research' },
    });
    const blocked = computeTaskBlocking(inResearch, [claim], [inResearch]);
    expect(blocked.blocked).toBe(true);
    expect(blocked.blockedReason).toBe('Human approval is required to leave research.');
    // An approval blocker leaves blockedBy EMPTY — it is a human surface, not a graph edge.
    expect(blocked.blockedBy).toEqual([]);
    expect(blocked.blockedSince).toBe('2026-07-27T00:00:00.000Z');
  });

  test('a completion-claim for a different phase does not block, and build is never an approval gate', () => {
    const inResearch = task({ workflow: 'research-first', phase: 'research', status: 'researched' });
    const wrongPhase = activity({
      type: 'session',
      time: '2026-07-27T00:00:00.000Z',
      data: { event: 'completion-claim', phase: 'design' },
    });
    expect(computeTaskBlocking(inResearch, [wrongPhase], [inResearch]).blocked).toBe(false);

    // A build task with a completion-claim advances via status, it is never held for approval.
    const inBuild = task({ workflow: 'quick', phase: 'build', status: 'in_progress' });
    const buildClaim = activity({
      type: 'session',
      time: '2026-07-27T00:00:00.000Z',
      data: { event: 'completion-claim', phase: 'build' },
    });
    expect(computeTaskBlocking(inBuild, [buildClaim], [inBuild]).blocked).toBe(false);
  });

  test('a manual blocked status blocks with its own reason and an empty blockedBy', () => {
    const held = task({ status: 'blocked', statusReason: 'needs an API key from the user' });
    const result = computeTaskBlocking(held, [], [held]);
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe('needs an API key from the user');
    expect(result.blockedBy).toEqual([]);
  });

  test('withTaskBlocking merges the derived blocker onto the view', () => {
    const dependent = view({ id: 'F2', dependsOn: ['F1'] });
    const merged = withTaskBlocking(dependent, [], [dependent, task({ id: 'F1', phase: 'build' })]);
    expect(merged.blocked).toBe(true);
    expect(merged.blockedBy).toEqual(['F1']);
  });
});

describe('list ordering surfaces the longest-stalled task first', () => {
  test('blocked rows sort ahead of unblocked ones', () => {
    const rows = [
      view({ id: 'F1', blocked: false }),
      view({ id: 'F2', blocked: true, blockedSince: '2026-07-26T00:00:00.000Z' }),
    ];
    expect([...rows].sort(compareTaskViews).map(r => r.id)).toEqual(['F2', 'F1']);
  });

  test('among blocked rows the oldest blockedSince wins', () => {
    const rows = [
      view({ id: 'F1', blocked: true, blockedSince: '2026-07-27T00:00:00.000Z' }),
      view({ id: 'F2', blocked: true, blockedSince: '2026-07-25T00:00:00.000Z' }),
      view({ id: 'F3', blocked: true, blockedSince: '2026-07-26T00:00:00.000Z' }),
      // A null blockedSince sorts last among blocked rows (treated as most-recent).
      view({ id: 'F4', blocked: true, blockedSince: null }),
    ];
    expect([...rows].sort(compareTaskViews).map(r => r.id)).toEqual(['F2', 'F3', 'F1', 'F4']);
  });

  test('stale rows follow blockers, precede ordinary work, and oldest updatedAt wins', () => {
    const stale = (id: string, updatedAt: string): TaskView =>
      view({
        id,
        updatedAt,
        live: { ...unknownTaskLive(), staleness: 'quiet' },
      });
    const rows = [
      view({ id: 'F1' }),
      stale('F2', '2026-07-27T00:00:00.000Z'),
      stale('F3', '2026-07-25T00:00:00.000Z'),
      view({ id: 'F4', blocked: true, blockedSince: '2026-07-26T00:00:00.000Z' }),
    ];
    expect([...rows].sort(compareTaskViews).map(row => row.id)).toEqual(['F4', 'F3', 'F2', 'F1']);
  });
});
