// TaskService — daemon-side, session-scoped task records.
//
// Live task data is one atomic `<sessionDir>/tasks.json` snapshot per session.
// The old fleet-global TaskStore is retained as a read-only migration source and
// unresolved-record home; no route writes it. `GET /v1/tasks` remains an
// aggregate read so the human can still see the whole fleet.

import type { KTeamEvent } from './types';
import type { KTeamPaths } from './paths';
import { now } from './io';
import {
  TaskStore,
  compareTasks,
  normalizeTaskId as normalizeTaskIdLocal,
  parseTaskLinks,
  resolveStatusReason,
  toTaskSummary,
  validateTaskDescription,
  validateTaskKind,
  validateTaskLinkValue,
  validateTaskNote,
  validateTaskOrder,
  validateTaskStatus,
  validateTaskTitle,
  type TaskFilter,
} from './tasks-store';
import {
  SESSION_TASK_FILE_VERSION,
  SessionTaskStore,
  isSafeTaskSessionId,
  type SessionTaskStoreOptions,
  type StoredSessionTask,
} from './session-tasks-store';
import { migrateLegacyTasks, type TaskMigrationReport } from './tasks-migration';
import {
  annotateTasks,
  hasCurrentDoneMarker,
  resolveAssignee,
  type TaskAssigneeView,
  type TaskLiveOptions,
} from './tasks-live';
import {
  MAX_TASK_LINKS_PER_FIELD,
  TASK_SCHEMA_VERSION,
  TaskError,
  emptyTaskLinks,
  type FleetTaskListResponse,
  type ScopedTaskDetailResponse,
  type ScopedTaskView,
  type SessionTaskListResponse,
  type Task,
  type TaskActionInput,
  type TaskActivity,
  type TaskActor,
  type TaskCreateInput,
  type TaskLinks,
  type TaskView,
} from './tasks-types';

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
export * from './session-tasks-store';
export * from './tasks-migration';
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

/** Narrow session-world dependency. `SessionManager.list()` satisfies it. */
export interface TaskDeps {
  list(): Promise<TaskAssigneeView[]>;
}

export interface TaskServiceOptions extends SessionTaskStoreOptions {
  quietAfterMs?: number;
}

interface Provenance {
  actor: string;
  actorName: string | null;
  session: string | null;
}

export class TaskService {
  private readonly store: SessionTaskStore;
  private readonly legacy: TaskStore;
  private readonly listeners = new Set<(event: KTeamEvent) => void>();
  private initialization: Promise<TaskMigrationReport> | undefined;

  constructor(
    private readonly paths: KTeamPaths,
    private readonly deps: TaskDeps,
    private readonly options: TaskServiceOptions = {},
  ) {
    this.store = new SessionTaskStore(paths, { role: options.role ?? 'daemon' });
    // Intentionally reader-only: live code cannot mutate the retained source.
    this.legacy = new TaskStore(paths);
  }

  get tasks(): SessionTaskStore {
    return this.store;
  }

  get legacyTasks(): TaskStore {
    return this.legacy;
  }

  /** Copy-only, idempotent startup migration. Safe to call more than once in a
   *  process; every route also awaits it so wiring cannot accidentally serve a
   *  half-migrated view. */
  initialize(): Promise<TaskMigrationReport> {
    if (this.initialization === undefined) {
      const attempt = (async () => {
        const views = await this.deps.list().catch(() => [] as TaskAssigneeView[]);
        return migrateLegacyTasks(this.paths, this.legacy, this.store, views);
      })();
      this.initialization = attempt.catch(error => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  subscribe(listener: (event: KTeamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- session reads -----------------------------------------------------

  async sessionTaskList(sessionId: string, filter: TaskFilter = {}): Promise<SessionTaskListResponse> {
    await this.initialize();
    this.assertSessionId(sessionId);
    const read = await this.store.list(sessionId, filter);
    const views = await this.annotate(read.tasks.map(entry => entry.task));
    return {
      v: SESSION_TASK_FILE_VERSION,
      sessionId,
      tasks: views.map(view => ({ ...toTaskSummary(view), sessionId })),
      parseErrors: read.parseErrors,
      ...(read.parseErrorIds.length > 0 ? { parseErrorIds: read.parseErrorIds } : {}),
      updatedAt: read.file.updatedAt,
    };
  }

  async sessionTaskDetail(sessionId: string, id: string, afterSeq = 0): Promise<ScopedTaskDetailResponse | undefined> {
    await this.initialize();
    this.assertSessionId(sessionId);
    const { entry, read } = await this.store.detail(sessionId, id);
    if (entry === undefined) return undefined;
    const [view] = await this.annotate([entry.task]);
    if (view === undefined) return undefined;
    const activity = afterSeq > 0 ? entry.activity.filter(item => item.seq > afterSeq) : entry.activity;
    const activityParseErrors = read.activityParseErrors.get(entry.task.id) ?? 0;
    return {
      sessionId,
      task: { ...view, sessionId },
      activity,
      ...(activityParseErrors > 0 ? { activityParseErrors } : {}),
    };
  }

  // ---- aggregate read compatibility ------------------------------------

  /** Fleet-wide READ only. Every row carries its storage scope; unresolved
   *  legacy rows carry null and remain in the retained old store. */
  async taskList(filter: TaskFilter = {}): Promise<FleetTaskListResponse> {
    await this.initialize();
    const sessionIds = await this.store.listSessionIds();
    const scoped: Array<{ sessionId: string | null; task: Task }> = [];
    const migrated = new Set<string>();
    const parseErrorIds: string[] = [];
    let parseErrors = 0;

    for (const sessionId of sessionIds) {
      const read = await this.store.list(sessionId, filter);
      scoped.push(...read.tasks.map(entry => ({ sessionId, task: entry.task })));
      parseErrors += read.parseErrors;
      parseErrorIds.push(...read.parseErrorIds.map(id => `${sessionId}:${id}`));
      // A marker proves representation only while the corresponding record is
      // still readable. If it is damaged, the retained source becomes visible.
      for (const id of read.file.migratedGlobalIds) {
        if (read.file.tasks.some(entry => entry.task.id === id)) migrated.add(id);
      }
    }

    const legacy = await this.legacy.listTasks(filter);
    for (const task of legacy.tasks) {
      if (!migrated.has(task.id)) scoped.push({ sessionId: null, task });
    }
    parseErrors += legacy.parseErrors;
    parseErrorIds.push(...legacy.parseErrorIds.map(id => `legacy:${id}`));

    scoped.sort((a, b) => compareTasks(a.task, b.task) || String(a.sessionId).localeCompare(String(b.sessionId)));
    const annotated = await this.annotate(scoped.map(item => item.task));
    return {
      v: SESSION_TASK_FILE_VERSION,
      sessionId: null,
      tasks: annotated.map((view, index) => ({ ...toTaskSummary(view), sessionId: scoped[index]!.sessionId })),
      parseErrors,
      ...(parseErrorIds.length > 0 ? { parseErrorIds } : {}),
      updatedAt: now(),
    };
  }

  /** Compatibility detail for the existing fleet board. IDs are allocated
   *  globally, but migration conflicts or hand-edited data can still duplicate
   *  one; that case receives a 409 instead of an arbitrary record. */
  async taskDetail(id: string, afterSeq = 0): Promise<ScopedTaskDetailResponse | undefined> {
    await this.initialize();
    const canonical = canonicalTaskId(id);
    const sessionIds = await this.store.listSessionIds();
    const hits: Array<{ sessionId: string | null; entry: StoredSessionTask; activityParseErrors: number }> = [];
    let migrated = false;

    for (const sessionId of sessionIds) {
      const { entry, read } = await this.store.detail(sessionId, canonical);
      if (entry !== undefined) {
        hits.push({
          sessionId,
          entry,
          activityParseErrors: read.activityParseErrors.get(canonical) ?? 0,
        });
      }
      if (entry !== undefined && read.file.migratedGlobalIds.includes(canonical)) migrated = true;
    }

    if (!migrated) {
      const task = await this.legacy.readTask(canonical);
      if (task !== undefined) {
        const history = await this.legacy.readActivity(canonical);
        hits.push({
          sessionId: null,
          entry: { task, activity: history.activity },
          activityParseErrors: history.parseErrors,
        });
      }
    }
    if (hits.length === 0) return undefined;
    if (hits.length > 1) {
      const scopes = hits.map(hit => hit.sessionId ?? 'legacy-unassigned').join(', ');
      throw new TaskError(
        'ambiguous',
        `task ${canonical} exists in multiple scopes (${scopes}); use a session task route`,
      );
    }
    const hit = hits[0]!;
    const [view] = await this.annotate([hit.entry.task]);
    if (view === undefined) return undefined;
    return {
      sessionId: hit.sessionId,
      task: { ...view, sessionId: hit.sessionId },
      activity: afterSeq > 0 ? hit.entry.activity.filter(item => item.seq > afterSeq) : hit.entry.activity,
      ...(hit.activityParseErrors > 0 ? { activityParseErrors: hit.activityParseErrors } : {}),
    };
  }

  // ---- session writes ----------------------------------------------------

  async sessionTaskCreate(sessionId: string, input: TaskCreateInput, actor: TaskActor = {}): Promise<ScopedTaskView> {
    await this.initialize();
    const provenance = await this.authorize(sessionId, actor);
    const kind = validateTaskKind(input.kind);
    const title = validateTaskTitle(input.title);
    const description = validateTaskDescription(input.description);
    const status = input.status === undefined ? 'todo' : validateTaskStatus(input.status);
    const statusReason = resolveStatusReason(status, input.statusReason);
    const order = validateTaskOrder(input.order);
    const links = createLinks(input.links);
    const at = now();

    const result = await this.store.create(sessionId, kind, id => {
      const task: Task = {
        v: TASK_SCHEMA_VERSION,
        id,
        kind,
        title,
        description,
        status,
        statusReason,
        // The board owner is the useful default. An explicit assignee remains
        // declared metadata (sessionId is the immutable storage scope).
        assignee: input.assignee === undefined ? sessionId : trimOrNull(input.assignee),
        repo: trimOrNull(input.repo),
        links,
        order,
        createdAt: at,
        createdBy: provenance.session,
        updatedAt: at,
      };
      const created: TaskActivity = {
        v: TASK_SCHEMA_VERSION,
        seq: 1,
        time: at,
        actor: provenance.actor,
        actorName: provenance.actorName,
        type: 'created',
        data: {
          status,
          kind,
          title,
          ...(statusReason !== null ? { reason: statusReason } : {}),
          ...(task.assignee !== null ? { assignee: task.assignee } : {}),
        },
      };
      return { task, activity: [created] };
    });
    const view = await this.view(result.value.task, sessionId);
    await this.emit(sessionId, provenance);
    return view;
  }

  async sessionTaskAct(
    sessionId: string,
    id: string,
    input: TaskActionInput,
    actor: TaskActor = {},
  ): Promise<ScopedTaskView> {
    await this.initialize();
    const provenance = await this.authorize(sessionId, actor);
    const result = await this.store.transact(sessionId, id, current => {
      const at = now();
      let next: Task = { ...current.task, links: parseTaskLinks(current.task.links) };
      let activityType: TaskActivity['type'] = 'note';
      let data: Record<string, unknown> = {};

      switch (input.action) {
        case 'status': {
          const status = validateTaskStatus(input.status);
          const reason = resolveStatusReason(status, input.reason);
          const note = input.note === undefined ? null : validateTaskNote(input.note, 'note');
          next = { ...next, status, statusReason: reason };
          activityType = 'status';
          data = {
            from: current.task.status,
            to: status,
            ...(reason !== null ? { reason } : {}),
            ...(note !== null ? { note } : {}),
          };
          break;
        }
        case 'note':
        case 'feedback': {
          activityType = input.action;
          data = { text: validateTaskNote(input.text, input.action) };
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
          data = { from: current.task.assignee, to: assignee };
          break;
        }
        case 'order': {
          const order = validateTaskOrder(input.order);
          next = { ...next, order };
          activityType = 'order';
          data = { from: current.task.order, to: order };
          break;
        }
        default: {
          const unknown = input as { action?: unknown };
          throw new TaskError('invalid', `unknown task action ${String(unknown.action)}`);
        }
      }

      const highest = current.activity.reduce((value, item) => Math.max(value, item.seq), 0);
      const activity: TaskActivity = {
        v: TASK_SCHEMA_VERSION,
        seq: highest + 1,
        time: at,
        actor: provenance.actor,
        actorName: provenance.actorName,
        type: activityType,
        data,
      };
      return { task: { ...next, updatedAt: at }, activity: [...current.activity, activity] };
    });
    const view = await this.view(result.value.task, sessionId);
    await this.emit(sessionId, provenance);
    return view;
  }

  // ---- source-compatible service helpers (not HTTP routes) ---------------

  /** Older internal callers passed actor fields in the create object. Keep that
   *  source shape while still writing the actor's session file; API parsing does
   *  not call this helper and never trusts those body fields. */
  async taskCreate(input: TaskCreateInput & TaskActor): Promise<ScopedTaskView> {
    const requested = actorSession(input) ?? trimOrNull(input.assignee);
    if (requested === null) {
      throw new TaskError('invalid', 'a session-scoped task create needs a target session');
    }
    const views = await this.deps.list().catch(() => [] as TaskAssigneeView[]);
    const target =
      views.find(view => view.config.id === requested)?.config.id ?? resolveAssignee(requested, views)?.config.id;
    if (target === undefined) throw new TaskError('not-found', `no session resolves from ${requested}`);
    const { actor, actorName, ...body } = input;
    return this.sessionTaskCreate(target, body, { actor, actorName });
  }

  /** Compatibility aggregate-id action. It is deliberately ambiguity-safe. */
  async taskAct(id: string, input: TaskActionInput & TaskActor): Promise<ScopedTaskView> {
    const detail = await this.taskDetail(id);
    if (detail === undefined) throw new TaskError('not-found', `unknown task ${canonicalTaskId(id)}`);
    if (detail.sessionId === null) {
      throw new TaskError(
        'forbidden',
        `legacy-unassigned task ${detail.task.id} is read-only; assign it to a real session and rerun migration`,
      );
    }
    const { actor, actorName, ...action } = input;
    return this.sessionTaskAct(detail.sessionId, detail.task.id, action as TaskActionInput, { actor, actorName });
  }

  // ---- internals ---------------------------------------------------------

  private assertSessionId(sessionId: string): void {
    if (!isSafeTaskSessionId(sessionId)) {
      throw new TaskError('invalid', `not a valid session id: ${String(sessionId)}`);
    }
  }

  private async authorize(sessionId: string, actor: TaskActor): Promise<Provenance> {
    this.assertSessionId(sessionId);
    const provenance = provenanceOf(actor);
    if (provenance.session !== null && provenance.session !== sessionId) {
      throw new TaskError('forbidden', 'an agent may only change tasks in its own session');
    }
    const views = await this.deps.list().catch(() => [] as TaskAssigneeView[]);
    if (!views.some(view => view.config.id === sessionId)) {
      throw new TaskError('not-found', `no such session ${sessionId}`);
    }
    return provenance;
  }

  private async view(task: Task, sessionId: string): Promise<ScopedTaskView> {
    const [view] = await this.annotate([task]);
    return { ...(view ?? { ...task, live: emptyLive() }), sessionId };
  }

  private async annotate(tasks: readonly Task[]): Promise<TaskView[]> {
    if (tasks.length === 0) return [];
    const views = await this.deps.list().catch(() => [] as TaskAssigneeView[]);
    const withMarkers = await this.withDoneMarkers(tasks, views);
    const liveOptions: TaskLiveOptions =
      this.options.quietAfterMs !== undefined ? { quietAfterMs: this.options.quietAfterMs, nowMs: Date.now() } : {};
    return annotateTasks(tasks, withMarkers, liveOptions);
  }

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

  private async emit(sessionId: string, provenance: Provenance): Promise<void> {
    const snapshot = await this.sessionTaskList(sessionId);
    const event: KTeamEvent<SessionTaskListResponse> = {
      sequence: 0,
      time: now(),
      sessionId,
      turn: 0,
      type: 'tasks.updated',
      source: provenance.session ? `peer:${provenance.session}` : 'client',
      data: snapshot,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A socket subscriber is liveness only; it never rolls back storage.
      }
    }
  }
}

function canonicalTaskId(id: string): string {
  const canonical = normalizeTaskIdLocal(id);
  if (canonical === null) throw new TaskError('invalid', `not a task id: ${String(id)}`);
  return canonical;
}

function provenanceOf(actor: TaskActor): Provenance {
  const raw = typeof actor.actor === 'string' ? actor.actor.trim() : '';
  if (raw === '' || raw === 'user') return { actor: 'user', actorName: 'user', session: null };
  const actorName = typeof actor.actorName === 'string' && actor.actorName.trim() ? actor.actorName.trim() : null;
  return { actor: raw, actorName, session: raw };
}

function actorSession(actor: TaskActor): string | null {
  const value = typeof actor.actor === 'string' ? actor.actor.trim() : '';
  return value && value !== 'user' ? value : null;
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
  if (list.includes(value)) return next;
  if (list.length >= MAX_TASK_LINKS_PER_FIELD) {
    throw new TaskError(
      'too-long',
      `links.${key} already holds ${list.length} entries; the maximum is ${MAX_TASK_LINKS_PER_FIELD}`,
    );
  }
  list.push(value);
  return next;
}
