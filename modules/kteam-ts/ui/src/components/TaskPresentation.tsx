// Shared task-v2 cards and detail. All human-facing task references use #F12.
import type { ReactNode } from 'react';
import {
  Activity,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { Badge, Card, Label, PanelBody, PanelHeader } from './Primitives';
import { Markdown } from './Markdown';
import { Link } from '../lib/router';
import { parseGithubPr } from '../lib/pins';
import {
  taskActivityText,
  taskLivenessLabel,
  taskReference,
  TASK_PHASE_META,
  TASK_STALENESS_COPY,
  TASK_WORKFLOW_LABEL,
  type TaskActivity,
  type TaskFileConflict,
  type TaskRecord,
  type TaskSummary,
} from '../lib/tasks';
import { fmtAbsolute, fmtRelative } from '../lib/utils';

/** The one session-navigation affordance every task surface links through, so a
 *  cross-session node opens its owning session the same way the sidebar does. */
export const sessionHref = (id: string): string => `/session/${encodeURIComponent(id)}`;
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
}: {
  task: TaskSummary;
  conflicts?: TaskFileConflict[];
  onOpen: (id: string) => void;
}) {
  const phase = TASK_PHASE_META[task.phase];
  const stale = task.live.staleness ? TASK_STALENESS_COPY[task.live.staleness] : null;
  const pr = task.links.prs.map(parseGithubPr).find(Boolean);
  return (
    <div className="group flex min-h-[52px] min-w-0 items-center gap-2 px-3 py-2 hover:bg-surface-2">
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 text-left focus-visible:z-10"
        aria-label={`Open ${taskReference(task.id)}: ${task.title}`}
      >
        <span className="mono shrink-0 text-xs font-semibold text-accent">{taskReference(task.id)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-fg">{task.title}</span>
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
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted">
            <LivenessDot task={task} /> <span className="truncate">{taskLivenessLabel(task)}</span>
          </span>
        </span>
        <Badge tone={phase.tone} className="shrink-0 whitespace-nowrap">
          {phase.label}
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
      className={`h-2 w-2 shrink-0 rounded-full ${tone} ${task.live.staleness ? 'animate-pulse motion-reduce:animate-none' : ''}`}
    />
  );
}

export function TaskDetail({
  task,
  activity,
  conflicts,
}: {
  task: TaskSummary | TaskRecord;
  activity: TaskActivity[];
  conflicts?: TaskFileConflict[];
}) {
  const phase = TASK_PHASE_META[task.phase];
  const stale = task.live.staleness ? TASK_STALENESS_COPY[task.live.staleness] : null;
  const full = 'ask' in task;
  return (
    <Card className="min-w-0">
      <PanelHeader className="flex min-w-0 items-start gap-2">
        <span className="mono mt-0.5 text-xs font-semibold text-accent">{taskReference(task.id)}</span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-ui font-bold text-fg">{task.title}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted">
            <span>Workflow {TASK_WORKFLOW_LABEL[task.workflow]}</span>
            <Badge tone={phase.tone}>{phase.label}</Badge>
          </p>
        </div>
      </PanelHeader>
      <PanelBody className="flex min-w-0 flex-col gap-4">
        <Blocker task={task} />
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
        <Dependencies ids={task.dependsOn} />
        <TaskFiles files={task.files} conflicts={conflicts} />
        {full ? <AskAndClarifications task={task} /> : <p className="text-ui text-muted">Loading original ask…</p>}
        {full && task.description && (
          <section>
            <Label>Working brief</Label>
            <div className="mt-2">
              <Markdown text={task.description} />
            </div>
          </section>
        )}
        <TaskLinks links={task.links} />
        <TaskTimeline activity={activity} />
      </PanelBody>
    </Card>
  );
}

function Blocker({ task }: { task: TaskSummary }) {
  if (!task.blocked) return null;
  return (
    <section className="rounded-control border border-warn/50 bg-warn/10 p-2">
      <Label>Blocked</Label>
      <p className="mt-1 break-words text-ui font-medium text-warn">
        {task.blockedReason ?? task.statusReason ?? 'Blocked; no reason recorded.'}
      </p>
      {task.blockedBy.length > 0 && (
        <p className="mt-1 text-xs text-muted">Waiting on {task.blockedBy.map(taskReference).join(', ')}</p>
      )}
      {task.blockedSince && <p className="mt-1 text-xs text-muted">Since {fmtAbsolute(task.blockedSince)}</p>}
    </section>
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
function AskAndClarifications({ task }: { task: TaskRecord }) {
  return (
    <>
      <section>
        <Label>Original ask</Label>
        <blockquote className="mt-1 border-l-2 border-accent pl-3 text-ui text-fg whitespace-pre-wrap">
          {task.ask.text || 'No original ask recorded.'}
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
                <p className="whitespace-pre-wrap text-ui text-fg">{clarification.text}</p>
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
