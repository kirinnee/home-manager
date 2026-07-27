// SESSION TASKS — the task surface for ONE session, hosted in the unified side
// pane (SidePane.tsx).
//
// This is deliberately NOT the fleet Tasks page shrunk down. The daemon now
// keeps task records per session (GET /v1/sessions/:id/tasks — agreed with the
// teammate building that side; /v1/tasks stays the fleet-wide aggregate), and
// this surface answers one question: "what has THIS session declared it is
// doing". So: no repo/assignee filters, no status grouping ceremony — a short
// list, and one tap into the full brief. The row and detail renderers are the
// Tasks page's own (TaskRow / TaskDetail), re-hosted so declared-status
// presentation can never drift between the two surfaces.
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
import { TaskDetail, TaskRow } from '../pages/TasksPage';
import {
  parseTaskActivity,
  parseTaskListResponse,
  parseTaskRecord,
  type TaskActivity,
  type TaskRecord,
  type TaskSummary,
} from '../lib/tasks';

/** The honest copy per empty-ish state, exported for unit tests. */
export function sessionTasksEmptyCopy(state: 'absent' | 'error' | 'empty', error?: string | null): string {
  switch (state) {
    case 'absent':
      return 'This daemon does not serve per-session tasks yet. The fleet-wide Tasks page still works.';
    case 'error':
      return error ? `Couldn't load tasks: ${error}` : "Couldn't load tasks.";
    case 'empty':
      return 'No tasks recorded for this session yet. Agents record them with `kteam task create`.';
  }
}

type LoadState = 'loading' | 'ready' | 'absent' | 'error';

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
        {state === 'ready' && tasks.length > 0 && (
          <div className="divide-y divide-border-soft rounded-md border border-border-soft bg-surface">
            {tasks.map(task => (
              <TaskRow key={task.id} task={task} onOpen={id => void openDetail(id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
