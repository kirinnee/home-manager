// THE PERSISTENT AGENT SIDEBAR — the fleet, always on screen.
//
// Before this, "which of my teammates is stuck?" was a question you could only
// ask on the dashboard: you left the conversation you were reading, scanned a
// ten-column table, and came back. The fleet is the context for every page, so
// it now lives at shell level (App.tsx) — mounted once, never remounted by
// navigation, so its scroll position and its filter state survive going into a
// session and back out.
//
// WHAT A ROW SAYS, AND WHAT IT DELIBERATELY DOES NOT
//
// Four facts only: the task, the teammate, the labels, and a status mark. No
// model, no context %, no quota, no age. Those are dashboard columns; a row that
// carried them would be the noise wall this redesign exists to remove, at a
// third of the width. The task comes first because it is the thing you are
// looking for ("where's the transcript fix?"), the teammate second because it is
// how you refer to it.
//
// ONE SOURCE OF TRUTH FOR THE FILTERS
//
// The sidebar OWNS the shared controls — instant search, the All/Auto/
// Interactive segment, the RC filter, include-finished — and they live in the
// store, not here. So the dashboard table reflects them without a second copy to
// drift, and narrowing the fleet in the sidebar narrows it everywhere at once.
// The dashboard's toolbar keeps only what is genuinely its own (its table/cards
// switch, its transcript-result panel).
//
// THREE SHAPES, TWO FACTS
//
// `useLayoutMode` reports what the VIEWPORT allows; the store's
// `sidebarCollapsed` records what the READER asked for. They are separate
// because a rail forced by a 900px window must not silently overwrite the
// expanded preference — widening the window brings it back. Below 768px the
// column becomes an overlay drawer with a backdrop, an Escape handler, a
// labelled close button and focus moved into it on open.
//
// SCROLLING
//
// Exactly one scroller: the session list. It is a SIBLING of the main pane's
// scroller, not nested inside it, so the one-scroll-region rule holds — the
// header (search + filters) and the footer stay put while the list moves.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ChevronsLeft,
  ChevronsRight,
  Cpu,
  FolderGit2,
  Plus,
  Radio,
  Search,
  SlidersHorizontal,
  User,
  Users,
  X,
} from 'lucide-react';
import type { SessionView } from '../types';
import { Link } from '../lib/router';
import { cn } from '../lib/utils';
import { filterSessions, groupByProject, modeCounts, type SessionGroup } from '../lib/grouping';
import { useFleet, useStore, useUiControls, type ModeFilter } from '../lib/store';
import { StatusMark, statusMark } from './StatusMark';
import { TaskName } from './TaskName';
import { MODE_HINT } from './ModeBadge';
import { useLayoutMode, type LayoutMode } from '../hooks/useLayoutMode';

/** Expanded width. Wide enough for a task line and a teammate name, narrow
 *  enough that the transcript beside it still reads comfortably at 1280px. */
const EXPANDED_W = 'w-[248px]';
/** Icon rail: one column of 28px controls plus padding. */
const RAIL_W = 'w-[52px]';

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const MODE_ORDER: ReadonlyArray<ModeFilter> = ['all', 'auto', 'interactive'];

const MODE_LABEL: Record<ModeFilter, string> = {
  all: 'All',
  auto: 'Auto',
  interactive: 'Interactive',
};

function ModeSegment({
  value,
  counts,
  onChange,
}: {
  value: ModeFilter;
  counts: { all: number; auto: number; interactive: number };
  onChange: (next: ModeFilter) => void;
}) {
  return (
    <div className="flex rounded-md border border-border bg-surface p-0.5" role="group" aria-label="Filter by mode">
      {MODE_ORDER.map(m => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={value === m}
          // The count is what clicking WOULD show under the other filters, so
          // the tooltip says so rather than leaving the reader to assume it is a
          // fleet-wide total.
          title={
            m === 'all'
              ? `every session matching the current search and filters (${counts.all})`
              : `${MODE_HINT[m]}\n${counts[m]} match the current search and filters`
          }
          className={cn(
            'inline-flex min-w-0 flex-1 items-center justify-center gap-1 rounded px-1 py-1 text-[11.5px] font-medium transition-colors',
            value === m ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {m === 'auto' && <Cpu size={10} className="shrink-0" />}
          {m === 'interactive' && <User size={10} className="shrink-0" />}
          <span className="truncate">{MODE_LABEL[m]}</span>
          <span className="mono shrink-0 text-[10.5px] text-faint">{counts[m]}</span>
        </button>
      ))}
    </div>
  );
}

/** Search + mode segment + RC + include-finished. Rendered in the expanded
 *  column and in the drawer; the rail renders labelled icon equivalents. */
function Controls({ autoFocusSearch = false }: { autoFocusSearch?: boolean }) {
  const store = useStore();
  const { sessions } = useFleet();
  const [controls, setControls] = useUiControls();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const counts = useMemo(
    () =>
      modeCounts(sessions ?? [], {
        query: controls.query,
        mode: controls.mode,
        rcOnly: controls.rcOnly,
        includeFinished: controls.includeFinished,
      }),
    [sessions, controls.query, controls.mode, controls.rcOnly, controls.includeFinished],
  );

  // `/` from anywhere focuses the search box. It used to be the dashboard's
  // shortcut and had to check that the dashboard was the visible route; now the
  // box is on every route, so it simply works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (autoFocusSearch) inputRef.current?.focus();
  }, [autoFocusSearch]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative flex items-center">
        <Search size={13} className="pointer-events-none absolute left-2 text-faint" />
        <input
          ref={inputRef}
          // `text`, not `search`: WebKit adds its own clear affordance to a
          // search input, which would sit next to ours and behave differently
          // (it does not clear the transcript-search results).
          type="text"
          value={controls.query}
          onChange={e => setControls({ query: e.target.value })}
          onKeyDown={e => {
            // ENTER STILL SEARCHES TRANSCRIPTS. The instant filter narrows the
            // list as you type; Enter runs the daemon-side full-text search and
            // the dashboard's result panel renders it. Two features, one box,
            // exactly as before the box moved in here.
            if (e.key === 'Enter') {
              e.preventDefault();
              void store.runSearch(controls.query);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setControls({ query: '' });
              store.clearSearch();
            }
          }}
          placeholder="Search fleet…  ( / )"
          aria-label="Search sessions — Enter also searches transcripts"
          className="w-full py-1 pl-7 pr-7 text-[12.5px]"
        />
        {controls.query && (
          <button
            type="button"
            onClick={() => {
              setControls({ query: '' });
              store.clearSearch();
            }}
            aria-label="Clear search"
            className="absolute right-1.5 rounded p-0.5 text-faint hover:text-fg"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <ModeSegment value={controls.mode} counts={counts} onChange={m => setControls({ mode: m })} />

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setControls({ rcOnly: !controls.rcOnly })}
          aria-pressed={controls.rcOnly}
          title="only sessions launched with Remote Control (steerable from claude.ai / your phone)"
          className={cn(
            'inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11.5px] font-medium transition-colors',
            controls.rcOnly
              ? 'border-accent-border bg-accent-soft text-accent'
              : 'border-border bg-surface text-muted hover:text-fg',
          )}
        >
          <Radio size={10} />
          rc only
        </button>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-fg-soft">
          <input
            type="checkbox"
            checked={controls.includeFinished}
            onChange={e => setControls({ includeFinished: e.target.checked })}
            className="h-3 w-3"
          />
          finished
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function SidebarRow({
  view,
  active,
  onNavigate,
}: {
  view: SessionView;
  active: boolean;
  /** Drawer only: picking a session has to shut the overlay covering it. */
  onNavigate?: () => void;
}) {
  const cfg = view.config;
  const mark = statusMark(view);
  const labels = (cfg.label ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return (
    <li>
      <Link
        to={`/session/${encodeURIComponent(cfg.id)}`}
        // `aria-current="page"` is how a screen reader is told which of a list of
        // links is the one you are on; the left rail and surface are the same
        // fact for everyone else.
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
        title={`${cfg.teammate || cfg.id}\n${mark.label}`}
        className={cn(
          'group block border-l-2 py-1 pl-2 pr-1.5 transition-colors',
          active
            ? 'border-accent bg-accent-soft'
            : 'border-transparent hover:border-border hover:bg-surface-2 focus-visible:bg-surface-2',
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <StatusMark view={view} />
          <TaskName
            name={cfg.name}
            teammate={cfg.teammate}
            size="sm"
            className={cn('min-w-0 flex-1', active && 'text-accent')}
          />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1 pl-3.5">
          <span className={cn('mono min-w-0 truncate text-[11px]', active ? 'text-accent' : 'text-muted')}>
            {cfg.teammate || cfg.id}
          </span>
          {labels.map(l => (
            <span
              key={l}
              className="shrink-0 rounded-sm border border-border-soft bg-surface-2 px-1 text-[10px] text-muted"
            >
              {l}
            </span>
          ))}
        </div>
      </Link>
    </li>
  );
}

function GroupBlock({
  group,
  activeId,
  onNavigate,
}: {
  group: SessionGroup;
  activeId?: string;
  onNavigate?: () => void;
}) {
  return (
    <section>
      {/* Sticky, and OPAQUE (`bg-bg`, no alpha): rows scroll under it, and a
          translucent header over a dense list is unreadable in every theme. */}
      <h3 className="sticky top-0 z-10 flex min-w-0 items-center gap-1.5 bg-bg px-2 py-1">
        <FolderGit2 size={11} className="shrink-0 text-faint" />
        <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {group.name}
        </span>
        <span className="mono ml-auto shrink-0 text-[10.5px] text-faint">{group.rows.length}</span>
      </h3>
      <ul className="m-0 list-none p-0">
        {group.rows.map(v => (
          <SidebarRow key={v.config.id} view={v} active={v.config.id === activeId} onNavigate={onNavigate} />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

function RailButton({
  label,
  onClick,
  active = false,
  children,
  badge,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'relative inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors',
        active
          ? 'border-accent-border bg-accent-soft text-accent'
          : 'border-border bg-surface text-muted hover:text-fg',
      )}
    >
      {children}
      {badge != null && badge > 0 && (
        <span className="mono absolute -bottom-1 -right-1 rounded-full border border-border bg-surface px-1 text-[9px] leading-[1.3] text-muted">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

/** The collapsed rail. Every control here is a real, labelled button — the rail
 *  is a narrower sidebar, not a decoration: expanding it, cycling the mode
 *  filter, toggling RC and finished, and starting a session all work without
 *  ever widening it. */
function Rail({ count, onExpand }: { count: number; onExpand: () => void }) {
  const { sessions } = useFleet();
  const [controls, setControls] = useUiControls();
  const counts = useMemo(
    () =>
      modeCounts(sessions ?? [], {
        query: controls.query,
        mode: controls.mode,
        rcOnly: controls.rcOnly,
        includeFinished: controls.includeFinished,
      }),
    [sessions, controls.query, controls.mode, controls.rcOnly, controls.includeFinished],
  );
  const ModeIcon = controls.mode === 'auto' ? Cpu : controls.mode === 'interactive' ? User : Users;
  const nextMode: ModeFilter = controls.mode === 'all' ? 'auto' : controls.mode === 'auto' ? 'interactive' : 'all';

  return (
    <div className="flex flex-col items-center gap-1.5 py-2">
      <RailButton label="Expand the fleet sidebar" onClick={onExpand}>
        <ChevronsRight size={14} />
      </RailButton>
      <Link
        to="/new"
        aria-label="New session"
        title="New session"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-accent bg-accent text-accent-fg hover:bg-accent-strong"
      >
        <Plus size={14} />
      </Link>
      <div className="my-0.5 h-px w-6 bg-border" aria-hidden />
      <RailButton
        label={`Search and filter the fleet (${count} shown) — expands the sidebar`}
        onClick={onExpand}
        badge={count}
      >
        <SlidersHorizontal size={13} />
      </RailButton>
      <RailButton
        label={`Mode filter: ${MODE_LABEL[controls.mode]} (${counts[controls.mode]}) — click for ${MODE_LABEL[nextMode]}`}
        onClick={() => setControls({ mode: nextMode })}
        active={controls.mode !== 'all'}
      >
        <ModeIcon size={13} />
      </RailButton>
      <RailButton
        label={
          controls.rcOnly
            ? 'Showing Remote Control sessions only — click to show all'
            : 'Show only Remote Control sessions'
        }
        onClick={() => setControls({ rcOnly: !controls.rcOnly })}
        active={controls.rcOnly}
      >
        <Radio size={13} />
      </RailButton>
      <RailButton
        label={controls.includeFinished ? 'Hide finished sessions' : 'Include finished sessions'}
        onClick={() => setControls({ includeFinished: !controls.includeFinished })}
        active={controls.includeFinished}
      >
        <Users size={13} />
      </RailButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body (shared by expanded column and drawer)
// ---------------------------------------------------------------------------

function Body({
  groups,
  count,
  total,
  activeId,
  autoFocusSearch,
  onNavigate,
}: {
  groups: SessionGroup[];
  count: number;
  total: number;
  activeId?: string;
  autoFocusSearch?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="shrink-0 border-b border-border-soft px-2 pb-2">
        <Controls autoFocusSearch={autoFocusSearch} />
      </div>
      {/* THE ONE SCROLLER. A sibling of the main pane's, never nested in it. */}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {groups.length === 0 ? (
          <p className="px-2 py-4 text-[12px] text-muted">
            {total === 0 ? 'No sessions yet.' : 'No sessions match these filters.'}
          </p>
        ) : (
          <div className="space-y-1 py-1">
            {groups.map(g => (
              <GroupBlock key={g.path || g.name} group={g} activeId={activeId} onNavigate={onNavigate} />
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border-soft px-2 py-1.5">
        <Link
          to="/new"
          onClick={onNavigate}
          className="inline-flex items-center gap-1 rounded-md border border-accent bg-accent px-2 py-1 text-[12px] font-semibold text-accent-fg hover:bg-accent-strong"
        >
          <Plus size={12} /> New session
        </Link>
        <span className="mono ml-auto shrink-0 text-[10.5px] text-faint" title="shown / total sessions">
          {count}/{total}
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface AgentSidebarProps {
  /** The session route currently on screen, if any — gets the active marker. */
  activeId?: string;
  /** Drawer visibility (mobile only). Owned by the shell so the AppBar's
   *  trigger and the drawer's own close button drive one piece of state. */
  drawerOpen: boolean;
  onCloseDrawer: () => void;
}

export function AgentSidebar({ activeId, drawerOpen, onCloseDrawer }: AgentSidebarProps) {
  const { sessions, projects } = useFleet();
  const [controls, setControls] = useUiControls();
  const layout = useLayoutMode();

  const visible = useMemo(
    () =>
      filterSessions(sessions ?? [], {
        query: controls.query,
        mode: controls.mode,
        rcOnly: controls.rcOnly,
        includeFinished: controls.includeFinished,
      }),
    [sessions, controls.query, controls.mode, controls.rcOnly, controls.includeFinished],
  );
  const groups = useMemo(() => groupByProject(visible, projects, true), [visible, projects]);
  const total = sessions?.length ?? 0;

  // Escape closes the drawer, from anywhere inside it.
  useEffect(() => {
    if (layout !== 'drawer' || !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseDrawer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout, drawerOpen, onCloseDrawer]);

  const collapse = useCallback(() => setControls({ sidebarCollapsed: true }), [setControls]);
  const expand = useCallback(() => setControls({ sidebarCollapsed: false }), [setControls]);

  // MOBILE: an overlay drawer. Nothing is rendered in the layout flow at all,
  // so the main pane keeps the full width when the drawer is shut.
  if (layout === 'drawer') {
    if (!drawerOpen) return null;
    return (
      <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Fleet sessions">
        <button
          type="button"
          aria-label="Close the fleet sidebar"
          onClick={onCloseDrawer}
          className="absolute inset-0 bg-scrim"
        />
        <aside
          className={cn(
            'absolute inset-y-0 left-0 flex w-[min(88vw,300px)] flex-col',
            'border-r border-border bg-bg py-2 shadow-lg',
          )}
        >
          <div className="mb-1.5 flex shrink-0 items-center gap-1.5 px-2">
            <Users size={13} className="shrink-0 text-faint" />
            <span className="text-[12.5px] font-semibold">Fleet</span>
            <button
              type="button"
              onClick={onCloseDrawer}
              aria-label="Close the fleet sidebar"
              className="ml-auto rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X size={14} />
            </button>
          </div>
          {/* Focus lands on the search box when the drawer opens, so a keyboard
              user is inside the dialog rather than behind it. */}
          <Body
            groups={groups}
            count={visible.length}
            total={total}
            activeId={activeId}
            autoFocusSearch
            onNavigate={onCloseDrawer}
          />
        </aside>
      </div>
    );
  }

  // A rail is FORCED below 1100px and CHOSEN above it. The preference is only
  // read in `full`, so a narrow window never overwrites it.
  const railed = layout === 'rail' || controls.sidebarCollapsed;

  if (railed) {
    return (
      <nav aria-label="Fleet sessions" className={cn('flex shrink-0 flex-col border-r border-border bg-bg', RAIL_W)}>
        <Rail count={visible.length} onExpand={expand} />
      </nav>
    );
  }

  return (
    <nav
      aria-label="Fleet sessions"
      className={cn('flex min-h-0 shrink-0 flex-col border-r border-border bg-bg pt-2', EXPANDED_W)}
    >
      <div className="mb-1.5 flex shrink-0 items-center gap-1.5 px-2">
        <Users size={13} className="shrink-0 text-faint" />
        <span className="text-[12.5px] font-semibold">Fleet</span>
        <button
          type="button"
          onClick={collapse}
          aria-label="Collapse the fleet sidebar to an icon rail"
          title="Collapse to an icon rail"
          className="ml-auto rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"
        >
          <ChevronsLeft size={14} />
        </button>
      </div>
      <Body groups={groups} count={visible.length} total={total} activeId={activeId} />
    </nav>
  );
}

/** The AppBar's drawer trigger. Rendered only where the sidebar is a drawer;
 *  the rail and the expanded column carry their own affordances. */
export function SidebarDrawerTrigger({ onOpen }: { onOpen: () => void }) {
  const layout: LayoutMode = useLayoutMode();
  const { sessions } = useFleet();
  if (layout !== 'drawer') return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open the fleet sidebar"
      title="Open the fleet sidebar"
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11.5px] text-muted hover:border-accent-border hover:text-fg"
    >
      <Users size={12} />
      <span className="mono">{sessions?.length ?? 0}</span>
    </button>
  );
}
