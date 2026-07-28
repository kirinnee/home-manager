// Pure Task System v2 workflow and DAG policy. No I/O lives here: storage,
// API, CLI, and UI tests can all exercise the same transition/cycle rules.

import {
  TASK_BOARD_ORDER,
  TASK_WORKFLOW_PATHS,
  TaskError,
  taskReference,
  type Task,
  type TaskActivity,
  type TaskPhase,
  type TaskStatus,
  type TaskView,
  type TaskWorkflow,
} from './tasks-types';

const STATUS_TO_PHASE: Readonly<Record<TaskStatus, TaskPhase>> = {
  todo: 'todo',
  researched: 'research',
  designed: 'design',
  in_progress: 'build',
  built: 'built',
  live: 'live',
  done: 'done',
  // A manual block is orthogonal to phase. Legacy rows did not retain the
  // previous phase, so todo is the only honest additive fallback.
  blocked: 'todo',
  dropped: 'dropped',
};

const PHASE_TO_STATUS: Readonly<Record<TaskPhase, TaskStatus>> = {
  todo: 'todo',
  research: 'researched',
  design: 'designed',
  build: 'in_progress',
  built: 'built',
  live: 'live',
  done: 'done',
  dropped: 'dropped',
};

export function taskPhaseFromStatus(status: TaskStatus): TaskPhase {
  return STATUS_TO_PHASE[status];
}

export function taskStatusFromPhase(phase: TaskPhase): TaskStatus {
  return PHASE_TO_STATUS[phase];
}

/** Best-effort workflow for additive parsing of v1 records. New records always
 * persist their explicit choice. */
export function inferTaskWorkflow(phase: TaskPhase): TaskWorkflow {
  if (phase === 'research' || phase === 'done') return 'investigate';
  if (phase === 'design') return 'design-first';
  return 'quick';
}

export function taskWorkflowPath(workflow: TaskWorkflow): readonly TaskPhase[] {
  return TASK_WORKFLOW_PATHS[workflow];
}

export function assertTaskPhaseInWorkflow(workflow: TaskWorkflow, phase: TaskPhase): void {
  if (phase === 'dropped') return;
  if (!TASK_WORKFLOW_PATHS[workflow].includes(phase)) {
    throw new TaskError('transition', `phase ${phase} is not part of the ${workflow} workflow`);
  }
}

/** Enforce one adjacent phase edge. Research and design are human approval
 * gates: an agent may enter/work in them, but only the human can exit them. */
export function assertTaskPhaseTransition(task: Task, to: TaskPhase, human: boolean): void {
  const from = task.phase;
  if (from === to) throw new TaskError('transition', `${taskReference(task.id)} is already in ${to}`);
  if (from === 'dropped') throw new TaskError('transition', `${taskReference(task.id)} was dropped and cannot advance`);
  if (to === 'dropped') return;
  const path = TASK_WORKFLOW_PATHS[task.workflow];
  const fromIndex = path.indexOf(from);
  const toIndex = path.indexOf(to);
  if (fromIndex < 0 || toIndex !== fromIndex + 1) {
    const expected = fromIndex >= 0 ? path[fromIndex + 1] : undefined;
    throw new TaskError(
      'transition',
      `${taskReference(task.id)} cannot move ${from} → ${to} in ${task.workflow}; expected ${expected ?? 'no further phase'}`,
    );
  }
  if ((from === 'research' || from === 'design') && !human) {
    throw new TaskError(
      'approval-required',
      `${taskReference(task.id)} cannot leave ${from} until the human approves it`,
    );
  }
}

export function completionTarget(task: Task): TaskPhase | null {
  // A done signal is a claim about active build work. It never skips research,
  // design, or todo, and it never deploys.
  return task.phase === 'build' ? 'built' : null;
}

export function dependencySatisfied(task: Task | undefined): boolean {
  return task !== undefined && (task.phase === 'built' || task.phase === 'live' || task.phase === 'done');
}

function uniqueTaskMap(tasks: readonly Task[]): Map<string, Task> {
  const graph = new Map<string, Task>();
  for (const task of tasks) {
    if (graph.has(task.id)) throw new TaskError('ambiguous', `task ${taskReference(task.id)} exists more than once`);
    graph.set(task.id, task);
  }
  return graph;
}

/** Validate existence and acyclicity for the complete candidate record set.
 * The error includes the concrete cycle so the writer can repair the edge. */
export function assertTaskDag(tasks: readonly Task[]): void {
  const graph = uniqueTaskMap(tasks);
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!graph.has(dependency)) {
        throw new TaskError(
          'not-found',
          `${taskReference(task.id)} depends on missing task ${taskReference(dependency)}`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(Math.max(0, start)), id].map(taskReference).join(' → ');
      throw new TaskError('cycle', `dependency cycle refused: ${cycle}`);
    }
    visiting.add(id);
    path.push(id);
    for (const dependency of graph.get(id)?.dependsOn ?? []) visit(dependency);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

export function taskDependents(tasks: readonly Task[], id: string): Task[] {
  return tasks.filter(task => task.dependsOn.includes(id));
}

export function assertTaskCanDrop(tasks: readonly Task[], id: string): void {
  const dependents = taskDependents(tasks, id).filter(task => task.phase !== 'dropped');
  if (dependents.length === 0) return;
  throw new TaskError(
    'dependency-conflict',
    `${taskReference(id)} cannot be dropped; depended on by ${dependents.map(task => taskReference(task.id)).join(', ')}`,
  );
}

export interface TaskBlocking {
  blocked: boolean;
  blockedReason: string | null;
  blockedSince: string | null;
  blockedBy: string[];
}

function latestTime(activity: readonly TaskActivity[], predicate: (entry: TaskActivity) => boolean): string | null {
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const entry = activity[index]!;
    if (predicate(entry)) return entry.time;
  }
  return null;
}

const timeValue = (value: string | null): number => {
  if (value === null) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

/** One derived blocker contract consumed by list/Kanban/DAG and Attention.
 * Dependency-only blockers populate blockedBy and therefore stay quiet on the
 * human attention surface; approval/manual blockers leave blockedBy empty. */
export function computeTaskBlocking(
  task: Task,
  activity: readonly TaskActivity[],
  allTasks: readonly Task[],
): TaskBlocking {
  const graph = new Map(allTasks.map(candidate => [candidate.id, candidate] as const));
  const blockedBy = task.dependsOn.filter(id => !dependencySatisfied(graph.get(id)));
  if (blockedBy.length > 0) {
    const edgeTimes = blockedBy.map(
      id =>
        latestTime(
          activity,
          entry => entry.type === 'dependency' && entry.data['taskId'] === id && entry.data['operation'] !== 'remove',
        ) ?? task.createdAt,
    );
    const blockedSince = edgeTimes.sort((a, b) => timeValue(a) - timeValue(b))[0] ?? task.createdAt;
    return {
      blocked: true,
      blockedReason: `Waiting on ${blockedBy.map(taskReference).join(', ')}`,
      blockedSince,
      blockedBy,
    };
  }

  if (task.status === 'blocked') {
    return {
      blocked: true,
      blockedReason: task.statusReason ?? 'Human input is required.',
      blockedSince:
        latestTime(activity, entry => entry.type === 'status' && entry.data['to'] === 'blocked') ?? task.updatedAt,
      blockedBy: [],
    };
  }

  if (task.phase === 'research' || task.phase === 'design') {
    const phaseChangedAt =
      latestTime(
        activity,
        entry => entry.type === 'status' && (entry.data['phaseTo'] === task.phase || entry.data['to'] === task.phase),
      ) ?? task.createdAt;
    const claimAt = latestTime(
      activity,
      entry =>
        entry.type === 'session' &&
        entry.data['event'] === 'completion-claim' &&
        entry.data['phase'] === task.phase &&
        timeValue(entry.time) >= timeValue(phaseChangedAt),
    );
    if (claimAt !== null) {
      return {
        blocked: true,
        blockedReason: `Human approval is required to leave ${task.phase}.`,
        blockedSince: claimAt,
        blockedBy: [],
      };
    }
  }

  return { blocked: false, blockedReason: null, blockedSince: null, blockedBy: [] };
}

export function withTaskBlocking(
  view: TaskView,
  activity: readonly TaskActivity[],
  allTasks: readonly Task[],
): TaskView {
  return { ...view, ...computeTaskBlocking(view, activity, allTasks) };
}

/** Default list reading: the task stalled longest is first. Unblocked rows then
 * keep the established status/rank/id stability. */
export function compareTaskViews(a: TaskView, b: TaskView): number {
  const aUrgency = a.blocked ? 0 : a.live.staleness !== null ? 1 : 2;
  const bUrgency = b.blocked ? 0 : b.live.staleness !== null ? 1 : 2;
  if (aUrgency !== bUrgency) return aUrgency - bUrgency;
  if (a.blocked && b.blocked) {
    const stalled = timeValue(a.blockedSince) - timeValue(b.blockedSince);
    if (stalled !== 0) return stalled;
  }
  if (aUrgency === 1) {
    const stalled = timeValue(a.updatedAt) - timeValue(b.updatedAt);
    if (stalled !== 0) return stalled;
  }
  const group = TASK_BOARD_ORDER.indexOf(a.status) - TASK_BOARD_ORDER.indexOf(b.status);
  if (group !== 0) return group;
  const rank = (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY);
  return rank !== 0 ? rank : a.id.localeCompare(b.id, undefined, { numeric: true });
}
