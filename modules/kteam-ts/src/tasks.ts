// TaskService — the daemon-side task manager, and THE import point for the
// wiring patch. Everything the daemon, the API server, the CLI and the migration
// script need is re-exported from here, so `api-server.ts` / `index.ts` /
// `service.ts` each gain one import line and no knowledge of the layout:
//
//     import { TaskService, matchTaskRoute, parseTaskActionBody } from './tasks';
//
// Shape follows learning.ts exactly, for the same reason: the subsystem must
// type-check and test on its own while the shared daemon files are being edited
// by other people. It derives its own paths (tasks-store.taskPaths), declares its
// own types (tasks-types.ts), and depends on a NARROW slice of the session world
// (`TaskDeps` = "list the fleet"), which `SessionManager` satisfies structurally.
//
// THE TWO RULES IT ENFORCES:
//
//  1. Writes are daemon-only and serialised. The store refuses a write unless it
//     was constructed with `role: 'daemon'`, and every mutation here is
//     read → mutate a COPY → atomic record write → one-line activity append,
//     ordered per task by the store's queue.
//  2. Declared status is never derived. Every read joins on a `live` block
//     (tasks-live.ts) that can flag a mismatch; nothing in this file writes a
//     status the caller did not ask for.

import type { KTeamPaths } from './paths';
import { now } from './io';
import {
  TaskStore,
  resolveStatusReason,
  toTaskSummary,
  validateTaskDescription,
  validateTaskKind,
  validateTaskLinkValue,
  validateTaskNote,
  validateTaskOrder,
  validateTaskStatus,
  validateTaskTitle,
  parseTaskLinks,
  type TaskFilter,
} from './tasks-store';
import { annotateTasks, hasCurrentDoneMarker, type TaskAssigneeView, type TaskLiveOptions } from './tasks-live';
import {
  MAX_TASK_LINKS_PER_FIELD,
  TASK_SCHEMA_VERSION,
  TaskError,
  emptyTaskLinks,
  type Task,
  type TaskActionInput,
  type TaskActivity,
  type TaskActor,
  type TaskCreateInput,
  type TaskDetailResponse,
  type TaskLinks,
  type TaskListResponse,
  type TaskView,
} from './tasks-types';

// Re-exported so a wiring patch needs ONE import (see the header).
export * from './tasks-types';
export {
  TaskStore,
  taskPaths,
  isTaskId,
  normalizeTaskId,
  splitTaskId,
  parseTaskRecord,
  parseTaskActivity,
  parseTaskActivityLog,
  parseTaskCounters,
  parseTaskLinks,
  serializeTask,
  compareTasks,
  matchesTaskFilter,
  toTaskSummary,
  validateTaskTitle,
  validateTaskDescription,
  validateTaskNote,
  validateTaskLinkValue,
  validateTaskKind,
  validateTaskStatus,
  validateTaskOrder,
  resolveStatusReason,
  SerialQueue,
  type TaskFilter,
  type TaskStoreRole,
  type TaskActivityInput,
  type TaskMutation,
  type ParsedActivity,
} from './tasks-store';
export {
  annotateTask,
  annotateTasks,
  computeTaskLive,
  resolveAssignee,
  assigneeHealthOf,
  hasCurrentDoneMarker,
  type TaskAssigneeView,
  type TaskLiveOptions,
} from './tasks-live';
export * from './tasks-contract';

/** The narrow slice of the session world the service needs: list the fleet so an
 *  assignee can be resolved to live state. `SessionManager.list()` satisfies it
 *  structurally, so the wiring patch passes the manager itself. */
export interface TaskDeps {
  list(): Promise<TaskAssigneeView[]>;
}

export interface TaskServiceOptions {
  /** Enables the `quiet` staleness flag (phase 2 by default: omitted here means
   *  never quiet — see tasks-live.computeTaskLive). */
  quietAfterMs?: number;
}

export class TaskService {
  private readonly store: TaskStore;

  constructor(
    private readonly paths: KTeamPaths,
    private readonly deps: TaskDeps,
    private readonly options: TaskServiceOptions = {},
  ) {
    // The daemon — and ONLY the daemon — gets a writable store.
    this.store = new TaskStore(paths, { role: 'daemon' });
  }

  /** Exposed for the migration script and tests; the service owns the only
   *  writable handle in the process. */
  get tasks(): TaskStore {
    return this.store;
  }

  // ---- reads --------------------------------------------------------------

  /** The board. Summaries (no briefs) plus a `live` block each, and a count of
   *  records that were skipped because they did not parse. */
  async taskList(filter: TaskFilter = {}): Promise<TaskListResponse> {
    const { tasks, parseErrors, parseErrorIds } = await this.store.listTasks(filter);
    const annotated = await this.annotate(tasks);
    return { tasks: annotated.map(toTaskSummary), parseErrors, ...(parseErrorIds.length > 0 ? { parseErrorIds } : {}) };
  }

  /** One task: the full record (brief included) plus its history. `afterSeq`
   *  serves the UI's incremental fetch. Undefined when the task does not exist
   *  or its record is unreadable — the caller answers 404. */
  async taskDetail(id: string, afterSeq = 0): Promise<TaskDetailResponse | undefined> {
    const task = await this.store.readTask(id);
    if (task === undefined) return undefined;
    const [view] = await this.annotate([task]);
    if (view === undefined) return undefined;
    const { activity, parseErrors } = await this.store.readActivity(task.id, afterSeq);
    return { task: view, activity, ...(parseErrors > 0 ? { activityParseErrors: parseErrors } : {}) };
  }

  /** Annotate records with derived liveness. Never mutates the records; the
   *  done-marker lookup is the only I/O and it is per DISTINCT assignee, not per
   *  task, so a board of 40 tasks assigned to 3 teammates does 3 reads. */
  private async annotate(tasks: readonly Task[]): Promise<TaskView[]> {
    if (tasks.length === 0) return [];
    const views = await this.deps.list().catch(() => [] as TaskAssigneeView[]);
    const withMarkers = await this.withDoneMarkers(tasks, views);
    const liveOptions: TaskLiveOptions =
      this.options.quietAfterMs !== undefined ? { quietAfterMs: this.options.quietAfterMs, nowMs: Date.now() } : {};
    return annotateTasks(tasks, withMarkers, liveOptions);
  }

  /** Attach `hasDoneMarker` to just the sessions some task is assigned to. */
  private async withDoneMarkers(
    tasks: readonly Task[],
    views: readonly TaskAssigneeView[],
  ): Promise<TaskAssigneeView[]> {
    const assignees = new Set(tasks.map(task => task.assignee).filter((value): value is string => value !== null));
    if (assignees.size === 0) return [...views];
    const relevant = views.filter(
      view =>
        assignees.has(view.config.id) ||
        (view.config.teammate !== undefined && assignees.has(view.config.teammate)) ||
        (view.config.name !== undefined && assignees.has(view.config.name)),
    );
    const markers = new Map<string, boolean>();
    await Promise.all(
      relevant.map(async view => {
        const turn = view.state.turn ?? view.config.turn;
        markers.set(view.config.id, await hasCurrentDoneMarker(this.paths, view.config.id, turn).catch(() => false));
      }),
    );
    return views.map(view =>
      markers.has(view.config.id) ? { ...view, hasDoneMarker: markers.get(view.config.id) === true } : view,
    );
  }

  // ---- writes -------------------------------------------------------------

  /** Create a task: allocate the id, write the record, open the history with a
   *  `created` line. Every cap and the reason-required rule apply here exactly as
   *  they do to an update — a create is not a back door. */
  async taskCreate(input: TaskCreateInput): Promise<TaskView> {
    const kind = validateTaskKind(input.kind);
    const title = validateTaskTitle(input.title);
    const description = validateTaskDescription(input.description);
    const status = input.status === undefined ? 'todo' : validateTaskStatus(input.status);
    const statusReason = resolveStatusReason(status, input.statusReason);
    const order = validateTaskOrder(input.order);
    const links = createLinks(input.links);
    const at = now();
    const id = await this.store.allocateId(kind);
    const record: Task = {
      v: TASK_SCHEMA_VERSION,
      id,
      kind,
      title,
      description,
      status,
      statusReason,
      assignee: trimOrNull(input.assignee),
      repo: trimOrNull(input.repo),
      links,
      order,
      createdAt: at,
      createdBy: trimOrNull(input.actor),
      updatedAt: at,
    };
    const written = await this.store.transact(id, async mutation => {
      const task = await mutation.write(record, { updatedAt: at });
      await mutation.append({
        type: 'created',
        actor: input.actor ?? null,
        actorName: input.actorName ?? null,
        time: at,
        data: {
          status,
          kind,
          title,
          ...(statusReason !== null ? { reason: statusReason } : {}),
          ...(task.assignee !== null ? { assignee: task.assignee } : {}),
        },
      });
      return task;
    });
    const [view] = await this.annotate([written]);
    // annotate() returns one view per input record, so this is defensive only.
    return view ?? { ...written, live: { ...emptyLive() } };
  }

  /** Apply one action as ONE per-task transaction: read under the lock, mutate a
   *  COPY, write the record atomically, append exactly one activity line — then
   *  release. Two actions arriving together are therefore strictly ordered, and
   *  the second one sees the first one's record.
   *
   *  THE LOST UPDATE THIS CLOSES: with the read outside the lock, a `note` and a
   *  `status` posted in the same tick both read the old record and the later
   *  write reverted the other's declared fields — a board that silently un-does a
   *  status change. Both events are still recorded; last DECLARED write wins, and
   *  a note can no longer clobber a status because it re-reads it under the lock.
   *  Validation happens inside the transaction too, so a refusal writes nothing. */
  async taskAct(id: string, input: TaskActionInput & TaskActor): Promise<TaskView> {
    const written = await this.store.transact(id, async mutation => {
      const current = mutation.current;
      if (current === undefined) throw new TaskError('not-found', `unknown task ${mutation.id}`);

      const at = now();
      let next: Task = { ...current, links: parseTaskLinks(current.links) };
      let activityType: TaskActivity['type'] = 'note';
      let data: Record<string, unknown> = {};

      switch (input.action) {
        case 'status': {
          const status = validateTaskStatus(input.status);
          // A `blocked`/`dropped` write with no reason is refused, not defaulted.
          const reason = resolveStatusReason(status, input.reason);
          const note = input.note === undefined ? null : validateTaskNote(input.note, 'note');
          next = { ...next, status, statusReason: reason };
          activityType = 'status';
          data = {
            from: current.status,
            to: status,
            ...(reason !== null ? { reason } : {}),
            ...(note !== null ? { note } : {}),
          };
          break;
        }
        case 'note':
        case 'feedback': {
          // Declared fields are carried over from the record just read under the
          // lock, so a note only ever moves `updatedAt`.
          const text = validateTaskNote(input.text, input.action);
          activityType = input.action;
          data = { text };
          break;
        }
        case 'link': {
          const value = validateTaskLinkValue(input.value, input.field);
          next = { ...next, links: applyLink(next.links, input.field, value) };
          activityType = 'link';
          data = { field: input.field, value };
          break;
        }
        case 'assign': {
          const assignee = trimOrNull(input.assignee);
          next = { ...next, assignee };
          activityType = 'assign';
          data = { from: current.assignee, to: assignee };
          break;
        }
        case 'order': {
          const order = validateTaskOrder(input.order);
          next = { ...next, order };
          activityType = 'order';
          data = { from: current.order, to: order };
          break;
        }
        default: {
          // Exhaustiveness: an unknown action never silently no-ops.
          const unknown = input as { action?: unknown };
          throw new TaskError('invalid', `unknown task action ${String(unknown.action)}`);
        }
      }

      const task = await mutation.write(next, { updatedAt: at });
      await mutation.append({
        type: activityType,
        actor: input.actor ?? null,
        actorName: input.actorName ?? null,
        time: at,
        data,
      });
      return task;
    });
    const [view] = await this.annotate([written]);
    return view ?? { ...written, live: { ...emptyLive() } };
  }
}

const emptyLive = () => ({
  assigneeStatus: null,
  assigneeHealth: null,
  assigneeDoneMarker: false,
  assigneeLastActivityAt: null,
  staleness: null,
});

const trimOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Links supplied at create time, validated through the same caps as a `link`
 *  action (over-cap values are REFUSED here, not silently dropped as they are on
 *  a defensive READ of a damaged file). */
function createLinks(input: TaskCreateInput['links']): TaskLinks {
  const links = emptyTaskLinks();
  if (!input) return links;
  const list = (values: string[] | undefined, label: string): string[] => {
    if (values === undefined) return [];
    if (!Array.isArray(values)) throw new TaskError('invalid', `links.${label} must be an array`);
    if (values.length > MAX_TASK_LINKS_PER_FIELD) {
      throw new TaskError(
        'too-long',
        `links.${label} holds ${values.length} entries; the maximum is ${MAX_TASK_LINKS_PER_FIELD}`,
      );
    }
    const out: string[] = [];
    for (const value of values) {
      const text = validateTaskLinkValue(value, `links.${label}`);
      if (!out.includes(text)) out.push(text);
    }
    return out;
  };
  links.prs = list(input.prs, 'prs');
  links.commits = list(input.commits, 'commits');
  links.docs = list(input.docs, 'docs');
  links.branch =
    input.branch === undefined || input.branch === null ? null : validateTaskLinkValue(input.branch, 'links.branch');
  return links;
}

/** Apply one link write. `branch` is singular (last write wins); the lists
 *  append, de-duplicate, and REFUSE past the per-field cap — the record is not a
 *  log, and the log is right there. */
function applyLink(links: TaskLinks, field: 'pr' | 'branch' | 'commit' | 'doc', value: string): TaskLinks {
  const next: TaskLinks = {
    prs: [...links.prs],
    branch: links.branch,
    commits: [...links.commits],
    docs: [...links.docs],
  };
  if (field === 'branch') {
    next.branch = value;
    return next;
  }
  const key = field === 'pr' ? 'prs' : field === 'commit' ? 'commits' : 'docs';
  const list = next[key];
  if (list.includes(value)) return next; // idempotent: the same PR twice is one PR
  if (list.length >= MAX_TASK_LINKS_PER_FIELD) {
    throw new TaskError(
      'too-long',
      `links.${key} already holds ${list.length} entries; the maximum is ${MAX_TASK_LINKS_PER_FIELD}`,
    );
  }
  list.push(value);
  return next;
}
