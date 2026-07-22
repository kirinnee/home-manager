// Session header — two tight rows, truncation-safe, no layout jumps.
//   row 1: identity (teammate · task · label · status) + controls
//   row 2: dense mono status strip (model · turn · wrapper · context · liveness · ws)
//
// The per-second liveness/elapsed ticking is isolated in <LivenessStrip/> so
// it re-renders only itself, never the transcript.

import { memo, useEffect, useState } from 'react';
import { ChevronLeft, Pause, Play, StopCircle, ZapOff } from 'lucide-react';
import type { SessionView } from '../types';
import { Badge, Button, ActionGroup } from './Primitives';
import { Link } from '../lib/router';
import { toneFor } from '../lib/utils';

interface Props {
  view: SessionView;
  liveStatus: 'connecting' | 'open' | 'closed';
  isTerminal: boolean;
  isKillFailed: boolean;
  hasToken: boolean;
  onInterrupt: () => void;
  onStop: () => void;
  onResume: () => void;
}

export const SessionHeader = memo(function SessionHeader({
  view,
  liveStatus,
  isTerminal,
  isKillFailed,
  hasToken,
  onInterrupt,
  onStop,
  onResume,
}: Props) {
  const { config, state } = view;
  const title = config.teammate || config.name || config.id;

  return (
    <div className="mt-3 mb-2 flex flex-col gap-1.5">
      {/* row 1 — identity + controls */}
      <div className="flex items-center gap-2.5 min-w-0">
        <Link to="/" className="inline-flex shrink-0 items-center gap-1 text-muted hover:text-fg text-[13px]">
          <ChevronLeft size={15} />
        </Link>
        <h1 className="m-0 shrink-0 text-[1.15rem] font-semibold tracking-tight">{title}</h1>
        {config.teammate && config.name && (
          <span className="min-w-0 truncate text-[13px] text-muted" title={config.name}>
            {config.name}
          </span>
        )}
        {config.label && (
          <Badge tone="accent" className="shrink-0">
            {config.label}
          </Badge>
        )}
        <Badge tone={toneFor(state.status)} className="shrink-0">
          {state.status}
        </Badge>
        {state.nudgedAt && (
          <Badge tone="warn" className="shrink-0">
            nudged
          </Badge>
        )}

        <ActionGroup className="ml-auto shrink-0">
          {!isTerminal && hasToken && (
            <Button size="sm" variant="outline" onClick={onInterrupt} title="Interrupt the active turn">
              <Pause size={12} /> Interrupt
            </Button>
          )}
          {(!isTerminal || isKillFailed) && hasToken && (
            <Button size="sm" variant="danger" onClick={onStop} title="Stop the session">
              <StopCircle size={12} /> Stop
            </Button>
          )}
          {isTerminal && !isKillFailed && hasToken && (
            <Button size="sm" variant="primary" onClick={onResume} title="Resume a finished session">
              <Play size={12} /> Resume
            </Button>
          )}
          {isKillFailed && (
            <span className="inline-flex items-center gap-1 text-[12px] text-warn">
              <ZapOff size={12} /> kill failed — Stop first
            </span>
          )}
        </ActionGroup>
      </div>

      {/* row 2 — dense mono status strip */}
      <LivenessStrip view={view} liveStatus={liveStatus} />
    </div>
  );
});

const AGE_KEYS = [
  ['txn', 'lastTranscriptAt'],
  ['tok', 'lastTokenAdvanceAt'],
  ['ctr', 'lastCounterAdvanceAt'],
  ['sub', 'lastSubprocessAt'],
  ['pane', 'lastPaneAt'],
] as const;

const LivenessStrip = memo(function LivenessStrip({
  view,
  liveStatus,
}: {
  view: SessionView;
  liveStatus: 'connecting' | 'open' | 'closed';
}) {
  // Self-contained 1s tick — re-renders only this strip.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const { config, state } = view;
  const model = config.model || config.modelHint || 'default';
  const ctx = state.contextPercent;
  const ctxTone = ctx == null ? '' : ctx >= 90 ? 'text-err' : ctx >= 75 ? 'text-warn' : 'text-fg-soft';

  // Defensive liveness readout: render only the signs the API actually
  // provides (melanie's ledger fields may be absent on older daemons).
  const now = Date.now();
  const ages = AGE_KEYS.map(([label, key]) => {
    const at = state[key];
    if (!at) return null;
    const s = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
    return `${label} ${s}s`;
  }).filter(Boolean) as string[];

  const dot = liveStatus === 'open' ? 'bg-ok' : liveStatus === 'connecting' ? 'bg-warn' : 'bg-err';

  return (
    <div className="flex min-w-0 items-center gap-x-3 gap-y-0.5 overflow-hidden text-[11.5px] text-muted mono whitespace-nowrap">
      <span className="shrink-0 text-fg-soft">{model}</span>
      <Sep />
      <span className="shrink-0">turn {state.turn}</span>
      <Sep />
      <span className="min-w-0 truncate text-faint" title={`${config.binary} · ${config.harness} TUI`}>
        {config.binary} · {config.harness}
      </span>
      {ctx != null && (
        <>
          <Sep />
          <span className={`shrink-0 ${ctxTone}`}>context {ctx}%</span>
        </>
      )}
      {ages.length > 0 && (
        <>
          <Sep />
          <span
            className="shrink-0 text-faint"
            title="liveness ledger: seconds since transcript / token / counter / subprocess / pane life-signs"
          >
            {ages.join(' · ')}
          </span>
        </>
      )}
      <span className="ml-auto inline-flex shrink-0 items-center gap-1">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
        ws {liveStatus}
      </span>
    </div>
  );
});

function Sep() {
  return <span className="shrink-0 text-border">·</span>;
}
