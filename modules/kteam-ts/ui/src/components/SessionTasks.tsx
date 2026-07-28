// SESSION TASKS — the task surface for ONE session, hosted in the unified side
// pane (SidePane.tsx).
//
// The daemon keeps task records per session (GET /v1/sessions/:id/tasks;
// /v1/tasks remains the CLI/analytics aggregate), and this surface answers one
// question: "what has THIS session declared it is doing". There are no filters
// or collapsed sections: every returned task is grouped by its declared status,
// including built, live, blocked, and dropped work, then opens into its brief.
//
// The pane is 320–680px wide, so list and detail are a two-level stack (list →
// detail with a Back button), the same navigation shape FilesTab settled on,
// not a side-by-side grid.
//
// VERSION SKEW IS A FIRST-CLASS STATE. The session routes ship in the same
// change-set as this UI but deploy separately; a daemon that predates them
// answers 404 `unknown_route` (the same signal the fs probe keys on) and the
// surface says so honestly instead of showing an empty board as "no tasks".
//
// LIVE, NOT POLLED. Task writes broadcast a sequence-0 `tasks.updated` event
// for the session carrying the complete list snapshot; this surface applies it
// directly. The fetch happens once per mount (the host mounts the surface only
// while it is open), with a manual refresh for reassurance.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ListTodo, Loader2, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useSessionEvents } from '../lib/store';
import { isUnknownRoute } from './files-api';
import { TaskDetail, TaskRow } from './TaskPresentation';
import {
  groupTasks,
  parseTaskActivity,
  parseTaskListResponse,
  parseTaskRecord,
  TASK_STATUS_META,
  type TaskActivity,
  type TaskRecord,
  type TaskSummary,
} from '../lib/tasks';

/** The honest copy per empty-ish state, exported for unit tests. */
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

/** Every task appears exactly once. Status groups follow the daemon's canonical
 * board order; explicit rank and id order the rows inside each group. */
export function SessionTaskList({ tasks, onOpen }: { tasks: TaskSummary[]; onOpen: (id: string) => void }) {
  return (
    <div className="space-y-3">
      {groupTasks(tasks).map(group => (
        <section
          key={group.status}
          data-task-status={group.status}
          aria-label={`${TASK_STATUS_META[group.status].label} tasks`}
        >
          <div className="mb-1 flex items-center gap-2">
            <h3 className="kt-label m-0">{TASK_STATUS_META[group.status].label}</h3>
            <span className="text-xs text-muted">{group.tasks.length}</span>
          </div>
          <div className="divide-y divide-border-soft rounded-md border border-border-soft bg-surface">
            {group.tasks.map(task => (
              <TaskRow key={task.id} task={task} onOpen={onOpen} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
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
  /** Monotonic guard: a superseded response must never paint (same discipline
   *  as the chat page's loadId). */
  const seq = useRef(0);

  const load = useCallback(async () => {
    const generation = ++seq.current;
    setRefreshing(true);
    try {
      const parsed = parseTaskListResponse(await api.listSessionTasks(sessionId));
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
      // A failed refresh over an already-loaded list keeps the list: the last
      // known-good answer beats a blank pane. Only a first load lands on the
      // error state.
      setError(e instanceof ApiError ? e.message : String(e));
      setState(current => (current === 'ready' ? 'ready' : 'error'));
    } finally {
      if (seq.current === generation) setRefreshing(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setState('loading');
    setTasks([]);
    setSelectedId(null);
    setDetail(null);
    setActivity([]);
    void load();
  }, [load]);

  // Live convergence: every successful task write broadcasts the whole session
  // snapshot. Applying it replaces the list — the server owns ordering.
  useSessionEvents(sessionId, event => {
    if (event.type !== 'tasks.updated' || event.sessionId !== sessionId) return;
    const parsed = parseTaskListResponse(event.data);
    setTasks(parsed.tasks);
    setParseErrors(parsed.parseErrors);
    setState('ready');
    setError(null);
  });

  const openDetail = useCallback(
    async (taskId: string) => {
      // Never render task B with task A's activity while B's request is in
      // flight (same rule as the Tasks page).
      setDetail(null);
      setActivity([]);
      setSelectedId(taskId);
      try {
        const response = (await api.getSessionTask(sessionId, taskId)) as {
          task?: unknown;
          activity?: unknown;
        };
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
        // The summary row is still authoritative; the detail view below renders
        // it with whatever it has rather than erasing the selection.
      }
    },
    [sessionId],
  );

  const selectedSummary = tasks.find(task => task.id === selectedId) ?? null;
  const selected = detail?.id === selectedId ? detail : selectedSummary;

  if (selectedId && selected) {
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
          <TaskDetail task={selected} activity={activity} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-sm px-panel py-2">
        <span className="kt-label">
          {state === 'ready' ? `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}` : 'Session tasks'}
        </span>
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

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-3">
        {state === 'loading' && (
          <p role="status" className="py-6 text-center text-cell text-muted">
            Loading tasks…
          </p>
        )}
        {(state === 'absent' || state === 'error' || (state === 'ready' && tasks.length === 0)) && (
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
        {state === 'ready' && tasks.length > 0 && <SessionTaskList tasks={tasks} onOpen={id => void openDetail(id)} />}
      </div>
    </div>
  );
}
