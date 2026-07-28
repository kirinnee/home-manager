// Route-independent task presentation shared by the per-session list and its
// detail view. Keeping these renderers together means declared status,
// liveness evidence, links, and activity history cannot drift between the two
// levels of the session surface.

import type { ReactNode } from 'react';
import { Activity, ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest, UserRound } from 'lucide-react';
import { Badge, Card, Label, PanelBody, PanelHeader } from './Primitives';
import { Markdown } from './Markdown';
import { parseGithubPr } from '../lib/pins';
import {
  taskActivityText,
  taskLivenessLabel,
  TASK_STATUS_META,
  TASK_STALENESS_COPY,
  type TaskActivity,
  type TaskRecord,
  type TaskSummary,
} from '../lib/tasks';
import { fmtRelative } from '../lib/utils';

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

function ExternalTaskLink({ href, icon, text }: { href: string; icon: ReactNode; text: string }) {
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
