// SESSION LINEAGE IN THE SIDE PANE — the focused session's local family, not
// another fleet browser. The left rail remains the whole-fleet overview; this
// surface answers the smaller question raised while reading one transcript:
// who started this session, and what work did it fan out?
//
// Tree construction, sorting, cycle defence, labels, orphan resolution and the
// two-step indentation cap all come from lib/lineage. This file only selects
// the focused node from that existing tree and gives it a touch-sized, narrow-
// pane presentation.

import { useMemo } from 'react';
import type { SessionView } from '../types';
import { Link } from '../lib/router';
import {
  buildLineage,
  lineageIndent,
  lineageLabel,
  MAX_INDENT_DEPTH,
  nestByLineage,
  parentDisplay,
  type NestedRow,
  type ParentDisplay,
} from '../lib/lineage';
import { useFleet } from '../lib/store';
import { cn } from '../lib/utils';
import { Badge } from './Primitives';
import { StatusMark, statusMark } from './StatusMark';
import { LineageName } from './TaskName';

export interface LineageSurfaceModel {
  current: SessionView | undefined;
  parent: ParentDisplay;
  /** The whole subtree below `current`, already ordered by the shared API. */
  descendants: NestedRow[];
  descendantCount: number;
}

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
  return {
    current,
    parent: parentDisplay(current.config.parent, byId),
    descendants,
    descendantCount: countNestedRows(descendants),
  };
}

function sessionPath(id: string): string {
  return `/session/${encodeURIComponent(id)}`;
}

function visibleStatus(view: SessionView): string {
  return view.state.status.replaceAll('_', ' ');
}

function SessionLineageLink({
  view,
  role,
  current = false,
  depth = 0,
}: {
  view: SessionView;
  role: 'current' | 'parent' | 'descendant';
  current?: boolean;
  /** Relative descendant depth: direct child = 0. */
  depth?: number;
}) {
  const label = lineageLabel(view);
  const mark = statusMark(view);
  const deep = role === 'descendant' && depth > MAX_INDENT_DEPTH;

  return (
    <Link
      to={sessionPath(view.config.id)}
      aria-current={current ? 'page' : undefined}
      data-lineage-role={role}
      data-session-status={view.state.status}
      data-lineage-depth={role === 'descendant' ? depth : undefined}
      title={`${label.full}\n${mark.label}`}
      className={cn(
        'group flex min-h-[52px] min-w-0 items-center gap-sm rounded-control border px-3 py-2 text-left',
        'hover:border-accent-border hover:bg-surface-2 focus-visible:border-accent',
        current ? 'border-accent bg-accent-soft' : 'border-border-soft bg-surface',
      )}
    >
      {deep && (
        <span aria-hidden="true" className="shrink-0 text-faint" title={`Lineage depth ${depth + 1}`}>
          »
        </span>
      )}
      <StatusMark view={view} size={8} />
      <LineageName
        label={label}
        className={cn('min-w-0 flex-1 text-ui font-semibold', current ? 'text-accent' : 'text-fg')}
      />
      {/* StatusMark already speaks the complete state. This visible badge is
          hidden from accessibility APIs so the link does not announce it twice. */}
      <Badge aria-hidden="true" tone={mark.tone} className="max-w-[108px] shrink-0 truncate text-2xs">
        {visibleStatus(view)}
      </Badge>
    </Link>
  );
}

function DescendantList({ rows, depth = 0 }: { rows: readonly NestedRow[]; depth?: number }) {
  return (
    <ul className="m-0 grid list-none gap-xs p-0" aria-label={depth === 0 ? 'Descendant sessions' : undefined}>
      {rows.map(row => {
        // Match the left drawer: each generation earns one 10px rail, but the
        // third and deeper levels share the final indent on narrow screens.
        const railIndent = Math.max(0, lineageIndent(depth + 1) - lineageIndent(depth));
        return (
          <li key={row.view.config.id}>
            <SessionLineageLink view={row.view} role="descendant" depth={depth} />
            {row.children.length > 0 && (
              <div
                className={cn('mt-xs', railIndent > 0 && 'border-l border-border-soft')}
                style={railIndent > 0 ? { marginLeft: `${railIndent - 1}px`, paddingLeft: '1px' } : undefined}
              >
                <DescendantList rows={row.children} depth={depth + 1} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function MissingParent({ parent }: { parent: Extract<ParentDisplay, { kind: 'missing' }> }) {
  return (
    <div
      data-lineage-role="missing-parent"
      role="note"
      className="flex min-h-[52px] items-center gap-sm rounded-control border border-border-soft bg-surface px-3 py-2"
    >
      <span
        aria-hidden="true"
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-err-border text-2xs text-err"
      >
        ×
      </span>
      <span className="min-w-0">
        <span className="block text-ui font-semibold text-fg">Parent gone</span>
        <span className="block truncate text-meta text-muted">
          Record{' '}
          <span className="mono" title="The configured parent session no longer resolves">
            {parent.shortId}
          </span>{' '}
          is no longer available.
        </span>
      </span>
    </div>
  );
}

function TopLevelParent() {
  return (
    <div
      data-lineage-role="top-level"
      className="flex min-h-[44px] items-center rounded-control border border-border-soft bg-surface px-3 py-2"
    >
      <span>
        <span className="block text-ui font-semibold text-fg">Top-level session</span>
        <span className="block text-meta text-muted">No parent was recorded for this session.</span>
      </span>
    </div>
  );
}

/** Pure presentation for static tests and unusual hostless callers. */
export function LineageSurfaceContent({
  sessionId,
  sessions,
}: {
  sessionId: string;
  sessions: readonly SessionView[];
}) {
  const model = useMemo(() => buildLineageSurfaceModel(sessionId, sessions), [sessionId, sessions]);

  if (!model.current) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-panel py-6" role="status">
        <p className="m-0 text-center text-cell text-muted">This session is not in the live fleet snapshot.</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-panel pb-4 pt-3 scroll-thin">
      <div className="grid gap-4">
        <section aria-label="This session" className="grid gap-xs">
          <h3 className="kt-label m-0">This session</h3>
          <SessionLineageLink view={model.current} role="current" current />
        </section>

        <section aria-label="Parent session" className="grid gap-xs">
          <h3 className="kt-label m-0">Parent</h3>
          {model.parent?.kind === 'resolved' ? (
            <SessionLineageLink view={model.parent.view} role="parent" />
          ) : model.parent?.kind === 'missing' ? (
            <MissingParent parent={model.parent} />
          ) : (
            <TopLevelParent />
          )}
        </section>

        <section aria-label="Child sessions" className="grid gap-xs">
          <div className="flex items-baseline gap-sm">
            <h3 className="kt-label m-0">Children</h3>
            <span className="mono text-2xs text-faint" aria-live="polite">
              {model.descendantCount} {model.descendantCount === 1 ? 'descendant' : 'descendants'}
            </span>
          </div>
          {model.descendants.length > 0 ? (
            <DescendantList rows={model.descendants} />
          ) : (
            <div
              data-lineage-role="no-children"
              className="flex min-h-[44px] items-center rounded-control border border-dashed border-border-soft px-3 py-2 text-cell text-muted"
            >
              No children yet. New child sessions will appear here.
            </div>
          )}
        </section>
      </div>
    </div>
  );
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
