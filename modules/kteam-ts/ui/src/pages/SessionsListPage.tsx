// Sessions list. Live teammate sessions managed by kteamd, grouped by project.
//  - header: title + count + table/cards switch + New (title is sr-only below
//    `sm`: the app bar crumb already says it)
//  - per-project group: header + table (identity, TASK, status, runtime,
//    activity, signals); at reduced density in cards mode the group renders as
//    ONE panel — hue rail + header + one 44px row per session — with a
//    majority status hoisted into the header (B42)
//
// NO DATA OF ITS OWN (round 5). This page used to fetch the session list, open
// its own fleet WebSocket, and re-GET the ENTIRE list 1.5s after every event —
// including while it was not even the visible route. Sessions, projects and
// live updates now come from the shared store, which holds ONE socket for the
// app and refreshes one session at a time.
//
// NO FILTER CONTROLS OF ITS OWN (round 6). The persistent agent sidebar owns
// the instant query, the All/Auto/Interactive segment, the RC filter and
// "include finished" — one source of truth, rendered once, visible on every
// route. This page still READS those store controls, so the rows on screen are
// exactly what the sidebar says they are; it just no longer offers a second set
// of widgets that could disagree. Transcript search is the same story: the
// sidebar owns the input and the Enter trigger, this page renders the results
// panel from the store and can close it.

import { memo, useMemo, useEffect, useState } from 'react';
import { Bot, Sparkles, Activity, FolderGit2, Folders, Plus, Search, X, LayoutGrid, Rows3 } from 'lucide-react';
import type { SearchResponse, SessionView } from '../types';
import { Badge } from '../components/Primitives';
import { ModeBadge } from '../components/ModeBadge';
import { RcBadge } from '../components/RcBadge';
import { TaskName } from '../components/TaskName';
import { StatusMark, nameToneClass } from '../components/StatusMark';
import { WardenStrip } from '../components/WardenStrip';
import { WardenVerdicts } from '../components/WardenVerdicts';
import { displayCallsign } from '../lib/callsign';
import { Link, navigate } from '../lib/router';
import { TERMINAL_STATUSES, cn, fmtAge, fmtRelative, toneFor } from '../lib/utils';
import { QuotaReadout } from '../components/QuotaBadge';
import { useUsage } from '../hooks/useUsage';
import { quotaFor, type Quota } from '../lib/usage';
import type { UsageAccountView } from '../types';
import { useFleet, useStore, useTranscriptSearch, useUiControls, type Density } from '../lib/store';
import {
  filterSessions,
  groupByProject,
  isScopeResolvable,
  projectKeyFor,
  scopeSessions,
  type SessionGroup,
} from '../lib/grouping';
import { useDensity } from '../hooks/useDensity';
import { enterProjectScope, exitProjectScope, readProjectScope, useProjectScope } from '../hooks/useProjectScope';

// Below this the TABLE cannot fit without a horizontal scrollbar, so the card
// view becomes the default — the one-scroll-region rule means no nested
// scrollbars, and a table narrower than its content is exactly that. (A user who
// explicitly picks table view below this width still gets it, and its scroll.)
function useIsNarrow(bp = 900): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < bp : false));
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < bp);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [bp]);
  return narrow;
}

// TASK rendering (`config.name`, bracket-prefix parsing, em-dash fallback) lives
// in components/TaskName.tsx, and fleet filtering + project grouping live in
// lib/grouping.ts — both shared with the persistent sidebar on purpose. The
// dashboard and the sidebar must answer "which sessions, whose project, what
// task?" identically, and the only way they can disagree is by each keeping its
// own copy of the predicate.

// One-line "what it's doing": the live pane activity when working, else a quiet
// word about the state. TASK has its own column now, so this deliberately no
// longer falls back to `config.name` — that printed the same string twice on
// every row that was not actively working.
function activityLine(v: SessionView): { text: string; live: boolean } {
  // A declared wait outranks the pane: the teammate is parked on purpose and
  // the useful line is WHAT it waits for and until when, not a stale spinner.
  const wait = v.state.waiting;
  if (wait)
    return {
      text: `waiting: ${wait.condition ?? 'external condition'}${wait.until ? ` (until ${new Date(wait.until).toLocaleTimeString()})` : ''}`,
      live: true,
    };
  const act = v.state.activity?.trim();
  if (act) return { text: act, live: !TERMINAL_STATUSES.has(v.state.status) };
  // Nothing live to report. The id is already in the identity cell, so say
  // something about the state instead of repeating it.
  return {
    text: TERMINAL_STATUSES.has(v.state.status) ? 'no activity recorded' : 'awaiting activity',
    live: false,
  };
}

function ActivityLine({ view, className = '' }: { view: SessionView; className?: string }) {
  const { text, live } = activityLine(view);
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-sm ${className}`}>
      <Activity size={11} className={live ? 'shrink-0 text-accent' : 'shrink-0 text-faint'} />
      <span className={live ? 'truncate shimmer' : 'truncate text-muted'} title={text}>
        {text}
      </span>
    </span>
  );
}

// Highlight case-insensitive occurrences of `q` in `text`.
function highlight(text: string, q: string) {
  if (!q) return text;
  const lower = text.toLowerCase();
  const nq = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < text.length) {
    const at = lower.indexOf(nq, i);
    if (at === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (at > i) parts.push(text.slice(i, at));
    parts.push(
      <mark key={n++} className="rounded-badge bg-accent-soft px-0.5 text-accent">
        {text.slice(at, at + q.length)}
      </mark>,
    );
    i = at + q.length;
  }
  return parts;
}

export function SessionsListPage() {
  // Shared cache + one socket for the whole app (lib/store.tsx).
  const { sessions, projects, error } = useFleet();
  const store = useStore();
  // Global persisted controls, OWNED BY THE SIDEBAR. Read-only here except for
  // the table/cards preference, which is a property of this page.
  const [controls, setControls] = useUiControls();
  const { query: filter, mode: modeFilter, rcOnly, includeFinished, dashboardView: viewPref } = controls;
  const { density } = useDensity();
  // FOLDER MODE. `useProjectScope` mounts the deterministic scope machine here —
  // this page stays mounted for the app's life, so its boot + popstate precedence
  // and one-shot missing-folder recovery are live on every route. The active
  // scope is read from the store (never from the URL directly); rendering is a
  // one-way consumer of that value.
  useProjectScope();
  const scope = readProjectScope(controls);
  // The folder's display name, resolved the same way the group would resolve it
  // (registered project name, else the cwd basename) — available even when the
  // scoped-and-filtered list is empty, so the header can still name the folder.
  const scopeName = scope !== null ? projectKeyFor(scope, projects).name : '';
  // Resolvable = the folder still exists in the UNFILTERED fleet (or is a
  // registered project). Unresolvable scopes get the notice + one-shot recovery
  // inside the hook; a resolvable-but-filtered-empty scope is preserved.
  const resolvable = scope === null || sessions === null || isScopeResolvable(scope, sessions, projects);
  // Transcript search results (server-side, triggered from the sidebar) —
  // distinct from the instant client-side list filter below. Store-owned, so
  // the results survive navigating into a hit and back.
  const { searching: tSearching, results: tResults } = useTranscriptSearch();
  // View mode: cards (mobile-friendly) vs table. Auto-defaults to cards on
  // narrow viewports; a desktop user can override.
  const isNarrow = useIsNarrow();
  const mode = viewPref ?? (isNarrow ? 'cards' : 'table');
  // Instant, client-side filter across every identifying field — the SHARED
  // predicate, fed by the sidebar's controls. The output is what this page
  // shows, so the sidebar's counts and this table can never disagree.
  // Scope FIRST (folder mode), then the four instant filters — one predicate,
  // composed, replacing none of the others. `scopeSessions` is identity when
  // unscoped, so this is exactly today's list until a folder is focused.
  const visible = useMemo(
    () =>
      sessions
        ? filterSessions(scopeSessions(sessions, projects, scope), {
            query: filter,
            mode: modeFilter,
            rcOnly,
            includeFinished,
          })
        : [],
    [sessions, projects, scope, filter, includeFinished, modeFilter, rcOnly],
  );

  // Longest-project-path-prefix grouping, cwd basename fallback. `sortRows` is
  // left off: the dashboard keeps the daemon's order (the sidebar is the view
  // that wants most-recently-active first).
  const groups = useMemo(() => groupByProject(visible, projects), [visible, projects]);

  // Tapping a group heading focuses that folder. `enterProjectScope` is
  // store-first then a single history push, so it is deterministic and safe from
  // any route.
  const onFocus = (path: string) => enterProjectScope(store, path);

  // The page is a flex column that fills the shell: a fixed header block and
  // ONE scroller under it. The whole page used to be the scroller, which was
  // fine on its own but inconsistent with the chat route.
  return (
    <div data-density={density} className="flex h-full min-h-0 w-full flex-col pb-2">
      {/* Tighter above the fold on a phone: at 390x844 this toolbar and the app
          bar are the dashboard's whole chrome budget, and 8px of margin at each
          end of it is most of a sixth session row. `sm:` restores the desktop
          rhythm exactly. */}
      {/* When scoped the header must NOT wrap (G10: one row at 360px), so the
          folder name is the only flexible element and everything else is
          shrink-0. Unscoped keeps the original wrapping toolbar untouched. */}
      <div
        className={cn(
          'mt-0.5 mb-1 flex items-center justify-between gap-2 sm:mt-2 sm:mb-2',
          scope === null && 'flex-wrap',
        )}
      >
        {/* `--text-display` / `--weight-display` / `--tracking-display`: Mission
            shouts this in 0.08em caps, Neo at 900, Ember in a serif. */}
        {/* Below `sm` the h1 is screen-reader-only: the app bar's breadcrumb
            already says "Sessions" one row above, and at 390x844 the repeated
            display-size title was the single largest block of chrome between
            the reader and the first session (B42). The heading stays in the
            a11y tree at every width. */}
        {scope === null ? (
          <h1 className="sr-only m-0 font-display text-display font-bold tracking-display sm:not-sr-only">Sessions</h1>
        ) : (
          // SCOPED: [All-folders chip] [FolderGit2 + folder name h1] [(n sessions)].
          // The chip is a real link to `/` (deep-linkable, right-clickable) whose
          // click performs the in-app clear; the name is the h1 and truncates.
          <div className="flex min-w-0 flex-1 items-center gap-sm">
            <a
              href="/"
              onClick={e => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                exitProjectScope(store);
              }}
              aria-label="Show all folders"
              title="Show all folders"
              className="kt-btn min-h-[44px] shrink-0"
            >
              <Folders size={13} /> All folders
            </a>
            <FolderGit2 size={15} className="shrink-0 text-faint" aria-hidden="true" />
            <h1 className="m-0 min-w-0 truncate font-display text-display font-bold tracking-display" title={scopeName}>
              {scopeName}
            </h1>
            <span className="mono shrink-0 text-meta text-faint" aria-live="polite">
              {visible.length} session{visible.length === 1 ? '' : 's'}
            </span>
          </div>
        )}
        {/* On a phone (h1 sr-only) the count anchors the LEFT end of the band
            so the row reads as [count … New session] instead of a dead gutter
            with a floating cluster; `sm:` returns it to the right cluster
            beside the button. Rendered twice, shown once — never both. */}
        {sessions && scope === null && (
          <span className="mono text-meta text-faint sm:hidden" title="visible / total sessions">
            {visible.length}/{sessions.length}
          </span>
        )}
        {/* `ml-auto` keeps this cluster right-aligned when the h1 above is
            sr-only (position:absolute leaves it out of flow, so justify-between
            alone would swing the cluster to the left edge). */}
        <div className="ml-auto flex shrink-0 items-center gap-sm">
          {/* Unscoped: the visible/total subset readout. When scoped, the folder
              name and the scoped count above already tell the story, so it is
              dropped to hold the header to one row at 360px. */}
          {sessions && scope === null && (
            <span className="mono hidden text-meta text-faint sm:inline" title="visible / total sessions">
              {visible.length}/{sessions.length}
            </span>
          )}
          {!isNarrow && (
            // Same shape as ViewTabs: the track keeps its own box, each option is
            // `.kt-tab` and `aria-pressed` — already the accessible truth here —
            // is what the selected treatment keys off. No state class list left.
            <div className="inline-flex shrink-0 rounded-control border border-border bg-surface p-0.5">
              {(['table', 'cards'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setControls({ dashboardView: m })}
                  aria-label={`${m} view`}
                  aria-pressed={mode === m}
                  title={`${m} view`}
                  className="kt-tab"
                >
                  {m === 'table' ? <Rows3 size={12} /> : <LayoutGrid size={12} />}
                  {m}
                </button>
              ))}
            </div>
          )}
          <Link to="/new" data-variant="primary" className="kt-btn">
            <Plus size={13} /> New session
          </Link>
        </div>
      </div>

      <WardenStrip />
      <WardenVerdicts />

      {(tSearching || tResults) && (
        <TranscriptResults
          query={filter}
          searching={tSearching}
          results={tResults}
          onClose={() => store.clearSearch()}
        />
      )}

      {error && (
        <div className="mb-3 rounded-panel border border-err-border bg-err-bg px-panel py-row-y text-row text-err">
          {error}
        </div>
      )}

      <div data-density-region="dashboard-scroller" className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {!sessions && <SkeletonRows />}
        {sessions && visible.length === 0 && (
          <div className="rounded-panel border border-dashed border-border bg-surface-2 px-4 py-10 text-center text-muted">
            {scope === null
              ? 'No matching sessions.'
              : !resolvable
                ? 'That folder is no longer available — showing the whole fleet.'
                : 'No sessions in this folder match the filters.'}
          </div>
        )}

        {/* When scoped there is a single group and the page header already names
            the folder, so the per-group heading is suppressed to avoid saying it
            twice. Unscoped, each heading is the tap-to-focus entry point. */}
        {density === 'full' ? (
          <FullDensityGroups groups={groups} mode={mode} scoped={scope !== null} onFocus={onFocus} />
        ) : (
          <LeanDensityGroups groups={groups} mode={mode} density={density} scoped={scope !== null} onFocus={onFocus} />
        )}
      </div>
    </div>
  );
}

type DashboardMode = 'cards' | 'table';

export const DENSITY_COLUMN_LABELS: Readonly<Record<Density, readonly string[]>> = {
  full: ['Teammate', 'Task', 'Status', 'Runtime', 'Activity', 'Signals'],
  compact: ['Teammate', 'Task', 'Status'],
  minimal: ['Teammate', 'Task'],
};

// The heading is the dashboard's fold-in entry point: a full-width button that
// focuses the folder it names. The count stays inside the hit area (simpler, and
// the whole row reads as one "focus this folder" affordance).
function ProjectHeading({ group, onFocus }: { group: SessionGroup; onFocus: (path: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onFocus(group.path)}
      aria-label={`Focus folder ${group.name}`}
      title={`Focus folder ${group.name}`}
      // `overflow-hidden` + `min-w-0` on every flexible child: the count used to
      // be sliced off at the right edge of a 390px viewport when the name+path
      // pair refused to shrink (B42 problem 3). Nothing in this row may ever be
      // wider than the page again, whatever the font metrics.
      className="mb-1 flex w-full min-w-0 items-baseline gap-sm overflow-hidden rounded-control px-0.5 text-left hover:bg-surface-2"
    >
      <FolderGit2 size={13} className="shrink-0 translate-y-0.5 text-faint" />
      <span className="min-w-0 truncate text-ui font-semibold text-fg">{group.name}</span>
      {group.path && <span className="mono min-w-0 truncate text-meta text-faint">{group.path}</span>}
      <span className="mono ml-auto shrink-0 pr-1 text-meta text-faint">{group.rows.length}</span>
    </button>
  );
}

/** Full is the only density that subscribes to account usage. Compact and
 * Minimal do not merely hide quota fields: they never mount this component, so
 * the usage hook and quota joins do not run for information the user removed. */
function FullDensityGroups({
  groups,
  mode,
  scoped,
  onFocus,
}: {
  groups: SessionGroup[];
  mode: DashboardMode;
  scoped: boolean;
  onFocus: (path: string) => void;
}) {
  const { index: usage } = useUsage();
  return (
    <div className="space-y-3">
      {groups.map(group => (
        <section key={group.path || group.name}>
          {!scoped && <ProjectHeading group={group} onFocus={onFocus} />}
          {mode === 'cards' ? (
            <div className="grid gap-2.5 sm:gap-1.5">
              {group.rows.map(view => (
                <SessionCard key={view.config.id} view={view} usage={usage} />
              ))}
            </div>
          ) : (
            // SIX columns, `table-fixed`, no min-width and no horizontal
            // scroller. Percentage columns and truncation keep it pane-sized.
            <div className="kt-panel">
              <table className="w-full table-fixed border-collapse">
                <caption className="sr-only">Sessions in {group.name}</caption>
                <thead>
                  <tr>
                    <Th className="w-[16%]">Teammate</Th>
                    <Th className="w-[22%]">Task</Th>
                    <Th className="w-[9%]">Status</Th>
                    <Th className="w-[14%]">Runtime</Th>
                    <Th className="w-[26%]">Activity</Th>
                    <Th className="w-[13%]">Signals</Th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map(view => (
                    <SessionRow key={view.config.id} view={view} usage={usage} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

export function LeanDensityGroups({
  groups,
  mode,
  density,
  scoped,
  onFocus,
}: {
  groups: SessionGroup[];
  mode: DashboardMode;
  density: Exclude<Density, 'full'>;
  scoped: boolean;
  onFocus: (path: string) => void;
}) {
  const columns = DENSITY_COLUMN_LABELS[density];
  const hues = groupHueVars(groups);
  return (
    <div className="space-y-3">
      {groups.map((group, groupIndex) =>
        mode === 'cards' ? (
          // CARDS ARE NOW ROWS IN A GROUP PANEL (B42). Nine free-standing white
          // cards, each carrying the same status pill, read as one monotone
          // slab and paid a border + gap + padding tax per session. The panel
          // carries the group identity ONCE (header + hue rail), the status
          // pill is hoisted when the whole group agrees, and each session
          // shrinks to a single 44px row — same facts, half the height.
          <LeanGroupPanel
            key={group.path || group.name}
            group={group}
            hue={hues[groupIndex]!}
            density={density}
            scoped={scoped}
            onFocus={onFocus}
          />
        ) : (
          <section key={group.path || group.name}>
            {!scoped && <ProjectHeading group={group} onFocus={onFocus} />}
            <div className="kt-panel">
              <table className="w-full table-fixed border-collapse">
                <caption className="sr-only">Sessions in {group.name}</caption>
                <thead>
                  <tr>
                    {columns.map((column, index) => (
                      <Th
                        key={column}
                        className={
                          density === 'minimal'
                            ? index === 0
                              ? 'w-[38%]'
                              : 'w-[62%]'
                            : index === 0
                              ? 'w-[28%]'
                              : index === 1
                                ? 'w-[44%]'
                                : 'w-[28%]'
                        }
                      >
                        {column}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map(view => (
                    <LeanSessionRow key={view.config.id} view={view} density={density} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ),
      )}
    </div>
  );
}

/** Raw status enums ('TOOL_RUNNING', 'AWAITING_USER') were leaking straight
 * into the lean pills — internal identifiers, shouted in caps, spending up to
 * 13 characters per row on a 390px line whose job is to show the TASK TITLE.
 * The pill text is now a short human word; the raw value stays on the pill's
 * `title` for hover, and the tone colours still come from `toneFor(raw)`.
 * 'you' is deliberate for awaiting_user: the pill answers "who is this
 * waiting on?". Unknown statuses degrade to the raw name with underscores
 * unshouted, never to silence. Lean surfaces only — the full-density table
 * and cards have the width for the precise enum and keep it. */
const STATUS_WORDS: Record<string, string> = {
  created: 'new',
  starting: 'start',
  running: 'run',
  thinking: 'think',
  tool_running: 'tool',
  awaiting_question: 'ask',
  awaiting_user: 'you',
  interrupted: 'paused',
  rate_limited: 'limited',
  retrying: 'retry',
  kill_failed: 'zombie',
  waiting: 'wait',
  completed: 'done',
  failed: 'failed',
  stalled: 'stalled',
  stopped: 'stopped',
};
export function statusWord(status: string): string {
  return STATUS_WORDS[status] ?? status.replace(/_/g, ' ');
}

/** The status pill was the loudest element on every card and, in a real fleet,
 * identical across a whole repo group — pure noise (B42 problem 1). When one
 * status holds a strict majority of a group (and at least two rows), it is
 * hoisted into the group header and only the exceptions keep their pill. Ties,
 * pairs of one, and single-row groups hoist nothing: there the pill still
 * varies row to row and IS the signal. Every row keeps its StatusMark shape
 * regardless, so no fact is removed — only the repetition. */
export interface HoistedStatus {
  status: string;
  count: number;
  uniform: boolean;
}
export function hoistedStatus(rows: readonly SessionView[]): HoistedStatus | null {
  if (rows.length < 2) return null;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state.status, (counts.get(row.state.status) ?? 0) + 1);
  let status: string | null = null;
  let count = 0;
  for (const [s, n] of counts) {
    if (n > count) {
      status = s;
      count = n;
    }
  }
  if (!status || count < 2 || count * 2 <= rows.length) return null;
  return { status, count, uniform: count === rows.length };
}

/** The list's second variation axis, independent of status (B42 problem 1):
 * a stable identity hue per repo group, hashed from the group key so `diene`
 * keeps its colour across visits and filters. The hues are the existing
 * `--tool-*` categorical tokens — defined and tuned in every one of the ten
 * themes (High Contrast and Neo included), so no new colour enters the system.
 * The greys (`wait`/`generic`) are excluded; seven distinct hues remain.
 *
 * DECORATIVE ONLY (contract §8.2 spirit): the hue appears as a rail and an
 * icon tint, always redundant with the group NAME beside it, so its contrast
 * is never load-bearing and it carries no state. */
const GROUP_HUES = ['read', 'edit', 'write', 'search', 'patch', 'bash', 'plan'] as const;
function groupHueIndex(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % GROUP_HUES.length;
}
export function groupHueVar(key: string): string {
  return `var(--tool-${GROUP_HUES[groupHueIndex(key)]})`;
}

/** Hue per group for one render of the list, in order. Hashing alone let two
 * ADJACENT groups land on the same hue (observed on the live fleet, first
 * screen: two green rails in a row — the monotony the axis exists to break),
 * so a collision with the group directly above bumps to the next hue. Non-
 * adjacent repeats are fine; only neighbours compete for the eye. */
export function groupHueVars(groups: readonly SessionGroup[]): string[] {
  const out: number[] = [];
  for (const group of groups) {
    let idx = groupHueIndex(group.path || group.name);
    if (out.length > 0 && idx === out[out.length - 1]) idx = (idx + 1) % GROUP_HUES.length;
    out.push(idx);
  }
  return out.map(idx => `var(--tool-${GROUP_HUES[idx]})`);
}

/** One repo group rendered as a single panel: hue rail, tappable header
 * (focus-folder, same affordance as ProjectHeading), then one row per session.
 * Mirrors TranscriptResults' proven shape — `kt-panel overflow-hidden` around
 * a `divide-y` list of full-width interactive rows — so every theme's panel
 * silhouette (Mission's HUD sheet, Neo's hard offset, Ember's seam, High
 * Contrast's plain box) carries the group for free. The header lives INSIDE
 * the panel, with `min-w-0` truncation on every flexible child, so it can
 * never escape the page's horizontal padding again (B42 problem 3). */
function LeanGroupPanel({
  group,
  hue,
  density,
  scoped,
  onFocus,
}: {
  group: SessionGroup;
  /** From groupHueVars — hashed on the group key, de-collided per render. */
  hue: string;
  density: Exclude<Density, 'full'>;
  scoped: boolean;
  onFocus: (path: string) => void;
}) {
  // When scoped the header is suppressed (the page header already names the
  // folder), and with it the hoist: rows keep their own pills rather than
  // pointing at a summary that is not on screen. Minimal density never shows
  // a status WORD anywhere, so it never hoists one either.
  const hoisted = !scoped && density === 'compact' ? hoistedStatus(group.rows) : null;
  return (
    <section className="kt-panel overflow-hidden" style={{ borderLeftWidth: 3, borderLeftColor: hue }}>
      {!scoped && (
        <button
          type="button"
          onClick={() => onFocus(group.path)}
          aria-label={`Focus folder ${group.name}`}
          title={`Focus folder ${group.name}`}
          className="kt-panel__header min-h-[44px] w-full min-w-0 text-left hover:bg-surface-2"
        >
          <FolderGit2 size={13} className="shrink-0" style={{ color: hue }} aria-hidden="true" />
          <span className="min-w-0 truncate text-ui font-semibold text-fg">{group.name}</span>
          {/* The full path is desktop context; at phone widths it duplicated the
              basename beside it and was what pushed the count off the right
              edge. Reduced density means fewer facts — the button's title still
              carries the folder name, and focusing the group shows the path. */}
          {group.path && (
            <span className="mono hidden min-w-0 truncate text-meta text-faint sm:inline">{group.path}</span>
          )}
          {hoisted && (
            <Badge tone={toneFor(hoisted.status)} title={hoisted.status} className="ml-auto shrink-0">
              {hoisted.uniform ? statusWord(hoisted.status) : `${hoisted.count}× ${statusWord(hoisted.status)}`}
            </Badge>
          )}
          <span className={cn('mono shrink-0 text-meta text-faint', !hoisted && 'ml-auto')}>{group.rows.length}</span>
        </button>
      )}
      <div className="divide-y divide-border-soft">
        {group.rows.map(view => (
          <LeanSessionCard
            key={view.config.id}
            view={view}
            density={density}
            statusHoisted={hoisted != null && view.state.status === hoisted.status}
          />
        ))}
      </div>
    </section>
  );
}

function TranscriptResults({
  query,
  searching,
  results,
  onClose,
}: {
  query: string;
  searching: boolean;
  results: SearchResponse | null;
  onClose: () => void;
}) {
  return (
    <div className="kt-panel mb-4 overflow-hidden">
      <div className="kt-panel__header bg-surface-2 text-ui">
        <Search size={14} className="shrink-0 text-faint" />
        <span className="font-medium text-fg-soft">Transcript matches</span>
        {results && (
          <span className="mono text-meta text-faint">
            {results.results.length} in {results.scanned} session{results.scanned === 1 ? '' : 's'} searched
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close transcript results"
          className="ml-auto rounded-control p-1 text-muted hover:bg-surface hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
      {searching ? (
        <div className="px-panel py-4 text-ui text-muted">searching transcripts…</div>
      ) : !results || results.results.length === 0 ? (
        <div className="px-panel py-4 text-ui text-muted">
          No transcript matches for <span className="mono text-fg-soft">{query}</span>.
        </div>
      ) : (
        <ul className="divide-y divide-border-soft">
          {results.results.map((r, i) => (
            <li key={`${r.sessionId}-${i}`}>
              <button
                type="button"
                onClick={() => navigate(`/session/${encodeURIComponent(r.sessionId)}`)}
                className="block w-full px-panel py-row-y text-left hover:bg-surface-2"
              >
                <div className="flex items-center gap-sm text-cell">
                  <span className="font-semibold text-fg">{displayCallsign(r.teammate) || r.sessionId}</span>
                  <span className="mono text-meta text-faint">{r.sessionId}</span>
                  {r.turn != null && <span className="mono text-meta text-faint">turn {r.turn}</span>}
                  <span className="mono ml-auto shrink-0 text-meta text-faint">{r.at ? fmtRelative(r.at) : ''}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-ui leading-snug text-muted">
                  {highlight(r.snippet, query.trim())}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// `scope="col"` is what tells a screen reader that this header labels a COLUMN
// rather than a row — without it a six-column grid is announced as bare cells.
// `.kt-label` owns the casing: shouted uppercase in Studio/Mission/Neo, small
// caps in Ember, and 0.14em mono caps under Mission's `--font-ui: mono`.
function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`kt-label border-b border-border bg-surface-2 px-cell-x py-row-y text-left ${className}`}
    >
      {children}
    </th>
  );
}

// MEMOIZED (round 5). The store patches ONE session's object per event and
// leaves every other object identical, so a memo on the row means a terminal
// frame from one teammate re-renders one row instead of the whole fleet. (The
// usage index is memoized in useUsage for the same reason.)
const SessionRow = memo(function SessionRow({
  view,
  usage,
}: {
  view: SessionView;
  usage: Map<string, UsageAccountView>;
}) {
  const cfg = view.config;
  const state = view.state;
  const quota: Quota | null = quotaFor(view, usage);
  return (
    // `.kt-row` owns the divider, the hover, the row floor (34px Studio, 32px
    // Mission, 44px High Contrast) and — via `.kt-row > td` — the cell padding,
    // cell type size and vertical alignment. The cells below therefore carry
    // LAYOUT only.
    <tr className="kt-row group">
      {/* IDENTITY — who, and its label. The id moves to the second line and the
          label joins it here rather than owning a whole column. */}
      <td>
        <Link to={`/session/${encodeURIComponent(cfg.id)}`} className="block min-w-0" title={cfg.id}>
          <div className="truncate text-row font-semibold text-fg group-hover:text-accent">
            {displayCallsign(cfg.teammate) || cfg.id}
          </div>
          {/* `.kt-chrome` is the app's one recede-at-rest meta tier: a
              contrast-checked ink that brightens when you reach for the row,
              replacing three hand-tuned `text-[11px] text-faint` copies. */}
          <div className="kt-chrome mono flex min-w-0 items-baseline gap-xs">
            <span className="truncate">{cfg.id}</span>
            {cfg.label && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate text-fg-soft" title={cfg.label}>
                  {cfg.label}
                </span>
              </>
            )}
          </div>
        </Link>
      </td>
      {/* TASK — the headline of the row. A real leading `[Bracket]` prefix is
          always rendered as its own chip, including when it repeats the nearby
          teammate: that prefix is part of the raw human title contract. */}
      <td>
        <TaskName name={cfg.name} size="md" className="max-w-full" />
      </td>
      <td>
        <Badge tone={toneFor(state.status)} className="max-w-full truncate">
          {state.status}
        </Badge>
      </td>
      {/* RUNTIME — mode + RC on top, CLI + model underneath. Three columns
          collapsed into one: they answer a single question ("what is this thing
          running as?") and were never read independently. */}
      <td>
        <div className="flex min-w-0 flex-col gap-xs">
          <div className="flex items-center gap-sm">
            <ModeBadge mode={cfg.mode} />
            <RcBadge remoteControl={cfg.remoteControl} url={state.remoteControlUrl} />
          </div>
          <span className="mono flex min-w-0 items-center gap-xs text-meta text-fg-soft" title={cfg.harness}>
            {cfg.harness === 'claude' ? (
              <Bot size={11} className="shrink-0 text-faint" />
            ) : (
              <Sparkles size={11} className="shrink-0 text-faint" />
            )}
            <span className="truncate">{cfg.model || cfg.modelHint || 'default'}</span>
          </span>
        </div>
      </td>
      <td>
        <ActivityLine view={view} className="mono text-cell" />
      </td>
      {/* SIGNALS — context, quota and age stacked into one compact cell. Each
          was a column of its own; none of them is worth 10% of the width. */}
      <td>
        <div className="flex min-w-0 flex-col gap-xs">
          {state.contextPercent != null ? (
            <ContextMeter value={state.contextPercent} />
          ) : (
            <span className="text-meta text-faint">no context</span>
          )}
          <div className="kt-chrome mono flex min-w-0 items-center gap-sm">
            <QuotaReadout quota={quota} className="min-w-0 truncate text-muted" showUnknown />
            <span className="ml-auto shrink-0 text-faint" title={fmtRelative(state.lastActivityAt)}>
              {fmtAge(state.lastActivityAt)}
            </span>
          </div>
        </div>
      </td>
    </tr>
  );
});

function AttentionFlags({ view }: { view: SessionView }) {
  return (
    <>
      {view.state.waiting && <Badge tone="warn">parked</Badge>}
      {view.state.needsHuman && <Badge tone="err">needs human</Badge>}
    </>
  );
}

/** Compact and Minimal table rows are separate render paths, not CSS-hidden
 * versions of the full row. Minimal therefore mounts exactly name + task; it
 * never constructs quota, model, activity, mode, or status subtrees. */
export const LeanSessionRow = memo(function LeanSessionRow({
  view,
  density,
}: {
  view: SessionView;
  density: Exclude<Density, 'full'>;
}) {
  const cfg = view.config;
  return (
    <tr className="kt-row group">
      {/* The status SHAPE leads the identity cell so a lean list still varies
          row to row: circle/diamond/square is a landmark the eye can catch even
          when the status WORD is gone (minimal) — and it is greyscale-safe, so
          it is not the colour-only anchor the badge alone would be. The name
          then recedes when the session is finished (`nameToneClass`), giving the
          column a second, lightness-based rhythm. Neither adds a fact. */}
      <td>
        <Link
          to={`/session/${encodeURIComponent(cfg.id)}`}
          className="flex min-w-0 items-center gap-sm text-row font-semibold"
        >
          <StatusMark view={view} />
          <span className={cn('min-w-0 truncate group-hover:text-accent', nameToneClass(view))}>
            {displayCallsign(cfg.teammate) || cfg.id}
          </span>
        </Link>
      </td>
      <td>
        <TaskName name={cfg.name} teammate={cfg.teammate} size="md" className="max-w-full" />
      </td>
      {density === 'compact' && (
        <td>
          <div className="flex min-w-0 flex-wrap items-center gap-xs">
            {/* Same lean voice as the cards: short human word, raw enum on
                hover, and a declared park collapses to its single 'parked'
                flag instead of two chips for one condition. */}
            {!view.state.waiting && (
              <Badge tone={toneFor(view.state.status)} title={view.state.status} className="max-w-full truncate">
                {statusWord(view.state.status)}
              </Badge>
            )}
            <AttentionFlags view={view} />
          </div>
        </td>
      )}
    </tr>
  );
});

// Mobile-first card: full-width, tappable, single column, no horizontal
// scroll. Shows the same fields as a table row, TASK and activity included.
const SessionCard = memo(function SessionCard({
  view,
  usage,
}: {
  view: SessionView;
  usage: Map<string, UsageAccountView>;
}) {
  const cfg = view.config;
  const state = view.state;
  const quota: Quota | null = quotaFor(view, usage);
  return (
    <Link
      to={`/session/${encodeURIComponent(cfg.id)}`}
      // `.kt-panel` for the card silhouette — Mission gets the gridded, glowing
      // HUD sheet, Neo a 3px block on a 4px hard offset, Ember a seamed page,
      // High Contrast a plain bordered box. `p-panel` is the themed body
      // padding (10px Studio → 16px Ember); density is a design statement.
      //
      // `hover:border-accent`, not `hover:border-accent-border`: the hover edge
      // is the affordance, and `--accent-border` is 1.2-2.9:1 on surface in 6 of
      // 10 themes (contract §8.2 — decorative tint only).
      className="kt-panel group block p-panel transition-colors hover:border-accent active:bg-surface-2"
    >
      <div className="flex items-center gap-sm">
        <span className="min-w-0 truncate text-row font-semibold text-fg group-hover:text-accent">
          {displayCallsign(cfg.teammate) || cfg.id}
        </span>
        {/* Status is the one badge that must never be squeezed, so it sits on
            row 1 with the name. Mode and RC get their own row below WITH THEIR
            WORDS: at 390px an unlabelled cog and antenna are not legible, and
            "auto vs interactive" is the fact the user most needs to read. */}
        <span className="ml-auto" />
        <Badge tone={toneFor(state.status)} className="shrink-0">
          {state.status}
        </Badge>
      </div>
      {/* TASK, directly under the name: on a phone this is the line that tells
          you which session you are looking at. */}
      <div className="mt-1">
        <TaskName name={cfg.name} size="md" className="max-w-full" />
      </div>
      <div className="kt-chrome mono mt-0.5 flex flex-wrap items-center gap-x-sm gap-y-0.5">
        <span className="truncate">{cfg.id}</span>
        <span className="text-border">·</span>
        <span className="inline-flex items-center gap-1 text-fg-soft">
          {cfg.harness === 'claude' ? <Bot size={11} /> : <Sparkles size={11} />}
          {cfg.model || cfg.modelHint || 'default'}
        </span>
        {cfg.label && (
          <>
            <span className="text-border">·</span>
            <span className="text-fg-soft">{cfg.label}</span>
          </>
        )}
      </div>
      {/* Mode + RC, with words, on their own line — legible at 390px. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-sm">
        <ModeBadge mode={cfg.mode} />
        <RcBadge remoteControl={cfg.remoteControl} url={state.remoteControlUrl} />
      </div>
      <div className="mt-1.5">
        <ActivityLine view={view} className="w-full text-cell" />
      </div>
      <div className="mt-1.5 flex items-center gap-sm">
        {state.contextPercent != null && <ContextMeter value={state.contextPercent} />}
        <QuotaReadout quota={quota} className="text-meta text-faint" showUnknown />
        <span className="mono ml-auto shrink-0 text-meta text-faint" title={fmtRelative(state.lastActivityAt)}>
          {fmtAge(state.lastActivityAt)}
        </span>
      </div>
    </Link>
  );
});

/** Reduced-density counterpart to LeanSessionRow — no longer a free-standing
 * card but ONE ROW inside its group's panel (LeanGroupPanel): a single 44px
 * line, mark → name → task, with the pill and exception flags on the right at
 * compact. Two 16px lines in a padded, bordered box cost ~90px per session and
 * looked identical nine times over (B42); the same facts fit on one line
 * because the name and the task were both short by contract (kteam titles cap
 * at five words) and both truncate with the full string in `title`. Density
 * still means fewer facts, never smaller type — the row is 16px text on a
 * 44px tap floor.
 *
 * `statusHoisted` is set by LeanGroupPanel when this row's status is already
 * summarised in the group header: the pill is then repetition, not signal, and
 * only the exceptions keep theirs. Attention flags (parked / needs human) are
 * exceptional by nature and always survive at compact. Rendered standalone
 * (tests), the default keeps the pill. */
export const LeanSessionCard = memo(function LeanSessionCard({
  view,
  density,
  statusHoisted = false,
}: {
  view: SessionView;
  density: Exclude<Density, 'full'>;
  statusHoisted?: boolean;
}) {
  const cfg = view.config;
  return (
    <Link
      to={`/session/${encodeURIComponent(cfg.id)}`}
      className="group flex min-h-[44px] min-w-0 items-center gap-sm px-panel py-1.5 transition-colors hover:bg-surface-2 active:bg-surface-2"
    >
      {/* Same anchor as the table row: the shape carries state greyscale-safe,
          and the name recedes once the work is done — so a scrolled column of
          rows is not ten identical bold headings. */}
      <StatusMark view={view} />
      {/* TRUNCATION PRIORITY: the title is what identifies a session, so it is
          the LAST thing to lose width. The callsign shrinks eight times as
          eagerly (shrink-[8] vs the title's default 1) down to a ~8-character
          floor (min-w-16 — 'Joselynn' survives; a 40px floor left 'M…', which
          identifies nothing either), and only then does the title give. The
          old shrink-0 callsign rendered in full while 'Build Manager Rails'
          died at 'Build …'. */}
      <span
        className={cn(
          'min-w-16 max-w-[45%] shrink-[8] truncate text-row font-semibold group-hover:text-accent',
          nameToneClass(view),
        )}
      >
        {displayCallsign(cfg.teammate) || cfg.id}
      </span>
      <TaskName name={cfg.name} teammate={cfg.teammate} size="md" className="min-w-0 grow" />
      {density === 'compact' && (
        <span className="ml-auto flex shrink-0 items-center gap-xs">
          {/* One condition, one chip: a declared park already renders the
              'parked' flag below, and the raw pane status next to it said the
              same thing twice while eating the title (the park outranks the
              pane — same rule as activityLine). Hoisted rows drop the pill
              because the group header already carries it. */}
          {!statusHoisted && !view.state.waiting && (
            <Badge tone={toneFor(view.state.status)} title={view.state.status} className="max-w-full truncate">
              {statusWord(view.state.status)}
            </Badge>
          )}
          <AttentionFlags view={view} />
        </span>
      )}
    </Link>
  );
});

function ContextMeter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const bar = pct >= 90 ? 'bg-err' : pct >= 75 ? 'bg-warn' : 'bg-ok';
  return (
    // `.kt-meter*` owns the track geometry — Neo squares it off (`--radius-badge`
    // resolves to 0 there) while every other family keeps the pill.
    <div className="kt-meter" title={`context ${pct}% used`}>
      <div className="kt-meter__track">
        <div className={`kt-meter__fill ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="mono text-meta text-fg-soft">{pct}%</span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="grid gap-2">
      {Array.from({ length: 6 }).map((_, i) => (
        // `h-row` is the themed row floor the real rows will land on, so the
        // skeleton does not jump height when the data arrives.
        <div key={i} className="h-row animate-pulse rounded-panel border border-border-soft bg-surface-2" />
      ))}
    </div>
  );
}
