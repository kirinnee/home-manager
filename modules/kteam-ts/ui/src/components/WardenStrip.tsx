// Fleet-health "checks" strip — quiet by default. Surfaces the warden sweep:
// last sweep time + anomaly count + cadence. Polls /v1/warden/status every 30s
// (paused when the tab is hidden, per the perf budget) and self-hides if the
// route is absent/erroring on an older daemon.

import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';
import type { WardenStatusView } from '../types';
import { fmtRelative } from '../lib/utils';

const POLL_MS = 30_000;

export function WardenStrip() {
  const [status, setStatus] = useState<WardenStatusView | null>(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const s = await api.wardenStatus();
        if (!cancelled) {
          setStatus(s);
          setFailed(false);
        }
      } catch {
        if (!cancelled && !status) setFailed(true);
      }
    };
    void poll();
    timer.current = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer.current) window.clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed || !status) return null; // absent on older daemons → stay hidden

  const anomalies = status.anomalies ?? [];
  const count = anomalies.length;
  const clean = count === 0;
  const interval = status.config?.intervalMinutes;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-soft bg-surface-2 px-3 py-2 text-[12px]">
      <span className="inline-flex items-center gap-1.5 font-medium text-fg-soft">
        {clean ? <ShieldCheck size={14} className="text-ok" /> : <ShieldAlert size={14} className="text-warn" />}
        Fleet checks
      </span>
      <span className="text-border">·</span>
      <span className="mono text-muted">last sweep {status.lastSweepAt ? fmtRelative(status.lastSweepAt) : '—'}</span>
      <span className="text-border">·</span>
      <span className={clean ? 'mono text-ok' : 'mono font-medium text-warn'}>
        {clean ? 'no anomalies' : `${count} ${count === 1 ? 'anomaly' : 'anomalies'}`}
      </span>
      {interval != null && (
        <>
          <span className="text-border">·</span>
          <span className="mono text-faint">every {interval}m</span>
        </>
      )}
      {status.liveWarden && (
        <>
          <span className="text-border">·</span>
          <span className="mono text-accent">warden live</span>
        </>
      )}
      {!clean && (
        <span
          className="mono ml-auto min-w-0 truncate text-faint"
          title={anomalies.map(a => `${a.kind}: ${a.teammate ?? a.sessionId}`).join('\n')}
        >
          {anomalies
            .slice(0, 3)
            .map(a => a.kind)
            .join(', ')}
          {count > 3 ? ` +${count - 3}` : ''}
        </span>
      )}
    </div>
  );
}
