// Sessions list. Live teammate sessions managed by kteamd.
//  - toolbar: label filter + "include finished" toggle
//  - table: teammate, model, label, status, harness, context %, activity, updated
//  - live updates via WebSocket /v1/events with a 1.5s trailing debounce (the
//    daemon emits frame events every few seconds per session — never refetch
//    per event).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Sparkles, Activity } from 'lucide-react';
import { api } from '../lib/api';
import type { SessionView } from '../types';
import { Badge } from '../components/Primitives';
import { WardenStrip } from '../components/WardenStrip';
import { Link } from '../lib/router';
import { debounce, TERMINAL_STATUSES, fmtRelative, toneFor } from '../lib/utils';
import { openEventStream } from '../lib/ws';

export function SessionsListPage() {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [includeFinished, setIncludeFinished] = useState(false);
  const socketRef = useRef<ReturnType<typeof openEventStream> | null>(null);

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
  }, []);

  useEffect(() => {
    const debounced = debounce(() => void load(false), 1500);
    const handle = openEventStream('', -200, () => debounced());
    socketRef.current = handle;
    return () => handle.close();
  }, []);

  const visible = useMemo(() => {
    if (!sessions) return [];
    const needle = filter.trim().toLowerCase();
    return sessions.filter(v => {
      if (!includeFinished && TERMINAL_STATUSES.has(v.state.status)) return false;
      if (needle && !(v.config.label ?? '').toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [sessions, filter, includeFinished]);

  return (
    <div className="mx-auto w-full">
      <div className="mt-5 mb-4 flex items-end justify-between gap-3">
        <div>
          <h1 className="m-0 text-[1.5rem] font-semibold tracking-tight">Sessions</h1>
          <p className="mt-0.5 text-[13px] text-muted">Live teammate sessions managed by kteamd.</p>
        </div>
        {sessions && (
          <span className="mono text-[12px] text-faint">
            {visible.length} shown · {sessions.length} total
          </span>
        )}
      </div>

      <WardenStrip />

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border-soft bg-surface-2 px-3 py-2">
        <input
          type="search"
          placeholder="Filter by label…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          aria-label="Filter by label"
          className="min-w-[220px] flex-1 bg-surface"
        />
        <label className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap text-[13px] text-fg-soft">
          <input type="checkbox" checked={includeFinished} onChange={e => setIncludeFinished(e.target.checked)} />
          include finished
        </label>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-err-border bg-err-bg px-3 py-2 text-[13px] text-err">{error}</div>
      )}

      {!sessions && <SkeletonRows />}
      {sessions && visible.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-surface-2 px-4 py-12 text-center text-muted">
          No matching sessions.
        </div>
      )}
      {sessions && visible.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-sm">
          <table className="w-full min-w-[860px] border-collapse">
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
              {visible.map(v => (
                <SessionRow key={v.config.id} view={v} />
              ))}
            </tbody>
          </table>
        </div>
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
