// Live "working" indicator. Shows the harness's verbatim activity line when
// available (parsed by the daemon from the pane), with its jumpy embedded
// elapsed stripped and replaced by a fluid, client-side elapsed that ticks
// every 1s from `since` — zero extra network (turn-005 fluid timers).

import { useLiveTick } from '../hooks/useLiveTick';

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export function ThinkingIndicator({ activity, since }: { activity?: string | null; since?: number | null }) {
  // Re-render once a second to advance the fluid elapsed — but FREEZE while the
  // reader holds a selection: this indicator lives inside the transcript, and on
  // WebKit/iOS a per-second text mutation next to a highlight collapses it (see
  // useLiveTick). The count catches up the moment the selection clears.
  useLiveTick();

  const raw = (activity && activity.trim()) || 'Working…';
  // Drop a trailing "(34s · 2.1k tokens)" style parenthetical — we render our
  // own fluid elapsed instead of the daemon's 5s-quantised one.
  const label = raw.replace(/\s*\([^)]*\)\s*$/, '').trim() || 'Working…';
  const elapsed = since != null ? fmtElapsed(Date.now() - since) : null;

  return (
    <div className="flex items-center gap-2 text-[12.5px]">
      <span className="flex gap-0.5">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: '0ms' }} />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: '120ms' }} />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: '240ms' }} />
      </span>
      <span className="mono shimmer">{label}</span>
      {elapsed && <span className="mono text-faint">{elapsed}</span>}
    </div>
  );
}
