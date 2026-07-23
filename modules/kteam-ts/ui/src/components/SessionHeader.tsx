// Session header — decrowded into distinct rows so nothing is squeezed:
//   row 1: identity (teammate · task · label · status) + controls
//   row 2: wrapper/CLI · model · turn · mode
//   row 3: context + liveness + ws  (self-ticking, isolated from the transcript)
//
// The per-second liveness/context ticking lives in <LivenessStrip/> so it
// re-renders only itself.

import { memo, useEffect, useState } from 'react';
import { ChevronLeft, Pause, Play, StopCircle, ZapOff, Bot, Sparkles } from 'lucide-react';
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
  const model = config.model || config.modelHint || 'default';

  return (
    <div className="mt-3 mb-2 flex flex-col gap-1.5 border-b border-border-soft pb-2.5">
      {/* row 1 — identity + controls */}
      <div className="flex items-center gap-2.5 min-w-0">
        <Link to="/" className="inline-flex shrink-0 items-center gap-1 text-muted hover:text-fg" title="All sessions">
          <ChevronLeft size={16} />
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
        {state.needsHuman && (
          <Badge tone="err" className="shrink-0" title={state.needsHuman}>
            needs human
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

      {/* row 2 — wrapper / model / turn / mode */}
      <div className="flex min-w-0 items-center gap-x-3 overflow-hidden text-[11.5px] text-muted mono whitespace-nowrap">
        <span
          className="inline-flex shrink-0 items-center gap-1 text-fg-soft"
          title={`${config.binary} · ${config.harness} TUI`}
        >
          {config.harness === 'claude' ? (
            <Bot size={12} className="text-faint" />
          ) : (
            <Sparkles size={12} className="text-faint" />
          )}
          <span className="min-w-0 truncate">{config.binary}</span>
        </span>
        <Sep />
        <span className="shrink-0 text-fg-soft">{model}</span>
        <Sep />
        <span className="shrink-0">turn {state.turn}</span>
        <Sep />
        <span className="shrink-0 text-faint">{config.mode} mode</span>
      </div>

      {/* row 3 — context + liveness + ws */}
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
  // Self-contained 1s tick — re-renders only this strip (fluid liveness ages).
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const { state } = view;
  const ctx = state.contextPercent;
  const ctxTone = ctx == null ? '' : ctx >= 90 ? 'text-err' : ctx >= 75 ? 'text-warn' : 'text-fg-soft';

  const now = Date.now();
  const ages = AGE_KEYS.map(([label, key]) => {
    const at = state[key];
    if (!at) return null;
    const s = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
    return `${label} ${s}s`;
  }).filter(Boolean) as string[];

  const dot = liveStatus === 'open' ? 'bg-ok' : liveStatus === 'connecting' ? 'bg-warn' : 'bg-err';

  return (
    <div className="flex min-w-0 items-center gap-x-3 overflow-hidden text-[11.5px] text-muted mono whitespace-nowrap">
      {ctx != null ? (
        <span className={`shrink-0 ${ctxTone}`}>context {ctx}%</span>
      ) : (
        <span className="shrink-0 text-faint">context —</span>
      )}
      {ages.length > 0 && (
        <>
          <Sep />
          <span
            className="min-w-0 truncate text-faint"
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
