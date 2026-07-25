// Session header — ONE compact summary bar.
//
// It used to be two dense rows: identity badges, mode, RC, status, nudged,
// needs-human, wrapper, model, turn, context, five liveness ages, quota and the
// socket state. Every fact there is real, and none of them is a fact you need
// continuously — on a 100dvh page they cost two lines of transcript on every
// screen and read as a badge wall rather than as a status.
//
// What stays here is what you STEER by:
//   back · status (shape + word) · who/what · exceptions · tabs · controls · Details
//
// Everything else moved into <SessionDetails/>, an accessible right-side drawer
// with four labelled groups (Identity, Runtime, Progress, Budget). The two facts
// that must never be one click away — a declared park and needs-human — keep a
// rest-visible chip up here, because they are what a lead scans for.

import { memo, useId, useState, type ReactNode } from 'react';
import { ChevronLeft, Pause, Play, StopCircle, ZapOff, Info } from 'lucide-react';
import type { SessionView } from '../types';
import { Button, ActionGroup } from './Primitives';
import { Link } from '../lib/router';
import { cn, toneFor, type Tone } from '../lib/utils';
import { SessionDetails, type LiveStatus } from './SessionDetails';
import type { Quota } from '../lib/usage';

interface Props {
  view: SessionView;
  /** Resolved account quota for this session's wrapper; null = unknown. */
  quota: Quota | null;
  liveStatus: LiveStatus;
  isTerminal: boolean;
  isKillFailed: boolean;
  hasToken: boolean;
  onInterrupt: () => void;
  onStop: () => void;
  onResume: () => void;
  /** Chat/Terminal switch, hosted here instead of owning its own row. */
  tabs?: ReactNode;
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
}: Props) {
  const { config, state } = view;
  const title = config.teammate || config.name || config.id;
  const subtitle = config.teammate && config.name ? config.name : config.label;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const panelId = `${detailsId}-panel`;

  return (
    <div className="mt-1.5 mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-soft pb-1.5">
      <Link
        to="/"
        aria-label="Back to all sessions"
        title="All sessions"
        className="inline-flex shrink-0 items-center text-muted hover:text-fg"
      >
        <ChevronLeft size={15} aria-hidden="true" />
      </Link>

      <StatusChip status={state.status} parked={Boolean(state.waiting)} />

      <h1 className="m-0 min-w-0 max-w-[42vw] truncate text-[15px] font-semibold tracking-tight" title={title}>
        {title}
      </h1>
      {subtitle && (
        <span className="hidden min-w-0 max-w-[28vw] truncate text-[12px] text-muted sm:inline" title={subtitle}>
          {subtitle}
        </span>
      )}

      {/* The two exceptions that stay at rest-visible priority. Both carry their
          own words — the colour is reinforcement, never the message. */}
      {state.waiting && (
        <span
          className="inline-flex min-w-0 max-w-[34vw] items-center rounded border border-warn-border bg-warn-bg px-1.5 py-0.5 text-[11px] font-medium text-warn"
          title={`parked${state.waiting.until ? ` until ${new Date(state.waiting.until).toLocaleString()}` : ''}: ${
            state.waiting.condition ?? 'external condition'
          }`}
        >
          <span className="truncate">parked: {state.waiting.condition ?? 'external condition'}</span>
        </span>
      )}
      {state.needsHuman && (
        <span
          className="inline-flex shrink-0 items-center rounded border border-err-border bg-err-bg px-1.5 py-0.5 text-[11px] font-semibold text-err"
          title={state.needsHuman}
        >
          needs human
        </span>
      )}

      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {tabs}
        <ActionGroup>
          {!isTerminal && hasToken && (
            <Button
              size="sm"
              variant="outline"
              onClick={onInterrupt}
              aria-label="Interrupt the active turn"
              title="Interrupt the active turn"
            >
              <Pause size={12} aria-hidden="true" /> <span className="hidden sm:inline">Interrupt</span>
            </Button>
          )}
          {(!isTerminal || isKillFailed) && hasToken && (
            <Button size="sm" variant="danger" onClick={onStop} aria-label="Stop this session" title="Stop the session">
              <StopCircle size={12} aria-hidden="true" /> <span className="hidden sm:inline">Stop</span>
            </Button>
          )}
          {isTerminal && !isKillFailed && hasToken && (
            <Button
              size="sm"
              variant="primary"
              onClick={onResume}
              aria-label="Resume this finished session"
              title="Resume a finished session"
            >
              <Play size={12} aria-hidden="true" /> <span className="hidden sm:inline">Resume</span>
            </Button>
          )}
          {isKillFailed && (
            <span
              className="inline-flex items-center gap-1 text-[12px] text-warn"
              title="the pane could not be killed; Stop it first"
            >
              <ZapOff size={12} aria-hidden="true" /> kill failed — Stop first
            </span>
          )}
          <Button
            id={detailsId}
            size="sm"
            variant="outline"
            onClick={() => setDetailsOpen(open => !open)}
            aria-expanded={detailsOpen}
            aria-controls={detailsOpen ? panelId : undefined}
            aria-label="Session details"
            title="Identity, runtime, progress and budget for this session"
          >
            <Info size={12} aria-hidden="true" /> <span className="hidden sm:inline">Details</span>
          </Button>
        </ActionGroup>
      </div>

      <SessionDetails
        view={view}
        quota={quota}
        liveStatus={liveStatus}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        labelledBy={detailsId}
      />
    </div>
  );
});

/** Status as SHAPE + WORD. The shape is what makes it readable without colour
 *  (a themed UI with five families cannot rely on hue alone, and neither can a
 *  colour-blind reader): filled circle = fine, diamond = working/attention,
 *  square = failed, hollow ring = pending. The word is always there. */
const SHAPE: Record<Tone, string> = {
  ok: 'rounded-full bg-ok',
  warn: 'rotate-45 rounded-[1px] bg-warn',
  err: 'rounded-[1px] bg-err',
  pend: 'rounded-full border border-pend bg-transparent',
  accent: 'rounded-full bg-accent',
};

const TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
  pend: 'text-pend',
  accent: 'text-accent',
};

function StatusChip({ status, parked }: { status: string; parked: boolean }) {
  const tone = toneFor(status);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-semibold"
      title={parked ? `${status} — parked on a declared external condition` : `session status: ${status}`}
    >
      <span className={cn('inline-block h-2 w-2 shrink-0', SHAPE[tone])} aria-hidden="true" />
      <span className={TEXT[tone]}>{status}</span>
    </span>
  );
}
