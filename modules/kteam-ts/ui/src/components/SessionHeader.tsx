// Session header — ONE compact summary bar.
//
// ROUND 8 — ON A PHONE IT IS ONE ROW, AND IT IS THE ONLY ROW.
//
// Measured at 390x844 it was three: the app bar's breadcrumb, this bar's
// identity line, and this bar's WRAPPED action line (the `flex-wrap` below plus
// four 44px touch targets cannot share 390px with a title). 141px of chrome
// stating the session's name twice. So below DRAWER_MAX the app bar is
// suppressed entirely (App.tsx) and this becomes the single top row, `nowrap`,
// carrying everything it re-homed:
//
//   [fleet] [‹ ◆ status teammate ————] [chat|term] [theme] [⋯]
//
// The composition is deliberate and was costed against 360px, not 390px: Back,
// the status shape and the identity are ONE flexible labelled target rather than
// three, because eight separate 44px controls in one row do not fit at any phone
// width. Interrupt/Stop/Resume join Details behind the `⋯` overflow — which is
// the existing focus-trapped details dialog, not a new popover — so the row
// holds five targets and a flexible title instead of nine.
//
// It used to be two dense rows: identity badges, mode, RC, status, nudged,
// needs-human, wrapper, model, turn, context, five liveness ages, quota and the
// socket state. Every fact there is real, and none of them is a fact you need
// continuously — on a 100dvh page they cost two lines of transcript on every
// screen and read as a badge wall rather than as a status.
//
// What stays here is what you STEER by:
//   back · status (shape + word) · who/what · exceptions · tabs · controls · overflow
//
// Everything else moved into <SessionDetails/>, an accessible bottom sheet with
// labelled Identity, Lineage, Runtime, Progress and Budget groups. The two facts
// that must never be one click away — a declared park and needs-human — keep a
// rest-visible chip up here, because they are what a lead scans for.

import { memo, useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronLeft, Pause, Play, StopCircle, ZapOff, MoreHorizontal } from 'lucide-react';
import type { SessionView } from '../types';
import { Button, ActionGroup } from './Primitives';
import { Link } from '../lib/router';
import { cn, toneFor, type Tone } from '../lib/utils';
import { SessionDetails, type LiveStatus } from './SessionDetails';
import { SidebarDrawerTrigger } from './AgentSidebar';
import { ThemeToggle } from './ThemeToggle';
import type { Quota } from '../lib/usage';

interface Props {
  view: SessionView;
  /** Retained chat panes stay mounted; false means this header is backgrounded. */
  active?: boolean;
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
  /** Phone chrome: one nowrap row that also absorbs the suppressed app bar's
   *  drawer trigger and theme picker, and moves the session controls behind the
   *  details overflow. Desktop never sets it and never changes shape. */
  compact?: boolean;
  /** Opens the fleet drawer. Only meaningful while `compact` — above DRAWER_MAX
   *  the app bar still owns the trigger. */
  onOpenSidebar?: () => void;
  /** Mount the theme picker. THE THEME PICKER MUST BE A SINGLE INSTANCE.
   *
   *  `useTheme` holds the preference in component state and writes it to
   *  localStorage; a same-document write fires no `storage` event, so a second,
   *  RETAINED session pane (App.tsx keeps up to MAX_MOUNTED_SESSIONS mounted so
   *  drafts and scroll survive navigation) would sit on a stale family and
   *  re-assert it on its next render. Only the pane the reader is looking at
   *  renders one. */
  showTheme?: boolean;
}

export const SessionHeader = memo(function SessionHeader({
  view,
  active,
  quota,
  liveStatus,
  isTerminal,
  isKillFailed,
  hasToken,
  onInterrupt,
  onStop,
  onResume,
  tabs,
  compact,
  onOpenSidebar,
  showTheme = true,
}: Props) {
  const { config, state } = view;
  const title = config.teammate || config.name || config.id;
  const subtitle = config.teammate && config.name ? config.name : config.label;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const panelId = `${detailsId}-panel`;

  // A retained background pane must not keep an invisible modal or its
  // open-only lineage subscription alive after route navigation.
  useEffect(() => {
    if (active === false) setDetailsOpen(false);
  }, [active]);

  const actions = (
    <SessionActions
      isTerminal={isTerminal}
      isKillFailed={isKillFailed}
      hasToken={hasToken}
      onInterrupt={onInterrupt}
      onStop={onStop}
      onResume={onResume}
      labels={Boolean(compact)}
    />
  );
  const details = (
    <SessionDetails
      id={panelId}
      view={view}
      quota={quota}
      liveStatus={liveStatus}
      open={detailsOpen}
      onClose={() => setDetailsOpen(false)}
      labelledBy={detailsId}
      // On a phone the sheet is where Interrupt/Stop/Resume live: it is already
      // a real dialog with a focus trap, an Escape path and restored focus, so
      // the controls keep a robust home instead of a second ad-hoc popover.
      actions={compact ? actions : undefined}
    />
  );

  if (compact) {
    const tone = toneFor(state.status);
    return (
      <>
        <div
          data-density-region="session-header"
          data-density-row="primary"
          className="kt-session-bar mt-0.5 mb-0.5 flex min-w-0 flex-nowrap items-center gap-xs border-b border-border-soft pb-0.5"
        >
          {onOpenSidebar && <SidebarDrawerTrigger onOpen={onOpenSidebar} />}

          {/* BACK + STATUS + IDENTITY ARE ONE TARGET. Three 44px boxes for three
              facts that are read together does not fit at 360px, and the middle
              one was never interactive anyway. The link's accessible name spells
              out all three, so nothing is lost to a screen reader; the shape is
              what makes the state readable without colour, and the WORD beside it
              collapses (visually only) below 420px — see `.kt-status-word`. */}
          <Link
            to="/"
            aria-label={`Back to all sessions. Currently ${title}, status ${state.status}`}
            title={`Back to all sessions — ${title} · ${state.status}`}
            className="inline-flex min-w-0 flex-1 items-center gap-xs text-muted hover:text-fg"
          >
            <ChevronLeft size={16} aria-hidden="true" className="shrink-0" />
            <span className={cn('inline-block h-2 w-2 shrink-0', SHAPE[tone])} aria-hidden="true" />
            <span className={cn('kt-status-word shrink-0 text-meta font-semibold', TEXT[tone])} aria-hidden="true">
              {state.status}
            </span>
            <h1 className="m-0 min-w-0 truncate text-ui font-semibold tracking-tight text-fg">{title}</h1>
          </Link>

          {/* Shed while typing: you are writing into Chat, so the switch to
              Terminal and the theme picker are not what the row is for. Back,
              identity, the fleet drawer and the session controls all stay. */}
          <div data-kb-hide className="shrink-0">
            {tabs}
          </div>
          {showTheme && (
            <div data-kb-hide className="shrink-0">
              <ThemeToggle />
            </div>
          )}
          <Button
            id={detailsId}
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setDetailsOpen(open => !open)}
            aria-expanded={detailsOpen}
            aria-controls={detailsOpen ? panelId : undefined}
            aria-label="Session controls and details"
            title="Interrupt, stop, resume, and this session's identity, runtime, progress and budget"
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </Button>
        </div>

        {/* The two exceptions keep rest-visible priority, and they cannot share a
            nowrap row — so they get a conditional strip that a normal running
            session never pays for. */}
        {(state.waiting || state.needsHuman) && (
          <div
            data-density-region="session-exceptions"
            className="mb-0.5 flex min-w-0 flex-nowrap items-center gap-xs overflow-hidden"
          >
            <ExceptionChips state={state} wide />
          </div>
        )}

        {details}
      </>
    );
  }

  return (
    <div
      data-density-region="session-header"
      data-density-row="primary"
      className="mt-1.5 mb-1 flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs border-b border-border-soft pb-1.5"
    >
      <Link
        to="/"
        aria-label="Back to all sessions"
        title="All sessions"
        className="inline-flex shrink-0 items-center text-muted hover:text-fg"
      >
        <ChevronLeft size={15} aria-hidden="true" />
      </Link>

      <StatusChip status={state.status} parked={Boolean(state.waiting)} />

      <h1 className="m-0 min-w-0 max-w-[42vw] truncate text-title font-semibold tracking-tight" title={title}>
        {title}
      </h1>
      {subtitle && (
        <span className="hidden min-w-0 max-w-[28vw] truncate text-cell text-muted sm:inline" title={subtitle}>
          {subtitle}
        </span>
      )}

      {/* The two exceptions that stay at rest-visible priority. Both carry their
          own words — the colour is reinforcement, never the message. */}
      <ExceptionChips state={state} />

      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-sm">
        {tabs}
        <ActionGroup>
          {actions}
          <Button
            id={detailsId}
            size="sm"
            variant="outline"
            onClick={() => setDetailsOpen(open => !open)}
            aria-expanded={detailsOpen}
            aria-controls={detailsOpen ? panelId : undefined}
            aria-label="Session controls and details"
            title="Controls, identity, lineage, runtime, progress and budget"
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </Button>
        </ActionGroup>
      </div>

      {details}
    </div>
  );
});

/** Interrupt / Stop / Resume, and the kill-failed explanation that replaces
 *  them. Rendered inline in the desktop header and inside the details dialog on
 *  a phone — `labels` is the only difference, because the dialog has room for
 *  the words that the header hides below `sm`. */
function SessionActions({
  isTerminal,
  isKillFailed,
  hasToken,
  onInterrupt,
  onStop,
  onResume,
  labels,
}: {
  isTerminal: boolean;
  isKillFailed: boolean;
  hasToken: boolean;
  onInterrupt: () => void;
  onStop: () => void;
  onResume: () => void;
  labels: boolean;
}) {
  const word = (text: string) => <span className={labels ? undefined : 'hidden sm:inline'}>{text}</span>;
  return (
    <>
      {!isTerminal && hasToken && (
        <Button
          size="sm"
          variant="outline"
          onClick={onInterrupt}
          aria-label="Interrupt the active turn"
          title="Interrupt the active turn"
        >
          <Pause size={12} aria-hidden="true" /> {word('Interrupt')}
        </Button>
      )}
      {(!isTerminal || isKillFailed) && hasToken && (
        <Button size="sm" variant="danger" onClick={onStop} aria-label="Stop this session" title="Stop the session">
          <StopCircle size={12} aria-hidden="true" /> {word('Stop')}
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
          <Play size={12} aria-hidden="true" /> {word('Resume')}
        </Button>
      )}
      {isKillFailed && (
        <span
          className="inline-flex items-center gap-xs text-cell text-warn"
          title="the pane could not be killed; Stop it first"
        >
          <ZapOff size={12} aria-hidden="true" /> kill failed — Stop first
        </span>
      )}
    </>
  );
}

/** A declared park and needs-human. Both carry their own words — the colour is
 *  reinforcement, never the message.
 *
 *  THE PHONE STRIP IS BUDGETED AT 24px. It is a whole extra band above the
 *  transcript that only an exceptional session pays, so it is capped — and
 *  measured, it was not: 26.1px in Studio and 29.7px in High Contrast, because
 *  the chip inherits the body leading (1.55, which is 21.7px on a 14px chip) and
 *  then adds 4px of padding and up to 4px of border on top.
 *
 *  So the WIDE variant tightens the leading to 1.25 and drops the vertical
 *  padding: the half-leading that a 1.25 line-height still carries is what keeps
 *  the tint from hugging the words, and it leaves descenders (`parked`) room
 *  inside the `truncate` box, which `leading-none` would have clipped. Nothing
 *  else moves — same words, same tint, same border, same badge radius, and
 *  neither chip is interactive so no target floor is involved. The desktop chip
 *  shares a row with the title and the controls and is untouched. */
const CHIP_BASE = 'inline-flex items-center rounded-badge border px-badge-x text-meta';
/** Tight enough for the 24px budget, loose enough to keep descenders. */
const CHIP_COMPACT = 'py-0 leading-tight';
const CHIP_DESKTOP = 'py-0.5';

function ExceptionChips({ state, wide }: { state: SessionView['state']; wide?: boolean }) {
  return (
    <>
      {state.waiting && (
        <span
          className={cn(
            CHIP_BASE,
            'min-w-0 border-warn-border bg-warn-bg font-medium text-warn',
            // The desktop chip is capped so it cannot crowd the title out; the
            // phone strip is its own line and has the whole width to spend.
            wide ? `max-w-full ${CHIP_COMPACT}` : `max-w-[34vw] ${CHIP_DESKTOP}`,
          )}
          title={`parked${state.waiting.until ? ` until ${new Date(state.waiting.until).toLocaleString()}` : ''}: ${
            state.waiting.condition ?? 'external condition'
          }`}
        >
          <span className="truncate">parked: {state.waiting.condition ?? 'external condition'}</span>
        </span>
      )}
      {state.needsHuman && (
        <span
          className={cn(
            CHIP_BASE,
            'shrink-0 border-err-border bg-err-bg font-semibold text-err',
            wide ? CHIP_COMPACT : CHIP_DESKTOP,
          )}
          title={state.needsHuman}
        >
          needs human
        </span>
      )}
    </>
  );
}

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
      className="inline-flex shrink-0 items-center gap-sm text-cell font-semibold"
      title={parked ? `${status} — parked on a declared external condition` : `session status: ${status}`}
    >
      <span className={cn('inline-block h-2 w-2 shrink-0', SHAPE[tone])} aria-hidden="true" />
      <span className={TEXT[tone]}>{status}</span>
    </span>
  );
}
