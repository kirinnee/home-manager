/** Read-only task-v2 parsing and pure projections. The daemon owns records. */
export const TASK_STATUSES = [
  'todo',
  'researched',
  'designed',
  'in_progress',
  'built',
  'live',
  'done',
  'blocked',
  'dropped',
] as const;
export const TASK_PHASES = ['todo', 'research', 'design', 'build', 'built', 'live', 'done', 'dropped'] as const;
export const TASK_BOARD_LANES = ['todo', 'in_progress', 'built', 'live', 'done', 'dropped'] as const;
export const TASK_WORKFLOWS = ['quick', 'design-first', 'research-first', 'investigate'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPhase = (typeof TASK_PHASES)[number];
export type TaskBoardLane = (typeof TASK_BOARD_LANES)[number];
export type TaskWorkflow = (typeof TASK_WORKFLOWS)[number];
export type TaskKind = 'bug' | 'feature' | 'infra' | 'chore';
export type TaskStaleness = 'assignee-dead' | 'maybe-finished' | 'quiet';
export type TaskHealth = 'active' | 'waiting' | 'dead' | 'unknown';

export interface TaskLinks {
  prs: string[];
  branch: string | null;
  commits: string[];
  docs: string[];
}
export interface TaskLive {
  assigneeSessionId?: string | null;
  assigneeName?: string | null;
  assigneeStatus: string | null;
  assigneeHealth: TaskHealth | null;
  assigneeDoneMarker: boolean;
  assigneeLastActivityAt: string | null;
  staleness: TaskStaleness | null;
}
export interface TaskMessage {
  text: string;
  source: string;
}
export interface TaskClarification extends TaskMessage {
  at: string | null;
  by: string | null;
  byName: string | null;
}
export interface TaskSummary {
  id: string;
  kind: TaskKind | null;
  title: string;
  workflow: TaskWorkflow;
  phase: TaskPhase;
  dependsOn: string[];
  status: TaskStatus;
  statusReason: string | null;
  blocked: boolean;
  blockedReason: string | null;
  blockedSince: string | null;
  blockedBy: string[];
  assignee: string | null;
  repo: string | null;
  links: TaskLinks;
  order: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  askChars: number;
  askSource: string | null;
  clarificationCount: number;
  /** A session id means agent-created; null means human-created; omission is a
   * legacy record whose provenance cannot be proved. */
  createdBy?: string | null;
  /** Owning storage session. Aggregate `/v1/tasks` rows carry it; `null` names a
   *  legacy-unassigned record. Session-scoped reads leave it null harmlessly. */
  sessionId: string | null;
  /** Advisory file claims, additive; a daemon predating them yields `[]`. */
  files: string[];
  live: TaskLive;
}
export interface TaskRecord extends TaskSummary {
  description: string;
  ask: TaskMessage;
  clarifications: TaskClarification[];
  createdBy: string | null;
}
export type TaskActivityType =
  | 'created'
  | 'status'
  | 'note'
  | 'link'
  | 'assign'
  | 'order'
  | 'feedback'
  | 'clarification'
  | 'dependency'
  | 'file'
  | 'session';
export interface TaskActivity {
  v: number;
  seq: number;
  time: string | null;
  actor: string | null;
  actorName: string | null;
  type: TaskActivityType;
  data: Record<string, unknown>;
}

const STATUS_SET = new Set<string>(TASK_STATUSES);
const PHASE_SET = new Set<string>(TASK_PHASES);
const WORKFLOW_SET = new Set<string>(TASK_WORKFLOWS);
const KIND_SET = new Set<TaskKind>(['bug', 'feature', 'infra', 'chore']);
const ACTIVITY_SET = new Set<TaskActivityType>([
  'created',
  'status',
  'note',
  'link',
  'assign',
  'order',
  'feedback',
  'clarification',
  'dependency',
  'file',
  'session',
]);

const emptyLinks = (): TaskLinks => ({ prs: [], branch: null, commits: [], docs: [] });
const emptyLive = (): TaskLive => ({
  assigneeSessionId: null,
  assigneeName: null,
  assigneeStatus: null,
  assigneeHealth: null,
  assigneeDoneMarker: false,
  assigneeLastActivityAt: null,
  staleness: null,
});
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.flatMap(item => (text(item) ? [text(item)!] : [])))] : [];

export const taskReference = (id: string): `#${string}` => `#${id.replace(/^#/, '')}`;

function phaseForStatus(status: TaskStatus): TaskPhase {
  switch (status) {
    case 'researched':
      return 'research';
    case 'designed':
      return 'design';
    case 'in_progress':
      return 'build';
    case 'built':
    case 'live':
    case 'done':
    case 'dropped':
      return status;
    default:
      return 'todo';
  }
}

function workflowForPhase(phase: TaskPhase): TaskWorkflow {
  if (phase === 'research' || phase === 'done') return 'investigate';
  if (phase === 'design') return 'design-first';
  return 'quick';
}

export function parseTaskLinks(value: unknown): TaskLinks {
  const raw = object(value);
  if (!raw) return emptyLinks();
  return {
    prs: strings(raw['prs']),
    branch: text(raw['branch']),
    commits: strings(raw['commits']),
    docs: strings(raw['docs']),
  };
}
export function parseTaskLive(value: unknown): TaskLive {
  const raw = object(value);
  if (!raw) return emptyLive();
  const staleness = raw['staleness'];
  return {
    assigneeSessionId: text(raw['assigneeSessionId']),
    assigneeName: text(raw['assigneeName']),
    assigneeStatus: text(raw['assigneeStatus']),
    assigneeHealth: ['active', 'waiting', 'dead', 'unknown'].includes(String(raw['assigneeHealth']))
      ? (raw['assigneeHealth'] as TaskHealth)
      : null,
    assigneeDoneMarker: raw['assigneeDoneMarker'] === true,
    assigneeLastActivityAt: text(raw['assigneeLastActivityAt']),
    staleness: ['assignee-dead', 'maybe-finished', 'quiet'].includes(String(staleness))
      ? (staleness as TaskStaleness)
      : null,
  };
}
function parseMessage(value: unknown): TaskMessage {
  const raw = object(value);
  return { text: typeof raw?.['text'] === 'string' ? raw['text'] : '', source: text(raw?.['source']) ?? '' };
}
function parseClarifications(value: unknown): TaskClarification[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const raw = object(item);
    if (!raw) return [];
    const message = parseMessage(raw);
    return message.text || message.source
      ? [{ ...message, at: text(raw['at']), by: text(raw['by']), byName: text(raw['byName']) }]
      : [];
  });
}

/** Summary parsing accepts a v1 response defensively, but prefers the v2 fields. */
export function parseTaskSummary(value: unknown): TaskSummary | null {
  const raw = object(value);
  if (!raw) return null;
  const id = text(raw['id']);
  const title = text(raw['title']);
  if (!id || !title || !STATUS_SET.has(String(raw['status']))) return null;
  const status = raw['status'] as TaskStatus;
  // P1: never surface a status/phase contradiction to a renderer. `blocked`
  // legitimately retains its pre-block phase, so it keeps a valid declared
  // phase; every other status has exactly one coherent phase, so a declared
  // phase that disagrees is repaired down to the status-derived one — the record
  // is served, but never with two contradictory states.
  const declaredPhase = PHASE_SET.has(String(raw['phase'])) ? (raw['phase'] as TaskPhase) : null;
  const phase =
    status === 'blocked'
      ? (declaredPhase ?? phaseForStatus(status))
      : declaredPhase === phaseForStatus(status)
        ? declaredPhase
        : phaseForStatus(status);
  const ask = parseMessage(raw['ask']);
  const blockedBy = strings(raw['blockedBy']);
  const blocked = raw['blocked'] === true || status === 'blocked';
  const kind = raw['kind'];
  const createdBy = raw['createdBy'] === null ? null : text(raw['createdBy']);
  return {
    id,
    title,
    status,
    phase,
    workflow: WORKFLOW_SET.has(String(raw['workflow'])) ? (raw['workflow'] as TaskWorkflow) : workflowForPhase(phase),
    dependsOn: strings(raw['dependsOn']),
    kind: typeof kind === 'string' && KIND_SET.has(kind as TaskKind) ? (kind as TaskKind) : null,
    statusReason: text(raw['statusReason']),
    blocked,
    blockedReason: text(raw['blockedReason']) ?? (blocked ? text(raw['statusReason']) : null),
    blockedSince: text(raw['blockedSince']),
    blockedBy,
    assignee: text(raw['assignee']),
    repo: text(raw['repo']),
    links: parseTaskLinks(raw['links']),
    order: typeof raw['order'] === 'number' && Number.isFinite(raw['order']) ? raw['order'] : null,
    createdAt: text(raw['createdAt']),
    updatedAt: text(raw['updatedAt']),
    askChars: typeof raw['askChars'] === 'number' && raw['askChars'] >= 0 ? raw['askChars'] : ask.text.length,
    askSource: text(raw['askSource']) ?? (ask.source || null),
    clarificationCount:
      typeof raw['clarificationCount'] === 'number' && raw['clarificationCount'] >= 0
        ? raw['clarificationCount']
        : parseClarifications(raw['clarifications']).length,
    ...(createdBy !== null || raw['createdBy'] === null ? { createdBy } : {}),
    sessionId: text(raw['sessionId']),
    files: strings(raw['files']),
    live: parseTaskLive(raw['live']),
  };
}
export function parseTaskRecord(value: unknown): TaskRecord | null {
  const summary = parseTaskSummary(value);
  const raw = object(value);
  if (!summary || !raw) return null;
  const ask = parseMessage(raw['ask']);
  const clarifications = parseClarifications(raw['clarifications']);
  return {
    ...summary,
    description: typeof raw['description'] === 'string' ? raw['description'] : '',
    ask,
    clarifications,
    askChars: ask.text.length || summary.askChars,
    askSource: ask.source || summary.askSource,
    clarificationCount: clarifications.length || summary.clarificationCount,
    createdBy: text(raw['createdBy']),
  };
}
export function parseTaskActivity(value: unknown): TaskActivity | null {
  const raw = object(value);
  if (!raw || typeof raw['seq'] !== 'number' || !Number.isSafeInteger(raw['seq']) || raw['seq'] < 1) return null;
  if (!ACTIVITY_SET.has(raw['type'] as TaskActivityType)) return null;
  return {
    v: typeof raw['v'] === 'number' && Number.isFinite(raw['v']) ? raw['v'] : 1,
    seq: raw['seq'],
    time: text(raw['time']),
    actor: text(raw['actor']),
    actorName: text(raw['actorName']),
    type: raw['type'] as TaskActivityType,
    data: object(raw['data']) ?? {},
  };
}
export function parseTaskList(value: unknown): TaskSummary[] {
  const raw = Array.isArray(value) ? value : object(value)?.['tasks'];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap(item => {
    const task = parseTaskSummary(item);
    if (!task || seen.has(task.id)) return [];
    seen.add(task.id);
    return [task];
  });
}
export interface ParsedTaskList {
  tasks: TaskSummary[];
  parseErrors: number;
}
export function parseTaskListResponse(value: unknown): ParsedTaskList {
  const raw = object(value);
  const count = raw?.['parseErrors'];
  return {
    tasks: parseTaskList(value),
    parseErrors: typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 0,
  };
}

export const TASK_STATUS_META: Record<TaskStatus, { label: string; tone: 'ok' | 'warn' | 'err' | 'pend' | 'accent' }> =
  {
    todo: { label: 'To do', tone: 'pend' },
    researched: { label: 'Researched', tone: 'warn' },
    designed: { label: 'Designed', tone: 'accent' },
    in_progress: { label: 'In progress', tone: 'warn' },
    built: { label: 'Built', tone: 'accent' },
    live: { label: 'Live', tone: 'ok' },
    done: { label: 'Done', tone: 'ok' },
    blocked: { label: 'Blocked', tone: 'err' },
    dropped: { label: 'Dropped', tone: 'err' },
  };
export const TASK_PHASE_META: Record<TaskPhase, { label: string; tone: 'ok' | 'warn' | 'err' | 'pend' | 'accent' }> = {
  todo: { label: 'To do', tone: 'pend' },
  research: { label: 'Research', tone: 'warn' },
  design: { label: 'Design', tone: 'accent' },
  build: { label: 'Build', tone: 'warn' },
  built: { label: 'Built', tone: 'accent' },
  live: { label: 'Live', tone: 'ok' },
  done: { label: 'Done', tone: 'ok' },
  dropped: { label: 'Dropped', tone: 'err' },
};
export const TASK_BOARD_LANE_META: Record<
  TaskBoardLane,
  { label: string; tone: 'ok' | 'warn' | 'err' | 'pend' | 'accent' }
> = {
  todo: { label: 'To do', tone: 'pend' },
  in_progress: { label: 'In progress', tone: 'warn' },
  built: { label: 'Built', tone: 'accent' },
  live: { label: 'Live', tone: 'ok' },
  done: { label: 'Done', tone: 'ok' },
  dropped: { label: 'Dropped', tone: 'err' },
};
export const TASK_STALENESS_COPY: Record<TaskStaleness, { label: string; reason: string }> = {
  'assignee-dead': {
    label: 'Assignee unavailable',
    reason:
      'Declared status remains in progress; the assignee is no longer live. Verify and update the declared status manually.',
  },
  'maybe-finished': {
    label: 'Maybe finished',
    reason:
      'The assignee reports completion or has a done marker. This is evidence only; verify before changing the declared status.',
  },
  quiet: {
    label: 'Quiet',
    reason: 'No recent task or assignee activity was observed. The declared status has not been changed.',
  },
};
export const TASK_WORKFLOW_LABEL: Record<TaskWorkflow, string> = {
  quick: 'Quick',
  'design-first': 'Design first',
  'research-first': 'Research first',
  investigate: 'Investigate',
};

export function taskLivenessLabel(task: Pick<TaskSummary, 'assignee' | 'live'>): string {
  if (!task.assignee) return 'Unassigned';
  if (task.live.staleness) return TASK_STALENESS_COPY[task.live.staleness].label;
  return task.live.assigneeStatus
    ? `${task.assignee} · ${task.live.assigneeStatus}`
    : `${task.assignee} · status unavailable`;
}
export function taskActivityText(activity: TaskActivity): string {
  const d = activity.data;
  const value = (key: string): string | null => text(d[key]);
  if (activity.type === 'status') {
    const from = value('phaseFrom') ?? value('from') ?? 'phase';
    const to = value('phaseTo') ?? value('to') ?? 'phase';
    return `${from} → ${to}${(value('reason') ?? value('note')) ? `: ${value('reason') ?? value('note')}` : ''}`;
  }
  if (activity.type === 'clarification') return `Clarification: ${value('text') ?? ''}`;
  if (activity.type === 'dependency') {
    const removed = d['operation'] === 'remove' || d['remove'] === true;
    return `${removed ? 'Removed dependency' : 'Depends on'} ${taskReference(String(d['taskId'] ?? d['dependency'] ?? 'unknown'))}`;
  }
  if (activity.type === 'file') {
    const removed = d['operation'] === 'remove' || d['remove'] === true;
    const reason = value('reason');
    return `${removed ? 'Unclaimed file' : 'Claimed file'} ${String(d['path'] ?? d['file'] ?? 'unknown')}${reason ? `: ${reason}` : ''}`;
  }
  if (activity.type === 'session' && d['event'] === 'completion-claim')
    return `Completion claim: ${String(d['session'] ?? activity.actor ?? 'session')} (turn ${String(d['turn'] ?? '—')}, ${String(d['phase'] ?? 'phase')})${value('reason') ? `: ${value('reason')}` : ''}`;
  if (activity.type === 'assign') return `Assigned to ${String(d['assignee'] ?? d['to'] ?? 'unassigned')}`;
  if (activity.type === 'order')
    return `Priority ${String(d['from'] ?? 'unranked')} → ${String(d['to'] ?? 'unranked')}`;
  if (activity.type === 'link') return `Linked ${String(d['field'] ?? 'item')}: ${String(d['value'] ?? '')}`;
  if (activity.type === 'created') return `Created${d['phase'] ? ` in ${String(d['phase'])}` : ''}`;
  return value('text') ?? activity.type;
}

export interface TaskFilters {
  repo: string;
  status: TaskStatus | 'all';
  assignee: string;
}
export function filterTasks(tasks: TaskSummary[], filters: TaskFilters): TaskSummary[] {
  return tasks.filter(
    task =>
      (filters.repo === 'all' || task.repo === filters.repo) &&
      (filters.status === 'all' || task.status === filters.status) &&
      (filters.assignee === 'all' || task.assignee === filters.assignee),
  );
}
const timeOf = (value: string | null): number => {
  const parsed = value ? Date.parse(value) : Number.POSITIVE_INFINITY;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};
/** ADHD list: all currently blocked/stalled cards first, oldest evidence first. */
export function sortTasksForList(tasks: readonly TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => {
    const aAttention = a.blocked ? 0 : a.live.staleness ? 1 : 2;
    const bAttention = b.blocked ? 0 : b.live.staleness ? 1 : 2;
    if (aAttention !== bAttention) return aAttention - bAttention;
    const aTime = timeOf(a.blockedSince ?? a.updatedAt ?? a.createdAt);
    const bTime = timeOf(b.blockedSince ?? b.updatedAt ?? b.createdAt);
    if (aTime !== bTime) return aTime - bTime;
    const aOrder = a.order ?? Number.POSITIVE_INFINITY;
    const bOrder = b.order ?? Number.POSITIVE_INFINITY;
    return aOrder - bOrder || a.id.localeCompare(b.id);
  });
}
/** Presentation-only collapse: raw workflow phases remain on every record and
 * in activity history, while active work scans as one board lane. */
export function taskBoardLane(phase: TaskPhase): TaskBoardLane {
  if (phase === 'research' || phase === 'design' || phase === 'build') return 'in_progress';
  return phase;
}
export function groupTasksByBoardLane(
  tasks: readonly TaskSummary[],
): Array<{ lane: TaskBoardLane; tasks: TaskSummary[] }> {
  return TASK_BOARD_LANES.map(lane => ({
    lane,
    tasks: sortTasksForList(tasks.filter(task => taskBoardLane(task.phase) === lane)),
  }));
}
/** Raw audit-phase projection retained for non-board consumers. */
export function groupTasksByPhase(tasks: readonly TaskSummary[]): Array<{ phase: TaskPhase; tasks: TaskSummary[] }> {
  return TASK_PHASES.map(phase => ({ phase, tasks: sortTasksForList(tasks.filter(task => task.phase === phase)) }));
}
/** Legacy named export retains its original raw-phase shape. */
export const groupTasks = groupTasksByPhase;

/** Rows owned by one session, derived from the single fleet array. The List and
 *  Kanban read this so they never show another session's work. */
export function tasksForSession(fleet: readonly TaskSummary[], sessionId: string): TaskSummary[] {
  return fleet.filter(task => task.sessionId === sessionId);
}

/** One DAG projection over the fleet array — NOT a second data model. A node
 *  either resolves to a real fleet task (with its state) or is honestly marked
 *  missing; cross-session nodes carry their owning session for linking. */
export interface TaskDagNode {
  id: string;
  task: TaskSummary | null;
  sessionId: string | null;
  /** Owned by a session other than the one being viewed. */
  crossSession: boolean;
  /** A selected-session task the closure grew from. */
  seed: boolean;
  /** Referenced by an edge but absent/corrupt in the fleet array. */
  missing: boolean;
}
export interface TaskDagEdge {
  from: string;
  to: string;
}
export interface TaskDag {
  nodes: TaskDagNode[];
  edges: TaskDagEdge[];
}

/** Recursive dependency closure from the selected session's tasks across the
 *  whole fleet: every dependency becomes a real node, cross-session ones
 *  included, missing ones distinguished. Edges are explicit and de-duplicated. */
export function buildTaskDag(fleet: readonly TaskSummary[], sessionId: string): TaskDag {
  const byId = new Map(fleet.map(task => [task.id, task]));
  const seedIds = new Set(tasksForSession(fleet, sessionId).map(task => task.id));
  const visited = new Set<string>();
  const edges: TaskDagEdge[] = [];
  const edgeSeen = new Set<string>();
  const queue = [...seedIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const task = byId.get(id);
    if (!task) continue;
    for (const dependency of task.dependsOn) {
      const key = `${id}->${dependency}`;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        edges.push({ from: id, to: dependency });
      }
      if (!visited.has(dependency)) queue.push(dependency);
    }
  }
  const order = new Map(
    sortTasksForList([...byId.values()].filter(task => visited.has(task.id))).map((task, index) => [task.id, index]),
  );
  const rank = (node: TaskDagNode): number => (node.seed ? 0 : node.missing ? 2 : 1);
  const nodes = [...visited]
    .map<TaskDagNode>(id => {
      const task = byId.get(id) ?? null;
      return {
        id,
        task,
        sessionId: task?.sessionId ?? null,
        crossSession: task ? task.sessionId !== sessionId : false,
        seed: seedIds.has(id),
        missing: !task,
      };
    })
    .sort((a, b) => rank(a) - rank(b) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || a.id.localeCompare(b.id));
  return { nodes, edges };
}

/** A file two tasks both claim. Advisory only — visibility, never a lock, an
 *  edge, or a blocker. */
export interface TaskFileConflict {
  taskId: string;
  sessionId: string | null;
  /** Exact overlapping file strings. */
  files: string[];
  /** The other task belongs to a different session. */
  crossSession: boolean;
}

const ACTIVE_FILE_CLAIM_PHASES = new Set<TaskPhase>(['todo', 'research', 'design', 'build']);

/** Two tasks conflict on a file only when the exact path matches AND their repos
 *  do not provably differ (equal, or either side unknown): an identical relative
 *  path in two known-different repos is not the same file. Legacy/empty file
 *  sets never conflict. */
export function computeFileConflicts(fleet: readonly TaskSummary[]): Map<string, TaskFileConflict[]> {
  const result = new Map<string, TaskFileConflict[]>();
  for (const a of fleet) {
    // Claims are an early-warning signal for concurrent work. Once a task is
    // built/live/done/dropped, retaining its historical claim must not leave a
    // permanent conflict banner on active work.
    if (!ACTIVE_FILE_CLAIM_PHASES.has(a.phase) || a.files.length === 0) continue;
    const claimed = new Set(a.files);
    const conflicts: TaskFileConflict[] = [];
    for (const b of fleet) {
      if (b.id === a.id || !ACTIVE_FILE_CLAIM_PHASES.has(b.phase) || b.files.length === 0) continue;
      if (a.repo && b.repo && a.repo !== b.repo) continue;
      const overlap = [...new Set(b.files)].filter(file => claimed.has(file)).sort();
      if (overlap.length === 0) continue;
      conflicts.push({
        taskId: b.id,
        sessionId: b.sessionId,
        files: overlap,
        crossSession: b.sessionId !== a.sessionId,
      });
    }
    if (conflicts.length > 0)
      result.set(
        a.id,
        conflicts.sort((x, y) => x.taskId.localeCompare(y.taskId)),
      );
  }
  return result;
}
