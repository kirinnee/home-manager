// Terminal tab content for SessionChatPage. Mirrors what the legacy
// PaneSnapshotDrawer does, but as a first-class view: polling is gated on
// (a) this tab being visible AND (b) the document being visible, sticky
// scroll stays put unless the reader is already pinned to the bottom, and
// the header line surfaces the tmux session name + a "cached · updated <n>s
// ago" hint so the user always knows how fresh the snapshot is.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';
import { api, ApiError } from '../lib/api';

interface Props {
  sessionId: string;
  tmuxSession: string;
}

const POLL_MS = 3000;

export function TerminalView({ sessionId, tmuxSession }: Props) {
  const [text, setText] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // `stale` is true only after we've successfully received at least one
  // snapshot — keeps the initial-load case from flashing a "stale" chip
  // before the first poll lands.
  const [stale, setStale] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  // Tick to drive the "updated <n>s ago" re-render every second.
  const [now, setNow] = useState(() => Date.now());

  const scrollerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const timerRef = useRef<number | null>(null);

  const tick = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return; // pause on visibilitychange
    try {
      const t = await api.snapshot(sessionId, false);
      setText(t);
      setLastUpdatedAt(Date.now());
      setStale(false);
      setErrorMsg(null);
      // Stick to the bottom only if the reader was already pinned; otherwise
      // leave their scroll position exactly where it was.
      requestAnimationFrame(() => {
        const el = scrollerRef.current;
        if (el && atBottomRef.current) {
          el.scrollTop = el.scrollHeight;
          el.scrollLeft = 0;
        }
      });
    } catch (e) {
      // Keep the last good content; surface a subtle stale indicator so the
      // user knows the daemon is momentarily unreachable.
      setStale(true);
      setErrorMsg(e instanceof ApiError ? e.message : String(e));
    }
  }, [sessionId]);

  // Poll loop. Polling is conditioned on document.visibilityState — when the
  // tab is in the background we stop the interval entirely (no work for the
  // daemon, no churn on the UI). The Terminal tab being active is handled by
  // the parent (it just renders / unmounts this component).
  useEffect(() => {
    let cancelled = false;

    const start = () => {
      if (cancelled) return;
      if (timerRef.current) return;
      // First fetch fires immediately; subsequent ones every POLL_MS.
      void tick();
      timerRef.current = window.setInterval(() => void tick(), POLL_MS);
    };
    const stop = () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tick]);

  // Re-render once per second so the "updated <n>s ago" hint stays accurate.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // 4px slop covers sub-pixel rounding when content height matches the
    // viewport exactly.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distance < 4;
  }, []);

  const updatedAgo = lastUpdatedAt ? fmtAgo(now - lastUpdatedAt) : '—';
  const updatedAbs = lastUpdatedAt ? fmtClock(lastUpdatedAt) : '';

  return (
    <div className="flex-1 min-h-0 rounded-md border border-border bg-surface flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-b border-border-soft bg-surface-2 text-[11.5px] text-fg-soft">
        <span className="inline-flex items-center gap-1.5 shrink-0">
          <Terminal size={13} className="text-muted" />
          <span className="font-semibold text-fg">Terminal</span>
        </span>
        <span className="mono text-muted truncate min-w-0 max-w-[18rem]" title={tmuxSession}>
          tmux: {tmuxSession}
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5 mono text-[11px] shrink-0">
          {stale ? (
            <span className="text-warn" title={errorMsg ?? 'stale'}>
              stale · last update {updatedAgo} ago
              {errorMsg ? ` · ${errorMsg}` : ''}
            </span>
          ) : (
            <span className="text-muted" title={updatedAbs}>
              cached · updated {updatedAgo} ago
            </span>
          )}
        </span>
      </div>
      <div ref={scrollerRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto bg-code-bg text-fg-soft">
        <pre className="m-0 whitespace-pre px-3 py-2 mono text-[12px] leading-[1.5] min-w-max">
          {text || '(no snapshot yet)'}
        </pre>
      </div>
    </div>
  );
}

function fmtAgo(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
