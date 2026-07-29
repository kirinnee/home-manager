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
  SerialQueue,
  compareTasks,
  normalizeTaskId as normalizeTaskIdLocal,
  parseTaskLinks,
  resolveStatusReason,
  toTaskSummary,
  validateTaskDescription,
  validateTaskDependencies,
  validateTaskFile,
  validateTaskFiles,
  validateTaskKind,
  validateTaskLinkValue,
  validateTaskMessage,
  validateTaskNote,
  validateTaskOrder,
  validateTaskPhase,
  validateTaskStatus,
  validateTaskTitle,
  validateTaskWorkflow,
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
  assertTaskCanDrop,
  assertTaskDag,
  assertTaskPhaseInWorkflow,
  assertTaskPhaseTransition,
  compareTaskViews,
  completionTarget,
  dependencySatisfied,
  inferTaskWorkflow,
  taskPhaseMovesBackward,
  taskPhaseFromStatus,
  taskStatusFromPhase,
  withTaskBlocking,
} from './tasks-workflow';
import {
  MAX_TASK_LINKS_PER_FIELD,
  MAX_TASK_CLARIFICATIONS,
  MAX_TASK_FILES,
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
  type TaskPhase,
  type TaskView,
  type TaskWorkflow,
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
  subscribe?(listener: (event: KTeamEvent) => void): () => void;
}

export interface TaskServiceOptions extends SessionTaskStoreOptions {
  quietAfterMs?: number;
}

interface Provenance {
  actor: string;
  actorName: string | null;
  session: string | null;
}

interface ShippedReopen {
  id: string;
  title: string;
  from: 'live' | 'done';
  to: TaskPhase;
  reason: string;
}

export class TaskService {
  private readonly store: SessionTaskStore;
  private readonly legacy: TaskStore;
  private readonly graphQueue = new SerialQueue();
  private readonly listeners = new Set<(event: KTeamEvent) => void>();
  private initialization: Promise<TaskMigrationReport> | undefined;
  private lifecycleUnsubscribe: (() => void) | undefined;

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
        const report = await migrateLegacyTasks(this.paths, this.legacy, this.store, views);
        this.attachLifecycle();
        return report;
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
    const views = await this.annotateEntries(read.tasks, await this.graphTasks());
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
    const [view] = await this.annotateEntries([entry], await this.graphTasks());
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

  /** One-file startup baseline for durable source adapters. This deliberately
   * returns stored activity without liveness/DAG annotation: Attention only
   * needs the append-only reopen evidence, and reading task detail once per row
   * would reread the same session file N times at daemon boot. */
  async sessionTaskActivityBaselines(sessionId: string): Promise<{
    tasks: Array<{
      id: string;
      workflow: TaskWorkflow;
      activity: TaskActivity[];
      activityParseErrors: number;
    }>;
    parseErrors: number;
  }> {
    await this.initialize();
    this.assertSessionId(sessionId);
    const read = await this.store.read(sessionId);
    return {
      tasks: read.file.tasks.map(entry => ({
        id: entry.task.id,
        workflow: entry.task.workflow,
        activity: [...entry.activity],
        activityParseErrors: read.activityParseErrors.get(entry.task.id) ?? 0,
      })),
      parseErrors: read.parseErrors,
    };
  }

  // ---- aggregate read compatibility ------------------------------------

  /** Fleet-wide READ only. Every row carries its storage scope; unresolved
   *  legacy rows carry null and remain in the retained old store. */
  async taskList(filter: TaskFilter = {}): Promise<FleetTaskListResponse> {
    await this.initialize();
    const sessionIds = await this.store.listSessionIds();
    const scoped: Array<{ sessionId: string | null; entry: StoredSessionTask }> = [];
    const migrated = new Set<string>();
    const parseErrorIds: string[] = [];
    let parseErrors = 0;

    for (const sessionId of sessionIds) {
      const read = await this.store.list(sessionId, filter);
      scoped.push(...read.tasks.map(entry => ({ sessionId, entry })));
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
      if (!migrated.has(task.id)) {
        const history = await this.legacy.readActivity(task.id);
        scoped.push({ sessionId: null, entry: { task, activity: history.activity } });
      }
    }
    parseErrors += legacy.parseErrors;
    parseErrorIds.push(...legacy.parseErrorIds.map(id => `legacy:${id}`));

    scoped.sort(
      (a, b) => compareTasks(a.entry.task, b.entry.task) || String(a.sessionId).localeCompare(String(b.sessionId)),
    );
    const annotated = await this.annotateEntries(
      scoped.map(item => item.entry),
      await this.graphTasks(),
    );
    const scopeById = new Map(scoped.map(item => [item.entry.task.id, item.sessionId] as const));
    return {
      v: SESSION_TASK_FILE_VERSION,
      sessionId: null,
      tasks: annotated.map(view => ({ ...toTaskSummary(view), sessionId: scopeById.get(view.id) ?? null })),
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
    const [view] = await this.annotateEntries([hit.entry], await this.graphTasks());
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
    const suppliedStatus = input.status === undefined ? undefined : validateTaskStatus(input.status);
    const phase =
      input.phase !== undefined
        ? validateTaskPhase(input.phase)
        : suppliedStatus !== undefined
          ? taskPhaseFromStatus(suppliedStatus)
          : ('todo' as const);
    const workflow = input.workflow === undefined ? inferTaskWorkflow(phase) : validateTaskWorkflow(input.workflow);
    assertTaskPhaseInWorkflow(workflow, phase);
    if (suppliedStatus !== undefined && suppliedStatus !== 'blocked' && taskPhaseFromStatus(suppliedStatus) !== phase) {
      throw new TaskError('invalid', `status ${suppliedStatus} does not match phase ${phase}`);
    }
    const status = suppliedStatus === 'blocked' ? 'blocked' : taskStatusFromPhase(phase);
    const statusReason = resolveStatusReason(status, input.statusReason);
    const ask =
      input.ask === undefined
        ? { text: description.length > 0 ? description : title, source: `session:${sessionId}` }
        : validateTaskMessage(input.ask);
    const dependsOn = validateTaskDependencies(input.dependsOn);
    const files = validateTaskFiles(input.files);
    const order = validateTaskOrder(input.order);
    const links = createLinks(input.links);
    const at = now();

    const outcome = await this.graphQueue.run('__task_graph__', async () => {
      const allTasks = await this.graphTasks();
      const write = await this.store.create(sessionId, kind, id => {
        const task: Task = {
          v: TASK_SCHEMA_VERSION,
          id,
          kind,
          title,
          description,
          ask,
          clarifications: [],
          workflow,
          phase,
          dependsOn,
          status,
          statusReason,
          // The board owner is the useful default. An explicit assignee remains
          // declared metadata (sessionId is the immutable storage scope).
          assignee: input.assignee === undefined ? sessionId : trimOrNull(input.assignee),
          repo: trimOrNull(input.repo),
          files,
          links,
          order,
          createdAt: at,
          createdBy: provenance.session,
          updatedAt: at,
        };
        assertTaskDag([...allTasks, task]);
        const created: TaskActivity = {
          v: TASK_SCHEMA_VERSION,
          seq: 1,
          time: at,
          actor: provenance.actor,
          actorName: provenance.actorName,
          type: 'created',
          data: {
            status,
            phase,
            workflow,
            kind,
            title,
            askSource: ask.source,
            dependsOn: [...dependsOn],
            // Advisory file claims supplied at create time belong in authoritative
            // history, not just the snapshot — so a later reader sees what was
            // claimed from the start. Omitted when none were supplied.
            ...(files.length > 0 ? { files: [...files] } : {}),
            reason: statusReason ?? 'Task created.',
            ...(task.assignee !== null ? { assignee: task.assignee } : {}),
          },
        };
        return { task, activity: [created] };
      });
      return { write, graph: [...allTasks, write.value.task] };
    });
    const view = await this.view(outcome.write.value, sessionId, outcome.graph);
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
    const outcome = await this.graphQueue.run('__task_graph__', async () => {
      const allTasks = await this.graphTasks();
      let satisfactionChanged = false;
      let shippedReopen: ShippedReopen | null = null;
      const write = await this.store.transact(sessionId, id, current => {
        const at = now();
        let next: Task = {
          ...current.task,
          links: parseTaskLinks(current.task.links),
          dependsOn: [...current.task.dependsOn],
          files: [...current.task.files],
          clarifications: current.task.clarifications.map(item => ({ ...item })),
        };
        const activityBefore: Array<{ type: TaskActivity['type']; data: Record<string, unknown> }> = [];
        let activityType: TaskActivity['type'] = 'note';
        let data: Record<string, unknown> = {};

        const appendClarification = (text: unknown, source: unknown): Record<string, unknown> => {
          if (next.clarifications.length >= MAX_TASK_CLARIFICATIONS) {
            throw new TaskError(
              'too-long',
              `${current.task.id} already has ${next.clarifications.length} clarifications; the maximum is ${MAX_TASK_CLARIFICATIONS}`,
            );
          }
          const clarification = validateTaskMessage({ text, source }, 'clarification');
          next = {
            ...next,
            clarifications: [
              ...next.clarifications,
              { ...clarification, at, by: provenance.actor, byName: provenance.actorName },
            ],
          };
          return { text: clarification.text, source: clarification.source };
        };

        const movePhase = (to: TaskPhase, rawReason: unknown, note?: string): void => {
          const reasonText = trimOrNull(rawReason);
          if (reasonText === null) {
            throw new TaskError('reason-required', 'phase changes require a reason');
          }
          const reason = validateTaskNote(reasonText, 'phase change reason');
          const transitionNote = note === undefined ? null : validateTaskNote(note, 'note');
          const clearingManualBlock = current.task.status === 'blocked' && to === current.task.phase;
          if (!clearingManualBlock) {
            assertTaskPhaseTransition(current.task, to, provenance.session === null);
          }
          const backward = !clearingManualBlock && taskPhaseMovesBackward(current.task, to);
          const reopeningShipped = backward && (current.task.phase === 'live' || current.task.phase === 'done');
          if (to === 'dropped') assertTaskCanDrop(allTasks, current.task.id);
          const status = taskStatusFromPhase(to);
          next = {
            ...next,
            phase: to,
            status,
            statusReason: to === 'dropped' || backward ? reason : null,
          };
          activityType = 'status';
          data = {
            from: current.task.status,
            to: status,
            phaseFrom: current.task.phase,
            phaseTo: to,
            reason,
            ...(transitionNote !== null ? { note: transitionNote } : {}),
            ...(backward ? { backward: true } : {}),
            ...(reopeningShipped ? { reopened: true } : {}),
            ...(!backward &&
            (current.task.phase === 'research' || current.task.phase === 'design' || current.task.phase === 'live') &&
            provenance.session === null
              ? { approvedByHuman: true }
              : {}),
            ...(current.task.phase === 'live' && to === 'done' && provenance.session === null
              ? { verifiedByHuman: true }
              : {}),
          };
          if (backward && (current.task.phase === 'live' || current.task.phase === 'done')) {
            shippedReopen = {
              id: current.task.id,
              title: current.task.title,
              from: current.task.phase,
              to,
              reason,
            };
          }
        };

        switch (input.action) {
          case 'status': {
            const status = validateTaskStatus(input.status);
            if (status === 'blocked') {
              const reason = resolveStatusReason(status, input.reason);
              const note = input.note === undefined ? null : validateTaskNote(input.note, 'note');
              next = { ...next, status, statusReason: reason };
              activityType = 'status';
              data = {
                from: current.task.status,
                to: status,
                phaseFrom: current.task.phase,
                phaseTo: current.task.phase,
                reason,
                ...(note !== null ? { note } : {}),
              };
            } else {
              movePhase(taskPhaseFromStatus(status), input.reason, input.note);
            }
            break;
          }
          case 'phase': {
            movePhase(validateTaskPhase(input.phase), input.reason);
            break;
          }
          case 'reopen': {
            if (current.task.phase !== 'built' && current.task.phase !== 'live' && current.task.phase !== 'done') {
              throw new TaskError(
                'transition',
                `${current.task.id} can be reopened only from built, live, or done; use task phase with --reason for other moves`,
              );
            }
            activityBefore.push({
              type: 'clarification',
              data: appendClarification(input.ask, input.source),
            });
            movePhase('build', input.reason);
            break;
          }
          case 'note':
          case 'feedback': {
            activityType = input.action;
            data = { text: validateTaskNote(input.text, input.action) };
            break;
          }
          case 'clarify': {
            activityType = 'clarification';
            data = appendClarification(input.text, input.source);
            break;
          }
          case 'dependency': {
            const dependency = validateTaskDependencies([input.taskId])[0]!;
            if (dependency === current.task.id) {
              throw new TaskError('cycle', `${current.task.id} cannot depend on itself`);
            }
            const remove = input.remove === true;
            const exists = next.dependsOn.includes(dependency);
            if (remove && !exists)
              throw new TaskError('invalid', `${current.task.id} does not depend on ${dependency}`);
            if (!remove && exists)
              throw new TaskError('invalid', `${current.task.id} already depends on ${dependency}`);
            next = {
              ...next,
              dependsOn: remove
                ? next.dependsOn.filter(candidate => candidate !== dependency)
                : validateTaskDependencies([...next.dependsOn, dependency]),
            };
            activityType = 'dependency';
            data = { taskId: dependency, operation: remove ? 'remove' : 'add' };
            const candidate = replaceGraphTask(allTasks, next);
            assertTaskDag(candidate);
            break;
          }
          case 'file': {
            // Advisory file claims: mutate ONLY the persisted set and record the
            // change in history. Deliberately no DAG rebuild, no blocker/Attention
            // derivation, no satisfaction recheck — overlap is surfaced elsewhere,
            // never arbitrated here. A reason is welcome but NOT required (unlike a
            // phase/status move), so a discovered claim carries no forced friction.
            const path = validateTaskFile(input.path);
            const remove = input.remove === true;
            const exists = next.files.includes(path);
            if (remove && !exists) throw new TaskError('invalid', `${current.task.id} does not claim ${path}`);
            if (!remove && exists) throw new TaskError('invalid', `${current.task.id} already claims ${path}`);
            if (!remove && next.files.length >= MAX_TASK_FILES) {
              throw new TaskError(
                'too-long',
                `${current.task.id} already claims ${next.files.length} files; the maximum is ${MAX_TASK_FILES}`,
              );
            }
            const reason = trimOrNull(input.reason);
            next = {
              ...next,
              files: remove ? next.files.filter(candidate => candidate !== path) : [...next.files, path],
            };
            activityType = 'file';
            data = {
              path,
              operation: remove ? 'remove' : 'add',
              ...(reason !== null ? { reason: validateTaskNote(reason, 'file change reason') } : {}),
            };
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
        const activities: TaskActivity[] = [...activityBefore, { type: activityType, data }].map(
          (inputActivity, index) => ({
            v: TASK_SCHEMA_VERSION,
            seq: highest + index + 1,
            time: at,
            actor: provenance.actor,
            actorName: provenance.actorName,
            type: inputActivity.type,
            data: inputActivity.data,
          }),
        );
        satisfactionChanged = dependencySatisfied(current.task) !== dependencySatisfied(next);
        return { task: { ...next, updatedAt: at }, activity: [...current.activity, ...activities] };
      });
      const graph = replaceGraphTask(allTasks, write.value.task);
      return { write, graph, satisfactionChanged, shippedReopen };
    });
    const view = await this.view(outcome.write.value, sessionId, outcome.graph);
    const emitSessions = new Set([sessionId]);
    if (outcome.satisfactionChanged) {
      for (const dependentSession of await this.dependentSessionIds([outcome.write.value.task.id])) {
        emitSessions.add(dependentSession);
      }
    }
    for (const targetSession of emitSessions) {
      await this.emit(targetSession, provenance, targetSession === sessionId ? outcome.shippedReopen : null);
    }
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
    const canonical = canonicalTaskId(id);
    const scopes: string[] = [];
    for (const sessionId of await this.store.listSessionIds()) {
      if ((await this.store.detail(sessionId, canonical)).entry !== undefined) scopes.push(sessionId);
    }
    if (scopes.length > 1) throw new TaskError('ambiguous', `task ${canonical} exists in multiple sessions`);
    if (scopes.length === 0 && (await this.legacy.readTask(canonical)) !== undefined) {
      throw new TaskError(
        'forbidden',
        `legacy-unassigned task ${canonical} is read-only; assign it to a real session and rerun migration`,
      );
    }
    const sessionId = scopes[0];
    if (sessionId === undefined) throw new TaskError('not-found', `unknown task ${canonical}`);
    const { actor, actorName, ...action } = input;
    return this.sessionTaskAct(sessionId, canonical, action as TaskActionInput, { actor, actorName });
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

  private async view(
    entry: StoredSessionTask,
    sessionId: string,
    allTasks: readonly Task[] = [],
  ): Promise<ScopedTaskView> {
    const graph = allTasks.length > 0 ? allTasks : await this.graphTasks();
    const [view] = await this.annotateEntries([entry], graph);
    return {
      ...(view ?? {
        ...entry.task,
        live: emptyLive(),
        blocked: false,
        blockedReason: null,
        blockedSince: null,
        blockedBy: [],
      }),
      sessionId,
    };
  }

  private async annotateEntries(entries: readonly StoredSessionTask[], allTasks: readonly Task[]): Promise<TaskView[]> {
    if (entries.length === 0) return [];
    const tasks = entries.map(entry => entry.task);
    const views = await this.deps.list().catch(() => [] as TaskAssigneeView[]);
    const withMarkers = await this.withDoneMarkers(tasks, views);
    const liveOptions: TaskLiveOptions =
      this.options.quietAfterMs !== undefined ? { quietAfterMs: this.options.quietAfterMs, nowMs: Date.now() } : {};
    return annotateTasks(tasks, withMarkers, liveOptions)
      .map((view, index) => withTaskBlocking(view, entries[index]?.activity ?? [], allTasks))
      .sort(compareTaskViews);
  }

  /** Complete fleet record set for cross-session edges and derived blockers.
   * Migrated legacy duplicates stay suppressed exactly like the aggregate read. */
  private async graphTasks(): Promise<Task[]> {
    const tasks: Task[] = [];
    const migrated = new Set<string>();
    for (const sessionId of await this.store.listSessionIds()) {
      const read = await this.store.read(sessionId);
      tasks.push(...read.file.tasks.map(entry => entry.task));
      for (const id of read.file.migratedGlobalIds) {
        if (read.file.tasks.some(entry => entry.task.id === id)) migrated.add(id);
      }
    }
    const legacy = await this.legacy.listTasks();
    tasks.push(...legacy.tasks.filter(task => !migrated.has(task.id)));
    return tasks;
  }

  private async scopedEntries(): Promise<Array<{ sessionId: string; entry: StoredSessionTask }>> {
    const entries: Array<{ sessionId: string; entry: StoredSessionTask }> = [];
    for (const sessionId of await this.store.listSessionIds()) {
      const read = await this.store.read(sessionId);
      entries.push(...read.file.tasks.map(entry => ({ sessionId, entry })));
    }
    return entries;
  }

  /** Session boards whose derived blocker state can change when one of these
   * dependency nodes becomes satisfied (or ceases to be). */
  private async dependentSessionIds(taskIds: readonly string[]): Promise<string[]> {
    if (taskIds.length === 0) return [];
    const changed = new Set(taskIds);
    const sessions = new Set<string>();
    for (const { sessionId, entry } of await this.scopedEntries()) {
      if (entry.task.dependsOn.some(id => changed.has(id))) sessions.add(sessionId);
    }
    return [...sessions];
  }

  private attachLifecycle(): void {
    if (this.lifecycleUnsubscribe !== undefined || this.deps.subscribe === undefined) return;
    this.lifecycleUnsubscribe = this.deps.subscribe(event => {
      if (event.type !== 'session.completed') return;
      void this.recordSessionCompletion(event).catch(error => {
        console.error(`kteamd task completion claim failed for ${event.sessionId}: ${String(error)}`);
      });
    });
  }

  /** Persist a delegated done CLAIM and, only for active build work, advance to
   * built. Research/design remain in place so the human approval gate cannot be
   * skipped. Replayed events for the same session turn are idempotent. */
  async recordSessionCompletion(event: KTeamEvent): Promise<void> {
    if (event.type !== 'session.completed') return;
    const touched = await this.graphQueue.run('__task_graph__', async () => {
      const entries = await this.scopedEntries();
      const views = await this.deps.list().catch(() => [] as TaskAssigneeView[]);
      const assigneeView = views.find(view => view.config.id === event.sessionId);
      const actorName = assigneeView?.config.teammate ?? assigneeView?.config.name ?? null;
      const affected = entries.filter(({ entry }) => {
        if (entry.task.assignee === null) return false;
        return (
          entry.task.assignee === event.sessionId ||
          resolveAssignee(entry.task.assignee, views)?.config.id === event.sessionId
        );
      });
      const changed = new Set<string>();
      const newlySatisfied = new Set<string>();

      for (const { sessionId, entry } of affected) {
        const alreadyRecorded = entry.activity.some(
          item =>
            item.type === 'session' &&
            item.data['event'] === 'completion-claim' &&
            item.data['session'] === event.sessionId &&
            item.data['turn'] === event.turn,
        );
        if (alreadyRecorded) continue;
        let wroteClaim = false;
        let advanced = false;
        await this.store.transact(sessionId, entry.task.id, current => {
          const duplicate = current.activity.some(
            item =>
              item.type === 'session' &&
              item.data['event'] === 'completion-claim' &&
              item.data['session'] === event.sessionId &&
              item.data['turn'] === event.turn,
          );
          if (duplicate) return current;
          wroteClaim = true;

          const at = event.time || now();
          const highest = current.activity.reduce((value, item) => Math.max(value, item.seq), 0);
          const target = current.task.status === 'blocked' ? null : completionTarget(current.task);
          const reason = `Assignee ${event.sessionId} signalled done for turn ${event.turn}; recorded as a completion claim.`;
          const claim: TaskActivity = {
            v: TASK_SCHEMA_VERSION,
            seq: highest + 1,
            time: at,
            actor: event.sessionId,
            actorName,
            type: 'session',
            data: {
              event: 'completion-claim',
              session: event.sessionId,
              turn: event.turn,
              phase: current.task.phase,
              claimedAt: at,
              ...(target !== null ? { advancesTo: target } : {}),
            },
          };
          if (target === null) {
            return {
              task: { ...current.task, updatedAt: at },
              activity: [...current.activity, claim],
            };
          }
          advanced = true;
          const phaseChange: TaskActivity = {
            v: TASK_SCHEMA_VERSION,
            seq: highest + 2,
            time: at,
            actor: event.sessionId,
            actorName,
            type: 'status',
            data: {
              from: current.task.status,
              to: taskStatusFromPhase(target),
              phaseFrom: current.task.phase,
              phaseTo: target,
              reason,
              completionClaim: true,
            },
          };
          return {
            task: {
              ...current.task,
              phase: target,
              status: taskStatusFromPhase(target),
              statusReason: null,
              updatedAt: at,
            },
            activity: [...current.activity, claim, phaseChange],
          };
        });
        if (wroteClaim) {
          changed.add(sessionId);
          if (advanced) newlySatisfied.add(entry.task.id);
        }
      }
      return { sessions: [...changed], newlySatisfied: [...newlySatisfied] };
    });
    const provenance: Provenance = { actor: event.sessionId, actorName: null, session: event.sessionId };
    const emitSessions = new Set(touched.sessions);
    for (const dependentSession of await this.dependentSessionIds(touched.newlySatisfied)) {
      emitSessions.add(dependentSession);
    }
    for (const sessionId of emitSessions) await this.emit(sessionId, provenance);
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

  private async emit(
    sessionId: string,
    provenance: Provenance,
    shippedReopen: ShippedReopen | null = null,
  ): Promise<void> {
    if (this.listeners.size === 0) return;
    if (shippedReopen !== null) {
      this.notify({
        sequence: 0,
        time: now(),
        sessionId,
        turn: 0,
        type: 'task.reopened',
        source: provenance.session ? `peer:${provenance.session}` : 'client',
        data: {
          ...shippedReopen,
          actor: provenance.actor,
          actorName: provenance.actorName,
        },
      });
    }
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
    this.notify(event);
  }

  private notify(event: KTeamEvent): void {
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

/** Replace the current graph node, or restore it when a damaged/legacy graph
 * read omitted the task that the scoped transaction successfully resolved. */
function replaceGraphTask(tasks: readonly Task[], next: Task): Task[] {
  let replaced = false;
  const graph = tasks.map(task => {
    if (task.id !== next.id) return task;
    replaced = true;
    return next;
  });
  return replaced ? graph : [...graph, next];
}
