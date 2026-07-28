import { Link } from '../lib/router';
import { TASK_STALENESS_COPY, type TaskSummary } from '../lib/tasks';
import { cn } from '../lib/utils';

interface ResolvedAssigneeLive {
  /** Read-time identity fields supplied by the task annotator in newer daemons. */
  assigneeName?: unknown;
  assigneeSessionId?: unknown;
}

export interface TaskAssigneePresentation {
  name: string;
  sessionId: string | null;
  href: string | null;
  status: string | null;
  label: string;
  assigned: boolean;
}

const nonBlank = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

export function taskAssigneeHref(sessionId: string): string {
  return `/session/${encodeURIComponent(sessionId)}`;
}

/** Resolve display identity without replacing the stored historical assignee. */
export function taskAssigneePresentation(task: Pick<TaskSummary, 'assignee' | 'live'>): TaskAssigneePresentation {
  const resolved = task.live as TaskSummary['live'] & ResolvedAssigneeLive;
  const stored = nonBlank(task.assignee);
  // Only the live annotator can prove that an assignee resolves to a current
  // session. A stored id-shaped string may be historical and must not become a
  // dead navigation route merely because it matches a naming convention.
  const sessionId = nonBlank(resolved.assigneeSessionId);
  const name = nonBlank(resolved.assigneeName) ?? stored ?? 'Unassigned';
  const status = task.live.staleness
    ? TASK_STALENESS_COPY[task.live.staleness].label
    : task.live.assigneeStatus
      ? task.live.assigneeStatus.replaceAll('_', ' ')
      : stored
        ? 'status unavailable'
        : null;
  return {
    name,
    sessionId,
    href: sessionId ? taskAssigneeHref(sessionId) : null,
    status,
    label: status ? `${name} · ${status}` : name,
    assigned: stored !== null,
  };
}

/** The original liveness encoding, lifted intact so the identity can sit beside it. */
export function TaskLivenessDot({ task }: { task: Pick<TaskSummary, 'assignee' | 'live'> }) {
  const tone = task.live.staleness ? 'bg-warn' : task.live.assigneeHealth === 'active' ? 'bg-ok' : 'bg-muted';
  return (
    <span
      aria-hidden="true"
      className={`h-2 w-2 shrink-0 rounded-full ${tone} ${task.live.staleness ? 'animate-pulse motion-reduce:animate-none' : ''}`}
    />
  );
}

export function TaskAssigneeLink({
  task,
  className,
  showStatus = true,
}: {
  task: Pick<TaskSummary, 'assignee' | 'live'>;
  className?: string;
  /** Compact cards can show just dot + name; detail surfaces keep the state. */
  showStatus?: boolean;
}) {
  const identity = taskAssigneePresentation(task);
  return (
    <span
      data-task-assignee={identity.sessionId ?? (identity.assigned ? 'unresolved' : 'unassigned')}
      className={cn('flex min-w-0 items-center gap-1 text-xs text-muted', className)}
      title={identity.sessionId ? `${identity.label}\nSession ${identity.sessionId}` : identity.label}
    >
      <TaskLivenessDot task={task} />
      {identity.href ? (
        <Link
          to={identity.href}
          aria-label={`Open ${identity.name}'s session`}
          className="min-w-0 truncate font-semibold text-accent hover:underline"
        >
          {identity.name}
        </Link>
      ) : (
        <span className="min-w-0 truncate font-semibold text-fg-soft">{identity.name}</span>
      )}
      {showStatus && identity.status && (
        <>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">{identity.status}</span>
        </>
      )}
    </span>
  );
}
