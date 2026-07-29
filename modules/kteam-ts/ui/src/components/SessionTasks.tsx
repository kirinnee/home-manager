// One fleet task array, three accessible readings: a session-scoped list and
// phase-kanban, plus a depends-on DAG whose closure crosses sessions. The List
// and Kanban never show another session's work; the DAG renders every
// dependency as a real node (cross-session ones linked to their owning session,
// truly-absent ones marked missing) so the graph is never silently incomplete.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ListTodo, Loader2, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import { useFleetEvents } from '../lib/store';
import { useLayoutMode } from '../hooks/useLayoutMode';
import type { CodeReference } from '../lib/code-references';
import type { AttentionId } from '../lib/attention';
import type { PinReferenceLookup } from '../lib/remark-session-references';
import { isUnknownRoute } from './files-api';
import { TaskDetail, TaskRow, sessionHref, taskAskOrigin } from './TaskPresentation';
import { TaskDagGraph } from './TaskDagGraph';
import { TaskStatusFilter } from './TaskStatusFilter';
import { taskAssigneePresentation } from './TaskAssigneeLink';
import {
  filterTaskDag,
  filterTasksByStatuses,
  taskFilterSummary,
  taskStatusCounts,
  toggleTaskStatusFilter,
  type FilteredTaskDag,
} from '../lib/task-views';
import {
  buildTaskDag,
  computeFileConflicts,
  groupTasksByBoardLane,
  parseTaskActivity,
  parseTaskListResponse,
  parseTaskRecord,
  sortTasksForList,
  taskBoardLane,
  tasksForSession,
  TASK_BOARD_LANE_META,
  type TaskActivity,
  type TaskFileConflict,
  type TaskRecord,
  type TaskStatus,
  type TaskSummary,
} from '../lib/tasks';

export function sessionTasksEmptyCopy(state: 'absent' | 'error' | 'empty', error?: string | null): string {
  switch (state) {
    case 'absent':
      return "This daemon does not serve per-session tasks yet. Update it to view this session's task records here.";
    case 'error':
      return error ? `Couldn't load tasks: ${error}` : "Couldn't load tasks.";
    case 'empty':
      return 'No tasks recorded for this session yet. Agents record them with `kteam task create`.';
  }
}
type LoadState = 'loading' | 'ready' | 'absent' | 'error';
export type TaskProjection = 'list' | 'kanban' | 'dag';
type ConflictMap = Map<string, TaskFileConflict[]>;
const EMPTY_CONFLICTS: ConflictMap = new Map();

interface TaskRowContext {
  showStatusBadge: boolean;
  showAssignee: boolean;
  showAskOriginMarker: boolean;
}

/** Metadata earns card space only when it changes within the group the reader
 *  is comparing. The key mirrors TaskAssigneeLink's visible/linkable identity
 *  plus its dot tone so a real liveness or destination difference survives. */
function taskRowContext(tasks: TaskSummary[]): TaskRowContext {
  const assignees = new Set(
    tasks.map(task => {
      const identity = taskAssigneePresentation(task);
      const destination = identity.href ?? (identity.assigned ? 'unresolved' : 'unassigned');
      const tone = task.live.staleness ? 'warn' : task.live.assigneeHealth === 'active' ? 'active' : 'muted';
      return `${identity.name.toLocaleLowerCase()}|${destination}|${tone}`;
    }),
  );
  const states = new Set(tasks.map(task => (task.blocked ? 'blocked' : taskBoardLane(task.phase))));
  const askOrigins = new Set(tasks.map(taskAskOrigin));
  return {
    showStatusBadge: states.size > 1,
    showAssignee: assignees.size > 1,
    showAskOriginMarker: askOrigins.has('agent') && askOrigins.size > 1,
  };
}

export function SessionTaskList({
  tasks,
  conflicts = EMPTY_CONFLICTS,
  onOpen,
}: {
  tasks: TaskSummary[];
  conflicts?: ConflictMap;
  onOpen: (id: string) => void;
}) {
  const visibleTasks = sortTasksForList(tasks);
  const context = taskRowContext(visibleTasks);
  return (
    // `.kt-panel`, not a bespoke bordered box: the list inherits each family's
    // panel silhouette (Mission glow, Neo hard offset, Ember seams, Contrast
    // plain border) exactly like the sessions list does. Clipping is safe here
    // — rows host no popovers, and row focus rings sit inside the padding.
    <div data-task-view="list" className="kt-panel overflow-hidden divide-y divide-border-soft">
      {visibleTasks.map(task => (
        <TaskRow
          key={task.id}
          task={task}
          conflicts={conflicts.get(task.id)}
          onOpen={onOpen}
          showStatusBadge={context.showStatusBadge}
          showAssignee={context.showAssignee}
          showAskOriginMarker={context.showAskOriginMarker}
        />
      ))}
      {visibleTasks.length === 0 && <p className="px-3 py-4 text-center text-xs text-muted">No matching tasks.</p>}
    </div>
  );
}
export function SessionTaskKanban({
  tasks,
  conflicts = EMPTY_CONFLICTS,
  onOpen,
  compact = false,
}: {
  tasks: TaskSummary[];
  conflicts?: ConflictMap;
  onOpen: (id: string) => void;
  /** Narrow surfaces trade horizontal travel for one normal reading column. */
  compact?: boolean;
}) {
  const visibleContext = taskRowContext(tasks);
  return (
    <div
      data-task-view="kanban"
      data-task-layout={compact ? 'stacked' : 'columns'}
      className={compact ? 'flex min-w-0 flex-col gap-3 pb-2' : 'flex min-w-max gap-3 pb-2'}
    >
      {groupTasksByBoardLane(tasks).map(column => {
        const context = taskRowContext(column.tasks);
        const lane = TASK_BOARD_LANE_META[column.lane];
        return (
          // One `.kt-panel` per lane (gray-box-inside-gray-box nesting made the
          // board read flat) with the lane's identity in its header: tone dot +
          // tone count. The rows below repeat the same tone on their rails, so
          // a column is a colour block, not a caption.
          <section
            key={column.lane}
            data-task-lane={column.lane}
            data-tone={lane.tone}
            aria-label={`${lane.label} column`}
            className={`${compact ? 'w-full min-w-0' : 'w-64 shrink-0'} kt-task-tone kt-panel overflow-hidden`}
          >
            <div className="kt-panel__header justify-between">
              <span className="flex min-w-0 items-center gap-sm">
                <span className="kt-task-tone-dot" aria-hidden="true" />
                <h3 className="kt-label m-0">{lane.label}</h3>
              </span>
              <span className="kt-task-tone-ink text-xs font-semibold">{column.tasks.length}</span>
            </div>
            <div className="divide-y divide-border-soft">
              {column.tasks.map(task => (
                <TaskRow
                  key={task.id}
                  task={task}
                  conflicts={conflicts.get(task.id)}
                  onOpen={onOpen}
                  impliedLane={column.lane}
                  showAssignee={context.showAssignee}
                  showAskOriginMarker={visibleContext.showAskOriginMarker}
                />
              ))}
              {column.tasks.length === 0 && <p className="px-3 py-2 text-xs text-muted">No tasks.</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
/** The DAG derives from the FLEET array so a dependency owned by another session
 *  is a real, openable node — not an `(external)` dead end. Cross-session nodes
 *  navigate to their owning session; same-session nodes open detail in place. */
export function SessionTaskDag({
  dag,
  conflicts = EMPTY_CONFLICTS,
  onOpen,
  onShowAll = () => undefined,
}: {
  /** Already-built and filtered by the surface so rerenders do not reset the
   *  graph's fitted viewport with a referentially-new projection. */
  dag: FilteredTaskDag;
  conflicts?: ConflictMap;
  onOpen: (id: string) => void;
  onShowAll?: () => void;
}) {
  return (
    <div data-task-view="dag">
      {dag.contextCount > 0 && (
        <p className="mb-2 text-meta text-muted">
          PATH nodes keep matching tasks attached to every dependency they need.
        </p>
      )}
      <TaskDagGraph
        dag={dag}
        conflicts={conflicts}
        onShowAll={onShowAll}
        onOpen={node => {
          if (node.crossSession && node.sessionId) navigate(sessionHref(node.sessionId));
          else onOpen(node.id);
        }}
      />
    </div>
  );
}
function ProjectionTabs({ value, onChange }: { value: TaskProjection; onChange: (view: TaskProjection) => void }) {
  const views: Array<{ id: TaskProjection; label: string }> = [
    { id: 'list', label: 'List' },
    { id: 'kanban', label: 'Kanban' },
    { id: 'dag', label: 'DAG' },
  ];
  return (
    <div role="tablist" aria-label="Task views" className="flex items-center gap-1">
      {views.map(view => (
        <button
          key={view.id}
          role="tab"
          type="button"
          aria-selected={value === view.id}
          className="kt-btn kt-btn--sm"
          onClick={() => onChange(view.id)}
        >
          {view.label}
        </button>
      ))}
    </div>
  );
}
export function TaskProjectionView({
  view,
  tasks,
  dag,
  conflicts,
  onOpen,
  compact,
  selectedStatuses,
  onShowAll,
}: {
  view: TaskProjection;
  tasks: TaskSummary[];
  dag: FilteredTaskDag;
  conflicts: ConflictMap;
  onOpen: (id: string) => void;
  compact: boolean;
  selectedStatuses: ReadonlySet<TaskStatus> | null;
  onShowAll: () => void;
}) {
  if (view === 'kanban')
    return (
      <SessionTaskKanban
        tasks={filterTasksByStatuses(tasks, selectedStatuses)}
        conflicts={conflicts}
        onOpen={onOpen}
        compact={compact}
      />
    );
  if (view === 'dag') return <SessionTaskDag dag={dag} conflicts={conflicts} onOpen={onOpen} onShowAll={onShowAll} />;
  return (
    <SessionTaskList tasks={filterTasksByStatuses(tasks, selectedStatuses)} conflicts={conflicts} onOpen={onOpen} />
  );
}

/** Serialize an async loader: one run in flight, triggers during that run
 *  coalesce into exactly ONE follow-up, and every completed run's result is
 *  applied. The previous generation-counter discipline DISCARDED superseded
 *  responses instead — on a busy fleet, `tasks.updated` events arrive faster
 *  than one slow `/v1/tasks` round trip, so every response was superseded and
 *  the surface sat on "Loading tasks…" forever. Discarding is only required
 *  when responses could interleave; serializing removes that case, and the
 *  fleet list is session-independent so a completed response is never stale
 *  data for the wrong surface. */
export function coalesceLoads(run: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  let queued = false;
  const invoke = async (): Promise<void> => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      await run();
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        await invoke();
      }
    }
  };
  return invoke;
}

export interface TaskOpenRequest {
  id: string;
  sequence: number;
}

export interface TaskDetailRequestToken {
  sequence: number;
  sessionId: string;
  taskId: string;
}

/** Exact identity gate for async detail responses. Sequence rejects A after B;
 *  session identity also rejects a response from a retained pane's old session
 *  before the session-change effect has a chance to run. */
export function taskDetailRequestIsCurrent(
  current: TaskDetailRequestToken | null,
  request: TaskDetailRequestToken,
  surfaceSessionId: string,
): boolean {
  return (
    current !== null &&
    current.sequence === request.sequence &&
    current.sessionId === request.sessionId &&
    current.taskId === request.taskId &&
    surfaceSessionId === request.sessionId
  );
}

export function SessionTasksSurface({
  sessionId,
  cwd,
  requestedTask,
  onRequestedTaskHandled,
  onCodeReferenceOpen,
  onAttentionOpen,
  onPinOpen,
}: {
  sessionId: string;
  /** Files-pane root owned by the hosting session. */
  cwd?: string;
  requestedTask?: TaskOpenRequest | null;
  onRequestedTaskHandled?: (sequence: number) => void;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  onAttentionOpen?: (id: AttentionId, opener?: HTMLElement | null) => void;
  onPinOpen?: (reference: PinReferenceLookup, opener?: HTMLElement | null) => void;
}) {
  const compact = useLayoutMode() === 'drawer';
  const [state, setState] = useState<LoadState>('loading');
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [parseErrors, setParseErrors] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskRecord | null>(null);
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [projection, setProjection] = useState<TaskProjection>('list');
  const [selectedStatuses, setSelectedStatuses] = useState<ReadonlySet<TaskStatus> | null>(null);
  const detailSeq = useRef(0);
  const detailRequest = useRef<TaskDetailRequestToken | null>(null);
  const surfaceSessionId = useRef(sessionId);
  surfaceSessionId.current = sessionId;
  // ONE fleet fetch. List/Kanban are derived by session below; the DAG reads the
  // whole array so its dependency closure can cross sessions. Loads are
  // coalesced, never discarded — see coalesceLoads for why discarding starved
  // this surface on a busy fleet.
  const load = useMemo(
    () =>
      coalesceLoads(async () => {
        setRefreshing(true);
        try {
          const parsed = parseTaskListResponse(await api.listTasks());
          setTasks(parsed.tasks);
          setParseErrors(parsed.parseErrors);
          setState('ready');
          setError(null);
        } catch (e) {
          if (isUnknownRoute(e)) {
            setState('absent');
            return;
          }
          setError(e instanceof ApiError ? e.message : String(e));
          setState(current => (current === 'ready' ? 'ready' : 'error'));
        } finally {
          setRefreshing(false);
        }
      }),
    [],
  );
  // The store's one fleet socket supplies live-only aggregate events. Subscribe
  // before the initial fetch effect so a first task created in any previously
  // taskless session cannot fall into a load→subscribe gap.
  useFleetEvents(event => {
    if (event.type === 'tasks.updated') void load();
  });
  useEffect(() => {
    setState('loading');
    setTasks([]);
    setSelectedId(null);
    setDetail(null);
    setActivity([]);
    detailRequest.current = null;
    setProjection('list');
    setSelectedStatuses(null);
    void load();
  }, [load, sessionId]);
  const sessionTasks = useMemo(() => tasksForSession(tasks, sessionId), [tasks, sessionId]);
  const conflicts = useMemo(() => computeFileConflicts(tasks), [tasks]);
  // Build the cross-session dependency closure once per fleet snapshot, then
  // filter that stable projection once per selection. TaskDagGraph keys its
  // layout/fit effect on object identity, so rebuilding either object during an
  // unrelated render would snap the reader's pan/zoom back to fit.
  const taskDag = useMemo(() => buildTaskDag(tasks, sessionId), [tasks, sessionId]);
  const filteredTaskDag = useMemo(() => filterTaskDag(taskDag, selectedStatuses), [taskDag, selectedStatuses]);
  const openDetail = useCallback(
    async (taskId: string) => {
      const request: TaskDetailRequestToken = { sequence: ++detailSeq.current, sessionId, taskId };
      detailRequest.current = request;
      setDetail(null);
      setActivity([]);
      setSelectedId(taskId);
      try {
        const owner = tasks.find(task => task.id === taskId)?.sessionId;
        const response = (await (owner && owner !== sessionId
          ? api.getTask(taskId)
          : api.getSessionTask(sessionId, taskId))) as { task?: unknown; activity?: unknown };
        const record = parseTaskRecord(response?.task ?? response);
        const entries = Array.isArray(response?.activity) ? response.activity : [];
        const parsedActivity = entries
          .flatMap(item => {
            const parsed = parseTaskActivity(item);
            return parsed ? [parsed] : [];
          })
          .sort((a, b) => a.seq - b.seq);
        if (!taskDetailRequestIsCurrent(detailRequest.current, request, surfaceSessionId.current)) return;
        setDetail(record);
        setActivity(parsedActivity);
      } catch {
        /* The summary remains an honest selected row while detail fails. */
      }
    },
    [sessionId, tasks],
  );
  useEffect(() => {
    if (!requestedTask || state !== 'ready') return;
    void openDetail(requestedTask.id);
    onRequestedTaskHandled?.(requestedTask.sequence);
  }, [onRequestedTaskHandled, openDetail, requestedTask, state]);
  const selectedSummary = tasks.find(task => task.id === selectedId) ?? null;
  const selected = detail?.id === selectedId ? detail : selectedSummary;
  if (selectedId && selected)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-sm px-panel py-2">
          <button
            type="button"
            className="kt-btn kt-btn--sm"
            onClick={() => {
              detailRequest.current = null;
              setSelectedId(null);
            }}
            aria-label="Back to the task list"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Back
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-3">
          <TaskDetail
            task={selected}
            activity={activity}
            conflicts={conflicts.get(selected.id)}
            onOpenTask={id => void openDetail(id)}
            onCodeReferenceOpen={onCodeReferenceOpen}
            onAttentionOpen={onAttentionOpen}
            onPinOpen={onPinOpen}
            surfaceSessionId={sessionId}
            surfaceCwd={cwd}
          />
        </div>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-sm px-panel py-2">
        <span className="kt-label">
          {state === 'ready'
            ? `${sessionTasks.length} ${sessionTasks.length === 1 ? 'task' : 'tasks'}`
            : 'Session tasks'}
        </span>
        <div className="flex items-center gap-2">
          <ProjectionTabs value={projection} onChange={setProjection} />
          <button
            type="button"
            className="kt-btn kt-btn--sm"
            onClick={() => void load()}
            disabled={refreshing}
            aria-label="Refresh tasks"
          >
            {refreshing ? (
              <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            ) : (
              <RefreshCw size={13} aria-hidden="true" />
            )}
            Refresh
          </button>
        </div>
      </div>
      {error && state === 'ready' && (
        <p
          role="status"
          className="mx-panel mb-1 shrink-0 rounded-md border border-warn-border bg-warn-bg px-2.5 py-1 text-meta text-warn"
        >
          Refresh failed; showing the last successful result.
        </p>
      )}
      {parseErrors > 0 && (
        <p
          role="status"
          className="mx-panel mb-1 shrink-0 rounded-md border border-warn-border bg-warn-bg px-2.5 py-1 text-meta text-warn"
        >
          {parseErrors} malformed task {parseErrors === 1 ? 'record was' : 'records were'} skipped.
        </p>
      )}
      {state === 'ready' &&
        sessionTasks.length > 0 &&
        (() => {
          const countTasks =
            projection === 'dag' ? taskDag.nodes.flatMap(node => (node.task ? [node.task] : [])) : sessionTasks;
          const counts = taskStatusCounts(countTasks);
          const matched = filterTasksByStatuses(sessionTasks, selectedStatuses).length;
          const summary =
            selectedStatuses === null
              ? `All ${countTasks.length}`
              : projection === 'dag'
                ? taskFilterSummary(filteredTaskDag.matchCount, filteredTaskDag.contextCount)
                : `${matched} ${matched === 1 ? 'match' : 'matches'}`;
          return (
            <section className="shrink-0 px-panel pb-2" aria-label="Task status filter">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="kt-label">Status</span>
                <span className="text-meta text-muted">{summary}</span>
              </div>
              <TaskStatusFilter
                counts={counts}
                selected={selectedStatuses}
                onSelect={status => setSelectedStatuses(current => toggleTaskStatusFilter(current, status))}
                onShowAll={() => setSelectedStatuses(null)}
              />
            </section>
          );
        })()}
      <div className="min-h-0 flex-1 overflow-auto scroll-thin px-panel pb-3">
        {state === 'loading' && (
          <p role="status" className="py-6 text-center text-cell text-muted">
            Loading tasks…
          </p>
        )}
        {(state === 'absent' || state === 'error' || (state === 'ready' && sessionTasks.length === 0)) && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <ListTodo size={22} aria-hidden="true" className="text-faint" />
            <p
              className="m-0 max-w-[36ch] text-cell leading-base text-muted"
              role={state === 'error' ? 'alert' : undefined}
            >
              {sessionTasksEmptyCopy(state === 'ready' ? 'empty' : state, error)}
            </p>
          </div>
        )}
        {state === 'ready' && sessionTasks.length > 0 && (
          <TaskProjectionView
            view={projection}
            tasks={sessionTasks}
            dag={filteredTaskDag}
            conflicts={conflicts}
            onOpen={id => void openDetail(id)}
            compact={compact}
            selectedStatuses={selectedStatuses}
            onShowAll={() => setSelectedStatuses(null)}
          />
        )}
      </div>
    </div>
  );
}
