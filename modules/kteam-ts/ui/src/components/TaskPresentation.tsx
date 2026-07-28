// Shared task-v2 cards and detail. All human-facing task references use #F12.
import type { ReactNode } from 'react';
import {
  Activity,
  Bot,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  TriangleAlert,
} from 'lucide-react';
import { Badge, Card, Label, PanelBody, PanelHeader } from './Primitives';
import { Markdown } from './Markdown';
import { Link } from '../lib/router';
import { parseGithubPr } from '../lib/pins';
import type { CodeReference } from '../lib/code-references';
import {
  taskActivityText,
  taskBoardLane,
  taskReference,
  TASK_BOARD_LANE_META,
  TASK_PHASE_META,
  TASK_STATUS_META,
  TASK_STALENESS_COPY,
  TASK_WORKFLOW_LABEL,
  type TaskActivity,
  type TaskBoardLane,
  type TaskFileConflict,
  type TaskRecord,
  type TaskSummary,
} from '../lib/tasks';
import { fmtAbsolute, fmtRelative } from '../lib/utils';
import { TaskAssigneeLink } from './TaskAssigneeLink';

/** The one session-navigation affordance every task surface links through, so a
 *  cross-session node opens its owning session the same way the sidebar does. */
export const sessionHref = (id: string): string => `/session/${encodeURIComponent(id)}`;

export type TaskAskOrigin = 'human' | 'agent' | 'unknown';

/** New tasks carry the verbatim ask plus its source. Direct chat/message
 *  sources are human asks; kteam/session artifacts are fleet-originated work.
 *  Legacy records without both pieces stay unknown rather than being guessed. */
export function taskAskOrigin(task: Pick<TaskSummary, 'askChars' | 'askSource'>): TaskAskOrigin {
  const source = task.askSource?.trim();
  if (task.askChars <= 0 || !source || /^(?:legacy:|#[BFIC][0-9]{1,9}$)/iu.test(source)) return 'unknown';
  const agentSource =
    /^(?:agent(?:\s|:)|kteam(?:\s|:)|session:|turn:)/iu.test(source) || /(?:^|[/\\])\.kteam(?:[/\\]|$)/iu.test(source);
  return agentSource ? 'agent' : 'human';
}

/** A Files pane is session-scoped. Never resolve prose against one task owner
 *  and deliver its path to another session's pane. */
export function taskCodeReferencesStayInSession(
  surfaceSessionId: string | undefined,
  taskSessionId: string | null | undefined,
): boolean {
  return Boolean(surfaceSessionId && taskSessionId && surfaceSessionId === taskSessionId);
}

export interface TaskCodeReferenceContext {
  sessionId: string;
  cwd?: string;
}

/** The hosting Files surface is the sole authority for filesystem context.
 *  Stored task.repo is audit data and may differ from the active worktree, so
 *  it must never be used to resolve a path that will open in this pane. */
export function taskCodeReferenceContext(
  surfaceSessionId: string | undefined,
  surfaceCwd: string | undefined,
  taskSessionId: string | null | undefined,
): TaskCodeReferenceContext | null {
  return taskCodeReferencesStayInSession(surfaceSessionId, taskSessionId)
    ? { sessionId: surfaceSessionId!, ...(surfaceCwd ? { cwd: surfaceCwd } : {}) }
    : null;
}

export function SessionLink({ sessionId, label }: { sessionId: string; label?: string }) {
  return (
    <Link
      to={sessionHref(sessionId)}
      title={`Open session ${sessionId}`}
      className="mono inline-block max-w-[18ch] truncate align-bottom text-accent hover:underline"
    >
      {label ?? sessionId}
    </Link>
  );
}

export function TaskRow({
  task,
  conflicts,
  onOpen,
  impliedLane,
  showStatusBadge = true,
  showAssignee = true,
  showAskOriginMarker = true,
}: {
  task: TaskSummary;
  conflicts?: TaskFileConflict[];
  onOpen: (id: string) => void;
  /** A Kanban column already names its lane. Only exceptional blocked state
   *  still needs a badge there; mixed list rows keep their status by default. */
  impliedLane?: TaskBoardLane;
  /** Homogeneous lists already expose their one status in the shared filter. */
  showStatusBadge?: boolean;
  /** Visible-set context suppresses an identity repeated on every sibling. */
  showAssignee?: boolean;
  /** Ask provenance distinguishes only when the visible set mixes origins. */
  showAskOriginMarker?: boolean;
}) {
  const lane = taskBoardLane(task.phase);
  const boardState = task.blocked ? TASK_STATUS_META.blocked : TASK_BOARD_LANE_META[lane];
  const statusIsImplied = !showStatusBadge || (!task.blocked && impliedLane === lane);
  const askOrigin = taskAskOrigin(task);
  const stale = task.live.staleness ? TASK_STALENESS_COPY[task.live.staleness] : null;
  const pr = task.links.prs.map(parseGithubPr).find(Boolean);
  return (
    <div data-task-id={task.id} className="group min-w-0 px-3 py-2 hover:bg-surface-2">
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        className="flex min-h-[44px] w-full min-w-0 flex-col justify-center gap-1 text-left focus-visible:z-10"
        aria-label={`Open ${taskReference(task.id)}: ${task.title}`}
      >
        <span
          data-task-title={task.id}
          className="block w-full whitespace-normal break-words text-row font-semibold leading-tight text-fg"
        >
          {task.title}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="mono shrink-0 text-2xs font-medium text-faint">{taskReference(task.id)}</span>
          {showAskOriginMarker && <TaskAskOriginMarker origin={askOrigin} compact />}
          {!statusIsImplied && (
            <Badge data-task-status-badge tone={boardState.tone} className="shrink-0 whitespace-nowrap">
              {boardState.label}
            </Badge>
          )}
          {stale && (
            <span className="inline-flex shrink-0" title={stale.reason}>
              <span className="sr-only">{stale.reason}</span>
              <Badge tone="warn" className="animate-pulse motion-reduce:animate-none">
                !
              </Badge>
            </span>
          )}
        </span>
        <span className="block min-w-0 w-full">
          {task.blocked && task.blockedReason && (
            <span className="mt-0.5 block truncate text-xs font-medium text-warn">{task.blockedReason}</span>
          )}
          {task.blockedBy.length > 0 && (
            <span className="mt-0.5 block truncate text-xs text-warn">
              Blocked by {task.blockedBy.map(taskReference).join(', ')}
            </span>
          )}
          {task.dependsOn.length > 0 && (
            <span className="mt-0.5 block truncate text-xs text-muted">
              Depends on {task.dependsOn.map(taskReference).join(', ')}
            </span>
          )}
          {task.files.length > 0 && (
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted">
              <FileText size={11} aria-hidden="true" className="shrink-0" />
              <span className="truncate">{task.files.join(', ')}</span>
            </span>
          )}
          {conflicts && conflicts.length > 0 && (
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-warn">
              <TriangleAlert size={11} aria-hidden="true" className="shrink-0" />
              <span className="truncate">
                Shares files with {conflicts.map(conflict => taskReference(conflict.taskId)).join(', ')}
              </span>
            </span>
          )}
        </span>
      </button>
      {(showAssignee || pr) && (
        <div className={`mt-1 min-w-0 items-center gap-2 ${showAssignee ? 'flex' : 'hidden sm:flex'}`}>
          {showAssignee && <TaskAssigneeLink task={task} showStatus={false} className="max-w-full" />}
          {pr && (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              title={`Open ${pr.org}/${pr.repo} PR #${pr.number}`}
              aria-label={`Open ${pr.org}/${pr.repo} pull request ${pr.number}`}
              className="ml-auto hidden shrink-0 items-center gap-1 rounded-control border border-border-soft px-1.5 py-1 text-xs text-muted hover:text-fg sm:inline-flex"
            >
              <GitPullRequest size={13} aria-hidden="true" />
              {pr.repo}#{pr.number}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskDetail({
  task,
  activity,
  conflicts,
  onOpenTask,
  onCodeReferenceOpen,
  surfaceSessionId,
  surfaceCwd,
}: {
  task: TaskSummary | TaskRecord;
  activity: TaskActivity[];
  conflicts?: TaskFileConflict[];
  onOpenTask?: (id: string, opener?: HTMLElement | null) => void;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  /** Session that owns the hosting Files pane. */
  surfaceSessionId?: string;
  /** Root of that same Files pane; task.repo is not an opening context. */
  surfaceCwd?: string;
}) {
  const lane = taskBoardLane(task.phase);
  const boardState = task.blocked ? TASK_STATUS_META.blocked : TASK_BOARD_LANE_META[lane];
  const auditPhase = lane === task.phase ? null : TASK_PHASE_META[task.phase];
  const stale = task.live.staleness ? TASK_STALENESS_COPY[task.live.staleness] : null;
  const full = 'ask' in task;
  const askOrigin = taskAskOrigin(task);
  const codeReferenceContext = taskCodeReferenceContext(surfaceSessionId, surfaceCwd, task.sessionId);
  const openCodeReference = codeReferenceContext ? onCodeReferenceOpen : undefined;
  return (
    <Card className="min-w-0">
      <PanelHeader className="flex min-w-0 items-start gap-2">
        <span className="mono mt-0.5 text-xs font-semibold text-accent">{taskReference(task.id)}</span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-ui font-bold text-fg">{task.title}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted">
            <span>Workflow {TASK_WORKFLOW_LABEL[task.workflow]}</span>
            <Badge tone={boardState.tone}>{boardState.label}</Badge>
            <TaskAskOriginMarker origin={askOrigin} />
            {auditPhase && <span>Audit phase {auditPhase.label}</span>}
          </p>
        </div>
      </PanelHeader>
      <PanelBody className="flex min-w-0 flex-col gap-4">
        <TaskQuickSummary task={task} />
        {stale && (
          <div role="status" className="rounded-control border border-warn/50 bg-warn/10 p-2 text-ui text-fg">
            <span className="font-semibold text-warn">Evidence: {stale.label}.</span> {stale.reason}
          </div>
        )}
        <section>
          <Label>Assignee evidence</Label>
          <TaskAssigneeLink task={task} className="mt-1 text-ui" />
          {task.live.assigneeLastActivityAt && (
            <p className="mt-0.5 text-xs text-muted">Last activity {fmtRelative(task.live.assigneeLastActivityAt)}</p>
          )}
        </section>
        <Dependencies ids={task.dependsOn} />
        <TaskFiles files={task.files} conflicts={conflicts} />
        {full ? (
          <AskAndClarifications
            task={task}
            onOpenTask={onOpenTask}
            codeReferenceContext={codeReferenceContext}
            onCodeReferenceOpen={openCodeReference}
          />
        ) : (
          <p className="text-ui text-muted">Loading original ask…</p>
        )}
        {full && task.description && (
          <section>
            <Label>Working brief</Label>
            <TaskMarkdown
              text={task.description}
              sessionId={codeReferenceContext?.sessionId}
              cwd={codeReferenceContext?.cwd}
              onOpenTask={onOpenTask}
              onCodeReferenceOpen={openCodeReference}
              className="mt-2"
            />
          </section>
        )}
        <TaskLinks links={task.links} />
        <TaskTimeline activity={activity} />
      </PanelBody>
    </Card>
  );
}

function TaskAskOriginMarker({ origin, compact = false }: { origin: TaskAskOrigin; compact?: boolean }) {
  if (compact) {
    if (origin !== 'agent') return null;
    return (
      <span
        data-task-ask-origin="agent"
        className="inline-flex shrink-0 items-center text-faint"
        title="Original ask came from an agent"
      >
        <Bot size={11} aria-hidden="true" />
        <span className="sr-only">Agent-originated</span>
      </span>
    );
  }
  const label = origin === 'agent' ? 'Agent-originated' : origin === 'human' ? 'Human-asked' : 'Ask origin unknown';
  const title =
    origin === 'agent'
      ? 'Original ask came from an agent'
      : origin === 'human'
        ? 'Original ask came from the human'
        : 'Original ask provenance is unavailable';
  return (
    <span
      data-task-ask-origin={origin}
      className={`mt-0.5 inline-flex w-fit items-center gap-1 rounded-control border px-1.5 py-0.5 text-2xs font-semibold ${
        origin === 'agent'
          ? 'border-accent-border bg-accent-soft text-accent'
          : 'border-border-soft bg-surface text-muted'
      }`}
      title={title}
    >
      {origin === 'agent' && <Bot size={11} aria-hidden="true" />}
      {label}
    </span>
  );
}

function TaskQuickSummary({ task }: { task: TaskSummary }) {
  const state = task.blocked ? TASK_STATUS_META.blocked : TASK_BOARD_LANE_META[taskBoardLane(task.phase)];
  const assignee = task.live.assigneeName?.trim() || task.assignee?.trim() || null;
  const blocker = task.blockedReason ?? task.statusReason ?? 'Blocked; no reason recorded.';
  const headingId = `task-quick-summary-${task.id}`;
  return (
    <section aria-labelledby={headingId} className="rounded-control border border-accent-border bg-accent-soft p-3">
      <Label id={headingId}>Quick summary</Label>
      <div className="mt-2 flex flex-col gap-1.5 text-ui leading-relaxed text-fg">
        <p>
          <strong>{state.label}.</strong>
        </p>
        <p>{task.title}</p>
        {task.blocked && <p className="whitespace-pre-wrap break-words text-warn">{blocker}</p>}
        {task.blockedBy.length > 0 && <p>Waiting on {task.blockedBy.map(taskReference).join(', ')}.</p>}
        {task.blockedSince && <p>Blocked since {fmtAbsolute(task.blockedSince)}.</p>}
        <p>{assignee ? `Assigned to ${assignee}.` : 'Unassigned.'}</p>
        {task.dependsOn.length > 0 && <p>Depends on {task.dependsOn.map(taskReference).join(', ')}.</p>}
      </div>
    </section>
  );
}

function TaskMarkdown({
  text,
  sessionId,
  cwd,
  onOpenTask,
  onCodeReferenceOpen,
  className = '',
}: {
  text: string;
  sessionId?: string | null;
  cwd?: string | null;
  onOpenTask?: (id: string, opener?: HTMLElement | null) => void;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  className?: string;
}) {
  return (
    <div className={`${className} min-w-0 whitespace-pre-wrap break-words text-ui text-fg`}>
      <Markdown
        text={text}
        sessionId={sessionId ?? undefined}
        cwd={cwd ?? undefined}
        onTaskOpen={onOpenTask}
        onCodeReferenceOpen={onCodeReferenceOpen}
      />
    </div>
  );
}
function Dependencies({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <section>
      <Label>Depends on</Label>
      <p className="mono mt-1 break-words text-ui text-fg">{ids.map(taskReference).join(', ')}</p>
    </section>
  );
}
function TaskFiles({ files, conflicts }: { files: string[]; conflicts?: TaskFileConflict[] }) {
  if (files.length === 0 && !(conflicts && conflicts.length > 0)) return null;
  return (
    <section className="min-w-0">
      <Label>Files</Label>
      {files.length > 0 ? (
        <ul className="mt-1.5 flex min-w-0 flex-col gap-1 text-ui">
          {files.map(file => (
            <li key={file} className="flex min-w-0 items-center gap-1.5 text-muted">
              <FileText size={13} aria-hidden="true" className="shrink-0" />
              <span className="mono truncate">{file}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-ui text-muted">No files claimed.</p>
      )}
      {conflicts && conflicts.length > 0 && (
        <div className="mt-2 rounded-control border border-warn/50 bg-warn/10 p-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-warn">
            <TriangleAlert size={13} aria-hidden="true" /> Advisory: shared file claims (not a blocker)
          </p>
          <ul className="mt-1 flex flex-col gap-1 text-xs text-fg">
            {conflicts.map(conflict => (
              <li key={conflict.taskId} className="min-w-0 break-words">
                <span className="mono font-semibold text-accent">{taskReference(conflict.taskId)}</span>
                {conflict.crossSession && conflict.sessionId && (
                  <>
                    {' '}
                    in <SessionLink sessionId={conflict.sessionId} />
                  </>
                )}{' '}
                · <span className="mono">{conflict.files.join(', ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
function AskAndClarifications({
  task,
  onOpenTask,
  codeReferenceContext,
  onCodeReferenceOpen,
}: {
  task: TaskRecord;
  onOpenTask?: (id: string, opener?: HTMLElement | null) => void;
  codeReferenceContext: TaskCodeReferenceContext | null;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
}) {
  return (
    <>
      <section>
        <Label>Original ask</Label>
        <blockquote className="mt-1 border-l-2 border-accent pl-3">
          <TaskMarkdown
            text={task.ask.text || 'No original ask recorded.'}
            sessionId={codeReferenceContext?.sessionId}
            cwd={codeReferenceContext?.cwd}
            onOpenTask={onOpenTask}
            onCodeReferenceOpen={onCodeReferenceOpen}
          />
        </blockquote>
        <SourceLink source={task.ask.source} label="Open ask source" />
      </section>
      <section>
        <Label>Clarifications</Label>
        {task.clarifications.length === 0 ? (
          <p className="mt-1 text-ui text-muted">No clarifications recorded.</p>
        ) : (
          <ol className="mt-2 space-y-2">
            {task.clarifications.map((clarification, index) => (
              <li
                key={`${clarification.at ?? 'unknown'}-${index}`}
                className="rounded-control border border-border-soft p-2"
              >
                <TaskMarkdown
                  text={clarification.text}
                  sessionId={codeReferenceContext?.sessionId}
                  cwd={codeReferenceContext?.cwd}
                  onOpenTask={onOpenTask}
                  onCodeReferenceOpen={onCodeReferenceOpen}
                />
                <p className="mt-1 text-xs text-muted">
                  {clarification.byName ?? clarification.by ?? 'unknown'} · {fmtAbsolute(clarification.at)}
                </p>
                <SourceLink source={clarification.source} label="Open clarification source" />
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
function SourceLink({ source, label }: { source: string; label: string }) {
  return source ? (
    <ExternalTaskLink href={source} icon={<ExternalLink size={13} />} text={label} />
  ) : (
    <p className="mt-1 text-xs text-muted">Source unavailable.</p>
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
function ExternalTaskLink({ href, icon, text }: { href: string; icon: ReactNode; text: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mt-1 flex min-w-0 items-center gap-1.5 text-accent hover:underline"
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
        <Label id="task-activity-heading">History</Label>
      </div>
      {activity.length === 0 ? (
        <p className="mt-1 text-ui text-muted">No activity recorded yet.</p>
      ) : (
        <ol className="mt-2 space-y-2 border-l border-border-soft pl-3">
          {activity.map(item => (
            <li
              key={item.seq}
              className={
                item.type === 'status' || item.type === 'session'
                  ? 'rounded-control border border-warn/40 bg-warn/10 p-2'
                  : 'text-ui'
              }
            >
              <p className="text-ui text-fg">{taskActivityText(item)}</p>
              {item.type === 'clarification' && typeof item.data['source'] === 'string' && (
                <SourceLink source={item.data['source']} label="Open clarification source" />
              )}
              <p className="mt-0.5 text-xs text-muted">
                {item.actorName ?? item.actor ?? 'unknown'} ·{' '}
                <time dateTime={item.time ?? undefined}>{fmtAbsolute(item.time)}</time>
                {item.time && ` (${fmtRelative(item.time)})`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
