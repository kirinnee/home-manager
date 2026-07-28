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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  CircleAlert,
  ChevronsLeft,
  ChevronsRight,
  Cpu,
  FolderGit2,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  Search,
  ServerCog,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  StopCircle,
  User,
  Users,
  X,
} from 'lucide-react';
import type { SessionView } from '../types';
import { api, ApiError, HAS_TOKEN } from '../lib/api';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { sessionActionSpecs, type SessionAction } from '../lib/session-actions';
import { RenameSheet } from './RenameSheet';
import { MigrateSheet } from './MigrateSheet';
import { displayCallsign } from '../lib/callsign';
import { Link } from '../lib/router';
import { cn } from '../lib/utils';
import { filterSessions, groupByProject, modeCounts, type SessionGroup } from '../lib/grouping';
import {
  buildLineage,
  lineageIndent,
  lineageLabel,
  MAX_INDENT_DEPTH,
  nestByLineage,
  parentDisplay,
  type LineageIndex,
  type NestedRow,
} from '../lib/lineage';
import { useFleet, useStore, useUiControls, type ModeFilter } from '../lib/store';
import { enterProjectScope, readProjectScope } from '../hooks/useProjectScope';
import { StatusMark, statusMark } from './StatusMark';
import { TaskName } from './TaskName';
import { MODE_HINT } from './ModeBadge';
import { useLayoutMode, type LayoutMode } from '../hooks/useLayoutMode';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useInputModality } from '../hooks/useInputModality';
import { usePullToSearch } from '../hooks/usePullToSearch';
import { requestSearchFocus, subscribeSearchFocus } from '../lib/search-focus';
import { useNeedsYouCount } from '../hooks/useNeedsYou';

/** Expanded width. Wide enough for a task line and a teammate name, narrow
 *  enough that the transcript beside it still reads comfortably at 1280px. */
const EXPANDED_W = 'w-[248px]';
/** Icon rail: one column of 28px controls plus padding. */
const RAIL_W = 'w-[52px]';

// ---------------------------------------------------------------------------
// Session-row context menu — the shared ContextMenu, reached two ways.
//
// A session row is a nav `<a>`, NOT selectable prose, so a long-press here is
// free to open a menu (unlike the transcript, where long-press IS selection).
// Desktop opens on the native `contextmenu` (right-click); touch opens on a held
// press — plus Android, which also fires `contextmenu` on a long-press, so both
// paths share one opener and a click-suppression window stops the ensuing tap
// from ALSO navigating into the session.
// ---------------------------------------------------------------------------

/** How long a finger must dwell before the row menu opens. */
const LONG_PRESS_MS = 500;
/** A press that drifts more than this is a scroll, not a long-press — cancel. */
const MOVE_CANCEL_PX = 10;
/** After the menu opens from a press, swallow the click that the same gesture
 *  fires so it does not navigate into the session underneath the menu. */
const CLICK_SUPPRESS_MS = 700;

export type OpenSessionMenu = (view: SessionView, x: number, y: number, trigger: HTMLElement) => void;

const ACTION_ICON: Record<SessionAction, React.ReactNode> = {
  interrupt: <Pause size={13} aria-hidden="true" />,
  stop: <StopCircle size={13} aria-hidden="true" />,
  resume: <Play size={13} aria-hidden="true" />,
  rename: <Pencil size={13} aria-hidden="true" />,
  migrate: <ServerCog size={13} aria-hidden="true" />,
};

/** Row gesture handlers for the context menu, or `undefined` when the row has no
 *  actions to offer (a read-only origin) — in which case the browser's own menu
 *  is left completely alone. A mouse uses right-click (`contextmenu`); touch uses
 *  a dwell timer that a scroll (a move past the threshold) cancels. */
function useRowContextGesture(open: OpenSessionMenu | undefined, view: SessionView) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startAt = useRef<{ x: number; y: number } | null>(null);
  const triggerEl = useRef<HTMLElement | null>(null);
  const firedAt = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    startAt.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  if (!open) return undefined;

  const fire = (x: number, y: number, trigger: HTMLElement) => {
    firedAt.current = performance.now();
    open(view, x, y, trigger);
  };

  return {
    // Right-click (mouse) and Android's long-press both arrive here.
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      cancel();
      fire(event.clientX, event.clientY, event.currentTarget);
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      // A mouse has right-click; only touch/pen need the dwell timer.
      if (event.pointerType === 'mouse') return;
      const trigger = event.currentTarget;
      const px = event.clientX;
      const py = event.clientY;
      startAt.current = { x: px, y: py };
      triggerEl.current = trigger;
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        if (startAt.current && triggerEl.current) fire(px, py, triggerEl.current);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const s = startAt.current;
      if (!s) return;
      if (Math.abs(event.clientX - s.x) > MOVE_CANCEL_PX || Math.abs(event.clientY - s.y) > MOVE_CANCEL_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // Swallow the click that a just-fired long-press produces, so it cannot
    // navigate into the session while the menu is open over it.
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
      if (performance.now() - firedAt.current < CLICK_SUPPRESS_MS) {
        event.preventDefault();
        event.stopPropagation();
        firedAt.current = 0;
      }
    },
  };
}

/** The menu + Rename/Migrate sheets for the whole sidebar, hosted once. Rows ask
 *  it to open via {@link OpenSessionMenu}; it rebuilds the actions for the picked
 *  session and runs them through the EXISTING paths — api.interrupt/stop/resume
 *  and the Rename/Migrate sheets, whose own confirmations it never bypasses. */
function SessionRowMenuLayer({
  state,
  onClose,
  triggerRef,
  touch,
  renameView,
  migrateView,
  onRename,
  onMigrate,
  onRun,
}: {
  state: { view: SessionView; x: number; y: number } | null;
  onClose: () => void;
  triggerRef: { current: HTMLElement | null };
  touch: boolean;
  renameView: SessionView | null;
  migrateView: SessionView | null;
  onRename: (view: SessionView | null) => void;
  onMigrate: (view: SessionView | null) => void;
  onRun: (view: SessionView, action: SessionAction) => void;
}) {
  const items: ContextMenuItem[] = state
    ? sessionActionSpecs(state.view, HAS_TOKEN).map(spec => ({
        key: spec.action,
        label: spec.label,
        danger: spec.danger,
        icon: ACTION_ICON[spec.action],
        onSelect: () => {
          if (spec.action === 'rename') onRename(state.view);
          else if (spec.action === 'migrate') onMigrate(state.view);
          else onRun(state.view, spec.action);
        },
      }))
    : [];

  return (
    <>
      <ContextMenu
        open={state !== null && items.length > 0}
        anchor={state ? { x: state.x, y: state.y } : { x: 0, y: 0 }}
        items={items}
        onClose={onClose}
        ariaLabel={
          state
            ? `Actions for ${displayCallsign(state.view.config.teammate) || state.view.config.name || state.view.config.id}`
            : 'Session actions'
        }
        triggerRef={triggerRef}
        touch={touch}
      />
      {renameView && <RenameSheet view={renameView} open onClose={() => onRename(null)} />}
      {migrateView && <MigrateSheet view={migrateView} open onClose={() => onMigrate(null)} />}
    </>
  );
}

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
    <div
      className="flex rounded-control border border-border bg-surface p-0.5"
      role="group"
      aria-label="Filter by mode"
    >
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
          // `.kt-tab` + the `aria-pressed` already on this button: the selected
          // treatment is now the family's (pill in Ember, notched mono caps in
          // Mission, hard block in Neo) instead of a hardcoded `bg-surface-2`.
          //
          // `!px-xs` is deliberate and is the ONE override here. `.kt-tab`'s
          // `--pad-control-x` is a toolbar figure (10-14px); three of these
          // segments share a 248px column, so at 14px a side "Interactive"
          // truncates to two characters. `--gap-xs` keeps the padding themed
          // while leaving the label readable, and `!` is required because the
          // structural classes are emitted after Tailwind's utilities.
          className="kt-tab min-w-0 flex-1 justify-center !px-xs"
        >
          {m === 'auto' && <Cpu size={10} className="shrink-0" />}
          {m === 'interactive' && <User size={10} className="shrink-0" />}
          <span className="truncate">{MODE_LABEL[m]}</span>
          <span className="mono shrink-0 text-2xs text-faint">{counts[m]}</span>
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

  // Pull-down-to-search (touch drawer) focuses the box through this signal. That
  // DOES summon the keyboard — deliberately, because a pull is an explicit user
  // gesture, unlike the drawer merely opening (which stays keyboard-free).
  useEffect(() => subscribeSearchFocus(() => inputRef.current?.focus()), []);

  return (
    <div className="flex flex-col gap-sm">
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
          // `.kt-input` brings the themed edge (`--border-strong`, ≥3:1), radius,
          // focus ring AND `--text-input`, which themes.css floors at 16px under
          // `(max-width: 640px)` — the hardcoded 12.5px made iOS zoom the whole
          // drawer every time this box was focused.
          //
          // The two `!` overrides are the icon gutters: `.kt-input` sets
          // `padding` as a shorthand, so `pl-7`/`pr-7` cannot win on source order
          // alone. Vertical padding stays themed.
          className="kt-input !pl-7 !pr-7"
        />
        {controls.query && (
          <button
            type="button"
            onClick={() => {
              setControls({ query: '' });
              store.clearSearch();
            }}
            aria-label="Clear search"
            className="absolute right-1.5 rounded-control p-0.5 text-faint hover:text-fg"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <ModeSegment value={controls.mode} counts={counts} onChange={m => setControls({ mode: m })} />

      <div className="flex items-center gap-sm">
        <button
          type="button"
          onClick={() => setControls({ rcOnly: !controls.rcOnly })}
          aria-pressed={controls.rcOnly}
          title="only sessions launched with Remote Control (steerable from claude.ai / your phone)"
          // STATE SITE 1 of 2. The pressed edge was `--accent-border`, which
          // measures 1.2-2.9:1 on surface in 6 of 10 themes; `.kt-tab
          // [aria-pressed='true']` draws it in `--accent` (≥4.5:1 in all ten)
          // and takes the whole selected treatment with it. Contract §8.2(b).
          className="kt-tab shrink-0"
        >
          <Radio size={10} />
          rc only
        </button>
        <label className="inline-flex cursor-pointer items-center gap-sm text-meta text-fg-soft">
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

function parentTrail(
  view: SessionView,
  byId: ReadonlyMap<string, SessionView>,
): { text: string; full: string } | undefined {
  const names: string[] = [];
  const fullNames: string[] = [];
  const seen = new Set<string>([view.config.id]);
  let parentId = view.config.parent?.trim();
  while (parentId && !seen.has(parentId) && names.length <= byId.size) {
    seen.add(parentId);
    const parent = parentDisplay(parentId, byId);
    if (!parent) break;
    if (parent.kind === 'resolved') {
      const label = lineageLabel(parent.view);
      names.unshift(label.text);
      fullNames.unshift(label.full);
    } else {
      names.unshift(parent.shortId);
      fullNames.unshift(parentId);
    }
    parentId = parent.kind === 'resolved' ? parent.view.config.parent?.trim() : undefined;
  }
  const text = names.join(' → ');
  return text ? { text, full: fullNames.join(' → ') } : undefined;
}

/** Exported for static-markup coverage of the sidebar's visible and
 * screen-reader lineage contract. */
export function SidebarRow({
  row,
  active,
  activeId,
  byId,
  onNavigate,
  onOpenSessionMenu,
}: {
  row: NestedRow;
  active: boolean;
  activeId?: string;
  byId: ReadonlyMap<string, SessionView>;
  /** Drawer only: picking a session has to shut the overlay covering it. */
  onNavigate?: () => void;
  /** Right-click / long-press a row to open its action menu. Absent in the
   *  static-markup tests and on a read-only origin. */
  onOpenSessionMenu?: OpenSessionMenu;
}) {
  const { view, depth, children, spawnedBy } = row;
  // Only wire the gesture when there is something to offer, so a read-only
  // origin leaves the browser's own context menu untouched.
  const gesture = useRowContextGesture(
    onOpenSessionMenu && sessionActionSpecs(view, HAS_TOKEN).length > 0 ? onOpenSessionMenu : undefined,
    view,
  );
  const cfg = view.config;
  const mark = statusMark(view);
  const label = lineageLabel(view);
  const parent = parentDisplay(cfg.parent, byId);
  const parentId = cfg.parent?.trim();
  const parentLabel = parent?.kind === 'resolved' ? lineageLabel(parent.view) : undefined;
  const parentFull =
    parentLabel?.full ??
    (parent?.kind === 'missing'
      ? `${parent.shortId}${parentId && parentId !== parent.shortId ? ` · ${parentId}` : ''}`
      : undefined);
  const spawnedByFull = parentFull ? `spawned by ${parentFull}` : undefined;
  const deepChain = depth > MAX_INDENT_DEPTH ? parentTrail(view, byId) : undefined;
  const deepTitle = deepChain ? `spawned by ${deepChain.full}` : undefined;
  const lineageText = [spawnedByFull, deepChain && `full lineage: ${deepChain.full}`].filter(Boolean).join('; ');
  const childDepth = children[0]?.depth ?? depth;
  const railIndent = Math.max(0, lineageIndent(childDepth) - lineageIndent(depth));
  const labels = (cfg.label ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const needsYouCount = useNeedsYouCount(cfg.id);

  return (
    <li>
      <Link
        to={`/session/${encodeURIComponent(cfg.id)}`}
        // `aria-current="page"` is how a screen reader is told which of a list of
        // links is the one you are on; the left rail and surface are the same
        // fact for everyone else.
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
        {...gesture}
        title={[label.full, mark.label, spawnedBy && spawnedByFull, deepTitle].filter(Boolean).join('\n')}
        // `.kt-navrow` keys its active treatment off `aria-current="page"` — the
        // attribute this row already had — so the hand-rolled `border-l-2` rail
        // is gone and the family draws its own: 2px inset in Studio, 4px glowing
        // in Mission, 4px hard in Neo, 3px in Ember, 4px in High Contrast. Row
        // height, padding, radius and type size come with it.
        className="kt-navrow group"
      >
        {/* ONE child, because `.kt-navrow` is a centred flex row: the two text
            lines stack inside it rather than sitting side by side. */}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-sm">
            {deepTitle && (
              <span aria-hidden="true" title={deepTitle} className="shrink-0 text-faint">
                »
              </span>
            )}
            <StatusMark view={view} />
            <TaskName
              name={cfg.name}
              teammate={cfg.teammate}
              size="sm"
              className={cn('min-w-0 flex-1', active && 'text-accent')}
            />
            {needsYouCount > 0 && (
              <span
                aria-label={`${needsYouCount} unresolved needs-you ${needsYouCount === 1 ? 'item' : 'items'}`}
                title={`${needsYouCount} unresolved needs-you ${needsYouCount === 1 ? 'item' : 'items'}`}
                className="mono inline-flex shrink-0 items-center gap-[3px] rounded-full border border-warn/40 bg-warn/10 px-1.5 text-2xs font-semibold text-warn"
              >
                <CircleAlert size={10} aria-hidden="true" />
                <span aria-hidden="true">{needsYouCount > 99 ? '99+' : needsYouCount}</span>
              </span>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-xs pl-3.5">
            <span className={cn('mono min-w-0 truncate text-meta', active ? 'text-accent' : 'text-muted')}>
              {displayCallsign(cfg.teammate) || cfg.id}
            </span>
            {labels.map(l => (
              <span
                key={l}
                className="shrink-0 rounded-badge border border-border-soft bg-surface-2 px-xs text-2xs text-muted"
              >
                {l}
              </span>
            ))}
          </div>
          {lineageText && <span className="sr-only"> — {lineageText}</span>}
        </div>
      </Link>
      {children.length > 0 && (
        /* The rail is on the child list, not a padded nav row: one border now
            spans every adjacent child (and its nested descendants) continuously. */
        <ul
          className={cn('m-0 list-none p-0', railIndent > 0 && 'border-l border-border-soft')}
          style={railIndent > 0 ? { marginLeft: `${railIndent - 1}px` } : undefined}
        >
          {children.map(child => (
            <SidebarRow
              key={child.view.config.id}
              row={child}
              active={child.view.config.id === activeId}
              activeId={activeId}
              byId={byId}
              onNavigate={onNavigate}
              onOpenSessionMenu={onOpenSessionMenu}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Pin the focused folder first without disturbing the activity order of the
 *  rest. A filtered-out scope simply isn't present and nothing is pinned.
 *  Exported pure so the pin contract is asserted without a store or a render. */
export function pinScopedFirst(groups: SessionGroup[], scope: string | null): SessionGroup[] {
  if (scope === null) return groups;
  const idx = groups.findIndex(x => x.path === scope);
  if (idx <= 0) return groups;
  return [groups[idx]!, ...groups.slice(0, idx), ...groups.slice(idx + 1)];
}

/** Exported for static-markup coverage of the folder-scope header contract. */
export function GroupBlock({
  group,
  lineage,
  byId,
  activeId,
  scoped,
  coarse,
  onFocus,
  onNavigate,
  onOpenSessionMenu,
}: {
  group: SessionGroup;
  lineage: LineageIndex;
  byId: ReadonlyMap<string, SessionView>;
  activeId?: string;
  /** This group is the active folder scope: pinned first + accent + aria-current. */
  scoped?: boolean;
  /** Drawer/touch context: the header button takes the 44px touch floor. */
  coarse?: boolean;
  /** Focus this folder (folder mode). */
  onFocus: (path: string) => void;
  onNavigate?: () => void;
  onOpenSessionMenu?: OpenSessionMenu;
}) {
  const rows = useMemo(() => nestByLineage(group.rows, lineage), [group.rows, lineage]);

  return (
    <section>
      {/* Sticky, and OPAQUE (`bg-bg`, no alpha): rows scroll under it, and a
          translucent header over a dense list is unreadable in every theme.
          `aria-current="true"` marks the focused folder for a screen reader; the
          accent treatment is the same fact for everyone else. */}
      <h3
        className="sticky top-0 z-10 flex min-w-0 items-center gap-sm bg-bg px-cell-x py-row-y"
        aria-current={scoped ? 'true' : undefined}
      >
        {/* The icon+name is the fold-in entry point — a real button that focuses
            the folder, and in the drawer also closes the overlay (row parity). */}
        <button
          type="button"
          onClick={() => {
            onFocus(group.path);
            onNavigate?.();
          }}
          aria-label={`Focus folder ${group.name}`}
          title={`Focus folder ${group.name}`}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-sm rounded-control text-left hover:bg-surface-2',
            coarse && 'min-h-[44px]',
            scoped && 'text-accent',
          )}
        >
          <FolderGit2 size={11} className={cn('shrink-0', scoped ? 'text-accent' : 'text-faint')} />
          {/* Section heads are the canonical `.kt-label` site: Ember renders these
              as small caps, Mission as 0.14em mono caps, Neo at 800. */}
          <span className="kt-label min-w-0 truncate">{group.name}</span>
        </button>
        <span className="mono ml-auto shrink-0 text-2xs text-faint">{group.rows.length}</span>
      </h3>
      <ul className="m-0 list-none p-0">
        {rows.map(row => (
          <SidebarRow
            key={row.view.config.id}
            row={row}
            active={row.view.config.id === activeId}
            activeId={activeId}
            byId={byId}
            onNavigate={onNavigate}
            onOpenSessionMenu={onOpenSessionMenu}
          />
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
    // The badge is a SIBLING of the button, not a child, and the wrapper is what
    // it is positioned against. `.kt-btn` resolves `clip-path` to Mission's
    // `notch(6px)`, and clip-path clips descendants — nested, the count bubble
    // would have had its corner sliced off in exactly one family.
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        title={label}
        // STATE SITE 2 of 2. `.kt-btn` so the rail carries the family silhouette
        // the rest of the app's buttons do — including High Contrast's permanent
        // `--outline-always`, which a bare tab would have dropped — and the
        // pressed edge moves from `--accent-border` to `--accent` (contract
        // §8.2(b)).
        //
        // The `!` prefixes are load-bearing: `.kt-btn` is emitted after
        // Tailwind's utilities, so its `border`/`background`/`color` shorthands
        // beat a same-specificity utility on source order. `!px-0` +
        // `aspect-square` keep the button square at whatever `--control-h` the
        // family asks for (26px Mission → 34px High Contrast → 44px on a coarse
        // pointer) instead of pinning it to 28px.
        className={cn(
          'kt-btn aspect-square justify-center !px-0',
          active && '!border-accent !bg-accent-soft !text-accent',
        )}
      >
        {children}
      </button>
      {badge != null && badge > 0 && (
        // NOT `.kt-badge`: that class carries the `pend` tone, and this is a
        // neutral count bubble. It stays deliberately round — same reasoning as
        // StatusMark, shape is the signal at this size.
        //
        // `aria-hidden` because the count is already spoken as part of the
        // button's `aria-label`; `pointer-events-none` because, now that it is
        // outside the button, a click landing on it would otherwise miss.
        <span
          aria-hidden
          className="mono pointer-events-none absolute -bottom-1 -right-1 rounded-full border border-border bg-surface px-1 text-2xs leading-[1.3] text-muted"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </span>
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
    <div className="flex flex-col items-center gap-sm py-2">
      <RailButton label="Expand the fleet sidebar" onClick={onExpand}>
        <ChevronsRight size={14} />
      </RailButton>
      <Link
        to="/new"
        aria-label="New session"
        title="New session"
        data-variant="primary"
        className="kt-btn aspect-square justify-center !px-0"
      >
        <Plus size={14} />
      </Link>
      <Link
        to="/warden"
        aria-label="Open Warden"
        title="Warden"
        className="kt-btn h-[44px] w-[44px] justify-center !px-0"
      >
        <ShieldCheck size={14} />
      </Link>
      <Link
        to="/settings"
        aria-label="Open settings"
        title="Settings"
        className="kt-btn h-[44px] w-[44px] justify-center !px-0"
      >
        <Settings size={14} />
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

/** Drawer-width destination tabs. They stay inside the deliberate fleet
 * drawer instead of taking two permanent slots in the phone's top bar. */
function NarrowDestinations({ onNavigate }: { onNavigate: () => void }) {
  const store = useStore();
  const openSettings = () => {
    onNavigate();
    requestAnimationFrame(() => store.openSettings());
  };
  return (
    <nav
      aria-label="Destinations"
      className="grid shrink-0 grid-cols-2 gap-sm border-b border-border-soft px-cell-x pb-2"
    >
      <Link to="/warden" onClick={onNavigate} className="kt-btn min-h-[44px] justify-center gap-xs">
        <ShieldCheck size={14} aria-hidden="true" />
        Warden
      </Link>
      <button type="button" onClick={openSettings} className="kt-btn min-h-[44px] justify-center gap-xs">
        <Settings size={14} aria-hidden="true" />
        Settings
      </button>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Body (shared by expanded column and drawer)
// ---------------------------------------------------------------------------

function Body({
  groups,
  count,
  total,
  lineage,
  byId,
  activeId,
  scope,
  coarse,
  onFocus,
  autoFocusSearch,
  onNavigate,
  onOpenSessionMenu,
}: {
  groups: SessionGroup[];
  count: number;
  total: number;
  lineage: LineageIndex;
  byId: ReadonlyMap<string, SessionView>;
  activeId?: string;
  /** The active folder scope key (folder mode), or null. */
  scope: string | null;
  /** Drawer/touch context, forwarded to the folder-header buttons. */
  coarse?: boolean;
  onFocus: (path: string) => void;
  autoFocusSearch?: boolean;
  onNavigate?: () => void;
  onOpenSessionMenu?: OpenSessionMenu;
}) {
  // PULL-DOWN TO SEARCH — touch drawer only (`coarse`). Attached to THIS list
  // scroller; on the expanded desktop column the gesture is disabled (the search
  // box is already right there and there is no keyboard to summon).
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pull = usePullToSearch(scrollerRef, { enabled: !!coarse, onTrigger: requestSearchFocus });

  return (
    <>
      <div className="shrink-0 border-b border-border-soft px-cell-x pb-2">
        <Controls autoFocusSearch={autoFocusSearch} />
      </div>
      {/* THE ONE SCROLLER, wrapped so the pull indicator can overlay its top
          without joining the scroll flow. A sibling of the main pane's scroller,
          never nested in it. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {coarse && pull.distance > 0 && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-xs overflow-hidden text-meta text-muted"
            style={{ height: Math.min(pull.distance * 0.5, 40), opacity: pull.progress }}
          >
            <ArrowDown size={13} className={cn('transition-transform', pull.armed && 'rotate-180 text-accent')} />
            <span className={cn(pull.armed && 'text-accent')}>
              {pull.armed ? 'Release to search' : 'Pull to search'}
            </span>
          </div>
        )}
        {/* `overscroll-contain`: a pull at the top must not chain to the page and
            trigger the browser's own pull-to-refresh. */}
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin">
          {groups.length === 0 ? (
            <p className="px-cell-x py-4 text-cell text-muted">
              {total === 0 ? 'No sessions yet.' : 'No sessions match these filters.'}
            </p>
          ) : (
            <div className="space-y-1 py-1">
              {groups.map(g => (
                <GroupBlock
                  key={g.path || g.name}
                  group={g}
                  lineage={lineage}
                  byId={byId}
                  activeId={activeId}
                  scoped={scope !== null && g.path === scope}
                  coarse={coarse}
                  onFocus={onFocus}
                  onNavigate={onNavigate}
                  onOpenSessionMenu={onOpenSessionMenu}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-sm border-t border-border-soft px-cell-x py-row-y">
        <Link to="/new" onClick={onNavigate} data-variant="primary" className="kt-btn">
          <Plus size={12} /> New session
        </Link>
        <span className="mono ml-auto shrink-0 text-2xs text-faint" title="shown / total sessions">
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

/**
 * A touch drawer must not invoke the software keyboard merely by opening. The
 * dialog focus hook already gives the container a stable, non-text landing
 * point; desktop keeps the search-first flow it has always had.
 *
 * Kept as a small pure policy so both focus sites change together and the
 * touch/desktop contract stays directly testable without a browser harness.
 */
export function drawerFocusPolicy(touchAffected: boolean): {
  dialogAutoFocus: boolean;
  searchAutoFocus: boolean;
} {
  return {
    dialogAutoFocus: touchAffected,
    searchAutoFocus: !touchAffected,
  };
}

export function AgentSidebar({ activeId, drawerOpen, onCloseDrawer }: AgentSidebarProps) {
  const { sessions, projects, byId } = useFleet();
  const store = useStore();
  const [controls, setControls] = useUiControls();
  const layout = useLayoutMode();
  const { touchAffected } = useInputModality();

  // FOLDER MODE. The sidebar stays WHOLE-FLEET (it is the only cross-project
  // navigation surface, so scoping it would hide the very rows the drawer exists
  // to reach). It only PINS the focused folder first and marks it — the dashboard
  // is what narrows. Reading the scope from the store keeps sidebar and dashboard
  // from ever drifting.
  const scope = readProjectScope(controls);
  const onFocus = useCallback((path: string) => enterProjectScope(store, path), [store]);

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
  const groups = useMemo(
    () => pinScopedFirst(groupByProject(visible, projects, true), scope),
    [visible, projects, scope],
  );
  const lineage = useMemo(() => buildLineage(sessions ?? []), [sessions]);
  const total = sessions?.length ?? 0;

  // SESSION-ROW CONTEXT MENU. Hosted once here (not per row) so heavy sheets
  // mount at most one at a time. Rows call `openSessionMenu`; the layer rebuilds
  // the actions and drives the existing paths.
  const [rowMenu, setRowMenu] = useState<{ view: SessionView; x: number; y: number } | null>(null);
  const [renameView, setRenameView] = useState<SessionView | null>(null);
  const [migrateView, setMigrateView] = useState<SessionView | null>(null);
  const rowMenuTrigger = useRef<HTMLElement | null>(null);

  const openSessionMenu = useCallback<OpenSessionMenu>((view, x, y, trigger) => {
    rowMenuTrigger.current = trigger;
    setRowMenu({ view, x, y });
  }, []);
  const closeSessionMenu = useCallback(() => setRowMenu(null), []);

  // Interrupt / Stop / Resume reuse the same api + store.upsertSession path the
  // header controls use; a failure surfaces plainly rather than vanishing.
  const runSessionAction = useCallback(
    (view: SessionView, action: SessionAction) => {
      const id = view.config.id;
      const settle = (p: Promise<SessionView>) =>
        void p
          .then(next => store.upsertSession(next))
          .catch(error => {
            if (typeof window !== 'undefined') window.alert(error instanceof ApiError ? error.message : String(error));
          });
      if (action === 'interrupt') settle(api.interrupt(id));
      else if (action === 'resume') settle(api.resume(id));
      else if (action === 'stop') {
        const reason =
          typeof window !== 'undefined'
            ? window.prompt('Reason for stopping this session:', 'stopped from browser')
            : null;
        if (reason == null) return;
        settle(api.stop(id, reason.trim() || 'stopped from browser'));
      }
    },
    [store],
  );

  const sessionMenuLayer = (
    <SessionRowMenuLayer
      state={rowMenu}
      onClose={closeSessionMenu}
      triggerRef={rowMenuTrigger}
      touch={touchAffected}
      renameView={renameView}
      migrateView={migrateView}
      onRename={setRenameView}
      onMigrate={setMigrateView}
      onRun={runSessionAction}
    />
  );

  // Escape, focus-in, focus-restore-to-the-trigger and a real Tab trap — the
  // shared modal contract (hooks/useDialogFocus.ts), the same one the session
  // details drawer uses. Touch uses the dialog container as its non-text
  // landing point so opening the drawer never summons the software keyboard;
  // fine pointer + hover retains the established search-first flow.
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const drawerIsOpen = layout === 'drawer' && drawerOpen;

  // THE POLICY IS LATCHED FOR THE LIFE OF ONE OPENING. `useDialogFocus` re-runs
  // its layout effect whenever `autoFocus` changes, and re-running it while the
  // dialog is already open overwrites `restoreTo` with whatever is focused INSIDE
  // the drawer — so a later close-without-navigate would restore focus to a node
  // that is about to unmount instead of the trigger, breaking the restore
  // contract; a false→true flip would additionally yank focus to the container
  // mid-use. Modality can genuinely change while the drawer is open (a
  // convertible switching modes, a mouse attached or detached — a media-query
  // `change`, rare but real), so the value that OPENED the drawer governs it.
  // The ref is only written while the drawer is shut, which makes the write
  // idempotent and safe under StrictMode double-render.
  const latchedTouch = useRef(touchAffected);
  if (!drawerIsOpen) latchedTouch.current = touchAffected;
  const focusPolicy = drawerFocusPolicy(latchedTouch.current);

  const { onKeyDown: onDrawerKeyDown } = useDialogFocus(drawerIsOpen, drawerRef, onCloseDrawer, {
    autoFocus: focusPolicy.dialogAutoFocus,
  });

  const collapse = useCallback(() => setControls({ sidebarCollapsed: true }), [setControls]);
  const expand = useCallback(() => setControls({ sidebarCollapsed: false }), [setControls]);

  // MOBILE: an overlay drawer. Nothing is rendered in the layout flow at all,
  // so the main pane keeps the full width when the drawer is shut.
  if (layout === 'drawer') {
    if (!drawerOpen) return null;
    return (
      <div
        ref={drawerRef}
        onKeyDown={onDrawerKeyDown}
        tabIndex={-1}
        className="kt-overlay fixed inset-0 z-40 md:hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Fleet sessions"
      >
        <button
          type="button"
          aria-label="Close the fleet sidebar"
          onClick={onCloseDrawer}
          className="absolute inset-0 bg-scrim"
        />
        <aside
          className={cn(
            'absolute inset-y-0 left-0 flex w-[min(88vw,300px)] flex-col',
            // `shadow-popover`, not `shadow-lg`: the drawer is one of the three
            // popover surfaces in the contract, so Neo gets a 6px hard offset
            // and High Contrast a 2px ring instead of a blur.
            'border-r border-border bg-bg py-2 shadow-popover',
          )}
        >
          <div className="mb-1.5 flex shrink-0 items-center gap-sm px-cell-x">
            <Users size={13} className="shrink-0 text-faint" />
            <span className="text-ui font-semibold">Fleet</span>
            <button
              type="button"
              onClick={onCloseDrawer}
              aria-label="Close the fleet sidebar"
              className="ml-auto rounded-control p-1 text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X size={14} />
            </button>
          </div>
          <NarrowDestinations onNavigate={onCloseDrawer} />
          {/* Fine pointer + hover keeps the established search-first drawer.
              Coarse touch instead lands on the dialog container above, never
              a text input, so opening cannot summon the software keyboard. */}
          <Body
            groups={groups}
            count={visible.length}
            total={total}
            lineage={lineage}
            byId={byId}
            activeId={activeId}
            scope={scope}
            coarse
            onFocus={onFocus}
            autoFocusSearch={focusPolicy.searchAutoFocus}
            onNavigate={onCloseDrawer}
            onOpenSessionMenu={openSessionMenu}
          />
        </aside>
        {sessionMenuLayer}
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
        {sessionMenuLayer}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Fleet sessions"
      className={cn('flex min-h-0 shrink-0 flex-col border-r border-border bg-bg pt-2', EXPANDED_W)}
    >
      <div className="mb-1.5 flex shrink-0 items-center gap-sm px-cell-x">
        <Users size={13} className="shrink-0 text-faint" />
        <span className="text-ui font-semibold">Fleet</span>
        <button
          type="button"
          onClick={collapse}
          aria-label="Collapse the fleet sidebar to an icon rail"
          title="Collapse to an icon rail"
          className="ml-auto rounded-control p-1 text-muted hover:bg-surface-2 hover:text-fg"
        >
          <ChevronsLeft size={14} />
        </button>
      </div>
      <Body
        groups={groups}
        count={visible.length}
        total={total}
        lineage={lineage}
        byId={byId}
        activeId={activeId}
        scope={scope}
        onFocus={onFocus}
        onOpenSessionMenu={openSessionMenu}
      />
      {sessionMenuLayer}
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
      // The hover edge here stays `--accent-border`: it is decorative tint on a
      // control whose state never depends on it, which §8.2(b) explicitly still
      // permits. Only the two selected states above had to move to `--accent`.
      className="inline-flex shrink-0 items-center gap-xs rounded-control border border-border px-1.5 py-0.5 text-meta text-muted hover:border-accent-border hover:text-fg"
    >
      <Users size={12} />
      <span className="mono">{sessions?.length ?? 0}</span>
    </button>
  );
}
