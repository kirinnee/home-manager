// Sessions list. Live teammate sessions managed by kteamd, grouped by project.
//  - toolbar: label filter + "include finished" toggle + New session
//  - per-project group: header + table (teammate, model, status, harness,
//    context, activity, updated)
//  - live updates via WebSocket /v1/events with a 1.5s trailing debounce.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Sparkles, Activity, FolderGit2, Plus, Search, X, LayoutGrid, Rows3, User, Cpu } from 'lucide-react';
import { api } from '../lib/api';
import type { InteractionMode, ProjectInfo, SearchResponse, SessionView } from '../types';
import { Badge } from '../components/Primitives';
import { ModeBadge, MODE_HINT } from '../components/ModeBadge';
import { RcBadge } from '../components/RcBadge';
import { WardenStrip } from '../components/WardenStrip';
import { WardenVerdicts } from '../components/WardenVerdicts';
import { Link, navigate } from '../lib/router';
import { debounce, TERMINAL_STATUSES, fmtAge, fmtRelative, toneFor } from '../lib/utils';
import { openEventStream } from '../lib/ws';
import { QuotaReadout } from '../components/QuotaBadge';
import { useUsage } from '../hooks/useUsage';
import { quotaFor, type Quota } from '../lib/usage';
import type { UsageAccountView } from '../types';

function baseName(p: string): string {
  const seg = p.replace(/\/+$/, '').split('/').filter(Boolean);
  return seg.length ? seg[seg.length - 1]! : p;
}

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

// One-line "what it's doing": the live pane activity when working, else the
// task description, else the id. Present in both list and card views.
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
  const task = v.config.name?.trim();
  if (task && task !== v.config.teammate) return { text: task, live: false };
  return { text: v.config.id, live: false };
}

function ActivityLine({ view, className = '' }: { view: SessionView; className?: string }) {
  const { text, live } = activityLine(view);
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <Activity size={11} className={live ? 'shrink-0 text-accent' : 'shrink-0 text-faint'} />
      <span className={live ? 'truncate shimmer' : 'truncate text-muted'}>{text}</span>
    </span>
  );
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
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
      <mark key={n++} className="rounded bg-accent-soft px-0.5 text-accent">
        {text.slice(at, at + q.length)}
      </mark>,
    );
    i = at + q.length;
  }
  return parts;
}

export function SessionsListPage() {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [includeFinished, setIncludeFinished] = useState(false);
  // Mode segment: the primary way to read the fleet — who is driving what.
  // Composes with the search box (both are applied in `visible`).
  const [modeFilter, setModeFilter] = useState<'all' | InteractionMode>('all');
  const socketRef = useRef<ReturnType<typeof openEventStream> | null>(null);
  // Transcript search (server-side, on Enter) — distinct from the instant
  // client-side list filter above.
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [tResults, setTResults] = useState<SearchResponse | null>(null);
  const [tSearching, setTSearching] = useState(false);
  // View mode: cards (mobile-friendly) vs table. Auto-defaults to cards on
  // narrow viewports; a desktop user can override.
  const isNarrow = useIsNarrow();
  const [viewPref, setViewPref] = useState<'cards' | 'table' | null>(null);
  const mode = viewPref ?? (isNarrow ? 'cards' : 'table');
  // Account quota, fleet-wide and joined by wrapper binary — see lib/usage.ts.
  const { index: usage } = useUsage();

  async function load(initial = false) {
    try {
      setSessions(await api.listSessions());
      setError(null);
    } catch (e) {
      if (initial) setError(String(e instanceof Error ? e.message : e));
    }
  }

  useEffect(() => {
    void load(true);
    void api
      .projects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    const debounced = debounce(() => void load(false), 1500);
    const handle = openEventStream('', -200, () => debounced());
    socketRef.current = handle;
    return () => handle.close();
  }, []);

  // Instant, client-side filter across every identifying field.
  const visible = useMemo(() => {
    if (!sessions) return [];
    const needle = filter.trim().toLowerCase();
    return sessions.filter(v => {
      if (!includeFinished && TERMINAL_STATUSES.has(v.state.status)) return false;
      if (modeFilter !== 'all' && v.config.mode !== modeFilter) return false;
      if (!needle) return true;
      const c = v.config;
      // `c.mode` is in the haystack too, so typing "interactive" filters as
      // well — and a literal "rc" matches the RC-enabled sessions.
      const hay = [
        c.id,
        c.teammate,
        c.name,
        c.label,
        c.binary,
        c.model,
        c.modelHint,
        c.cwd,
        c.mode,
        v.state.status,
        c.remoteControl ? 'rc remote-control' : '',
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [sessions, filter, includeFinished, modeFilter]);

  // Per-mode counts for the segment labels (over everything the OTHER filters
  // admit, so the numbers describe what clicking would show).
  const modeCounts = useMemo(() => {
    const pool = (sessions ?? []).filter(v => includeFinished || !TERMINAL_STATUSES.has(v.state.status));
    return {
      all: pool.length,
      interactive: pool.filter(v => v.config.mode === 'interactive').length,
      auto: pool.filter(v => v.config.mode === 'auto').length,
    };
  }, [sessions, includeFinished]);

  // `/` focuses the search box from anywhere (unless already typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !isTypingTarget(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function runTranscriptSearch() {
    const q = filter.trim();
    if (!q) {
      setTResults(null);
      return;
    }
    setTSearching(true);
    try {
      setTResults(await api.search(q, 40));
    } catch {
      setTResults({ query: q, scanned: 0, results: [] });
    } finally {
      setTSearching(false);
    }
  }

  function clearSearch() {
    setFilter('');
    setTResults(null);
    searchRef.current?.blur();
  }

  // Group by project: longest project-path prefix of the session cwd wins;
  // otherwise fall back to the cwd's basename so nothing is orphaned.
  const groups = useMemo(() => {
    const byPathLen = [...projects].sort((a, b) => b.path.length - a.path.length);
    const map = new Map<string, { name: string; path: string; rows: SessionView[] }>();
    for (const v of visible) {
      const cwd = v.config.cwd ?? '';
      const match = byPathLen.find(p => cwd === p.path || cwd.startsWith(p.path + '/'));
      const key = match?.path ?? cwd ?? 'ungrouped';
      const name = match?.name ?? (cwd ? baseName(cwd) : 'ungrouped');
      if (!map.has(key)) map.set(key, { name, path: match?.path ?? cwd, rows: [] });
      map.get(key)!.rows.push(v);
    }
    return [...map.values()].sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
  }, [visible, projects]);

  // The page is a flex column that fills the shell: a fixed toolbar block and
  // ONE scroller under it. The whole page used to be the scroller, which was
  // fine on its own but inconsistent with the chat route — and it meant the
  // search box and filters scrolled away exactly when a long fleet made them
  // most useful.
  return (
    <div className="flex h-full min-h-0 w-full flex-col pb-2">
      <div className="mt-2 mb-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="m-0 text-[1.15rem] font-semibold tracking-tight">Sessions</h1>
        <div className="flex items-center gap-2.5">
          {sessions && (
            <span className="mono text-[11.5px] text-faint">
              {visible.length}/{sessions.length}
            </span>
          )}
          <Link
            to="/new"
            className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 py-1 text-[12.5px] font-semibold text-accent-fg hover:bg-accent-strong"
          >
            <Plus size={13} /> New session
          </Link>
        </div>
      </div>

      <WardenStrip />
      <WardenVerdicts />

      <div className="mb-2 rounded-lg border border-border-soft bg-surface-2 px-2.5 py-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex min-w-[240px] flex-1 items-center">
            <Search size={14} className="pointer-events-none absolute left-2.5 text-faint" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search sessions — id, teammate, task, label, project, model, status…  ( / )"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runTranscriptSearch();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  clearSearch();
                }
              }}
              aria-label="Search sessions and transcripts"
              className="w-full bg-surface pl-8 pr-8"
            />
            {filter && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label="Clear search"
                className="absolute right-2 text-faint hover:text-fg"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div
            className="inline-flex shrink-0 rounded-md border border-border bg-surface p-0.5"
            role="group"
            aria-label="Filter by mode"
          >
            {(['all', 'interactive', 'auto'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setModeFilter(m)}
                title={m === 'all' ? 'every session' : MODE_HINT[m]}
                aria-pressed={modeFilter === m}
                className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[12px] font-medium transition-colors ${
                  modeFilter === m
                    ? m === 'interactive'
                      ? 'bg-accent-soft text-accent'
                      : 'bg-surface-2 text-fg'
                    : 'text-muted hover:text-fg'
                }`}
              >
                {m === 'interactive' && <User size={11} />}
                {m === 'auto' && <Cpu size={11} />}
                {m}
                <span className="mono text-[11px] text-faint">{modeCounts[m]}</span>
              </button>
            ))}
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap text-[13px] text-fg-soft">
            <input type="checkbox" checked={includeFinished} onChange={e => setIncludeFinished(e.target.checked)} />
            include finished
          </label>
          {!isNarrow && (
            <div className="inline-flex shrink-0 rounded-md border border-border bg-surface p-0.5">
              {(['table', 'cards'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setViewPref(m)}
                  aria-label={`${m} view`}
                  title={`${m} view`}
                  className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[12px] font-medium transition-colors ${
                    mode === m ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'
                  }`}
                >
                  {m === 'table' ? <Rows3 size={12} /> : <LayoutGrid size={12} />}
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* The instructional hint row is gone (round 4): four sentences
            explaining that a filter filters, that Enter searches, and what the
            two modes mean. The placeholder already says the first two and the
            mode badges carry MODE_HINT as a tooltip. */}
      </div>

      {(tSearching || tResults) && (
        <TranscriptResults query={filter} searching={tSearching} results={tResults} onClose={() => setTResults(null)} />
      )}

      {error && (
        <div className="mb-3 rounded-md border border-err-border bg-err-bg px-3 py-2 text-[13px] text-err">{error}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {!sessions && <SkeletonRows />}
        {sessions && visible.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-surface-2 px-4 py-10 text-center text-muted">
            No matching sessions.
          </div>
        )}

        <div className="space-y-3">
          {groups.map(g => (
            <section key={g.path || g.name}>
              <div className="mb-1 flex items-baseline gap-2 px-0.5">
                <FolderGit2 size={13} className="shrink-0 translate-y-0.5 text-faint" />
                <span className="text-[12.5px] font-semibold text-fg">{g.name}</span>
                {g.path && <span className="mono truncate text-[11px] text-faint">{g.path}</span>}
                <span className="mono ml-auto shrink-0 text-[11px] text-faint">{g.rows.length}</span>
              </div>
              {mode === 'cards' ? (
                <div className="grid gap-1.5">
                  {g.rows.map(v => (
                    <SessionCard key={v.config.id} view={v} usage={usage} />
                  ))}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-sm">
                  <table className="w-full min-w-[780px] border-collapse">
                    <thead>
                      <tr>
                        <Th>Teammate</Th>
                        <Th>Mode</Th>
                        <Th>Model</Th>
                        <Th>Label</Th>
                        <Th>Status</Th>
                        <Th>CLI</Th>
                        <Th>Context</Th>
                        <Th>Quota</Th>
                        <Th>Activity</Th>
                        <Th>Updated</Th>
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
    <div className="mb-4 overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-border-soft bg-surface-2 px-3 py-2 text-[12.5px]">
        <Search size={14} className="shrink-0 text-faint" />
        <span className="font-medium text-fg-soft">Transcript matches</span>
        {results && (
          <span className="mono text-[11.5px] text-faint">
            {results.results.length} in {results.scanned} session{results.scanned === 1 ? '' : 's'} searched
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close transcript results"
          className="ml-auto rounded p-1 text-muted hover:bg-surface hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
      {searching ? (
        <div className="px-3 py-4 text-[12.5px] text-muted">searching transcripts…</div>
      ) : !results || results.results.length === 0 ? (
        <div className="px-3 py-4 text-[12.5px] text-muted">
          No transcript matches for <span className="mono text-fg-soft">{query}</span>.
        </div>
      ) : (
        <ul className="divide-y divide-border-soft">
          {results.results.map((r, i) => (
            <li key={`${r.sessionId}-${i}`}>
              <button
                type="button"
                onClick={() => navigate(`/session/${encodeURIComponent(r.sessionId)}`)}
                className="block w-full px-3 py-2 text-left hover:bg-surface-2"
              >
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-semibold text-fg">{r.teammate ?? r.sessionId}</span>
                  <span className="mono text-[11px] text-faint">{r.sessionId}</span>
                  {r.turn != null && <span className="mono text-[11px] text-faint">turn {r.turn}</span>}
                  <span className="mono ml-auto shrink-0 text-[11px] text-faint">{r.at ? fmtRelative(r.at) : ''}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted">
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

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-border bg-surface-2 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
      {children}
    </th>
  );
}

function SessionRow({ view, usage }: { view: SessionView; usage: Map<string, UsageAccountView> }) {
  const cfg = view.config;
  const state = view.state;
  const quota: Quota | null = quotaFor(view, usage);
  return (
    <tr className="group border-b border-border-soft transition-colors last:border-b-0 hover:bg-surface-2">
      <td className="max-w-[150px] px-2 py-1.5 align-middle">
        <Link to={`/session/${encodeURIComponent(cfg.id)}`} className="block min-w-0" title={cfg.id}>
          <div className="truncate font-semibold text-fg group-hover:text-accent">
            {cfg.teammate || cfg.name || cfg.id}
          </div>
          <div className="mono truncate text-[11px] text-faint">{cfg.id}</div>
        </Link>
      </td>
      <td className="px-2 py-1.5 align-middle">
        <div className="flex items-center gap-1.5">
          <ModeBadge mode={cfg.mode} />
          <RcBadge remoteControl={cfg.remoteControl} url={state.remoteControlUrl} />
        </div>
      </td>
      <td className="mono max-w-[130px] truncate whitespace-nowrap px-2 py-1.5 align-middle text-[12px] text-fg-soft">
        {cfg.model || cfg.modelHint || 'default'}
      </td>
      <td className="max-w-[150px] px-2 py-1.5 align-middle text-[12.5px]">
        {cfg.label ? (
          <span className="block truncate text-fg-soft" title={cfg.label}>
            {cfg.label}
          </span>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 align-middle">
        <Badge tone={toneFor(state.status)}>{state.status}</Badge>
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 align-middle" title={cfg.harness}>
        <span className="mono inline-flex items-center gap-1.5 text-[12px] text-fg-soft">
          {cfg.harness === 'claude' ? (
            <Bot size={13} className="text-faint" />
          ) : (
            <Sparkles size={13} className="text-faint" />
          )}
          <span className="hidden xl:inline">{cfg.harness}</span>
        </span>
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 align-middle">
        {state.contextPercent != null ? (
          <ContextMeter value={state.contextPercent} />
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 align-middle text-[11.5px]">
        <QuotaReadout quota={quota} className="text-muted" showUnknown />
      </td>
      <td className="max-w-[150px] px-2 py-1.5 align-middle">
        <ActivityLine view={view} className="mono max-w-full text-[12px]" />
      </td>
      <td
        className="mono whitespace-nowrap px-2 py-1.5 align-middle text-[12px] text-muted"
        title={fmtRelative(state.lastActivityAt)}
      >
        {fmtAge(state.lastActivityAt)}
      </td>
    </tr>
  );
}

// Mobile-first card: full-width, tappable, single column, no horizontal
// scroll. Shows the same fields as a table row, activity line included.
function SessionCard({ view, usage }: { view: SessionView; usage: Map<string, UsageAccountView> }) {
  const cfg = view.config;
  const state = view.state;
  const quota: Quota | null = quotaFor(view, usage);
  return (
    <Link
      to={`/session/${encodeURIComponent(cfg.id)}`}
      className="group block rounded-lg border border-border bg-surface p-2 shadow-sm transition-colors hover:border-accent-border active:bg-surface-2"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-semibold text-fg group-hover:text-accent">
          {cfg.teammate || cfg.name || cfg.id}
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
      <div className="mono mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
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
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <ModeBadge mode={cfg.mode} />
        <RcBadge remoteControl={cfg.remoteControl} url={state.remoteControlUrl} />
      </div>
      <div className="mt-1.5">
        <ActivityLine view={view} className="w-full text-[12px]" />
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        {state.contextPercent != null && <ContextMeter value={state.contextPercent} />}
        <QuotaReadout quota={quota} className="text-[11px] text-faint" showUnknown />
        <span className="mono ml-auto shrink-0 text-[11px] text-faint" title={fmtRelative(state.lastActivityAt)}>
          {fmtAge(state.lastActivityAt)}
        </span>
      </div>
    </Link>
  );
}

function ContextMeter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const bar = pct >= 90 ? 'bg-err' : pct >= 75 ? 'bg-warn' : 'bg-ok';
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-surface-3">
        <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="mono text-[11.5px] text-fg-soft">{pct}%</span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="grid gap-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-11 animate-pulse rounded-lg border border-border-soft bg-surface-2" />
      ))}
    </div>
  );
}
