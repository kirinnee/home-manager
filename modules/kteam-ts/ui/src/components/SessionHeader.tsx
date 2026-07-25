// Session header — TWO rows, because the third was costing a line of transcript
// on every screen for facts that fit inline:
//   row 1: identity (teammate · task · label · mode · rc · status) + tabs + controls
//   row 2: wrapper/CLI · model · turn · context · liveness · ws
//
// The per-second liveness/context ticking lives in <LivenessStrip/> so it
// re-renders only itself; it is now an inline segment of row 2 rather than a
// row. Everything that used to be spelled out in prose ("autonomous ·
// reflex-supervised", the RC URL in full) is a `title` on the badge that
// already says it — the header states facts, it does not explain the tool.

import { memo, useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft, Pause, Play, StopCircle, ZapOff, Bot, Sparkles, Radio } from 'lucide-react';
import type { SessionView } from '../types';
import { Badge, Button, ActionGroup } from './Primitives';
import { ModeBadge } from './ModeBadge';
import { RcBadge } from './RcBadge';
import { Link } from '../lib/router';
import { toneFor } from '../lib/utils';
import { QuotaReadout } from './QuotaBadge';
import type { Quota } from '../lib/usage';

interface Props {
  view: SessionView;
  /** Resolved account quota for this session's wrapper; null = unknown. */
  quota: Quota | null;
  liveStatus: 'connecting' | 'open' | 'closed';
  isTerminal: boolean;
  isKillFailed: boolean;
  hasToken: boolean;
  onInterrupt: () => void;
  onStop: () => void;
  onResume: () => void;
  /** Chat/Terminal switch, hosted here instead of owning its own row. */
  tabs?: ReactNode;
  /** "who else is in this folder" toggle — next to the back link, because it
   *  is navigation, not a control that acts on this session. */
  folderToggle?: ReactNode;
}

export const SessionHeader = memo(function SessionHeader({
  view,
  quota,
  liveStatus,
  isTerminal,
  isKillFailed,
  hasToken,
  onInterrupt,
  onStop,
  onResume,
  tabs,
  folderToggle,
}: Props) {
  const { config, state } = view;
  const title = config.teammate || config.name || config.id;
  const model = config.model || config.modelHint || 'default';

  return (
    <div className="mt-1.5 mb-1 flex flex-col gap-1 border-b border-border-soft pb-1.5">
      {/* row 1 — identity + tabs + controls.
          Wraps: at 390px the identity badges plus the tab switch plus two
          buttons cannot share a line, and pushing Interrupt/Stop off the right
          edge (as the un-wrapped version did) makes them unreachable. Wrapping
          costs a line only on the widths where it is the alternative to losing
          the controls. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Link to="/" className="inline-flex shrink-0 items-center gap-1 text-muted hover:text-fg" title="All sessions">
          <ChevronLeft size={15} />
        </Link>
        {folderToggle}
        <h1 className="m-0 shrink-0 text-[15px] font-semibold tracking-tight">{title}</h1>
        {config.teammate && config.name && (
          <span className="min-w-0 truncate text-[12px] text-muted" title={config.name}>
            {config.name}
          </span>
        )}
        {config.label && (
          <Badge tone="accent" className="min-w-0 max-w-[40vw] truncate" title={config.label}>
            {config.label}
          </Badge>
        )}
        {/* Mode first: whether a human is driving decides how everything else on
            this page should be read — and whether the reflex layer applies. */}
        <ModeBadge mode={config.mode} />
        {/* RC next to mode: both answer "how can this session be driven?" */}
        <RcBadge remoteControl={config.remoteControl} url={state.remoteControlUrl} />
        <Badge tone={toneFor(state.status)} className="shrink-0">
          {/* A declared park reports 'waiting' exactly like an unanswered
              question does — say which, and until when. */}
          {state.waiting
            ? `parked: ${state.waiting.condition ?? 'external condition'}${
                state.waiting.until ? ` · until ${new Date(state.waiting.until).toLocaleTimeString()}` : ''
              }`
            : state.status}
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

        {tabs && <div className="ml-auto shrink-0">{tabs}</div>}

        <ActionGroup className={tabs ? 'shrink-0' : 'ml-auto shrink-0'}>
          {!isTerminal && hasToken && (
            <Button size="sm" variant="outline" onClick={onInterrupt} title="Interrupt the active turn">
              <Pause size={12} /> <span className="hidden sm:inline">Interrupt</span>
            </Button>
          )}
          {(!isTerminal || isKillFailed) && hasToken && (
            <Button size="sm" variant="danger" onClick={onStop} title="Stop the session">
              <StopCircle size={12} /> <span className="hidden sm:inline">Stop</span>
            </Button>
          )}
          {isTerminal && !isKillFailed && hasToken && (
            <Button size="sm" variant="primary" onClick={onResume} title="Resume a finished session">
              <Play size={12} /> <span className="hidden sm:inline">Resume</span>
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
        {/* The RC link, addressable. The mode badge in row 1 already carries
            MODE_HINT as its tooltip, so the sentence that used to sit here is
            gone rather than duplicated. */}
        {state.remoteControlUrl && (
          <>
            <Sep />
            <a
              href={state.remoteControlUrl}
              target="_blank"
              rel="noreferrer"
              title={state.remoteControlUrl}
              className="inline-flex min-w-0 shrink items-center gap-1 text-accent hover:underline"
            >
              <Radio size={11} className="shrink-0" />
              <span className="min-w-0 truncate">remote control</span>
            </a>
          </>
        )}
        {config.remoteControl && !state.remoteControlUrl && (
          <>
            <Sep />
            <span className="shrink-0 text-faint" title="launched with --rc; RC link not announced yet">
              rc pending
            </span>
          </>
        )}
        <Sep />
        <LivenessStrip view={view} quota={quota} liveStatus={liveStatus} />
      </div>
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
  quota,
  liveStatus,
}: {
  view: SessionView;
  quota: Quota | null;
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
    <>
      {ctx != null ? (
        <span className={`shrink-0 ${ctxTone}`}>context {ctx}%</span>
      ) : (
        <span className="shrink-0 text-faint">context —</span>
      )}
      {/* Always present, like context: a header that silently drops the quota
          when the feed has no record is indistinguishable from a UI that never
          rendered one — which is exactly how this looked before. `showUnknown`
          makes "we don't know" a visible, explainable state. */}
      <Sep />
      <QuotaReadout quota={quota} className="text-faint" showUnknown />
      {ages.length > 0 && (
        <>
          <Sep />
          <span
            className="hidden min-w-0 truncate text-faint sm:inline"
            title="liveness ledger: seconds since transcript / token / counter / subprocess / pane life-signs"
          >
            {ages.join(' · ')}
          </span>
        </>
      )}
      <span className="ml-auto inline-flex shrink-0 items-center gap-1" title={`websocket ${liveStatus}`}>
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="hidden sm:inline">ws {liveStatus}</span>
      </span>
    </>
  );
});

function Sep() {
  return <span className="shrink-0 text-border">·</span>;
}
