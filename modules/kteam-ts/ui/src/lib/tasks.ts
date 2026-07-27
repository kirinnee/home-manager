/**
 * Read-only task-board shapes and presentation helpers.
 *
 * The daemon owns the canonical task files. This module deliberately accepts
 * unknown API input and degrades field-by-field, so a partially-corrupt record
 * cannot take down the board (nor can UI code accidentally write task files).
 */
export const TASK_STATUSES = [
  'live',
  'built',
  'in_progress',
  'designed',
  'researched',
  'todo',
  'blocked',
  'dropped',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
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
  assigneeStatus: string | null;
  assigneeHealth: TaskHealth | null;
  assigneeDoneMarker: boolean;
  assigneeLastActivityAt: string | null;
  staleness: TaskStaleness | null;
}

export interface TaskSummary {
  id: string;
  kind: TaskKind | null;
  title: string;
  status: TaskStatus;
  statusReason: string | null;
  assignee: string | null;
  repo: string | null;
  links: TaskLinks;
  order: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  live: TaskLive;
}

export interface TaskRecord extends TaskSummary {
  description: string;
  createdBy: string | null;
}

export type TaskActivityType = 'created' | 'status' | 'note' | 'link' | 'assign' | 'feedback' | 'session';
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
const KIND_SET = new Set<TaskKind>(['bug', 'feature', 'infra', 'chore']);
const ACTIVITY_SET = new Set<TaskActivityType>(['created', 'status', 'note', 'link', 'assign', 'feedback', 'session']);

const EMPTY_LINKS: TaskLinks = { prs: [], branch: null, commits: [], docs: [] };
const EMPTY_LIVE: TaskLive = {
  assigneeStatus: null,
  assigneeHealth: null,
  assigneeDoneMarker: false,
  assigneeLastActivityAt: null,
  staleness: null,
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(item => (text(item) ? [text(item)!] : [])) : [];
}
function isStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

export function parseTaskLinks(value: unknown): TaskLinks {
  const raw = object(value);
  if (!raw) return EMPTY_LINKS;
  return {
    prs: strings(raw['prs']),
    branch: text(raw['branch']),
    commits: strings(raw['commits']),
    docs: strings(raw['docs']),
  };
}

export function parseTaskLive(value: unknown): TaskLive {
  const raw = object(value);
  if (!raw) return EMPTY_LIVE;
  const staleness = raw['staleness'];
  return {
    assigneeStatus: text(raw['assigneeStatus']),
    assigneeHealth:
      raw['assigneeHealth'] === 'active' ||
      raw['assigneeHealth'] === 'waiting' ||
      raw['assigneeHealth'] === 'dead' ||
      raw['assigneeHealth'] === 'unknown'
        ? raw['assigneeHealth']
        : null,
    assigneeDoneMarker: raw['assigneeDoneMarker'] === true,
    assigneeLastActivityAt: text(raw['assigneeLastActivityAt']),
    staleness:
      staleness === 'assignee-dead' || staleness === 'maybe-finished' || staleness === 'quiet' ? staleness : null,
  };
}

/** A summary needs only an id, title and declared status. Invalid records skip. */
export function parseTaskSummary(value: unknown): TaskSummary | null {
  const raw = object(value);
  if (!raw) return null;
  const id = text(raw['id']);
  const title = text(raw['title']);
  if (!id || !title || !isStatus(raw['status'])) return null;
  const kind = raw['kind'];
  return {
    id,
    title,
    status: raw['status'],
    kind: typeof kind === 'string' && KIND_SET.has(kind as TaskKind) ? (kind as TaskKind) : null,
    statusReason: text(raw['statusReason']),
    assignee: text(raw['assignee']),
    repo: text(raw['repo']),
    links: parseTaskLinks(raw['links']),
    order: typeof raw['order'] === 'number' && Number.isFinite(raw['order']) ? raw['order'] : null,
    createdAt: text(raw['createdAt']),
    updatedAt: text(raw['updatedAt']),
    live: parseTaskLive(raw['live']),
  };
}

export function parseTaskRecord(value: unknown): TaskRecord | null {
  const summary = parseTaskSummary(value);
  const raw = object(value);
  if (!summary || !raw) return null;
  return {
    ...summary,
    description: typeof raw['description'] === 'string' ? raw['description'] : '',
    createdBy: text(raw['createdBy']),
  };
}

export function parseTaskActivity(value: unknown): TaskActivity | null {
  const raw = object(value);
  if (!raw || typeof raw['seq'] !== 'number' || !Number.isFinite(raw['seq']) || typeof raw['type'] !== 'string')
    return null;
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

export const TASK_STATUS_META: Record<TaskStatus, { label: string; tone: 'ok' | 'warn' | 'err' | 'pend' | 'accent' }> =
  {
    live: { label: 'Live', tone: 'ok' },
    built: { label: 'Built', tone: 'accent' },
    in_progress: { label: 'In progress', tone: 'warn' },
    designed: { label: 'Designed', tone: 'accent' },
    researched: { label: 'Researched', tone: 'warn' },
    todo: { label: 'To do', tone: 'pend' },
    blocked: { label: 'Blocked', tone: 'err' },
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

export function taskLivenessLabel(task: Pick<TaskSummary, 'assignee' | 'live'>): string {
  if (!task.assignee) return 'Unassigned';
  if (task.live.staleness) return TASK_STALENESS_COPY[task.live.staleness].label;
  if (task.live.assigneeStatus) return `${task.assignee} · ${task.live.assigneeStatus}`;
  return `${task.assignee} · status unavailable`;
}

export function taskActivityText(activity: TaskActivity): string {
  const d = activity.data;
  const note = text(d['note']) ?? text(d['text']);
  if (activity.type === 'status')
    return note
      ? `${String(d['from'] ?? 'status')} → ${String(d['to'] ?? 'status')}: ${note}`
      : `${String(d['from'] ?? 'status')} → ${String(d['to'] ?? 'status')}`;
  if (activity.type === 'assign') return `Assigned to ${String(d['assignee'] ?? d['to'] ?? 'unassigned')}`;
  if (activity.type === 'link') return `Linked ${String(d['field'] ?? 'item')}: ${String(d['value'] ?? '')}`;
  if (activity.type === 'created') return `Created${d['status'] ? ` as ${String(d['status'])}` : ''}`;
  return note ?? (activity.type === 'session' ? `Session ${String(d['event'] ?? 'updated')}` : activity.type);
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

export function groupTasks(tasks: TaskSummary[]): Array<{ status: TaskStatus; tasks: TaskSummary[] }> {
  return TASK_STATUSES.map(status => ({
    status,
    tasks: tasks
      .filter(task => task.status === status)
      .sort(
        (a, b) =>
          (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
      ),
  })).filter(group => group.tasks.length > 0);
}
