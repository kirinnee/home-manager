// SESSION LINEAGE IN THE SIDE PANE — the focused session's local family, not
// another fleet browser. The left rail remains the whole-fleet overview; this
// surface answers the smaller question raised while reading one transcript:
// who started this session, and what work did it fan out?
//
// Tree construction, sorting, cycle defence, labels, orphan resolution and the
// two-step indentation cap all come from lib/lineage. This file only selects
// the focused node from that existing tree and gives it a touch-sized, narrow-
// pane presentation.

import { useMemo, useState } from 'react';
import type { SessionStatus, SessionView } from '../types';
import { Link } from '../lib/router';
import {
  buildLineage,
  lineageIndent,
  lineageLabel,
  MAX_INDENT_DEPTH,
  nestByLineage,
  parentDisplay,
  shortSessionId,
  type NestedRow,
  type ParentDisplay,
} from '../lib/lineage';
import { useFleet } from '../lib/store';
import { cn } from '../lib/utils';
import { Badge } from './Primitives';
import { StatusMark, statusMark } from './StatusMark';
import { LineageName } from './TaskName';

export type LineageSurfaceParent = ParentDisplay | { kind: 'invalid'; shortId: string };

export interface LineageSurfaceModel {
  current: SessionView | undefined;
  parent: LineageSurfaceParent;
  /** The whole subtree below `current`, already ordered by the shared API. */
  descendants: NestedRow[];
  descendantCount: number;
}

export interface FilteredLineageRow {
  view: SessionView;
  children: FilteredLineageRow[];
  /** False means this row is present only to preserve the path to a match. */
  matchesFilter: boolean;
}

export interface FilteredLineageTree {
  rows: FilteredLineageRow[];
  matchCount: number;
  contextCount: number;
}

const STATUS_ORDER: readonly SessionStatus[] = [
  'running',
  'tool_running',
  'thinking',
  'starting',
  'created',
  'retrying',
  'rate_limited',
  'waiting',
  'awaiting_user',
  'awaiting_question',
  'interrupted',
  'completed',
  'failed',
  'stalled',
  'stopped',
  'kill_failed',
];

function findNestedRow(rows: readonly NestedRow[], sessionId: string): NestedRow | undefined {
  const pending = [...rows];
  while (pending.length > 0) {
    const row = pending.pop()!;
    if (row.view.config.id === sessionId) return row;
    pending.push(...row.children);
  }
  return undefined;
}

function countNestedRows(rows: readonly NestedRow[]): number {
  let count = 0;
  const pending = [...rows];
  while (pending.length > 0) {
    const row = pending.pop()!;
    count += 1;
    pending.push(...row.children);
  }
  return count;
}

/** Status filtering preserves tree meaning: a non-matching node survives only
 * when it is an ancestor of a real match. Callers render that distinction as a
 * visible PATH marker rather than pretending the ancestor matched. `null`
 * means the unfiltered tree; an explicit set is a multi-status OR filter. */
export function filterLineageRows(
  rows: readonly NestedRow[],
  statuses: ReadonlySet<SessionStatus> | null,
): FilteredLineageTree {
  let matchCount = 0;
  let contextCount = 0;

  const visit = (row: NestedRow): FilteredLineageRow | null => {
    const children = row.children.map(visit).filter((child): child is FilteredLineageRow => child !== null);
    const matchesFilter = statuses === null || statuses.has(row.view.state.status);
    if (!matchesFilter && children.length === 0) return null;
    if (matchesFilter) matchCount += 1;
    else contextCount += 1;
    return { view: row.view, children, matchesFilter };
  };

  return {
    rows: rows.map(visit).filter((row): row is FilteredLineageRow => row !== null),
    matchCount,
    contextCount,
  };
}

/** `null` is the explicit All state. The first tap isolates one status; later
 * taps add/remove statuses, and removing the final one returns to All. */
export function toggleLineageStatusFilter(
  current: ReadonlySet<SessionStatus> | null,
  status: SessionStatus,
): ReadonlySet<SessionStatus> | null {
  if (current === null) return new Set([status]);
  const next = new Set(current);
  if (next.has(status)) next.delete(status);
  else next.add(status);
  return next.size === 0 ? null : next;
}

export function lineageFilterSummary(matchCount: number, contextCount: number): string {
  return `${matchCount} ${matchCount === 1 ? 'match' : 'matches'} · ${contextCount} ${contextCount === 1 ? 'path' : 'paths'}`;
}

/** Pure selection layer kept exported so tree depth, orphan and complete-
 * subtree behaviour can be asserted without mounting the live fleet store. */
export function buildLineageSurfaceModel(sessionId: string, sessions: readonly SessionView[]): LineageSurfaceModel {
  const byId = new Map(sessions.map(view => [view.config.id, view]));
  const current = byId.get(sessionId);
  if (!current) return { current: undefined, parent: null, descendants: [], descendantCount: 0 };

  const lineage = buildLineage(sessions);
  // `nestByLineage` owns attachment, sibling order and malformed-edge defence.
  // Walking its result to select one node is deliberately not a second tree.
  const currentRow = findNestedRow(nestByLineage(sessions, lineage), sessionId);
  const descendants = currentRow?.children ?? [];
  let parent: LineageSurfaceParent = parentDisplay(current.config.parent, byId);
  // parentDisplay owns honest id resolution, while buildLineage owns whether a
  // resolved edge is safe. A self/cyclic pointer must not be reintroduced here
  // as a duplicate connected node after the shared index deliberately dropped it.
  if (parent?.kind === 'resolved' && lineage.parentOf.get(sessionId) !== parent.view.config.id) {
    parent = { kind: 'invalid', shortId: shortSessionId(parent.view.config.id) };
  }
  return {
    current,
    parent,
    descendants,
    descendantCount: countNestedRows(descendants),
  };
}

function sessionPath(id: string): string {
  return `/session/${encodeURIComponent(id)}`;
}

function statusLabel(status: SessionStatus): string {
  return status.replaceAll('_', ' ');
}

function surfaceRows(model: LineageSurfaceModel): NestedRow[] {
  if (!model.current) return [];
  const current: NestedRow = {
    view: model.current,
    depth: model.parent?.kind === 'resolved' ? 1 : 0,
    children: model.descendants,
  };
  if (model.parent?.kind !== 'resolved') return [current];
  return [{ view: model.parent.view, depth: 0, children: [current] }];
}

function statusCounts(rows: readonly NestedRow[]): Map<SessionStatus, number> {
  const counts = new Map<SessionStatus, number>();
  const pending = [...rows];
  while (pending.length > 0) {
    const row = pending.pop()!;
    const status = row.view.state.status;
    counts.set(status, (counts.get(status) ?? 0) + 1);
    pending.push(...row.children);
  }
  return counts;
}

function orderedStatuses(
  counts: ReadonlyMap<SessionStatus, number>,
  selected: ReadonlySet<SessionStatus> | null,
): SessionStatus[] {
  const rank = new Map(STATUS_ORDER.map((status, index) => [status, index]));
  const visible = new Set(counts.keys());
  if (selected) for (const status of selected) visible.add(status);
  return [...visible].sort((a, b) => (rank.get(a) ?? STATUS_ORDER.length) - (rank.get(b) ?? STATUS_ORDER.length));
}

function StatusFilter({
  counts,
  selected,
  onSelect,
  onShowAll,
}: {
  counts: ReadonlyMap<SessionStatus, number>;
  selected: ReadonlySet<SessionStatus> | null;
  onSelect: (status: SessionStatus) => void;
  onShowAll: () => void;
}) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return (
    <div
      className="flex gap-xs overflow-x-auto overscroll-x-contain pb-1 scroll-thin"
      role="group"
      aria-label="Filter lineage by status"
    >
      <button
        type="button"
        aria-pressed={selected === null}
        onClick={onShowAll}
        className={cn(
          'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center gap-xs rounded-control border px-2 text-2xs font-semibold',
          selected === null
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-border-soft bg-surface text-muted hover:border-accent-border hover:text-fg',
        )}
      >
        All <span className="mono text-faint">{total}</span>
      </button>
      {orderedStatuses(counts, selected).map(status => {
        const active = selected?.has(status) ?? false;
        const count = counts.get(status) ?? 0;
        return (
          <button
            key={status}
            type="button"
            aria-pressed={active}
            aria-label={`${statusLabel(status)}, ${count} ${count === 1 ? 'session' : 'sessions'}`}
            title={active ? `Remove ${statusLabel(status)} from the filter` : `Show ${statusLabel(status)} sessions`}
            onClick={() => onSelect(status)}
            className={cn(
              'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center gap-xs rounded-control border px-2 text-2xs font-semibold',
              active
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border-soft bg-surface text-muted hover:border-accent-border hover:text-fg',
            )}
          >
            {statusLabel(status)} <span className="mono text-faint">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

type LineageRole = 'current' | 'parent' | 'descendant';

function roleFor(view: SessionView, model: LineageSurfaceModel): LineageRole {
  if (view.config.id === model.current?.config.id) return 'current';
  if (model.parent?.kind === 'resolved' && view.config.id === model.parent.view.config.id) return 'parent';
  return 'descendant';
}

function SessionLineageLink({
  view,
  role,
  current = false,
  displayDepth,
  descendantDepth,
  matchesFilter,
  hasChildren,
  topLevel,
}: {
  view: SessionView;
  role: LineageRole;
  current?: boolean;
  displayDepth: number;
  /** Relative descendant depth: direct child = 0. */
  descendantDepth?: number;
  matchesFilter: boolean;
  hasChildren: boolean;
  topLevel?: boolean;
}) {
  const label = lineageLabel(view);
  const mark = statusMark(view);
  const compressedDepth = displayDepth > MAX_INDENT_DEPTH;
  const contextNote = matchesFilter ? undefined : 'Shown as a path to a matching descendant';

  return (
    <Link
      to={sessionPath(view.config.id)}
      aria-current={current ? 'page' : undefined}
      data-lineage-role={role}
      data-lineage-origin={topLevel ? 'top-level' : undefined}
      data-lineage-filter={matchesFilter ? 'match' : 'context'}
      data-session-status={view.state.status}
      data-lineage-depth={role === 'descendant' ? descendantDepth : undefined}
      data-lineage-tree-depth={displayDepth}
      title={[label.full, mark.label, contextNote].filter(Boolean).join('\n')}
      className={cn(
        'group relative flex min-h-[44px] w-full min-w-0 items-center gap-xs border-l-2 px-2 py-1 text-left',
        'hover:bg-surface-2 focus-visible:bg-surface-2',
        current ? 'border-l-accent bg-accent-soft' : 'border-l-transparent',
        !matchesFilter && 'bg-surface-2',
      )}
    >
      {hasChildren && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-[15px] top-1/2 border-l border-border-soft"
        />
      )}
      <StatusMark view={view} size={8} className="relative z-[2]" />
      {compressedDepth && (
        <span aria-hidden="true" className="mono shrink-0 text-2xs text-faint" title={`Tree level ${displayDepth + 1}`}>
          ›{displayDepth}
        </span>
      )}
      <LineageName
        label={label}
        className={cn(
          'min-w-0 flex-1 text-ui',
          matchesFilter ? (current ? 'font-semibold text-accent' : 'font-semibold text-fg') : 'font-medium text-muted',
        )}
      />
      {matchesFilter ? (
        <Badge aria-hidden="true" tone={mark.tone} className="max-w-[104px] shrink-0 truncate text-2xs">
          {statusLabel(view.state.status)}
        </Badge>
      ) : (
        <span
          aria-hidden="true"
          className="mono shrink-0 rounded-badge border border-dashed border-border px-xs text-2xs font-semibold uppercase text-muted"
        >
          path
        </span>
      )}
      {contextNote && <span className="sr-only"> — {contextNote}; this session does not match the status filter</span>}
      {topLevel && <span className="sr-only"> — top-level session; no parent was recorded</span>}
    </Link>
  );
}

function LineageTreeRows({
  rows,
  model,
  depth = 0,
  descendantDepth,
}: {
  rows: readonly FilteredLineageRow[];
  model: LineageSurfaceModel;
  depth?: number;
  descendantDepth?: number;
}) {
  return (
    <ul className="m-0 list-none p-0" aria-label={depth === 0 ? 'Session lineage tree' : undefined}>
      {rows.map((filtered, index) => {
        const { view, children, matchesFilter } = filtered;
        const role = roleFor(view, model);
        const step = depth === 0 ? 0 : Math.max(0, lineageIndent(depth) - lineageIndent(depth - 1));
        const rowDescendantDepth = role === 'descendant' ? descendantDepth : undefined;
        const nextDescendantDepth =
          role === 'current' ? 0 : role === 'descendant' ? (descendantDepth ?? 0) + 1 : undefined;
        const last = index === rows.length - 1;
        return (
          <li key={view.config.id} className="relative">
            {depth > 0 && (
              <>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-4 top-0 z-[1] h-[22px] border-l border-border-soft"
                />
                {step > 0 && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-4 top-[21px] z-[1] border-t border-border-soft"
                    style={{ width: `${step}px` }}
                  />
                )}
                {!last && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-0 left-4 top-[22px] z-[1] border-l border-border-soft"
                  />
                )}
              </>
            )}
            <div className="relative" style={step > 0 ? { marginLeft: `${step}px` } : undefined}>
              <SessionLineageLink
                view={view}
                role={role}
                current={role === 'current'}
                displayDepth={depth}
                descendantDepth={rowDescendantDepth}
                matchesFilter={matchesFilter}
                hasChildren={children.length > 0}
                topLevel={role === 'current' && model.parent === null}
              />
              {children.length > 0 && (
                <LineageTreeRows
                  rows={children}
                  model={model}
                  depth={depth + 1}
                  descendantDepth={nextDescendantDepth}
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ParentIssue({
  parent,
  hasChildren,
}: {
  parent: Extract<LineageSurfaceParent, { kind: 'missing' | 'invalid' }>;
  hasChildren: boolean;
}) {
  const invalid = parent.kind === 'invalid';
  return (
    <div
      data-lineage-role={invalid ? 'invalid-parent' : 'missing-parent'}
      data-lineage-filter="context"
      role="note"
      title={
        invalid
          ? 'The configured parent edge is self-referential or cyclic and was ignored'
          : 'The configured parent session no longer resolves'
      }
      className={cn(
        'relative flex min-h-[44px] min-w-0 items-center gap-xs border-l-2 px-2 py-1',
        invalid ? 'border-l-warn' : 'border-l-err',
      )}
    >
      {hasChildren && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-[15px] top-1/2 border-l border-border-soft"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          'relative z-[2] flex h-3 w-3 shrink-0 items-center justify-center rounded-full border text-2xs',
          invalid ? 'border-warn-border text-warn' : 'border-err-border text-err',
        )}
      >
        {invalid ? '!' : '×'}
      </span>
      <span className="min-w-0 flex-1 truncate text-ui font-semibold text-muted">
        {invalid ? 'Invalid parent link' : 'Missing parent'}
      </span>
      <span className="mono shrink-0 text-2xs text-faint">{parent.shortId}</span>
    </div>
  );
}

function LineageSurfaceBody({ sessionId, sessions }: { sessionId: string; sessions: readonly SessionView[] }) {
  const model = useMemo(() => buildLineageSurfaceModel(sessionId, sessions), [sessionId, sessions]);
  const rows = useMemo(() => surfaceRows(model), [model]);
  const counts = useMemo(() => statusCounts(rows), [rows]);
  const [selectedStatuses, setSelectedStatuses] = useState<ReadonlySet<SessionStatus> | null>(null);
  const filtered = useMemo(() => filterLineageRows(rows, selectedStatuses), [rows, selectedStatuses]);

  const toggleStatus = (status: SessionStatus) => {
    setSelectedStatuses(current => toggleLineageStatusFilter(current, status));
  };

  if (!model.current) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-panel py-6" role="status">
        <p className="m-0 text-center text-cell text-muted">This session is not in the live fleet snapshot.</p>
      </div>
    );
  }

  const totalCount = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const filtering = selectedStatuses !== null;
  const filterSummary = filtering
    ? lineageFilterSummary(filtered.matchCount, filtered.contextCount)
    : `All ${totalCount}`;
  const parentIssue = model.parent?.kind === 'missing' || model.parent?.kind === 'invalid' ? model.parent : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-panel pb-4 scroll-thin">
      <div className="sticky top-0 z-10 -mx-panel bg-surface px-panel pb-2 pt-2">
        <div className="mb-xs flex items-baseline justify-between gap-sm">
          <h3 className="kt-label m-0">Status</h3>
          <span className="mono shrink-0 text-2xs text-faint" aria-live="polite">
            {filterSummary}
          </span>
        </div>
        <StatusFilter
          counts={counts}
          selected={selectedStatuses}
          onSelect={toggleStatus}
          onShowAll={() => setSelectedStatuses(null)}
        />
        {filtering && filtered.contextCount > 0 && (
          <p className="mb-0 mt-xs text-meta text-muted">
            Path rows keep matching descendants attached to their ancestors.
          </p>
        )}
      </div>

      <section aria-label="Session lineage" className="pt-2">
        <div className="mb-xs flex items-baseline justify-between gap-sm">
          <h3 className="kt-label m-0">Lineage tree</h3>
          <span className="mono shrink-0 text-2xs text-faint">
            {model.descendantCount} {model.descendantCount === 1 ? 'descendant' : 'descendants'}
          </span>
        </div>
        {filtered.rows.length > 0 ? (
          <div className="rounded-control border border-border-soft bg-surface p-px">
            {parentIssue && <ParentIssue parent={parentIssue} hasChildren={filtered.rows.length > 0} />}
            <LineageTreeRows rows={filtered.rows} model={model} depth={parentIssue ? 1 : 0} />
          </div>
        ) : (
          <div
            data-lineage-role="no-matches"
            role="status"
            className="flex min-h-[88px] flex-wrap items-center justify-between gap-sm rounded-control border border-dashed border-border-soft px-3 py-2 text-cell text-muted"
          >
            <span>No sessions currently match this status filter.</span>
            <button
              type="button"
              onClick={() => setSelectedStatuses(null)}
              className="min-h-[44px] rounded-control border border-border px-3 text-ui font-semibold text-fg hover:border-accent-border hover:text-accent"
            >
              Show all
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

/** Pure presentation for static tests and unusual hostless callers. The key
 * makes filter state session-scoped without an effect or focus movement when
 * the retained side pane navigates to another session. */
export function LineageSurfaceContent({
  sessionId,
  sessions,
}: {
  sessionId: string;
  sessions: readonly SessionView[];
}) {
  return <LineageSurfaceBody key={sessionId} sessionId={sessionId} sessions={sessions} />;
}

/** Live store adapter. The side pane mounts this only while Lineage is open,
 * so one existing fleet subscription is sufficient; there is no timer. */
export function LineageSurface({ sessionId }: { sessionId: string }) {
  const { sessions } = useFleet();
  if (sessions === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-panel py-6" role="status">
        <p className="m-0 text-center text-cell text-muted">Loading lineage…</p>
      </div>
    );
  }
  return <LineageSurfaceContent sessionId={sessionId} sessions={sessions} />;
}
