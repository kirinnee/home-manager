import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  ListTodo,
  RefreshCw,
  UserRound,
} from 'lucide-react';
import { BottomSheet } from '../components/SessionDetails';
import { Badge, Button, Card, Label, PanelBody, PanelHeader } from '../components/Primitives';
import { Markdown } from '../components/Markdown';
import { parseGithubPr } from '../lib/pins';
import {
  filterTasks,
  groupTasks,
  parseTaskActivity,
  parseTaskListResponse,
  parseTaskRecord,
  taskActivityText,
  taskLivenessLabel,
  TASK_STATUSES,
  TASK_STATUS_META,
  TASK_STALENESS_COPY,
  type TaskActivity,
  type TaskFilters,
  type TaskRecord,
  type TaskStatus,
  type TaskSummary,
} from '../lib/tasks';
import { fmtRelative } from '../lib/utils';
import { useLayoutMode } from '../hooks/useLayoutMode';

export interface TaskDetailResponse {
  task: unknown;
  activity?: unknown;
}

/**
 * The route wiring owns API calls. Keeping this page fetcher-injected lets the
 * board compile and be tested before the contested API module is touched.
 */
export interface TasksPageProps {
  fetchTasks?: () => Promise<unknown>;
  fetchTask?: (id: string) => Promise<TaskDetailResponse | unknown>;
  pollMs?: number;
  initialRepo?: string;
}

const ALL = 'all';

export function TasksPage({ fetchTasks, fetchTask, pollMs = 15_000, initialRepo = ALL }: TasksPageProps) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [parseErrors, setParseErrors] = useState(0);
  const [filters, setFilters] = useState<TaskFilters>({ repo: initialRepo, status: ALL, assignee: ALL });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskRecord | null>(null);
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  const [loading, setLoading] = useState(Boolean(fetchTasks));
  const [failed, setFailed] = useState(false);
  const layout = useLayoutMode();
  const compact = layout === 'drawer';

  const load = useCallback(async () => {
    if (!fetchTasks) return;
    try {
      const parsed = parseTaskListResponse(await fetchTasks());
      setTasks(parsed.tasks);
      setParseErrors(parsed.parseErrors);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [fetchTasks]);

  useEffect(() => {
    void load();
    if (!fetchTasks || pollMs <= 0) return;
    const poll = () => {
      if (typeof document === 'undefined' || !document.hidden) void load();
    };
    const wake = () => {
      if (!document.hidden) void load();
    };
    const interval = window.setInterval(poll, pollMs);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [fetchTasks, load, pollMs]);

  const loadDetail = useCallback(
    async (id: string) => {
      if (!fetchTask) return;
      const result = await fetchTask(id);
      const response = result as TaskDetailResponse;
      const record = parseTaskRecord(response?.task ?? result);
      const entries = Array.isArray(response?.activity) ? response.activity : [];
      return {
        record,
        activity: entries
          .flatMap(item => {
            const parsed = parseTaskActivity(item);
            return parsed ? [parsed] : [];
          })
          .sort((a, b) => a.seq - b.seq),
      };
    },
    [fetchTask],
  );

  useEffect(() => {
    if (!selectedId || !fetchTask) return;
    let cancelled = false;
    const refresh = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadDetail(selectedId)
        .then(result => {
          if (cancelled || !result) return;
          setDetail(result.record);
          setActivity(result.activity);
        })
        // A failed poll must not erase a brief/history that was already loaded.
        // For a first-load failure the summary remains visible and the next poll
        // retries; for later failures the last known-good detail stays put.
        .catch(() => undefined);
    };
    refresh();
    const wake = () => {
      if (!document.hidden) refresh();
    };
    const interval = pollMs > 0 ? window.setInterval(refresh, pollMs) : undefined;
    document.addEventListener('visibilitychange', wake);
    return () => {
      cancelled = true;
      if (interval !== undefined) window.clearInterval(interval);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [fetchTask, loadDetail, pollMs, selectedId]);

  const repos = useMemo(() => [...new Set(tasks.flatMap(task => (task.repo ? [task.repo] : [])))].sort(), [tasks]);
  const assignees = useMemo(
    () => [...new Set(tasks.flatMap(task => (task.assignee ? [task.assignee] : [])))].sort(),
    [tasks],
  );
  const visible = useMemo(() => filterTasks(tasks, filters), [tasks, filters]);
  const needsYou = visible.filter(task => task.status === 'blocked');
  const groups = useMemo(() => groupTasks(visible), [visible]);
  const selectedSummary = tasks.find(task => task.id === selectedId) ?? null;
  const selected = detail?.id === selectedId ? detail : selectedSummary;

  const close = useCallback(() => setSelectedId(null), []);
  const choose = useCallback((id: string) => {
    // Never render task B with task A's activity while B's request is in flight.
    setDetail(null);
    setActivity([]);
    setSelectedId(id);
  }, []);
  const updateFilter = <K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) =>
    setFilters(prev => ({ ...prev, [key]: value }));

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto scroll-thin pb-4">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-3 py-2">
        <header className="min-w-0">
          <h1 className="m-0 flex items-center gap-sm font-display text-display font-bold tracking-display">
            <ListTodo size={20} className="text-accent" aria-hidden="true" />
            Tasks
          </h1>
          <p className="mt-0.5 text-ui text-muted">
            Declared work status, with live assignee evidence kept visibly separate.
          </p>
        </header>

        <TaskFiltersBar
          filters={filters}
          repos={repos}
          assignees={assignees}
          onChange={updateFilter}
          onRefresh={load}
          loading={loading}
        />

        {failed && (
          <p
            role="status"
            className="kt-badge w-fit max-w-full break-words text-left !whitespace-normal"
            data-tone="warn"
          >
            Task service unavailable; showing the last successful result.
          </p>
        )}
        {parseErrors > 0 && (
          <p
            role="status"
            className="kt-badge w-fit max-w-full break-words text-left !whitespace-normal"
            data-tone="warn"
          >
            {parseErrors} malformed task {parseErrors === 1 ? 'record was' : 'records were'} skipped.
          </p>
        )}
        {!fetchTasks && (
          <p className="rounded-lg border border-border-soft bg-surface-2 px-3 py-4 text-ui text-muted">
            Task API wiring is pending. This page is ready for a fetcher.
          </p>
        )}

        {needsYou.length > 0 && (
          <section aria-labelledby="needs-you-heading" className="rounded-lg border border-warn/40 bg-warn/10 p-3">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <h2 id="needs-you-heading" className="m-0 font-display text-ui font-bold text-fg">
                Needs you
              </h2>
              <Badge tone="warn">{needsYou.length}</Badge>
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              {needsYou.map(task => (
                <TaskRow key={task.id} task={task} onOpen={choose} />
              ))}
            </div>
          </section>
        )}

        <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(300px,0.52fr)]">
          <main className="min-w-0 space-y-3" aria-label="Task board">
            {loading && tasks.length === 0 && <p className="text-ui text-muted">Loading tasks…</p>}
            {!loading && visible.length === 0 && fetchTasks && (
              <p className="rounded-lg border border-border-soft bg-surface-2 px-3 py-4 text-ui text-muted">
                No tasks match these filters.
              </p>
            )}
            {groups.map(group => (
              <section key={group.status} aria-labelledby={`task-group-${group.status}`} className="min-w-0">
                <div className="mb-1.5 flex items-center gap-2">
                  <h2 id={`task-group-${group.status}`} className="kt-label m-0">
                    {TASK_STATUS_META[group.status].label}
                  </h2>
                  <span className="text-xs text-muted">{group.tasks.length}</span>
                </div>
                <Card className="overflow-hidden">
                  <div className="divide-y divide-border-soft">
                    {group.tasks.map(task => (
                      <TaskRow key={task.id} task={task} onOpen={choose} />
                    ))}
                  </div>
                </Card>
              </section>
            ))}
          </main>

          <aside className="hidden min-w-0 md:block" aria-label="Task detail">
            <div className="sticky top-2">
              {selected ? <TaskDetail task={selected} activity={activity} /> : <EmptyDetail />}
            </div>
          </aside>
        </div>
      </div>

      <BottomSheet
        id="task-detail-sheet"
        open={Boolean(selected) && compact}
        onClose={close}
        ariaLabel="Task detail"
        closeLabel="Close task detail"
        panelClassName="md:hidden"
      >
        <div className="min-h-0 overflow-y-auto scroll-thin px-3 pb-4">
          {selected && <TaskDetail task={selected} activity={activity} />}
        </div>
      </BottomSheet>
    </div>
  );
}

function TaskFiltersBar({
  filters,
  repos,
  assignees,
  onChange,
  onRefresh,
  loading,
}: {
  filters: TaskFilters;
  repos: string[];
  assignees: string[];
  onChange: <K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-2 rounded-lg border border-border-soft bg-surface-2 p-2">
      <FilterSelect label="Repository" value={filters.repo} onChange={value => onChange('repo', value)}>
        <option value={ALL}>All repositories</option>
        {repos.map(repo => (
          <option key={repo} value={repo}>
            {repo}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect
        label="Status"
        value={filters.status}
        onChange={value => onChange('status', value as TaskStatus | 'all')}
      >
        <option value={ALL}>All statuses</option>
        {TASK_STATUSES.map(status => (
          <option key={status} value={status}>
            {TASK_STATUS_META[status].label}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect label="Assignee" value={filters.assignee} onChange={value => onChange('assignee', value)}>
        <option value={ALL}>Anyone</option>
        {assignees.map(assignee => (
          <option key={assignee} value={assignee}>
            {assignee}
          </option>
        ))}
      </FilterSelect>
      <Button
        size="sm"
        className="ml-auto min-h-[44px] gap-1.5"
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh tasks"
      >
        <RefreshCw
          size={14}
          className={loading ? 'animate-spin motion-reduce:animate-none' : undefined}
          aria-hidden="true"
        />
        Refresh
      </Button>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs text-muted sm:min-w-[150px]">
      {label}
      <select
        className="kt-input min-h-[44px] max-w-full px-2 text-ui text-fg"
        value={value}
        onChange={event => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

export function TaskRow({ task, onOpen }: { task: TaskSummary; onOpen: (id: string) => void }) {
  const meta = TASK_STATUS_META[task.status];
  const stale = task.live.staleness ? TASK_STALENESS_COPY[task.live.staleness] : null;
  const pr = task.links.prs.map(parseGithubPr).find(Boolean);
  return (
    <div className="group flex min-h-[52px] min-w-0 items-center gap-2 px-3 py-2 hover:bg-surface-2">
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 text-left focus-visible:z-10"
      >
        <span className="mono shrink-0 text-xs font-semibold text-accent">{task.id}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-fg">{task.title}</span>
          {(task.status === 'blocked' || task.status === 'dropped') && task.statusReason && (
            <span
              className={`mt-0.5 block truncate text-xs font-medium ${
                task.status === 'dropped' ? 'text-err' : 'text-warn'
              }`}
            >
              {task.statusReason}
            </span>
          )}
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted">
            <LivenessDot task={task} /> <span className="truncate">{taskLivenessLabel(task)}</span>
          </span>
        </span>
        <Badge tone={meta.tone} className="shrink-0 whitespace-nowrap">
          {meta.label}
        </Badge>
        {stale && (
          <span className="inline-flex shrink-0" title={stale.reason}>
            <span className="sr-only">{stale.reason}</span>
            <Badge tone="warn" className="animate-pulse motion-reduce:animate-none">
              !
            </Badge>
          </span>
        )}
      </button>
      {pr && (
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title={`Open ${pr.org}/${pr.repo} PR #${pr.number}`}
          aria-label={`Open ${pr.org}/${pr.repo} pull request ${pr.number}`}
          className="hidden shrink-0 items-center gap-1 rounded-control border border-border-soft px-1.5 py-1 text-xs text-muted hover:text-fg sm:inline-flex"
        >
          <GitPullRequest size={13} aria-hidden="true" />
          {pr.repo}#{pr.number}
        </a>
      )}
    </div>
  );
}

function LivenessDot({ task }: { task: Pick<TaskSummary, 'assignee' | 'live'> }) {
  const tone = task.live.staleness ? 'bg-warn' : task.live.assigneeHealth === 'active' ? 'bg-ok' : 'bg-muted';
  return (
    <span
      aria-hidden="true"
      className={`h-2 w-2 shrink-0 rounded-full ${tone} ${
        task.live.staleness ? 'animate-pulse motion-reduce:animate-none' : ''
      }`}
    />
  );
}

function EmptyDetail() {
  return (
    <Card className="p-4 text-ui text-muted">Select a task to read its full brief, links, and activity history.</Card>
  );
}

export function TaskDetail({ task, activity }: { task: TaskSummary | TaskRecord; activity: TaskActivity[] }) {
  const status = TASK_STATUS_META[task.status];
  const stale = task.live.staleness ? TASK_STALENESS_COPY[task.live.staleness] : null;
  const full = 'description' in task;
  return (
    <Card className="min-w-0">
      <PanelHeader className="flex min-w-0 items-start gap-2">
        <span className="mono mt-0.5 text-xs font-semibold text-accent">{task.id}</span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-ui font-bold text-fg">{task.title}</h2>
          <p className="mt-1 text-xs text-muted">
            Declared status <Badge tone={status.tone}>{status.label}</Badge>
          </p>
        </div>
      </PanelHeader>
      <PanelBody className="flex min-w-0 flex-col gap-4">
        {task.statusReason && (
          <section>
            <Label>Status reason</Label>
            <p
              className={`mt-1 break-words text-ui font-medium ${
                task.status === 'dropped' ? 'text-err' : task.status === 'blocked' ? 'text-warn' : 'text-fg'
              }`}
            >
              {task.statusReason}
            </p>
          </section>
        )}
        {stale && (
          <div role="status" className="rounded-control border border-warn/50 bg-warn/10 p-2 text-ui text-fg">
            <span className="font-semibold text-warn">Evidence: {stale.label}.</span> {stale.reason}
          </div>
        )}
        <section>
          <Label>Assignee evidence</Label>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-ui text-fg">
            <UserRound size={14} className="shrink-0 text-muted" aria-hidden="true" />
            <span className="truncate">{taskLivenessLabel(task)}</span>
          </p>
          {task.live.assigneeLastActivityAt && (
            <p className="mt-0.5 text-xs text-muted">Last activity {fmtRelative(task.live.assigneeLastActivityAt)}</p>
          )}
        </section>
        {full ? (
          <section>
            <Label>Brief</Label>
            {task.description ? (
              <div className="mt-2">
                <Markdown text={task.description} />
              </div>
            ) : (
              <p className="mt-1 text-ui text-muted">No brief was recorded.</p>
            )}
          </section>
        ) : (
          <p className="text-ui text-muted">Loading full brief…</p>
        )}
        <TaskLinks links={task.links} />
        <TaskTimeline activity={activity} />
      </PanelBody>
    </Card>
  );
}

function TaskLinks({ links }: { links: TaskSummary['links'] }) {
  if (!links.prs.length && !links.branch && !links.commits.length && !links.docs.length) return null;
  return (
    <section className="min-w-0">
      <Label>Links</Label>
      <div className="mt-1.5 flex min-w-0 flex-col gap-1.5 text-ui">
        {links.prs.map(link => (
          <ExternalTaskLink
            key={link}
            href={link}
            icon={<GitPullRequest size={14} />}
            text={parseGithubPr(link) ? `${parseGithubPr(link)!.repo}#${parseGithubPr(link)!.number}` : link}
          />
        ))}
        {links.branch && (
          <p className="flex min-w-0 items-center gap-1.5 text-muted">
            <GitBranch size={14} aria-hidden="true" />
            <span className="mono truncate">{links.branch}</span>
          </p>
        )}
        {links.commits.map(commit => (
          <p key={commit} className="flex min-w-0 items-center gap-1.5 text-muted">
            <GitCommitHorizontal size={14} aria-hidden="true" />
            <span className="mono truncate">{commit}</span>
          </p>
        ))}
        {links.docs.map(link => (
          <ExternalTaskLink key={link} href={link} icon={<ExternalLink size={14} />} text={link} />
        ))}
      </div>
    </section>
  );
}

function ExternalTaskLink({ href, icon, text }: { href: string; icon: React.ReactNode; text: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex min-w-0 items-center gap-1.5 text-accent hover:underline"
    >
      {icon}
      <span className="truncate">{text}</span>
    </a>
  );
}

function TaskTimeline({ activity }: { activity: TaskActivity[] }) {
  return (
    <section aria-labelledby="task-activity-heading">
      <div className="flex items-center gap-1.5">
        <Activity size={14} className="text-muted" aria-hidden="true" />
        <Label id="task-activity-heading">Activity</Label>
      </div>
      {activity.length === 0 ? (
        <p className="mt-1 text-ui text-muted">No activity recorded yet.</p>
      ) : (
        <ol className="mt-2 space-y-2 border-l border-border-soft pl-3">
          {activity.map(item => (
            <li
              key={item.seq}
              className={
                item.type === 'feedback'
                  ? 'rounded-control border border-accent-border bg-accent/10 p-2'
                  : item.type === 'status'
                    ? 'rounded-control border border-warn/40 bg-warn/10 p-2'
                    : 'text-ui'
              }
            >
              <p className="text-ui text-fg">{taskActivityText(item)}</p>
              <p className="mt-0.5 text-xs text-muted">
                {item.actorName ?? item.actor ?? 'unknown'} · {fmtRelative(item.time)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
