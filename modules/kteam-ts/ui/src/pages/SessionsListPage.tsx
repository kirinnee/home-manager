// Sessions list. Live teammate sessions managed by kteamd, grouped by project.
//  - toolbar: label filter + "include finished" toggle + New session
//  - per-project group: header + table (teammate, model, status, harness,
//    context, activity, updated)
//  - live updates via WebSocket /v1/events with a 1.5s trailing debounce.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Sparkles, Activity, FolderGit2, Plus, Search, X, CornerDownLeft } from 'lucide-react';
import { api } from '../lib/api';
import type { ProjectInfo, SearchResponse, SessionView } from '../types';
import { Badge } from '../components/Primitives';
import { WardenStrip } from '../components/WardenStrip';
import { WardenVerdicts } from '../components/WardenVerdicts';
import { Link, navigate } from '../lib/router';
import { debounce, TERMINAL_STATUSES, fmtRelative, toneFor } from '../lib/utils';
import { openEventStream } from '../lib/ws';

function baseName(p: string): string {
  const seg = p.replace(/\/+$/, '').split('/').filter(Boolean);
  return seg.length ? seg[seg.length - 1]! : p;
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
  const socketRef = useRef<ReturnType<typeof openEventStream> | null>(null);
  // Transcript search (server-side, on Enter) — distinct from the instant
  // client-side list filter above.
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [tResults, setTResults] = useState<SearchResponse | null>(null);
  const [tSearching, setTSearching] = useState(false);

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
      if (!needle) return true;
      const c = v.config;
      const hay = [c.id, c.teammate, c.name, c.label, c.binary, c.model, c.modelHint, c.cwd, v.state.status]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [sessions, filter, includeFinished]);

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

  return (
    <div className="mx-auto w-full">
      <div className="mt-5 mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 text-[1.5rem] font-semibold tracking-tight">Sessions</h1>
          <p className="mt-0.5 text-[13px] text-muted">Live teammate sessions managed by kteamd.</p>
        </div>
        <div className="flex items-center gap-3">
          {sessions && (
            <span className="mono text-[12px] text-faint">
              {visible.length} shown · {sessions.length} total
            </span>
          )}
          <Link
            to="/new"
            className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent px-3 py-1.5 text-[13px] font-semibold text-accent-fg hover:bg-accent-strong"
          >
            <Plus size={14} /> New session
          </Link>
        </div>
      </div>

      <WardenStrip />
      <WardenVerdicts />

      <div className="mb-4 rounded-lg border border-border-soft bg-surface-2 px-3 py-2">
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
          <label className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap text-[13px] text-fg-soft">
            <input type="checkbox" checked={includeFinished} onChange={e => setIncludeFinished(e.target.checked)} />
            include finished
          </label>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 pl-0.5 text-[11px] text-faint">
          <span>filters the list live</span>
          <span className="text-border">·</span>
          <span className="inline-flex items-center gap-1">
            <CornerDownLeft size={11} /> Enter searches transcripts
          </span>
        </div>
      </div>

      {(tSearching || tResults) && (
        <TranscriptResults query={filter} searching={tSearching} results={tResults} onClose={() => setTResults(null)} />
      )}

      {error && (
        <div className="mb-3 rounded-md border border-err-border bg-err-bg px-3 py-2 text-[13px] text-err">{error}</div>
      )}

      {!sessions && <SkeletonRows />}
      {sessions && visible.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-surface-2 px-4 py-12 text-center text-muted">
          No matching sessions.
        </div>
      )}

      <div className="space-y-5">
        {groups.map(g => (
          <section key={g.path || g.name}>
            <div className="mb-1.5 flex items-baseline gap-2 px-0.5">
              <FolderGit2 size={14} className="shrink-0 translate-y-0.5 text-faint" />
              <span className="text-[13px] font-semibold text-fg">{g.name}</span>
              {g.path && <span className="mono truncate text-[11.5px] text-faint">{g.path}</span>}
              <span className="mono ml-auto shrink-0 text-[11.5px] text-faint">{g.rows.length}</span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-sm">
              <table className="w-full min-w-[820px] border-collapse">
                <thead>
                  <tr>
                    <Th>Teammate</Th>
                    <Th>Model</Th>
                    <Th>Label</Th>
                    <Th>Status</Th>
                    <Th>Harness</Th>
                    <Th>Context</Th>
                    <Th>Activity</Th>
                    <Th>Updated</Th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map(v => (
                    <SessionRow key={v.config.id} view={v} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
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
    <th className="border-b border-border bg-surface-2 px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted">
      {children}
    </th>
  );
}

function SessionRow({ view }: { view: SessionView }) {
  const cfg = view.config;
  const state = view.state;
  const running = !TERMINAL_STATUSES.has(state.status);
  return (
    <tr className="group border-b border-border-soft transition-colors last:border-b-0 hover:bg-surface-2">
      <td className="px-3 py-2.5 align-middle">
        <Link to={`/session/${encodeURIComponent(cfg.id)}`} className="block">
          <div className="font-semibold text-fg group-hover:text-accent">{cfg.teammate || cfg.name || cfg.id}</div>
          <div className="mono text-[11px] text-faint">{cfg.id}</div>
        </Link>
      </td>
      <td className="mono px-3 py-2.5 align-middle text-[12.5px] text-fg-soft">
        {cfg.model || cfg.modelHint || 'default'}
      </td>
      <td className="px-3 py-2.5 align-middle text-[13px]">
        {cfg.label ? <span className="text-fg-soft">{cfg.label}</span> : <span className="text-faint">—</span>}
      </td>
      <td className="px-3 py-2.5 align-middle">
        <Badge tone={toneFor(state.status)}>{state.status}</Badge>
      </td>
      <td className="px-3 py-2.5 align-middle">
        <span className="mono inline-flex items-center gap-1.5 text-[12.5px] text-fg-soft">
          {cfg.harness === 'claude' ? (
            <Bot size={13} className="text-faint" />
          ) : (
            <Sparkles size={13} className="text-faint" />
          )}
          {cfg.harness}
        </span>
      </td>
      <td className="px-3 py-2.5 align-middle">
        {state.contextPercent != null ? (
          <ContextMeter value={state.contextPercent} />
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="max-w-[280px] px-3 py-2.5 align-middle">
        <div className="mono inline-flex max-w-full items-center gap-1.5 text-[12px]">
          {state.activity ? (
            <>
              <Activity size={11} className="shrink-0 text-accent" />
              <span className={running ? 'truncate shimmer' : 'truncate text-fg-soft'}>{state.activity}</span>
            </>
          ) : (
            <span className="text-faint">—</span>
          )}
        </div>
      </td>
      <td className="mono px-3 py-2.5 align-middle text-[12px] text-muted">{fmtRelative(state.lastActivityAt)}</td>
    </tr>
  );
}

function ContextMeter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const bar = pct >= 90 ? 'bg-err' : pct >= 75 ? 'bg-warn' : 'bg-ok';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3">
        <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="mono text-[12px] text-fg-soft">{pct}%</span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="grid gap-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg border border-border-soft bg-surface-2" />
      ))}
    </div>
  );
}
