// WHO ELSE IS WORKING HERE.
//
// A session's most useful neighbours are the other sessions in the same
// directory: they are the ones touching the same files, holding the same locks,
// and racing the same build. Finding them previously meant going back to the
// fleet list and reading `cwd` columns.
//
// Two tiers, and the distinction matters:
//
//   SAME FOLDER   — cwd is byte-identical. These agents are literally in each
//                   other's way; a concurrent edit is a real conflict.
//   SUBDIRECTORY  — cwd is nested under this one (a package inside the repo, a
//                   worktree inside a workspace). Related, but not colliding,
//                   so it is a separate, clearly-labelled group rather than
//                   silently pooled with the first.
//
// Each row carries the four facts you need to decide whether to talk to that
// teammate: name, mode (is a human driving it?), status, and quota. Clicking
// switches to it.
//
// Layout: a real flex column beside the chat on desktop, an overlay drawer
// below `lg`. It never introduces a second scroll region into the page — the
// list scrolls WITHIN the sidebar, which is a sibling of the transcript, not a
// nested scroller inside it.

import { useMemo } from 'react';
import { FolderGit2, PanelLeftClose, PanelLeftOpen, X, Users } from 'lucide-react';
import type { SessionView, UsageAccountView } from '../types';
import { Link } from '../lib/router';
import { Badge } from './Primitives';
import { ModeBadge } from './ModeBadge';
import { QuotaReadout } from './QuotaBadge';
import { quotaFor } from '../lib/usage';
import { TERMINAL_STATUSES, cn, fmtAge, toneFor } from '../lib/utils';

/** Trailing slashes make `/repo` and `/repo/` look like different folders. */
function normalize(cwd: string): string {
  return cwd.replace(/\/+$/, '');
}

function baseName(p: string): string {
  const seg = normalize(p).split('/').filter(Boolean);
  return seg.length ? seg[seg.length - 1]! : p;
}

/** `/a/b/c` under `/a/b` → `c`; used to label a nested session by what actually
 *  distinguishes it rather than repeating the shared prefix. */
function relative(cwd: string, root: string): string {
  const c = normalize(cwd);
  const r = normalize(root);
  return c.startsWith(`${r}/`) ? c.slice(r.length + 1) : c;
}

export interface FolderNeighbours {
  /** cwd byte-identical to the current session's. */
  same: SessionView[];
  /** cwd nested below it. */
  nested: SessionView[];
  total: number;
}

/** Split the fleet into this session's folder neighbours.
 *
 *  Terminal sessions are excluded: "who else is working here" is a question
 *  about live contention, and a list padded with yesterday's finished agents
 *  buries the two that are actually running. The current session is excluded
 *  too — it is the page you are on. */
export function folderNeighbours(sessions: SessionView[], current: SessionView | null): FolderNeighbours {
  if (!current) return { same: [], nested: [], total: 0 };
  const root = normalize(current.config.cwd ?? '');
  if (!root) return { same: [], nested: [], total: 0 };

  const same: SessionView[] = [];
  const nested: SessionView[] = [];
  for (const view of sessions) {
    if (view.config.id === current.config.id) continue;
    if (TERMINAL_STATUSES.has(view.state.status)) continue;
    const cwd = normalize(view.config.cwd ?? '');
    if (cwd === root) same.push(view);
    else if (cwd.startsWith(`${root}/`)) nested.push(view);
  }
  const byActivity = (a: SessionView, b: SessionView) =>
    Date.parse(b.state.lastActivityAt ?? b.config.updatedAt ?? '') -
    Date.parse(a.state.lastActivityAt ?? a.config.updatedAt ?? '');
  same.sort(byActivity);
  nested.sort(byActivity);
  return { same, nested, total: same.length + nested.length };
}

interface Props {
  current: SessionView | null;
  neighbours: FolderNeighbours;
  usage: Map<string, UsageAccountView>;
  open: boolean;
  onToggle: () => void;
}

/** The collapsed rail: one button that says how many neighbours there are.
 *  Shown on desktop when the sidebar is closed, so the count is never hidden
 *  behind a state the reader has to remember. */
export function FolderSidebarToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  const Icon = open ? PanelLeftClose : PanelLeftOpen;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={
        count === 0
          ? 'no other live sessions in this folder'
          : `${count} other live session${count === 1 ? '' : 's'} in this folder`
      }
      aria-expanded={open}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11.5px] text-muted hover:border-accent-border hover:text-fg"
    >
      <Icon size={12} />
      <Users size={11} />
      <span className="mono">{count}</span>
    </button>
  );
}

function NeighbourRow({
  view,
  usage,
  suffix,
}: {
  view: SessionView;
  usage: Map<string, UsageAccountView>;
  suffix?: string;
}) {
  const cfg = view.config;
  return (
    <Link
      to={`/session/${encodeURIComponent(cfg.id)}`}
      className="group block rounded-md px-1.5 py-1 hover:bg-surface-2"
      title={`${cfg.teammate ?? cfg.id} — ${cfg.name ?? ''}\n${cfg.cwd}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-[12.5px] font-semibold text-fg group-hover:text-accent">
          {cfg.teammate || cfg.name || cfg.id}
        </span>
        <Badge tone={toneFor(view.state.status)} className="ml-auto shrink-0">
          {/* A declared park is not the same idle as an unanswered question,
              and a PEER park names who is expected to unblock it. */}
          {view.state.waiting
            ? `parked${view.state.waiting.peerName ? `←${view.state.waiting.peerName}` : ''}`
            : view.state.status}
        </Badge>
      </div>
      {/* Everything below the name is chrome-weight: the sidebar must not
          compete with the conversation it sits beside. */}
      <div className="kt-chrome mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5">
        <ModeBadge mode={cfg.mode} size="sm" />
        <QuotaReadout quota={quotaFor(view, usage)} showUnknown />
        <span className="mono ml-auto shrink-0">{fmtAge(view.state.lastActivityAt)}</span>
      </div>
      {suffix && (
        <div className="kt-chrome mono min-w-0 truncate" title={cfg.cwd}>
          ./{suffix}
        </div>
      )}
    </Link>
  );
}

function Body({ current, neighbours, usage }: Pick<Props, 'current' | 'neighbours' | 'usage'>) {
  const root = normalize(current?.config.cwd ?? '');
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border-soft px-1.5 pb-1.5">
        <FolderGit2 size={12} className="shrink-0 text-faint" />
        <span className="min-w-0 truncate text-[12.5px] font-semibold" title={root}>
          {baseName(root)}
        </span>
        <span className="mono ml-auto shrink-0 text-[11px] text-faint">{neighbours.total}</span>
      </div>
      {/* The ONLY scroller in this component, and it is a sibling of the
          transcript rather than nested inside it — the one-scroll-region rule
          is about not stacking scrollers, not about having exactly one on the
          page. */}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin py-1">
        {neighbours.total === 0 ? (
          <p className="kt-chrome px-1.5">No other live sessions in this folder.</p>
        ) : (
          <>
            {neighbours.same.map(v => (
              <NeighbourRow key={v.config.id} view={v} usage={usage} />
            ))}
            {neighbours.nested.length > 0 && (
              <>
                {/* Labelled, not merged: a session in a subdirectory is a
                    neighbour, but it is NOT in your way the way a same-cwd
                    agent is. */}
                <div className="kt-chrome mt-2 px-1.5 uppercase tracking-[0.1em]">
                  subdirectories · {neighbours.nested.length}
                </div>
                {neighbours.nested.map(v => (
                  <NeighbourRow key={v.config.id} view={v} usage={usage} suffix={relative(v.config.cwd, root)} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

export function FolderSidebar({ current, neighbours, usage, open, onToggle }: Props) {
  const content = useMemo(
    () => <Body current={current} neighbours={neighbours} usage={usage} />,
    [current, neighbours, usage],
  );
  if (!open) return null;

  return (
    <>
      {/* Desktop: a real column in the flex row, so the transcript simply gets
          narrower. No overlay, nothing floating over the text. */}
      <aside className="hidden w-[220px] shrink-0 flex-col border-r border-border-soft pr-2 lg:flex">{content}</aside>

      {/* Below lg there is not enough width for a column, so the same content
          becomes a drawer. Backdrop dismisses it. */}
      <div className="fixed inset-0 z-30 lg:hidden" role="dialog" aria-label="Sessions in this folder">
        <button
          type="button"
          aria-label="Close"
          onClick={onToggle}
          className="absolute inset-0 bg-black/35 backdrop-blur-[1px]"
        />
        <aside
          className={cn(
            'absolute inset-y-0 left-0 flex w-[min(86vw,280px)] flex-col',
            'border-r border-border bg-surface px-2 py-2 shadow-md',
          )}
        >
          <div className="mb-1 flex items-center gap-1.5">
            <Users size={13} className="text-faint" />
            <span className="text-[12.5px] font-semibold">In this folder</span>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Close"
              className="ml-auto rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X size={14} />
            </button>
          </div>
          {content}
        </aside>
      </div>
    </>
  );
}
