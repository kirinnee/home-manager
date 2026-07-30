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
  matchesTaskFilter,
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
  isValidShippedReopenActivity,
  isSafeTaskSessionId,
  type SessionTaskRead,
  type SessionTaskStoreOptions,
  type StoredSessionTask,
} from './session-tasks-store';
import { migrateLegacyTasks, type TaskMigrationReport } from './tasks-migration';
import {
  TaskBoardService,
  exactWorkerAssignee,
  type ResolvedTaskScope,
  type TaskBoardSessionDeps,
} from './task-boards';
import { TaskBoardStore, hashTaskBoardPayload, legacyTaskBoardSessionIncarnation } from './task-boards-store';
import { TaskBoardError, taskBoardActionForTaskAction, type TaskBoardAction } from './task-boards-types';
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
  get?(ref: string): Promise<unknown>;
  recordBoardNotice?(
    sessionId: string,
    notice: { noticeId: string; type: string; data: Record<string, unknown> },
  ): Promise<void>;
  subscribe?(listener: (event: KTeamEvent) => void): () => void;
}

export interface TaskServiceOptions extends SessionTaskStoreOptions {
  quietAfterMs?: number;
  /** Test seam. Production constructs the service from SessionManager. */
  boardService?: TaskBoardService | null;
}

interface Provenance {
  actor: string;
  actorName: string | null;
  session: string | null;
  human: boolean;
}

interface ShippedReopen {
  id: string;
  title: string;
  from: 'live' | 'done';
  to: TaskPhase;
  reason: string;
  /** Sequence of the exact status activity entry that records this reopen. */
  seq: number;
}

export class TaskService {
  private readonly store: SessionTaskStore;
  private readonly boardStore: TaskBoardStore | undefined;
  private readonly boards: TaskBoardService | undefined;
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
    if (options.boardService !== undefined) {
      this.boards = options.boardService ?? undefined;
      this.boardStore = this.boards?.store;
    } else if (typeof deps.get === 'function') {
      this.boardStore = new TaskBoardStore(paths, {
        role: options.role ?? 'daemon',
        allocateId: kind => this.store.allocateId(kind),
        resolveAssignedSessionId: async task =>
          exactWorkerAssignee(
            task,
            (await this.deps.list()) as unknown as Awaited<ReturnType<TaskBoardSessionDeps['list']>>,
          ),
        resolveSessionIdentity: async sessionId => {
          const lookup = (this.deps as unknown as TaskBoardSessionDeps).get;
          const view = await lookup?.(sessionId).catch(() => undefined);
          if (!view) return null;
          return {
            sessionIncarnation:
              view.config.incarnation ?? legacyTaskBoardSessionIncarnation(view.config.id, view.config.createdAt),
            runtimeGeneration: view.config.runtimeGeneration ?? 1,
          };
        },
      });
      this.boards = new TaskBoardService(paths, this.boardStore, deps as unknown as TaskBoardSessionDeps);
    }
    // Intentionally reader-only: live code cannot mutate the retained source.
    this.legacy = new TaskStore(paths);
  }

  get tasks(): SessionTaskStore {
    return this.store;
  }

  get legacyTasks(): TaskStore {
    return this.legacy;
  }

  get taskBoards(): TaskBoardService | undefined {
    return this.boards;
  }

  /** Copy-only, idempotent startup migration. Safe to call more than once in a
   *  process; every route also awaits it so wiring cannot accidentally serve a
   *  half-migrated view. */
  initialize(): Promise<TaskMigrationReport> {
    if (this.initialization === undefined) {
      const attempt = (async () => {
        await this.boards?.initialize();
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

  async sessionTaskList(
    sessionId: string,
    filter: TaskFilter = {},
    actor: TaskActor = { humanAdmin: true },
  ): Promise<SessionTaskListResponse> {
    await this.initialize();
    this.assertSessionId(sessionId);
    const scope = await this.resolveScope(sessionId, actor, 'read');
    const read = await this.listScope(scope, filter);
    const views = await this.annotateEntries(read.tasks, await this.graphTasks());
    return {
      v: SESSION_TASK_FILE_VERSION,
      sessionId,
      tasks: views.map(view => ({ ...toTaskSummary(view), sessionId })),
      parseErrors: read.parseErrors,
      ...(read.parseErrorIds.length > 0 ? { parseErrorIds: read.parseErrorIds } : {}),
      updatedAt: read.file.updatedAt,
      ...(scope.kind === 'board' ? { authorization: this.authorizationProvenance(scope, 'read') } : {}),
    };
  }

  async sessionTaskDetail(
    sessionId: string,
    id: string,
    afterSeq = 0,
    actor: TaskActor = { humanAdmin: true },
  ): Promise<ScopedTaskDetailResponse | undefined> {
    await this.initialize();
    this.assertSessionId(sessionId);
    const scope = await this.resolveScope(sessionId, actor, 'read');
    const { entry, read } = await this.detailScope(scope, id);
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
      ...(scope.kind === 'board' ? { authorization: this.authorizationProvenance(scope, 'read') } : {}),
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
      reopenAckSeq: number;
      activity: TaskActivity[];
      activityParseErrors: number;
    }>;
    parseErrors: number;
  }> {
    await this.initialize();
    this.assertSessionId(sessionId);
    const scope = await this.resolveScope(sessionId, { humanAdmin: true }, 'read');
    const read = await this.readScope(scope);
    return {
      tasks: read.file.tasks.map(entry => ({
        id: entry.task.id,
        workflow: entry.task.workflow,
        reopenAckSeq: entry.task.reopenAckSeq ?? 0,
        activity: [...entry.activity],
        activityParseErrors: read.activityParseErrors.get(entry.task.id) ?? 0,
      })),
      parseErrors: read.parseErrors,
    };
  }

  // ---- aggregate read compatibility ------------------------------------

  /** Fleet-wide READ only. Every row carries its storage scope; unresolved
   *  legacy rows carry null and remain in the retained old store. One parallel
   *  walk of the session files feeds BOTH the rows and the dependency graph:
   *  the sequential double walk this replaces cost ~14s against a busy daemon
   *  (each awaited read paying the loop's lag) when the underlying I/O is
   *  ~70ms in parallel. */
  async taskList(filter: TaskFilter = {}, actor: TaskActor = { humanAdmin: true }): Promise<FleetTaskListResponse> {
    await this.initialize();
    if (actor.humanAdmin !== true) return this.authorizedAggregateList(filter, actor);
    const { reads, migrated } = await this.fleetReads();
    const scoped: Array<{ sessionId: string | null; entry: StoredSessionTask }> = [];
    const parseErrorIds: string[] = [];
    let parseErrors = 0;

    for (const { sessionId, read } of reads) {
      const rows = read.file.tasks.filter(entry => matchesTaskFilter(entry.task, filter));
      scoped.push(...rows.map(entry => ({ sessionId, entry })));
      parseErrors += read.parseErrors;
      parseErrorIds.push(...read.parseErrorIds.map(id => `${sessionId}:${id}`));
    }

    // Unfiltered on purpose: the same listing feeds the graph below, and parse
    // errors are a property of the store, not of the filter.
    const legacy = await this.legacy.listTasks();
    const legacyUnmigrated = legacy.tasks.filter(task => !migrated.has(task.id));
    const legacyEntries = await mapPooled(
      legacyUnmigrated.filter(task => matchesTaskFilter(task, filter)),
      FLEET_READ_CONCURRENCY,
      async task => ({
        sessionId: null,
        entry: { task, activity: (await this.legacy.readActivity(task.id)).activity },
      }),
    );
    scoped.push(...legacyEntries);
    parseErrors += legacy.parseErrors;
    parseErrorIds.push(...legacy.parseErrorIds.map(id => `legacy:${id}`));

    scoped.sort(
      (a, b) => compareTasks(a.entry.task, b.entry.task) || String(a.sessionId).localeCompare(String(b.sessionId)),
    );
    const annotated = await this.annotateEntries(
      scoped.map(item => item.entry),
      [...reads.flatMap(({ read }) => read.file.tasks.map(entry => entry.task)), ...legacyUnmigrated],
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
  async taskDetail(
    id: string,
    afterSeq = 0,
    actor: TaskActor = { humanAdmin: true },
  ): Promise<ScopedTaskDetailResponse | undefined> {
    await this.initialize();
    if (actor.humanAdmin !== true) return this.authorizedAggregateDetail(id, afterSeq, actor);
    const canonical = canonicalTaskId(id);
    const { reads, migrated } = await this.fleetReads();
    const hits: Array<{ sessionId: string | null; entry: StoredSessionTask; activityParseErrors: number }> = [];

    for (const { sessionId, read } of reads) {
      const entry = read.file.tasks.find(candidate => candidate.task.id === canonical);
      if (entry !== undefined) {
        hits.push({
          sessionId,
          entry,
          activityParseErrors: read.activityParseErrors.get(canonical) ?? 0,
        });
      }
    }

    if (!migrated.has(canonical)) {
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
    const legacyGraph = (await this.legacy.listTasks()).tasks.filter(task => !migrated.has(task.id));
    const [view] = await this.annotateEntries(
      [hit.entry],
      [...reads.flatMap(({ read }) => read.file.tasks.map(entry => entry.task)), ...legacyGraph],
    );
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
    const scope = await this.resolveScope(sessionId, actor, 'create');
    const provenance =
      scope.kind === 'board' ? provenanceFromBoard(scope.authorization) : await this.authorize(sessionId, actor);
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
      const build = (id: string): StoredSessionTask => {
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
      };
      const write =
        scope.kind === 'board'
          ? await this.boardStore!.createTask(
              scope.board.boardId,
              kind,
              {
                authorization: scope.authorization,
                action: 'create',
                payloadHash: hashTaskBoardPayload({ operation: 'task.create', input }),
              },
              build,
            )
          : await this.store.create(sessionId, kind, build);
      return { write, graph: [...allTasks, write.value.task] };
    });
    const baseView = await this.view(outcome.write.value, sessionId, outcome.graph);
    const view =
      scope.kind === 'board' ? { ...baseView, authorization: this.authorizationProvenance(scope, 'create') } : baseView;
    if (scope.kind === 'board') {
      const board = await this.boardStore!.require(scope.board.boardId);
      for (const grant of board.grants.filter(candidate => candidate.active))
        await this.emit(grant.sessionId, provenance);
    } else {
      await this.emit(sessionId, provenance);
    }
    return view;
  }

  async sessionTaskAct(
    sessionId: string,
    id: string,
    input: TaskActionInput,
    actor: TaskActor = {},
  ): Promise<ScopedTaskView> {
    await this.initialize();
    const readScope = await this.resolveScope(sessionId, actor, 'read');
    let scope = readScope;
    let boardAction: TaskBoardAction | null = null;
    if (readScope.kind === 'board') {
      const current = await this.boardStore!.detailTask(readScope.board.boardId, id);
      if (!current) throw new TaskError('not-found', `unknown task ${canonicalTaskId(id)} in session ${sessionId}`);
      boardAction = taskBoardActionForMutation(current.task, input);
      const sessionViews = await this.deps.list().catch(() => [] as TaskAssigneeView[]);
      const assignedSessionId = exactWorkerAssignee(
        current.task,
        sessionViews as unknown as Awaited<ReturnType<TaskBoardSessionDeps['list']>>,
      );
      scope = await this.resolveScope(sessionId, actor, boardAction, { assignedSessionId });
    }
    const provenance =
      scope.kind === 'board' ? provenanceFromBoard(scope.authorization) : await this.authorize(sessionId, actor);
    const outcome = await this.graphQueue.run('__task_graph__', async () => {
      const allTasks = await this.graphTasks();
      let satisfactionChanged = false;
      let shippedReopen: ShippedReopen | null = null;
      const transform = (current: StoredSessionTask): StoredSessionTask => {
        if (scope.kind === 'board') {
          const currentAction = taskBoardActionForMutation(current.task, input);
          if (currentAction !== boardAction) {
            throw new TaskBoardError(
              'conflict',
              `task ${current.task.id} changed authorization class before the serialized write`,
            );
          }
        }
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
            assertTaskPhaseTransition(
              current.task,
              to,
              provenance.human,
              scope.kind === 'board' && boardAction === 'mark_done',
            );
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
            provenance.human
              ? { approvedByHuman: true }
              : {}),
            ...(current.task.phase === 'live' && to === 'done' && provenance.human ? { verifiedByHuman: true } : {}),
            ...(current.task.phase === 'live' && to === 'done' && scope.kind === 'board' && boardAction === 'mark_done'
              ? { verifiedByTopAgent: true }
              : {}),
          };
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

        if (scope.kind === 'board') {
          data = {
            ...data,
            authorization: this.authorizationProvenance(
              scope,
              boardAction ?? taskBoardActionForTaskAction(input.action),
            ),
          };
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
        const reopenReason = data['reason'];
        if (
          data['reopened'] === true &&
          (current.task.phase === 'live' || current.task.phase === 'done') &&
          typeof reopenReason === 'string'
        ) {
          // The status entry is deliberately last (after a reopen's optional
          // clarification), so this is the exact durable generation emitted.
          shippedReopen = {
            id: current.task.id,
            title: current.task.title,
            from: current.task.phase,
            to: next.phase,
            reason: reopenReason,
            seq: activities.at(-1)!.seq,
          };
        }
        satisfactionChanged = dependencySatisfied(current.task) !== dependencySatisfied(next);
        return { task: { ...next, updatedAt: at }, activity: [...current.activity, ...activities] };
      };
      const write =
        scope.kind === 'board'
          ? await this.boardStore!.transactTask(
              scope.board.boardId,
              id,
              {
                authorization: scope.authorization,
                action: boardAction ?? taskBoardActionForTaskAction(input.action),
                payloadHash: hashTaskBoardPayload({ operation: 'task.action', id: canonicalTaskId(id), input }),
              },
              transform,
            )
          : await this.store.transact(sessionId, id, transform);
      const graph = replaceGraphTask(allTasks, write.value.task);
      return { write, graph, satisfactionChanged, shippedReopen };
    });
    const baseView = await this.view(outcome.write.value, sessionId, outcome.graph);
    const view =
      scope.kind === 'board'
        ? {
            ...baseView,
            authorization: this.authorizationProvenance(
              scope,
              boardAction ?? taskBoardActionForTaskAction(input.action),
            ),
          }
        : baseView;
    const emitSessions = new Set([sessionId]);
    if (scope.kind === 'board') {
      const board = await this.boardStore!.require(scope.board.boardId);
      for (const grant of board.grants.filter(candidate => candidate.active)) emitSessions.add(grant.sessionId);
    }
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

  /** Persist the generation displayed by a shipped-reopen Attention item.
   *
   * Lock ordering is load-bearing: Attention may call this while holding its
   * per-session mutation lock, so this method takes only the task store lock
   * (never graphQueue). Task writes never await Attention mutations. */
  async acknowledgeReopen(
    sessionId: string,
    id: string,
    seq: number,
    actor: TaskActor = {},
    note?: string,
  ): Promise<void> {
    await this.initialize();
    this.assertSessionId(sessionId);
    const canonical = canonicalTaskId(id);
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new TaskError('invalid', 'reopen acknowledgement seq must be a safe integer of at least 1');
    }
    const rawActor = typeof actor.actor === 'string' ? actor.actor.trim() : '';
    const humanAdmin = rawActor === 'user';
    const daemonAdmin = rawActor === 'daemon';
    const requestId =
      typeof actor.requestId === 'string' && actor.requestId.trim()
        ? actor.requestId.trim()
        : `attention-reopen-ack:${canonical}:${seq}:${hashTaskBoardPayload({ note: note ?? null, actor: rawActor })}`;
    let scopedActor: TaskActor = {
      ...actor,
      requestId,
      ...(humanAdmin ? { humanAdmin: true } : {}),
      ...(daemonAdmin ? { daemonAdmin: true } : {}),
    };
    // This method is reachable only from the daemon's already-authorized
    // Attention callback. Hydrate an agent's current credential here so an
    // Attention body can never supply or forge board authority.
    const targetBinding = await this.boardStore?.readBinding(sessionId);
    if (targetBinding && rawActor && !humanAdmin && !daemonAdmin) {
      const actorBinding = await this.boardStore!.readBinding(rawActor);
      if (actorBinding && actorBinding.boardId === targetBinding.boardId) {
        scopedActor = {
          ...scopedActor,
          boardCapability: actorBinding.capability,
          runtimeGeneration: actorBinding.runtimeGeneration,
        };
      }
    }
    const readScope = await this.resolveScope(sessionId, scopedActor, 'read');
    let scope = readScope;
    if (readScope.kind === 'board') {
      const current = await this.boardStore!.detailTask(readScope.board.boardId, canonical);
      if (!current) return;
      const views = await this.deps.list().catch(() => [] as TaskAssigneeView[]);
      scope = await this.resolveScope(sessionId, scopedActor, 'status', {
        assignedSessionId: exactWorkerAssignee(
          current.task,
          views as unknown as Awaited<ReturnType<TaskBoardSessionDeps['list']>>,
        ),
      });
    }
    const provenance = scope.kind === 'board' ? provenanceFromBoard(scope.authorization) : provenanceOf(actor);
    const transform = (current: StoredSessionTask): StoredSessionTask => {
      const highest = current.activity.reduce((value, item) => Math.max(value, item.seq), 0);
      if (seq > highest) {
        throw new TaskError(
          'invalid',
          `cannot acknowledge reopen generation ${seq} for ${canonical}; highest recorded activity is ${highest}`,
        );
      }
      const generation = current.activity.find(item => item.seq === seq);
      if (!isValidShippedReopenActivity(current.task.workflow, generation)) {
        throw new TaskError(
          'invalid',
          `cannot acknowledge reopen generation ${seq} for ${canonical}; it is not a valid shipped-reopen activity`,
        );
      }
      if (seq <= (current.task.reopenAckSeq ?? 0)) return current;
      const at = now();
      const acknowledgement: TaskActivity = {
        v: TASK_SCHEMA_VERSION,
        seq: highest + 1,
        time: at,
        actor: provenance.actor,
        actorName: provenance.actorName,
        type: 'session',
        data: {
          reopenAck: seq,
          resolvedBy: provenance.actor,
          resolvedByName: provenance.actorName,
          ...(note === undefined ? {} : { note }),
          ...(scope.kind === 'board' ? { authorization: this.authorizationProvenance(scope, 'status') } : {}),
        },
      };
      return {
        task: { ...current.task, reopenAckSeq: seq, updatedAt: at },
        activity: [...current.activity, acknowledgement],
      };
    };
    try {
      if (scope.kind === 'board') {
        await this.boardStore!.transactTask(
          scope.board.boardId,
          canonical,
          {
            authorization: scope.authorization,
            action: 'status',
            payloadHash: hashTaskBoardPayload({ operation: 'attention.reopen_ack', id: canonical, seq, note }),
          },
          transform,
        );
        const board = await this.boardStore!.require(scope.board.boardId);
        for (const grant of board.grants.filter(candidate => candidate.active)) {
          await this.emit(grant.sessionId, provenance);
        }
      } else {
        await this.store.transact(sessionId, canonical, transform);
      }
    } catch (error) {
      if (error instanceof TaskError && error.code === 'not-found') {
        console.error(`kteam tasks: reopen acknowledgement skipped; ${canonical} is absent from ${sessionId}`);
        return;
      }
      if (error instanceof TaskBoardError && error.code === 'not-found') return;
      throw error;
    }
  }

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
    for (const { sessionId, read } of await this.readSessions()) {
      if (read.file.tasks.some(entry => entry.task.id === canonical)) scopes.push(sessionId);
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

  private async resolveScope(
    sessionId: string,
    actor: TaskActor,
    action: TaskBoardAction,
    options: { assignedSessionId?: string | null } = {},
  ): Promise<ResolvedTaskScope> {
    if (!this.boards) return { kind: 'legacy', sessionId };
    try {
      return await this.boards.resolveTaskScope(sessionId, actor, action, options);
    } catch (error) {
      if (error instanceof TaskBoardError) {
        const code =
          error.code === 'not-found'
            ? 'not-found'
            : error.code === 'invalid'
              ? 'invalid'
              : error.code === 'conflict'
                ? 'ambiguous'
                : error.code === 'read-only'
                  ? 'read-only'
                  : 'forbidden';
        throw new TaskError(code, error.message);
      }
      throw error;
    }
  }

  private authorizationProvenance(scope: Extract<ResolvedTaskScope, { kind: 'board' }>, action: TaskBoardAction) {
    return this.boards!.provenance(scope.authorization, action);
  }

  private async authorizedAggregateList(filter: TaskFilter, actor: TaskActor): Promise<FleetTaskListResponse> {
    const actorSessionId = peerSessionId(actor);
    const scope = await this.resolveScope(actorSessionId, actor, 'read');
    const read = await this.listScope(scope, filter);
    const views = await this.annotateEntries(read.tasks, await this.graphTasks());
    const sessionId = scope.kind === 'board' ? scope.board.canonicalSessionId : actorSessionId;
    return {
      v: SESSION_TASK_FILE_VERSION,
      sessionId: null,
      tasks: views.map(view => ({ ...toTaskSummary(view), sessionId })),
      parseErrors: read.parseErrors,
      ...(read.parseErrorIds.length > 0 ? { parseErrorIds: read.parseErrorIds } : {}),
      updatedAt: read.file.updatedAt,
      ...(scope.kind === 'board' ? { authorization: this.authorizationProvenance(scope, 'read') } : {}),
    };
  }

  private async authorizedAggregateDetail(
    id: string,
    afterSeq: number,
    actor: TaskActor,
  ): Promise<ScopedTaskDetailResponse | undefined> {
    const actorSessionId = peerSessionId(actor);
    const scope = await this.resolveScope(actorSessionId, actor, 'read');
    const { entry, read } = await this.detailScope(scope, id);
    if (!entry) return undefined;
    const [view] = await this.annotateEntries([entry], await this.graphTasks());
    if (!view) return undefined;
    const sessionId = scope.kind === 'board' ? scope.board.canonicalSessionId : actorSessionId;
    const activityParseErrors = read.activityParseErrors.get(entry.task.id) ?? 0;
    return {
      sessionId,
      task: { ...view, sessionId },
      activity: afterSeq > 0 ? entry.activity.filter(item => item.seq > afterSeq) : entry.activity,
      ...(activityParseErrors > 0 ? { activityParseErrors } : {}),
      ...(scope.kind === 'board' ? { authorization: this.authorizationProvenance(scope, 'read') } : {}),
    };
  }

  private async readScope(scope: ResolvedTaskScope): Promise<SessionTaskRead> {
    if (scope.kind === 'legacy') return this.store.read(scope.sessionId);
    const read = await this.boardStore!.listTasks(scope.board.boardId);
    return read;
  }

  private async listScope(
    scope: ResolvedTaskScope,
    filter: TaskFilter,
  ): Promise<SessionTaskRead & { tasks: StoredSessionTask[] }> {
    return scope.kind === 'legacy'
      ? this.store.list(scope.sessionId, filter)
      : this.boardStore!.listTasks(scope.board.boardId, filter);
  }

  private async detailScope(
    scope: ResolvedTaskScope,
    id: string,
  ): Promise<{ entry?: StoredSessionTask; read: SessionTaskRead }> {
    if (scope.kind === 'legacy') return this.store.detail(scope.sessionId, id);
    const read = await this.boardStore!.listTasks(scope.board.boardId);
    return { entry: await this.boardStore!.detailTask(scope.board.boardId, id), read };
  }

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

  /** Every session task file, read once and IN PARALLEL. The sequential
   *  per-session loop this replaces was the whole performance defect: ~190
   *  boards × one awaited read each, and every await taxed by the busy
   *  daemon's event-loop lag. Reads are safe to run concurrently — writes stay
   *  serialised per session in the store, and each file is an atomic
   *  temp+rename snapshot. */
  private async readSessions(): Promise<Array<{ sessionId: string; boardId: string | null; read: SessionTaskRead }>> {
    const sessionIds = await this.store.listSessionIds();
    const legacyReads = await mapPooled(sessionIds, FLEET_READ_CONCURRENCY, async sessionId => {
      const binding = await this.boardStore?.readBinding(sessionId);
      return binding === null || binding === undefined
        ? { sessionId, boardId: null, read: await this.store.read(sessionId) }
        : null;
    });
    if (!this.boardStore) {
      return legacyReads.filter(
        (entry): entry is { sessionId: string; boardId: null; read: SessionTaskRead } => !!entry,
      );
    }
    const boardReads = await mapPooled(await this.boardStore.listBoardIds(), FLEET_READ_CONCURRENCY, async boardId => {
      const board = await this.boardStore!.require(boardId);
      const binding = await this.boardStore!.readBinding(board.canonicalSessionId);
      // A cutover target is deliberately invisible before the binding swap.
      if (!binding || binding.boardId !== boardId) return null;
      return {
        sessionId: board.canonicalSessionId,
        boardId,
        read: {
          exists: true,
          file: board.taskState,
          fatal: false,
          parseErrors: 0,
          parseErrorIds: [],
          activityParseErrors: new Map<string, number>(),
        } satisfies SessionTaskRead,
      };
    });
    return [...legacyReads, ...boardReads].flatMap(entry =>
      entry === null
        ? []
        : [{ sessionId: entry.sessionId, boardId: entry.boardId, read: entry.read as SessionTaskRead }],
    );
  }

  /** One fleet snapshot shared by rows, graph, and migration suppression, so no
   *  caller walks the files twice. A marker proves representation only while
   *  the corresponding record is still readable; if it is damaged, the retained
   *  source becomes visible. */
  private async fleetReads(): Promise<{
    reads: Array<{ sessionId: string; boardId: string | null; read: SessionTaskRead }>;
    migrated: Set<string>;
  }> {
    const reads = await this.readSessions();
    const migrated = new Set<string>();
    for (const { read } of reads) {
      for (const id of read.file.migratedGlobalIds) {
        if (read.file.tasks.some(entry => entry.task.id === id)) migrated.add(id);
      }
    }
    return { reads, migrated };
  }

  /** Complete fleet record set for cross-session edges and derived blockers.
   * Migrated legacy duplicates stay suppressed exactly like the aggregate read. */
  private async graphTasks(): Promise<Task[]> {
    const { reads, migrated } = await this.fleetReads();
    const tasks: Task[] = reads.flatMap(({ read }) => read.file.tasks.map(entry => entry.task));
    const legacy = await this.legacy.listTasks();
    tasks.push(...legacy.tasks.filter(task => !migrated.has(task.id)));
    return tasks;
  }

  private async scopedEntries(): Promise<
    Array<{ sessionId: string; boardId: string | null; entry: StoredSessionTask }>
  > {
    const reads = await this.readSessions();
    return reads.flatMap(({ sessionId, boardId, read }) =>
      read.file.tasks.map(entry => ({ sessionId, boardId, entry })),
    );
  }

  /** Session boards whose derived blocker state can change when one of these
   * dependency nodes becomes satisfied (or ceases to be). */
  private async dependentSessionIds(taskIds: readonly string[]): Promise<string[]> {
    if (taskIds.length === 0) return [];
    const changed = new Set(taskIds);
    const sessions = new Set<string>();
    for (const { sessionId, boardId, entry } of await this.scopedEntries()) {
      if (!entry.task.dependsOn.some(id => changed.has(id))) continue;
      if (boardId === null) {
        sessions.add(sessionId);
      } else {
        const board = await this.boardStore!.require(boardId);
        for (const grant of board.grants.filter(candidate => candidate.active)) sessions.add(grant.sessionId);
      }
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

      for (const { sessionId, boardId, entry } of affected) {
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
        let scope: ResolvedTaskScope = { kind: 'legacy', sessionId };
        let boardProvenance: ReturnType<TaskService['authorizationProvenance']> | undefined;
        if (boardId !== null) {
          const completionData =
            event.data && typeof event.data === 'object' && !Array.isArray(event.data)
              ? (event.data as Record<string, unknown>)
              : {};
          const eventIncarnation = completionData['sessionIncarnation'];
          const eventRuntimeGeneration = completionData['runtimeGeneration'];
          const binding = await this.boardStore!.readBinding(event.sessionId);
          if (
            !binding ||
            binding.boardId !== boardId ||
            eventIncarnation !== binding.sessionIncarnation ||
            eventRuntimeGeneration !== binding.runtimeGeneration
          ) {
            throw new TaskError(
              'forbidden',
              `completion event generation does not match the active grant for ${entry.task.id}`,
            );
          }
          scope = await this.resolveScope(
            event.sessionId,
            {
              actor: event.sessionId,
              actorName,
              boardCapability: binding.capability,
              runtimeGeneration: eventRuntimeGeneration as number,
              requestId: `session-completion:${event.sessionId}:${eventIncarnation}:${eventRuntimeGeneration}:${event.turn}:${entry.task.id}`,
            },
            'status',
            { assignedSessionId: event.sessionId },
          );
          if (scope.kind !== 'board' || scope.board.boardId !== boardId) {
            throw new TaskError('forbidden', `completion claim resolved outside task board for ${entry.task.id}`);
          }
          boardProvenance = this.authorizationProvenance(scope, 'status');
        }
        const transform = (current: StoredSessionTask): StoredSessionTask => {
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
              ...(boardProvenance ? { authorization: boardProvenance } : {}),
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
              ...(boardProvenance ? { authorization: boardProvenance } : {}),
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
        };
        if (scope.kind === 'board') {
          await this.boardStore!.transactTask(
            scope.board.boardId,
            entry.task.id,
            {
              authorization: scope.authorization,
              action: 'status',
              payloadHash: hashTaskBoardPayload({
                operation: 'session.completion',
                taskId: entry.task.id,
                sessionId: event.sessionId,
                turn: event.turn,
                time: event.time,
              }),
            },
            transform,
          );
        } else {
          await this.store.transact(sessionId, entry.task.id, transform);
        }
        if (wroteClaim) {
          if (boardId === null) {
            changed.add(sessionId);
          } else {
            const board = await this.boardStore!.require(boardId);
            for (const grant of board.grants.filter(candidate => candidate.active)) changed.add(grant.sessionId);
          }
          if (advanced) newlySatisfied.add(entry.task.id);
        }
      }
      return { sessions: [...changed], newlySatisfied: [...newlySatisfied] };
    });
    const provenance: Provenance = {
      actor: event.sessionId,
      actorName: null,
      session: event.sessionId,
      human: false,
    };
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

/** Enough parallelism to collapse a fleet walk into a handful of event-loop
 *  turns, bounded so a home with thousands of boards cannot hold that many file
 *  descriptors open at once. */
const FLEET_READ_CONCURRENCY = 64;

/** Order-preserving map with at most `limit` operations in flight. */
async function mapPooled<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]!);
      }
    }),
  );
  return results;
}

function canonicalTaskId(id: string): string {
  const canonical = normalizeTaskIdLocal(id);
  if (canonical === null) throw new TaskError('invalid', `not a task id: ${String(id)}`);
  return canonical;
}

function taskBoardActionForMutation(task: Task, input: TaskActionInput): TaskBoardAction {
  const requestedPhase =
    input.action === 'status' && input.status !== 'blocked'
      ? taskPhaseFromStatus(validateTaskStatus(input.status))
      : input.action === 'phase'
        ? validateTaskPhase(input.phase)
        : null;
  return task.phase === 'live' && requestedPhase === 'done' ? 'mark_done' : taskBoardActionForTaskAction(input.action);
}

function peerSessionId(actor: TaskActor): string {
  const value = typeof actor.actor === 'string' ? actor.actor.trim() : '';
  if (!value || value === 'user' || !isSafeTaskSessionId(value)) {
    throw new TaskError('forbidden', 'peer aggregate reads require an authenticated session identity');
  }
  return value;
}

function provenanceOf(actor: TaskActor): Provenance {
  const raw = typeof actor.actor === 'string' ? actor.actor.trim() : '';
  if (raw === '' || raw === 'user') return { actor: 'user', actorName: 'user', session: null, human: true };
  const actorName = typeof actor.actorName === 'string' && actor.actorName.trim() ? actor.actorName.trim() : null;
  return { actor: raw, actorName, session: raw, human: false };
}

function provenanceFromBoard(authorization: import('./task-boards-types').TaskBoardAuthorization): Provenance {
  const daemon = authorization.role === 'daemon';
  const human = authorization.role === 'human_admin';
  return {
    actor: authorization.actorSessionId ?? (daemon ? 'daemon' : 'user'),
    actorName: authorization.actorSessionId === null ? (daemon ? 'daemon' : 'user') : authorization.actorName,
    session: authorization.actorSessionId,
    human,
  };
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
