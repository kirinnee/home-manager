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
//   [fleet] [‹ task ———————————————————————————————] [⋯]
//
// The composition is deliberate and was costed against 360px, not 390px: Back
// and the identity are ONE flexible labelled target rather than two, because
// eight separate 44px controls in one row do not fit at any phone width.
// Interrupt/Stop/Resume join Details behind the `⋯` overflow — which is the
// existing focus-trapped details dialog, not a new popover — so the row holds
// three targets (fleet, back/identity, overflow) and a flexible title.
//
// THE PHONE ROW STATES NO STATUS AND NO FLEET COUNT. Both were carried here
// when this was the only row, and both are facts you glance at rather than
// steer by: the status shape/word duplicated what the transcript and the fleet
// list already say, and the `Users 12` count on the drawer trigger is a number
// nobody acts on from inside a session. They cost width in the one place where
// width is the scarce resource, so on a phone the trigger is icon-only and the
// status lives in the details sheet. Desktop keeps both, unchanged.
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

import {
  cloneElement,
  isValidElement,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ChevronLeft, Pause, Play, StopCircle, Users, ZapOff, MoreHorizontal, Settings } from 'lucide-react';
import type { SessionView } from '../types';
import { Button, ActionGroup } from './Primitives';
import { displayCallsign } from '../lib/callsign';
import { Link } from '../lib/router';
import { cn, toneFor, type Tone } from '../lib/utils';
import { SessionDetails, type LiveStatus } from './SessionDetails';
import { RenameSheet } from './RenameSheet';
import { MigrateSheet } from './MigrateSheet';
import { parseTaskName, TaskName, taskIsRedundant } from './TaskName';
import type { Quota } from '../lib/usage';
import { useStore } from '../lib/store';

const COMPACT_CALLSIGN_TITLE_RATIO = 0.6;

interface ViewSwitcherElementProps {
  iconOnly?: boolean;
  onChange?: (id: string) => void;
}

/** SessionChatPage owns the selected view and passes the switch as a React
 * element. Clone only its presentation callback for the compact sheet: labels
 * become visible and choosing a view dismisses the sheet immediately. */
export function viewSwitcherForSheet(tabs: ReactNode, onSelected: () => void): ReactNode {
  if (!isValidElement(tabs)) return tabs;
  const element = tabs as ReactElement<ViewSwitcherElementProps>;
  if (typeof element.props.onChange !== 'function') return tabs;
  const onChange = element.props.onChange;
  return cloneElement(element, {
    iconOnly: false,
    onChange: (id: string) => {
      onChange(id);
      onSelected();
    },
  });
}

/** The SessionChatPage-owned ViewTabs already carries the live setTab callback.
 * Reuse that exact path after Codex opens its native /model picker rather than
 * inventing a second navigation channel or touching page-owned tab state. */
export function openTerminalFromTabs(tabs: ReactNode): boolean {
  if (!isValidElement(tabs)) return false;
  const element = tabs as ReactElement<ViewSwitcherElementProps>;
  if (typeof element.props.onChange !== 'function') return false;
  element.props.onChange('terminal');
  return true;
}

export interface SessionHeaderIdentity {
  /** Source passed to TaskName; task first, then callsign, then id. */
  renderName: string;
  /** Plain equivalent of the visible TaskName content for accessible names. */
  primaryLabel: string;
  callsign: string;
  hasNamedTask: boolean;
  hasDistinctCallsign: boolean;
  desktopSecondary: string;
}

/** Keep the user's task as the session's headline everywhere. A missing task
 * falls back to callsign and then id so the bar can never become nameless. */
export function sessionHeaderIdentity(
  name: string | undefined,
  teammate: string | undefined,
  id: string,
  label?: string,
): SessionHeaderIdentity {
  const rawName = (name ?? '').trim();
  const parsed = parseTaskName(rawName);
  const hasNamedTask = Boolean(parsed.task);
  const callsign = displayCallsign(teammate);
  const renderName = hasNamedTask ? rawName : callsign || id;
  const prefixVisible = Boolean(parsed.prefix && parsed.prefix.toLowerCase() !== (teammate ?? '').trim().toLowerCase());
  const primaryLabel = hasNamedTask
    ? [prefixVisible ? parsed.prefix : null, parsed.task].filter(Boolean).join(' ')
    : renderName;
  const hasDistinctCallsign = Boolean(hasNamedTask && callsign && !taskIsRedundant(rawName, teammate));
  const fallbackSecondary = (label ?? '').trim();
  return {
    renderName,
    primaryLabel,
    callsign,
    hasNamedTask,
    hasDistinctCallsign,
    desktopSecondary: hasDistinctCallsign
      ? callsign
      : fallbackSecondary && fallbackSecondary !== primaryLabel
        ? fallbackSecondary
        : '',
  };
}

/** The plan's 60% rule is necessary but not sufficient in today's denser
 * phone row. Also require the task+callsign pair to fit the actual identity
 * slot, so adding secondary context can never force the task to truncate. */
export function compactCallsignFits(
  titleWidth: number,
  rowWidth: number,
  combinedWidth: number,
  identityWidth: number,
  hasDistinctCallsign = true,
): boolean {
  return (
    hasDistinctCallsign &&
    titleWidth > 0 &&
    rowWidth > 0 &&
    identityWidth > 0 &&
    titleWidth < rowWidth * COMPACT_CALLSIGN_TITLE_RATIO &&
    combinedWidth <= identityWidth
  );
}

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
   *  fleet trigger, and moves the view switch plus session controls behind the
   *  details overflow. Desktop never sets it and never changes shape. */
  compact?: boolean;
  /** Opens the fleet drawer. Only meaningful while `compact` — above DRAWER_MAX
   *  the app bar still owns the trigger. */
  onOpenSidebar?: () => void;
  /** Legacy caller compatibility. Theme now lives in Settings on mobile; the
   * desktop AppBar retains its established standalone picker. */
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
}: Props) {
  const { config, state } = view;
  const store = useStore();
  const identity = sessionHeaderIdentity(config.name, config.teammate, config.id, config.label);
  const compactRowRef = useRef<HTMLDivElement>(null);
  const compactIdentityRef = useRef<HTMLSpanElement>(null);
  const compactTitleMeasureRef = useRef<HTMLSpanElement>(null);
  const compactCombinedMeasureRef = useRef<HTMLSpanElement>(null);
  const [showCompactCallsign, setShowCompactCallsign] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const detailsId = useId();
  const panelId = `${detailsId}-panel`;

  // A retained background pane must not keep an invisible modal or its
  // open-only lineage subscription alive after route navigation.
  useEffect(() => {
    if (active === false) {
      setDetailsOpen(false);
      setRenameOpen(false);
      setMigrateOpen(false);
    }
  }, [active]);

  // Measure the task at its real rendered font, including text-size preference
  // and any TaskName prefix chip. ResizeObserver catches viewport, font and
  // text-adjust changes without a competing breakpoint or modality hook.
  useLayoutEffect(() => {
    if (!compact || !identity.hasDistinctCallsign) {
      setShowCompactCallsign(false);
      return;
    }

    const update = () => {
      const row = compactRowRef.current;
      const slot = compactIdentityRef.current;
      const title = compactTitleMeasureRef.current;
      const combined = compactCombinedMeasureRef.current;
      if (!row || !slot || !title || !combined) return;
      const next = compactCallsignFits(
        title.getBoundingClientRect().width,
        row.getBoundingClientRect().width,
        combined.getBoundingClientRect().width,
        slot.getBoundingClientRect().width,
        identity.hasDistinctCallsign,
      );
      setShowCompactCallsign(current => (current === next ? current : next));
    };

    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    for (const element of [
      compactRowRef.current,
      compactIdentityRef.current,
      compactTitleMeasureRef.current,
      compactCombinedMeasureRef.current,
    ]) {
      if (element) observer?.observe(element);
    }
    window.addEventListener('resize', update);
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) update();
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [compact, identity.callsign, identity.hasDistinctCallsign, identity.renderName]);

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
  const compactActions = (
    <>
      {actions}
      <button
        type="button"
        onClick={() => {
          // Let the Details focus trap restore to its trigger before Settings
          // opens and takes focus. Opening both modal layers in one React batch
          // would let the closing sheet steal focus back from the new one.
          setDetailsOpen(false);
          requestAnimationFrame(() => store.openSettings());
        }}
        aria-label={MOBILE_SETTINGS.label}
        title={MOBILE_SETTINGS.title}
        className="kt-btn inline-flex min-h-[44px] items-center gap-sm"
      >
        <Settings size={14} aria-hidden="true" />
        Settings
      </button>
    </>
  );
  const compactViewSwitcher = compact ? viewSwitcherForSheet(tabs, () => setDetailsOpen(false)) : undefined;
  const details = (
    <>
      <SessionDetails
        id={panelId}
        view={view}
        quota={quota}
        liveStatus={liveStatus}
        open={detailsOpen}
        onClose={() => {
          setDetailsOpen(false);
          setRenameOpen(false);
          setMigrateOpen(false);
        }}
        labelledBy={detailsId}
        // On a phone the sheet is where Interrupt/Stop/Resume live: it is already
        // a real dialog with a focus trap, an Escape path and restored focus, so
        // the controls keep a robust home instead of a second ad-hoc popover.
        actions={compact ? compactActions : undefined}
        viewSwitcher={compactViewSwitcher}
        onRename={hasToken ? () => setRenameOpen(true) : undefined}
        onMigrate={hasToken ? () => setMigrateOpen(true) : undefined}
        canControlRuntime={hasToken}
        onOpenTerminal={() => openTerminalFromTabs(tabs)}
      />
      <RenameSheet view={view} open={renameOpen} onClose={() => setRenameOpen(false)} />
      <MigrateSheet view={view} open={migrateOpen} onClose={() => setMigrateOpen(false)} />
    </>
  );

  if (compact) {
    return (
      <>
        <div
          ref={compactRowRef}
          data-density-region="session-header"
          data-density-row="primary"
          className="kt-session-bar mt-0.5 mb-0.5 flex min-w-0 flex-nowrap items-center gap-xs border-b border-border-soft pb-0.5"
        >
          {onOpenSidebar && <FleetTrigger onOpen={onOpenSidebar} />}

          {/* BACK + IDENTITY ARE ONE TARGET. Two 44px boxes for two facts that
              are read together does not fit at 360px. The accessible name spells
              out both, and it deliberately names NO status: the mobile row does
              not show one any more, and a name that announces a state the
              control does not present misleads exactly the reader who cannot
              see the row to check it. */}
          <Link
            to="/"
            aria-label={MOBILE_BACK.label(identity.primaryLabel, showCompactCallsign ? identity.callsign : undefined)}
            title={MOBILE_BACK.title(identity.primaryLabel, showCompactCallsign ? identity.callsign : undefined)}
            className="inline-flex min-h-[44px] min-w-0 flex-1 items-center gap-xs text-muted hover:text-fg"
          >
            <ChevronLeft size={16} aria-hidden="true" className="shrink-0" />
            <h1 data-session-primary-title={identity.primaryLabel} className="m-0 min-w-0 flex-1 text-fg">
              <span ref={compactIdentityRef} data-session-identity-slot className="flex min-w-0 items-baseline gap-xs">
                <TaskName
                  name={identity.renderName}
                  teammate={config.teammate}
                  showPrefix={identity.hasNamedTask}
                  size="sm"
                  className="min-w-0 max-w-full flex-1 font-semibold tracking-tight"
                />
                {showCompactCallsign && (
                  <span data-session-callsign className="shrink-0 text-meta font-normal text-muted">
                    · {identity.callsign}
                  </span>
                )}
              </span>
            </h1>

            {/* Intrinsic-width probe for the 60% rule. It uses the same
                components and type classes as the visible identity but is
                removed from layout, paint, hit testing and the accessibility
                tree. */}
            <span
              aria-hidden="true"
              className="pointer-events-none invisible fixed left-0 top-0 h-0 w-0 overflow-hidden"
            >
              <span
                ref={compactCombinedMeasureRef}
                data-session-combined-measure
                className="inline-flex w-max items-baseline gap-xs whitespace-nowrap"
              >
                <span ref={compactTitleMeasureRef} data-session-title-measure className="inline-flex w-max">
                  <TaskName
                    name={identity.renderName}
                    teammate={config.teammate}
                    showPrefix={identity.hasNamedTask}
                    size="sm"
                    className="max-w-none font-semibold tracking-tight"
                  />
                </span>
                <span className="shrink-0 text-meta font-normal">· {identity.callsign}</span>
              </span>
            </span>
          </Link>

          <Button
            id={detailsId}
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setDetailsOpen(open => !open)}
            aria-expanded={detailsOpen}
            aria-controls={detailsOpen ? panelId : undefined}
            aria-label="Session controls and details"
            title="View, controls, settings, identity, runtime, progress and budget"
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

      <h1
        className="m-0 min-w-0 max-w-[42vw] truncate text-title font-semibold tracking-tight"
        title={identity.primaryLabel}
      >
        {identity.primaryLabel}
      </h1>
      {identity.desktopSecondary && (
        <span
          className="hidden min-w-0 max-w-[28vw] truncate text-cell text-muted sm:inline"
          title={identity.desktopSecondary}
        >
          {identity.desktopSecondary}
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

/** The phone row's back/identity accessible name, lifted out of the JSX so the
 *  property that matters is checkable: it names the session, and it names NO
 *  status. The visible status left this row, and an accessible name is not the
 *  place to keep a fact the control stopped presenting — a screen-reader user
 *  cannot glance at the row to see it is gone. The status is in the details
 *  sheet, one deliberate tap away, and it is fully labelled there. */
export const MOBILE_BACK = {
  label: (title: string, callsign?: string) =>
    `Back to all sessions. Currently ${title}${callsign ? `, ${callsign}` : ''}`,
  title: (title: string, callsign?: string) => `Back to all sessions — ${title}${callsign ? ` · ${callsign}` : ''}`,
};

/** The phone fleet trigger's names. Icon-only and COUNTLESS on purpose (see the
 *  header note), so the name says what the control does and claims no number:
 *  `Open the fleet sidebar (12)` would announce a fact the button no longer
 *  shows, and the count is not why anyone presses it. */
export const MOBILE_FLEET = { label: 'Open the fleet sidebar', title: 'Open the fleet sidebar' };

/** Settings is reached from the phone overflow as a labelled 44px action. It
 * opens the shared Settings bottom sheet without changing the session route. */
export const MOBILE_SETTINGS = { label: 'Open settings', title: 'Open appearance and density settings' };

/** The phone drawer trigger. `SidebarDrawerTrigger` is the desktop/tablet app
 *  bar's control and still renders `Users N` there, which is right: that bar has
 *  the width and the count is fleet context. This row is 360px wide at worst and
 *  is the ONLY row, so it takes the icon alone. Same position, same action, same
 *  chrome — one fact fewer. */
function FleetTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={MOBILE_FLEET.label}
      title={MOBILE_FLEET.title}
      className="inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-control border border-border p-0 text-muted hover:border-accent-border hover:text-fg"
    >
      <Users size={16} aria-hidden="true" />
    </button>
  );
}

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
