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
import { isUnknownRoute } from './files-api';
import { SessionLink, TaskDetail, TaskRow, sessionHref } from './TaskPresentation';
import {
  buildTaskDag,
  computeFileConflicts,
  groupTasksByPhase,
  parseTaskActivity,
  parseTaskListResponse,
  parseTaskRecord,
  sortTasksForList,
  tasksForSession,
  taskReference,
  TASK_PHASE_META,
  type TaskActivity,
  type TaskFileConflict,
  type TaskRecord,
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

export function SessionTaskList({
  tasks,
  conflicts = EMPTY_CONFLICTS,
  onOpen,
}: {
  tasks: TaskSummary[];
  conflicts?: ConflictMap;
  onOpen: (id: string) => void;
}) {
  return (
    <div data-task-view="list" className="divide-y divide-border-soft rounded-md border border-border-soft bg-surface">
      {sortTasksForList(tasks).map(task => (
        <TaskRow key={task.id} task={task} conflicts={conflicts.get(task.id)} onOpen={onOpen} />
      ))}
    </div>
  );
}
export function SessionTaskKanban({
  tasks,
  conflicts = EMPTY_CONFLICTS,
  onOpen,
}: {
  tasks: TaskSummary[];
  conflicts?: ConflictMap;
  onOpen: (id: string) => void;
}) {
  return (
    <div data-task-view="kanban" className="flex min-w-max gap-3 pb-2">
      {groupTasksByPhase(tasks).map(column => (
        <section
          key={column.phase}
          data-task-phase={column.phase}
          aria-label={`${TASK_PHASE_META[column.phase].label} column`}
          className="w-64 shrink-0 rounded-md border border-border-soft bg-surface-2 p-2"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="kt-label m-0">{TASK_PHASE_META[column.phase].label}</h3>
            <span className="text-xs text-muted">{column.tasks.length}</span>
          </div>
          <div className="divide-y divide-border-soft rounded-md border border-border-soft bg-surface">
            {column.tasks.map(task => (
              <TaskRow key={task.id} task={task} conflicts={conflicts.get(task.id)} onOpen={onOpen} />
            ))}
            {column.tasks.length === 0 && <p className="px-3 py-2 text-xs text-muted">No tasks.</p>}
          </div>
        </section>
      ))}
    </div>
  );
}
/** The DAG derives from the FLEET array so a dependency owned by another session
 *  is a real, openable node — not an `(external)` dead end. Cross-session nodes
 *  navigate to their owning session; same-session nodes open detail in place. */
export function SessionTaskDag({
  fleet,
  sessionId,
  conflicts = EMPTY_CONFLICTS,
  onOpen,
}: {
  fleet: TaskSummary[];
  sessionId: string;
  conflicts?: ConflictMap;
  onOpen: (id: string) => void;
}) {
  const dag = buildTaskDag(fleet, sessionId);
  const nodeById = new Map(dag.nodes.map(node => [node.id, node]));
  const dependenciesOf = (id: string) => dag.edges.filter(edge => edge.from === id).map(edge => edge.to);
  return (
    <ol data-task-view="dag" className="space-y-3">
      {dag.nodes.map(node => (
        <li
          key={node.id}
          data-task-node={node.id}
          data-task-cross-session={node.crossSession ? 'true' : undefined}
          className="rounded-md border border-border-soft bg-surface"
        >
          {node.crossSession && node.sessionId && (
            <div className="flex items-center gap-1.5 border-b border-border-soft px-3 py-1 text-xs text-muted">
              <span className="shrink-0">Owned by session</span>
              <SessionLink sessionId={node.sessionId} />
            </div>
          )}
          {node.task ? (
            <TaskRow
              task={node.task}
              conflicts={conflicts.get(node.id)}
              onOpen={node.crossSession && node.sessionId ? () => navigate(sessionHref(node.sessionId!)) : onOpen}
            />
          ) : (
            <div data-task-missing={node.id} className="px-3 py-2">
              <span className="mono text-xs font-semibold text-warn">{taskReference(node.id)}</span>
              <span className="ml-2 text-xs text-muted">Referenced dependency is missing — deleted or unreadable.</span>
            </div>
          )}
          {dependenciesOf(node.id).length > 0 && (
            <ul className="border-t border-border-soft px-3 py-2 text-xs text-muted">
              {dependenciesOf(node.id).map(dependency => {
                const target = nodeById.get(dependency);
                return (
                  <li key={dependency} data-task-edge={`${node.id}->${dependency}`} className="ml-3 list-disc">
                    depends on{' '}
                    {!target || target.missing ? (
                      <span className="mono text-warn">{taskReference(dependency)} (missing)</span>
                    ) : target.crossSession && target.sessionId ? (
                      <SessionLink sessionId={target.sessionId} label={taskReference(dependency)} />
                    ) : (
                      <button
                        type="button"
                        className="mono text-accent hover:underline"
                        onClick={() => onOpen(dependency)}
                      >
                        {taskReference(dependency)}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      ))}
    </ol>
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
function TaskProjectionView({
  view,
  tasks,
  fleet,
  sessionId,
  conflicts,
  onOpen,
}: {
  view: TaskProjection;
  tasks: TaskSummary[];
  fleet: TaskSummary[];
  sessionId: string;
  conflicts: ConflictMap;
  onOpen: (id: string) => void;
}) {
  if (view === 'kanban') return <SessionTaskKanban tasks={tasks} conflicts={conflicts} onOpen={onOpen} />;
  if (view === 'dag')
    return <SessionTaskDag fleet={fleet} sessionId={sessionId} conflicts={conflicts} onOpen={onOpen} />;
  return <SessionTaskList tasks={tasks} conflicts={conflicts} onOpen={onOpen} />;
}

export function SessionTasksSurface({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<LoadState>('loading');
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [parseErrors, setParseErrors] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskRecord | null>(null);
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [projection, setProjection] = useState<TaskProjection>('list');
  const seq = useRef(0);
  // ONE fleet fetch. List/Kanban are derived by session below; the DAG reads the
  // whole array so its dependency closure can cross sessions.
  const load = useCallback(async () => {
    const generation = ++seq.current;
    setRefreshing(true);
    try {
      const parsed = parseTaskListResponse(await api.listTasks());
      if (seq.current !== generation) return;
      setTasks(parsed.tasks);
      setParseErrors(parsed.parseErrors);
      setState('ready');
      setError(null);
    } catch (e) {
      if (seq.current !== generation) return;
      if (isUnknownRoute(e)) {
        setState('absent');
        return;
      }
      setError(e instanceof ApiError ? e.message : String(e));
      setState(current => (current === 'ready' ? 'ready' : 'error'));
    } finally {
      if (seq.current === generation) setRefreshing(false);
    }
  }, []);
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
    setProjection('list');
    void load();
  }, [load, sessionId]);
  const sessionTasks = useMemo(() => tasksForSession(tasks, sessionId), [tasks, sessionId]);
  const conflicts = useMemo(() => computeFileConflicts(tasks), [tasks]);
  const openDetail = useCallback(
    async (taskId: string) => {
      setDetail(null);
      setActivity([]);
      setSelectedId(taskId);
      try {
        const response = (await api.getSessionTask(sessionId, taskId)) as { task?: unknown; activity?: unknown };
        const record = parseTaskRecord(response?.task ?? response);
        const entries = Array.isArray(response?.activity) ? response.activity : [];
        setDetail(record);
        setActivity(
          entries
            .flatMap(item => {
              const parsed = parseTaskActivity(item);
              return parsed ? [parsed] : [];
            })
            .sort((a, b) => a.seq - b.seq),
        );
      } catch {
        /* The summary remains an honest selected row while detail fails. */
      }
    },
    [sessionId],
  );
  const selectedSummary = sessionTasks.find(task => task.id === selectedId) ?? null;
  const selected = detail?.id === selectedId ? detail : selectedSummary;
  if (selectedId && selected)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-sm px-panel py-2">
          <button
            type="button"
            className="kt-btn kt-btn--sm"
            onClick={() => setSelectedId(null)}
            aria-label="Back to the task list"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Back
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-3">
          <TaskDetail task={selected} activity={activity} conflicts={conflicts.get(selected.id)} />
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
            fleet={tasks}
            sessionId={sessionId}
            conflicts={conflicts}
            onOpen={id => void openDetail(id)}
          />
        )}
      </div>
    </div>
  );
}
