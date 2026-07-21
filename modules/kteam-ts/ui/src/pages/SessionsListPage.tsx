// Sessions list. Provides:
//  - toolbar: label filter + "include finished" toggle
//  - table: teammate, model, harness, status, label, context %, last activity
//  - live updates via WebSocket /v1/events with a 1.5s trailing debounce —
//    the daemon emits frame events every few seconds per session, and the
//    lesson in the legacy shell was: never refetch-per-event.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Sparkles, Activity } from 'lucide-react';
import { api } from '../lib/api';
import type { SessionView } from '../types';
import { Badge } from '../components/Primitives';
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
      const list = await api.listSessions();
      setSessions(list);
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
    <div>
      <h1 className="mt-4 mb-1 text-[1.3rem] tracking-tight">Sessions</h1>
      <p className="text-muted mb-3">Live teammate sessions managed by kteamd.</p>

      <div className="flex flex-wrap items-center gap-2 mb-3 px-3 py-2 rounded-md border border-border-soft bg-surface-2">
        <input
          type="search"
          placeholder="Filter by label"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          aria-label="Filter by label"
          className="flex-1 min-w-[210px]"
        />
        <label className="inline-flex items-center gap-1.5 text-fg-soft whitespace-nowrap text-[13px]">
          <input type="checkbox" checked={includeFinished} onChange={e => setIncludeFinished(e.target.checked)} />
          include finished
        </label>
      </div>

      {error && (
        <div className="rounded-md border border-err-border bg-err-bg px-3 py-2 text-err text-[13px] mb-3">{error}</div>
      )}

      {!sessions && <SkeletonRows />}
      {sessions && visible.length === 0 && (
        <div className="px-4 py-9 rounded-md border border-dashed border-border bg-surface-2 text-muted text-center">
          No matching sessions.
        </div>
      )}
      {sessions && visible.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full border-collapse min-w-[820px]">
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
    <th className="px-2.5 py-2 border-b border-border bg-surface-2 text-muted text-[10.5px] font-bold uppercase tracking-wider text-left">
      {children}
    </th>
  );
}

function SessionRow({ view }: { view: SessionView }) {
  const cfg = view.config;
  const state = view.state;
  return (
    <tr className="cursor-pointer hover:bg-surface-2 border-b border-border-soft last:border-b-0">
      <td className="px-2.5 py-2.5 align-middle">
        <Link to={`/session/${encodeURIComponent(cfg.id)}`} className="block">
          <div className="font-bold">{cfg.teammate || cfg.name || cfg.id}</div>
          <div className="mono text-muted text-[11px]">{cfg.id}</div>
        </Link>
      </td>
      <td className="px-2.5 py-2.5 align-middle mono">{cfg.model || cfg.modelHint || 'default'}</td>
      <td className="px-2.5 py-2.5 align-middle">{cfg.label || '—'}</td>
      <td className="px-2.5 py-2.5 align-middle">
        <Badge tone={toneFor(state.status)}>{state.status}</Badge>
      </td>
      <td className="px-2.5 py-2.5 align-middle">
        <span className="inline-flex items-center gap-1 mono text-[12px]">
          {cfg.harness === 'claude' ? <Bot size={13} /> : <Sparkles size={13} />}
          {cfg.harness}
        </span>
      </td>
      <td className="px-2.5 py-2.5 align-middle">
        {state.contextPercent != null ? (
          <ContextMeter value={state.contextPercent} />
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-2.5 py-2.5 align-middle max-w-[280px]">
        <div className="inline-flex items-center gap-1 text-[12px] mono truncate">
          {state.activity ? (
            <>
              <Activity size={11} className="text-accent shrink-0" />
              <span className="truncate">{state.activity}</span>
            </>
          ) : (
            <span className="text-muted">—</span>
          )}
        </div>
      </td>
      <td className="px-2.5 py-2.5 align-middle text-muted text-[12px] mono">{fmtRelative(state.lastActivityAt)}</td>
    </tr>
  );
}

function ContextMeter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct >= 90 ? 'err' : pct >= 70 ? 'warn' : 'ok';
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 rounded-full bg-border-soft overflow-hidden">
        <div
          className={tone === 'err' ? 'h-full bg-err' : tone === 'warn' ? 'h-full bg-warn' : 'h-full bg-ok'}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="mono text-[12px]">{pct}%</span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="grid gap-1.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-12 rounded-md border border-border-soft bg-surface-2 animate-pulse" />
      ))}
    </div>
  );
}
