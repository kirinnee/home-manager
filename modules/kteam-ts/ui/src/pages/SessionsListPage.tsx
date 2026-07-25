// Sessions list. Live teammate sessions managed by kteamd, grouped by project.
//  - header: title + count + table/cards switch + New
//  - per-project group: header + table (identity, TASK, status, runtime,
//    activity, signals)
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
import { Bot, Sparkles, Activity, FolderGit2, Plus, Search, X, LayoutGrid, Rows3 } from 'lucide-react';
import type { SearchResponse, SessionView } from '../types';
import { Badge } from '../components/Primitives';
import { ModeBadge } from '../components/ModeBadge';
import { RcBadge } from '../components/RcBadge';
import { TaskName } from '../components/TaskName';
import { WardenStrip } from '../components/WardenStrip';
import { WardenVerdicts } from '../components/WardenVerdicts';
import { displayCallsign } from '../lib/callsign';
import { Link, navigate } from '../lib/router';
import { TERMINAL_STATUSES, fmtAge, fmtRelative, toneFor } from '../lib/utils';
import { QuotaReadout } from '../components/QuotaBadge';
import { useUsage } from '../hooks/useUsage';
import { quotaFor, type Quota } from '../lib/usage';
import type { UsageAccountView } from '../types';
import { useFleet, useStore, useTranscriptSearch, useUiControls } from '../lib/store';
import { filterSessions, groupByProject } from '../lib/grouping';

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
  // Transcript search results (server-side, triggered from the sidebar) —
  // distinct from the instant client-side list filter below. Store-owned, so
  // the results survive navigating into a hit and back.
  const { searching: tSearching, results: tResults } = useTranscriptSearch();
  // View mode: cards (mobile-friendly) vs table. Auto-defaults to cards on
  // narrow viewports; a desktop user can override.
  const isNarrow = useIsNarrow();
  const mode = viewPref ?? (isNarrow ? 'cards' : 'table');
  // Account quota, fleet-wide and joined by wrapper binary — see lib/usage.ts.
  const { index: usage } = useUsage();

  // Instant, client-side filter across every identifying field — the SHARED
  // predicate, fed by the sidebar's controls. The output is what this page
  // shows, so the sidebar's counts and this table can never disagree.
  const visible = useMemo(
    () => (sessions ? filterSessions(sessions, { query: filter, mode: modeFilter, rcOnly, includeFinished }) : []),
    [sessions, filter, includeFinished, modeFilter, rcOnly],
  );

  // Longest-project-path-prefix grouping, cwd basename fallback. `sortRows` is
  // left off: the dashboard keeps the daemon's order (the sidebar is the view
  // that wants most-recently-active first).
  const groups = useMemo(() => groupByProject(visible, projects), [visible, projects]);

  // The page is a flex column that fills the shell: a fixed header block and
  // ONE scroller under it. The whole page used to be the scroller, which was
  // fine on its own but inconsistent with the chat route.
  return (
    <div className="flex h-full min-h-0 w-full flex-col pb-2">
      {/* Tighter above the fold on a phone: at 390x844 this toolbar and the app
          bar are the dashboard's whole chrome budget, and 8px of margin at each
          end of it is most of a sixth session row. `sm:` restores the desktop
          rhythm exactly. */}
      <div className="mt-1 mb-1 flex flex-wrap items-center justify-between gap-2 sm:mt-2 sm:mb-2">
        {/* `--text-display` / `--weight-display` / `--tracking-display`: Mission
            shouts this in 0.08em caps, Neo at 900, Ember in a serif. */}
        <h1 className="m-0 font-display text-display font-bold tracking-display">Sessions</h1>
        <div className="flex items-center gap-sm">
          {sessions && (
            <span className="mono text-meta text-faint" title="visible / total sessions">
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
            No matching sessions.
          </div>
        )}

        <div className="space-y-3">
          {groups.map(g => (
            <section key={g.path || g.name}>
              <div className="mb-1 flex items-baseline gap-sm px-0.5">
                <FolderGit2 size={13} className="shrink-0 translate-y-0.5 text-faint" />
                <span className="text-ui font-semibold text-fg">{g.name}</span>
                {g.path && <span className="mono truncate text-meta text-faint">{g.path}</span>}
                <span className="mono ml-auto shrink-0 text-meta text-faint">{g.rows.length}</span>
              </div>
              {mode === 'cards' ? (
                <div className="grid gap-1.5">
                  {g.rows.map(v => (
                    <SessionCard key={v.config.id} view={v} usage={usage} />
                  ))}
                </div>
              ) : (
                // SIX columns, `table-fixed`, no min-width and no horizontal
                // scroller. The old ten-column wall needed 780px of intrinsic
                // width and scrolled sideways inside the page; percentage
                // columns plus per-cell truncation mean the table is exactly as
                // wide as the pane at any width, and ACTIVITY — the column you
                // actually read — gets the largest share instead of 150px.
                <div className="kt-panel">
                  <table className="w-full table-fixed border-collapse">
                    {/* One table per project group, so each needs its own
                        accessible name — otherwise a screen-reader user hears
                        six identical "table with 6 columns" landmarks and has no
                        way to tell which project they are in. */}
                    <caption className="sr-only">Sessions in {g.name}</caption>
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
                      {g.rows.map(v => (
                        <SessionRow key={v.config.id} view={v} usage={usage} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
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
                  <span className="font-semibold text-fg">
                    {r.teammate ? displayCallsign(r.teammate) : r.sessionId}
                  </span>
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
            {cfg.teammate ? displayCallsign(cfg.teammate) : cfg.id}
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
          {cfg.teammate ? displayCallsign(cfg.teammate) : cfg.id}
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
