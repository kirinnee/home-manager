// SESSION DETAILS — the bottom sheet behind the header's overflow button.
//
// The header used to be a badge wall: mode, RC, status, nudged, needs-human,
// wrapper, model, turn, context, five liveness ages, quota and the socket state,
// all spelled out across two rows of every screen. Every one of those is a fact
// somebody needs — none of them is a fact everybody needs all the time, and
// together they cost two lines of transcript on a 100dvh page and read as noise.
//
// They live here instead, in labelled groups. The header keeps only what you
// steer by (who, status, tabs, controls) and this answers "what exactly am I
// looking at" — including the session's direct lineage.
//
// Rules this file follows:
//   - a group is never identified by colour alone: icon + written heading, with
//     the tone as reinforcement
//   - decorative icons are aria-hidden; the adjacent text is the name
//   - it is a real dialog: Escape, scrim, a labelled handle button and a
//     handle-only swipe all dismiss it; focus moves in and is restored
//   - it is an OVERLAY with its own scroller, so the page keeps exactly one
//     pane scroller (the transcript) and the 100dvh shell never scrolls
//   - lineage is the one in-app navigation this metadata surface owns; every
//     route link closes the sheet before the route changes

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  ExternalLink,
  Gauge,
  GitFork,
  LoaderCircle,
  Radio,
  Pencil,
  ServerCog,
  Sparkles,
  Terminal,
  UserRound,
  Zap,
} from 'lucide-react';
import type { SessionView, WrapperInfo } from '../types';
import type { Quota } from '../lib/usage';
import { api, ApiError } from '../lib/api';
import { displayCallsign } from '../lib/callsign';
import { cn, fmtAbsolute, fmtAge, fmtRelative, TERMINAL_STATUSES } from '../lib/utils';
import { buildLineage, byNewestActivity, parentDisplay, shortSessionId } from '../lib/lineage';
import { Link } from '../lib/router';
import { useStore } from '../lib/store';
import { MODE_HINT } from './ModeBadge';
import { SessionCommandControls } from './SessionCommandControls';
import { StatusMark } from './StatusMark';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { SheetTabs, sheetPanelId, sheetTabId, type SheetTabSpec } from './SheetTabs';
import { DETAILS_TAB_ORDER, useDetailsTab, type DetailsTab } from '../hooks/useDetailsTab';

export type LiveStatus = 'connecting' | 'open' | 'closed';

interface Props {
  /** Concrete panel id; the header trigger's aria-controls resolves to it. */
  id: string;
  view: SessionView;
  quota: Quota | null;
  liveStatus: LiveStatus;
  open: boolean;
  onClose: () => void;
  /** Id of the button that opens this, so focus can be handed back to it. */
  labelledBy?: string;
  /** Session controls (Interrupt / Stop / Resume) when the caller has nowhere to
   *  put them — the phone header is a single nowrap row and cannot hold three
   *  more 44px targets. They go FIRST, above the read-only groups, because a
   *  sheet opened to stop a session should not need a scroll to do it. This is
   *  the whole reason the sheet is the overflow: it already traps focus,
   *  restores it and answers Escape, so the controls lose nothing by moving. */
  actions?: ReactNode;
  /** The mobile Chat / Terminal segment. It is first in the sheet because view
   *  selection is navigation, not session metadata. */
  viewSwitcher?: ReactNode;
  /** Layer a rename sheet over Details without adding another overflow menu. */
  onRename?: () => void;
  /** Layer the destructive runtime migration flow over Details. */
  onMigrate?: () => void;
  /** The page owns the Chat/Terminal state. The Codex native picker must open
   * in that existing Terminal view after the daemon accepts /model. */
  onOpenTerminal?: () => boolean;
  /** A token-less origin is read-only. Keep the explanation visible, but never
   * offer a control that cannot work. */
  canControlRuntime?: boolean;
}

/** Group tones. Colour is the SECOND signal in every case — the icon and the
 *  heading text carry the identity. */
const GROUP_TONE = {
  identity: 'text-accent border-accent',
  lineage: 'text-accent border-accent',
  runtime: 'text-fg-soft border-border',
  progress: 'text-warn border-warn-border',
  budget: 'text-ok border-ok-border',
} as const;

const SHEET_TRANSITION_MS = 200;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const MAX_DIRECT_CHILDREN = 12;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION).matches === true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(REDUCED_MOTION);
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return reduced;
}

interface SwipeGesture {
  pointerId: number;
  startY: number;
  lastY: number;
  lastAt: number;
  distance: number;
  velocity: number;
}

export interface BottomSheetProps {
  id: string;
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  ariaLabel?: string;
  closeLabel: string;
  children: ReactNode;
  panelClassName?: string;
  maxHeight?: string;
  /** Settings can replace Details during its closing frame, so it paints one
   *  layer higher while still using exactly the same sheet machinery. */
  zIndexClass?: string;
}

/**
 * The shared focus-trapped, swipe-dismissable bottom-sheet shell. Session
 * details was the original implementation; Settings deliberately composes this
 * exact primitive instead of growing a second, subtly different modal.
 */
export function BottomSheet({
  id,
  open,
  onClose,
  labelledBy,
  ariaLabel,
  closeLabel,
  children,
  panelClassName,
  maxHeight = 'min(72dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))',
  zIndexClass = 'z-40',
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const swipeRef = useRef<SwipeGesture | null>(null);
  const suppressHandleClick = useRef(false);
  const reducedMotion = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const [dragY, setDragY] = useState<number | null>(null);

  // `open || mounted` is load-bearing: the first open renders the panel before
  // useDialogFocus tries to focus it, while `mounted` alone keeps the DOM around
  // for the close slide. Reduced motion removes it in the closing layout pass.
  const rendered = open || mounted;
  useLayoutEffect(() => {
    let frame: number | undefined;
    swipeRef.current = null;
    setDragY(null);
    if (open) {
      setMounted(true);
      suppressHandleClick.current = false;
      if (reducedMotion) setEntered(true);
      else {
        setEntered(false);
        frame = requestAnimationFrame(() => setEntered(true));
      }
    } else {
      setEntered(false);
      if (reducedMotion) setMounted(false);
    }
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [open, reducedMotion]);

  useEffect(() => {
    if (open || !mounted || reducedMotion) return;
    const timeout = window.setTimeout(() => setMounted(false), SHEET_TRANSITION_MS);
    return () => window.clearTimeout(timeout);
  }, [open, mounted, reducedMotion]);

  // Losing the window mid-drag must snap the sheet back rather than leaving a
  // stale offset for the next open. Pointer capture itself is released by the
  // browser; this only clears our gesture state.
  useEffect(() => {
    const cancelSwipe = () => {
      if (!swipeRef.current) return;
      swipeRef.current = null;
      suppressHandleClick.current = true;
      setDragY(null);
    };
    window.addEventListener('blur', cancelSwipe);
    return () => window.removeEventListener('blur', cancelSwipe);
  }, []);

  // Escape, focus-in, focus-restore and the Tab trap — the same contract the
  // fleet drawer now uses (hooks/useDialogFocus.ts).
  const { onKeyDown } = useDialogFocus(open, panelRef, onClose);

  if (!rendered) return null;

  function beginSwipe(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!open || event.button !== 0) return;
    const at = event.timeStamp;
    swipeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      lastAt: at,
      distance: 0,
      velocity: 0,
    };
    suppressHandleClick.current = false;
    setDragY(0);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveSwipe(event: ReactPointerEvent<HTMLButtonElement>) {
    const gesture = swipeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - gesture.startY);
    const elapsed = Math.max(1, event.timeStamp - gesture.lastAt);
    gesture.velocity = (event.clientY - gesture.lastY) / elapsed;
    gesture.lastY = event.clientY;
    gesture.lastAt = event.timeStamp;
    gesture.distance = distance;
    if (distance > 4) suppressHandleClick.current = true;
    setDragY(distance);
  }

  function endSwipe(event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) {
    const gesture = swipeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    swipeRef.current = null;

    const threshold = (panelRef.current?.getBoundingClientRect().height ?? 0) * 0.25;
    const shouldClose =
      !cancelled && (gesture.distance >= threshold || (gesture.distance > 12 && gesture.velocity > 0.65));
    setDragY(null);
    if (shouldClose) onClose();
  }

  function clickHandle() {
    if (suppressHandleClick.current) {
      suppressHandleClick.current = false;
      return;
    }
    onClose();
  }

  const sheetTransform =
    dragY === null ? (open && entered ? 'translateY(0)' : 'translateY(100%)') : `translateY(${dragY}px)`;

  return (
    <div
      data-bottom-sheet={id}
      className={cn(
        'kt-overlay fixed inset-x-0 flex flex-col justify-end',
        zIndexClass,
        !open && 'pointer-events-none',
      )}
      aria-hidden={open ? undefined : true}
    >
      {/* Backdrop. A plain button so a click OR a keyboard activation dismisses,
          and screen readers are told what it does rather than meeting a div. */}
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        disabled={!open}
        tabIndex={open ? 0 : -1}
        className={cn(
          'absolute inset-0 cursor-default bg-scrim transition-opacity duration-200 motion-reduce:transition-none',
          open && entered ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        id={id}
        ref={panelRef}
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        aria-labelledby={open ? labelledBy : undefined}
        aria-label={open && !labelledBy ? ariaLabel : undefined}
        tabIndex={open ? -1 : undefined}
        inert={open ? undefined : true}
        onKeyDown={open ? onKeyDown : undefined}
        onTransitionEnd={event => {
          if (!open && event.target === event.currentTarget && event.propertyName === 'transform') setMounted(false);
        }}
        className={cn(
          'kt-panel kt-sheet relative z-10 flex w-full flex-col font-ui will-change-transform',
          panelClassName,
          dragY === null && 'transition-transform duration-200 ease-out motion-reduce:transition-none',
        )}
        style={{
          maxHeight,
          transform: sheetTransform,
        }}
      >
        {/* The handle is both the visible dismissal affordance and the ONLY
            swipe surface. Its own touch-action prevents gesture arbitration;
            the content scroller below never sees these pointer handlers. */}
        <button
          type="button"
          aria-label={closeLabel}
          data-sheet-swipe="supported"
          disabled={!open}
          onClick={clickHandle}
          onPointerDown={beginSwipe}
          onPointerMove={moveSwipe}
          onPointerUp={event => endSwipe(event, false)}
          onPointerCancel={event => endSwipe(event, true)}
          className="group mx-auto flex min-h-[44px] w-20 shrink-0 touch-none cursor-grab items-center justify-center py-3 active:cursor-grabbing"
          title="Close, or swipe down"
        >
          <span
            className="block h-1 w-12 rounded-full bg-border-strong transition-colors group-hover:bg-fg-soft"
            aria-hidden="true"
          />
        </button>
        {children}
      </div>
    </div>
  );
}

export function SessionDetails({
  id,
  view,
  quota,
  liveStatus,
  open,
  onClose,
  labelledBy,
  actions,
  viewSwitcher,
  onRename,
  onMigrate,
  onOpenTerminal,
  canControlRuntime = false,
}: Props) {
  const { config, state } = view;
  const observedModel = state.observedModel?.trim();
  const observedReasoningEffort = config.harness === 'codex' ? state.observedReasoningEffort?.trim() : undefined;
  // This is only what launch requested. It remains useful context, but is not
  // a substitute for the harness-observed runtime value above.
  const requestedModel = config.model?.trim();
  const title = displayCallsign(config.teammate) || config.name || config.id;
  const observedAtSwitchRef = useRef<ModelObservation | undefined>(undefined);
  const [modelVerificationPending, setModelVerificationPending] = useState(false);

  // A native /model command is handled locally: the harness does not emit a
  // new model fact until its next response. Until fresh model evidence arrives,
  // do not imply the old fact is still current.
  useEffect(() => {
    const before = observedAtSwitchRef.current;
    if (
      modelVerificationPending &&
      before &&
      modelObservationChanged(before, { model: observedModel, observedAt: state.observedModelAt })
    )
      setModelVerificationPending(false);
  }, [modelVerificationPending, observedModel, state.observedModelAt]);

  useEffect(() => {
    observedAtSwitchRef.current = undefined;
    setModelVerificationPending(false);
  }, [config.id]);

  const markModelVerificationPending = useCallback(() => {
    observedAtSwitchRef.current = { model: observedModel, observedAt: state.observedModelAt };
    setModelVerificationPending(true);
  }, [observedModel, state.observedModelAt]);
  const observedPresentation = observedModelPresentation(observedModel, modelVerificationPending);

  // TABS. The sheet had become one long undifferentiated scroll — status,
  // identity, runtime, progress, budget, controls all stacked — which is exactly
  // what "it's too confusing" named. It is now four labelled tabs: Identity ·
  // Runtime · Progress · Budget, with Lineage folded under Identity. The two
  // things you might have opened the sheet to DO — switch view, stop/resume the
  // session — are pinned ABOVE the tablist so they never need a tab switch.
  //
  // Reopen behaviour: the sheet returns to the tab you last left it on for THIS
  // session (least surprising — you left it on Budget, it opens on Budget); a
  // session you have not opened before starts on Identity; a reload forgets
  // everything (the memory is in-process only, see useDetailsTab).
  const [tab, setTab] = useDetailsTab(config.id, open);
  const tabs: SheetTabSpec<DetailsTab>[] = [
    { key: 'identity', label: 'Identity', icon: <UserRound size={13} aria-hidden="true" /> },
    {
      key: 'runtime',
      label: 'Runtime',
      icon:
        config.harness === 'claude' ? <Bot size={13} aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />,
    },
    { key: 'progress', label: 'Progress', icon: <Activity size={13} aria-hidden="true" /> },
    { key: 'budget', label: 'Budget', icon: <Gauge size={13} aria-hidden="true" /> },
  ];

  return (
    <BottomSheet
      id={id}
      open={open}
      onClose={onClose}
      labelledBy={labelledBy}
      ariaLabel="Session details"
      closeLabel="Close session details"
      panelClassName="kt-details"
      // The reader asked for a taller sheet. It rose from the 72dvh shared
      // default to 90dvh — in line with the Settings sheet, the other content-
      // heavy one — which keeps a rest-visible strip of transcript and the scrim
      // above it, so the sheet is still tappable-away and never buries its own
      // context. The keyboard-safe term is UNCHANGED: `calc(--app-h - gap)` still
      // governs whenever the keyboard shrinks the visible viewport, so a taller
      // ceiling never lets the sheet run under the keyboard (--app-h is the
      // visual-viewport height, not dvh).
      maxHeight="min(90dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
    >
      <div className="shrink-0 border-b border-border-soft">
        <div className="mx-auto flex w-full max-w-2xl min-w-0 items-baseline gap-sm px-panel pb-row-y">
          <span
            className="min-w-0 flex-1 truncate font-display text-title font-semibold tracking-display text-fg"
            title={title}
          >
            {title}
          </span>
          <span className="kt-label shrink-0">Session details</span>
        </div>
      </div>

      {/* PINNED ABOVE THE TABLIST: view switch + session controls. A sheet opened
          to stop a running session must not need a tab switch to reach Stop, and
          switching Chat/Terminal is navigation, not metadata. */}
      {(viewSwitcher || actions) && (
        <div className="shrink-0 border-b border-border-soft">
          <div className="mx-auto grid w-full max-w-2xl grid-cols-1 gap-sm px-panel py-row-y sm:grid-cols-2">
            {viewSwitcher && (
              <section className="min-w-0">
                <h2
                  className={cn(
                    'kt-label m-0 mb-xs flex items-center gap-xs border-l-heavy pl-cell-x',
                    GROUP_TONE.identity,
                  )}
                >
                  <Activity size={13} aria-hidden="true" />
                  View
                </h2>
                <div className="flex items-center">{viewSwitcher}</div>
              </section>
            )}
            {actions && (
              <section className="min-w-0">
                <h2
                  className={cn(
                    'kt-label m-0 mb-xs flex items-center gap-xs border-l-heavy pl-cell-x',
                    GROUP_TONE.progress,
                  )}
                >
                  <Zap size={13} aria-hidden="true" />
                  Controls
                </h2>
                <div className="flex flex-wrap items-center gap-sm">{actions}</div>
              </section>
            )}
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-2xl shrink-0">
        <SheetTabs sheetId={id} tabs={tabs} current={tab} order={DETAILS_TAB_ORDER} onChange={setTab} />
      </div>

      {/* The sheet's OWN scroller, carrying the ONE selected tabpanel. The page
          below still owns exactly one scroller (the transcript); this one is an
          overlay and never nests inside it. Unselected panels are not rendered,
          so their links never enter the dialog's focus trap and the Progress
          1s ticker only runs while Progress is on screen. */}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div
          role="tabpanel"
          id={sheetPanelId(id, tab)}
          aria-labelledby={sheetTabId(id, tab)}
          tabIndex={0}
          className="mx-auto w-full max-w-2xl focus:outline-none"
        >
          {tab === 'identity' && (
            <div className="grid grid-cols-1 sm:grid-cols-2">
              <Group
                icon={<UserRound size={13} aria-hidden="true" />}
                title="Identity"
                tone="identity"
                headerAction={
                  onRename ? (
                    <button
                      type="button"
                      onClick={onRename}
                      aria-label="Edit session identity"
                      title="Rename task, callsign, or detach from parent"
                      className="inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-control border border-border text-muted hover:border-accent hover:text-accent"
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                  ) : undefined
                }
              >
                {/* Canonical copy/command value, e.g. `kteam send <teammate>`. */}
                <Row label="Teammate" value={config.teammate} />
                <Row label="Task" value={config.name} />
                <Row label="Label" value={config.label} />
                <Row label="Folder" value={config.cwd} mono />
                <Row label="Session id" value={config.id} mono />
                <Row label="Started" value={state.startedAt ? fmtAbsolute(state.startedAt) : undefined} mono />
                {state.finishedAt && <Row label="Finished" value={fmtAbsolute(state.finishedAt)} mono />}
              </Group>

              <LineageGroup open={open} sessionId={config.id} parentId={config.parent} onNavigate={onClose} />
            </div>
          )}

          {tab === 'runtime' && (
            <Group
              icon={
                config.harness === 'claude' ? (
                  <Bot size={13} aria-hidden="true" />
                ) : (
                  <Sparkles size={13} aria-hidden="true" />
                )
              }
              title="Runtime"
              tone="runtime"
              footerAction={
                <>
                  <RuntimeModelControls
                    view={view}
                    open={open}
                    canControl={canControlRuntime}
                    onModelSwitch={markModelVerificationPending}
                    onOpenTerminal={onOpenTerminal}
                    onClose={onClose}
                  />
                  {/* Codex already tunes reasoning inside the model picker above,
                      so a second control there would be redundant; Claude has a
                      real in-session /effort command, so it gets its own. */}
                  {config.harness === 'claude' && (
                    <RuntimeEffortControls view={view} canControl={canControlRuntime} onClose={onClose} />
                  )}
                  <SessionCommandControls view={view} open={open} canControl={canControlRuntime} />
                  {onMigrate && (
                    <div className="mt-4 border-t border-border-soft pt-3">
                      <h3 className="m-0 text-ui font-semibold text-fg">Move account + relaunch</h3>
                      <p className="mt-1 text-meta leading-base text-muted">
                        This is the existing destructive migration flow: it moves the account, stops this pane, and
                        relaunches it. Use the in-place switch above when the account stays the same.
                      </p>
                      <button
                        type="button"
                        onClick={onMigrate}
                        className="kt-btn mt-3 flex min-h-[44px] w-full items-center justify-between gap-sm text-left"
                      >
                        <span>Move account + relaunch…</span>
                        <ServerCog size={15} aria-hidden="true" className="shrink-0" />
                      </button>
                    </div>
                  )}
                </>
              }
            >
              <Row label="CLI wrapper" value={config.binary} mono />
              <Row label="Harness" value={config.harness} />
              <Row label={observedPresentation.label} value={observedPresentation.value} mono />
              {config.harness === 'codex' && (
                <Row label="Last observed reasoning" value={observedReasoningEffort} mono />
              )}
              <Row
                label="Model (launch request)"
                value={requestedModel && requestedModel !== observedModel ? requestedModel : undefined}
                mono
              />
              <Row label="Mode" value={config.mode} hint={MODE_HINT[config.mode]} />
              <Row label="tmux session" value={config.tmuxSession} mono />
              {config.remoteControl && (
                <div className="flex items-baseline gap-sm">
                  <dt className="w-[104px] shrink-0 text-meta text-muted">Remote control</dt>
                  <dd className="m-0 min-w-0 flex-1 text-cell text-fg-soft">
                    {state.remoteControlUrl ? (
                      <a
                        href={state.remoteControlUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={state.remoteControlUrl}
                        className="inline-flex min-w-0 items-center gap-xs text-accent hover:underline"
                      >
                        <Radio size={11} aria-hidden="true" />
                        <span className="min-w-0 truncate">open RC surface</span>
                        <ExternalLink size={10} aria-hidden="true" />
                      </a>
                    ) : (
                      <span className="text-faint" title="launched with --rc; the surface has not announced itself yet">
                        enabled · link pending
                      </span>
                    )}
                  </dd>
                </div>
              )}
            </Group>
          )}

          {tab === 'progress' && (
            <Group icon={<Activity size={13} aria-hidden="true" />} title="Progress" tone="progress">
              <ProgressRows view={view} liveStatus={liveStatus} />
            </Group>
          )}

          {tab === 'budget' && (
            <Group icon={<Gauge size={13} aria-hidden="true" />} title="Budget" tone="budget">
              <BudgetRows view={view} quota={quota} />
            </Group>
          )}
        </div>
      </div>
    </BottomSheet>
  );
}

export interface ObservedModelPresentation {
  label: 'Model (observed)' | 'Last observed model';
  value?: string;
}

export interface ModelObservation {
  model?: string;
  observedAt?: string;
}

/** Only model-bearing harness evidence verifies a switch. Claude writes a
 * local-command transcript record for `/model` before its next response, so
 * lastTranscriptAt is intentionally not part of this comparison. */
export function modelObservationChanged(before: ModelObservation, current: ModelObservation): boolean {
  return before.model !== current.model || before.observedAt !== current.observedAt;
}

/** Keep runtime truth separate from launch configuration. Once /model was
 * accepted the last transcript fact is stale until a later model response
 * updates state.observedModel. */
export function observedModelPresentation(observedModel: string | undefined, stale = false): ObservedModelPresentation {
  return {
    label: stale ? 'Last observed model' : 'Model (observed)',
    value: observedModel?.trim() || undefined,
  };
}

/** A route-shaped 404 is daemon/UI version skew; an ordinary 404 can still be
 * a missing session and must retain its normal error treatment. */
export function isRuntimeEndpointUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'unknown_route';
}

/** A daemon that predates the effort runtime action rejects it with the 400 it
 * raises for any non-model action. That is version skew — the account CAN tune
 * effort, the running daemon just has not learned the verb yet — so it earns the
 * same "restart required" treatment as a missing runtime route, not a red error. */
export function isEffortActionUnsupported(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && /runtime action/i.test(error.message);
}

/** The four persistable levels the installed Claude CLI accepts. `auto` (reset
 * to the model default) and the session-only `max`/`ultracode` aliases are
 * deliberately absent — this surface only offers what persists as a default. */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

export type ClaudeRuntimeModelsResolution =
  | { kind: 'available'; choices: NonNullable<WrapperInfo['runtimeModels']> }
  | { kind: 'restart-required' }
  | { kind: 'missing-wrapper' };

/** An old daemon knows /v1/wrappers but predates its runtimeModels field. That
 * is version skew, not proof that the account has no choices. An explicit []
 * is the daemon's honest unsupported verdict and must remain distinguishable. */
export function resolveClaudeRuntimeModels(wrappers: WrapperInfo[], binary: string): ClaudeRuntimeModelsResolution {
  const wrapper = wrappers.find(item => item.name === binary);
  if (!wrapper) return { kind: 'missing-wrapper' };
  if (wrapper.runtimeModels === undefined) return { kind: 'restart-required' };
  return { kind: 'available', choices: wrapper.runtimeModels };
}

interface RuntimeModelControlsProps {
  view: SessionView;
  open: boolean;
  canControl: boolean;
  onModelSwitch: () => void;
  onOpenTerminal?: () => boolean;
  onClose: () => void;
}

/**
 * Native /model is a small, deliberately harness-specific control surface.
 * It does not fall back to config.model or a global catalog: provider-backed
 * accounts may reject values that a different Claude account accepts.
 */
export function RuntimeModelControls({
  view,
  open,
  canControl,
  onModelSwitch,
  onOpenTerminal,
  onClose,
}: RuntimeModelControlsProps) {
  const { config, state } = view;
  const terminal = TERMINAL_STATUSES.has(state.status);
  const promptReady = state.promptReady === true;
  const [claudeChoices, setClaudeChoices] = useState<NonNullable<WrapperInfo['runtimeModels']> | null>(null);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    setRestartRequired(false);
    setFailure(null);
    setNotice(null);
  }, [config.id]);

  // A restart-required verdict is deliberately sticky while this sheet stays
  // open, but reopening it after the lead restarts kteamd must retry rather
  // than trapping the reader behind an old local flag forever.
  useEffect(() => {
    if (open) setRestartRequired(false);
  }, [open]);

  useEffect(() => {
    if (!open || !canControl || terminal || config.harness !== 'claude') return;
    let cancelled = false;
    setClaudeChoices(null);
    setChoicesError(null);
    void api
      .wrappers()
      .then(wrappers => {
        if (cancelled) return;
        const resolution = resolveClaudeRuntimeModels(wrappers, config.binary);
        if (resolution.kind === 'restart-required') {
          setRestartRequired(true);
          return;
        }
        if (resolution.kind === 'missing-wrapper') {
          setChoicesError('The daemon did not return the current account wrapper. Refresh the session and try again.');
          return;
        }
        setClaudeChoices(resolution.choices);
      })
      .catch(error => {
        if (cancelled) return;
        if (isRuntimeEndpointUnavailable(error)) setRestartRequired(true);
        else setChoicesError(error instanceof ApiError ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [canControl, config.binary, config.harness, open, terminal]);

  async function runModelCommand(model?: string) {
    if (!canControl || terminal || !promptReady || submitting || restartRequired) return;
    const action = { action: 'model' as const, ...(model ? { model } : {}) };
    setSubmitting(true);
    setFailure(null);
    setNotice(null);
    try {
      // A fresh id belongs to every click. The daemon applies this native
      // command exactly once for that gesture; a later retry click is a new
      // explicit user decision rather than an invisible transport retry.
      await api.runtime(config.id, action, crypto.randomUUID());
      onModelSwitch();
      if (config.harness === 'codex') {
        if (onOpenTerminal?.()) {
          onClose();
          return;
        }
        setNotice(
          'Codex opened its native picker. Select Terminal, then choose a model and supported reasoning level.',
        );
      } else {
        setNotice('Model command sent. Verification updates after the next model response.');
      }
    } catch (error) {
      if (isRuntimeEndpointUnavailable(error)) {
        setRestartRequired(true);
        return;
      }
      setFailure(error instanceof ApiError ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  const title = 'Switch model in place';
  if (terminal) {
    return (
      <div className="border-t border-border-soft pt-3">
        <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
        <p className="mt-1 text-meta leading-base text-muted">
          In-session model switching requires a running session. Resume or relaunch this session before changing its
          runtime model.
        </p>
      </div>
    );
  }
  if (!canControl) {
    return (
      <div className="border-t border-border-soft pt-3">
        <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
        <p className="mt-1 text-meta leading-base text-muted">
          This origin is read-only, so it cannot send a native model command to the running session.
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-border-soft pt-3">
      <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
      <p className="mt-1 text-meta leading-base text-muted">
        Changes the model inside this running session. It does not move accounts, relaunch the pane, or discard its
        context.
      </p>
      {!promptReady && (
        <p className="mt-2 text-meta leading-base text-warn">
          Wait for an idle prompt before switching model. The daemon refuses a busy pane instead of queueing this
          command.
        </p>
      )}

      {restartRequired ? (
        <p role="alert" className="mt-2 rounded-control border border-warn-border bg-surface-2 p-3 text-ui text-warn">
          Daemon restart required to enable in-session model switching.
        </p>
      ) : config.harness === 'claude' ? (
        <ClaudeRuntimeChoices
          choices={claudeChoices}
          error={choicesError}
          submitting={submitting}
          disabled={submitting || !promptReady}
          onChoose={model => void runModelCommand(model)}
        />
      ) : config.harness === 'codex' ? (
        <div className="mt-3">
          <p className="m-0 text-meta leading-base text-muted">
            Codex owns the account-aware native picker. It asks for a model, then the reasoning level supported by that
            model; this sheet intentionally adds no separate effort control.
          </p>
          <button
            type="button"
            disabled={submitting || !promptReady}
            onClick={() => void runModelCommand()}
            className="kt-btn mt-3 flex min-h-[44px] w-full items-center justify-between gap-sm text-left"
          >
            <span>{submitting ? 'Opening native picker…' : 'Open model + reasoning picker in Terminal'}</span>
            {submitting ? (
              <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin" />
            ) : (
              <Terminal size={15} aria-hidden="true" className="shrink-0" />
            )}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-meta leading-base text-muted">
          In-session model switching is not available for this harness, so no nonfunctional control is shown.
        </p>
      )}

      {notice && (
        <p role="status" className="mt-2 text-ui leading-base text-ok">
          {notice}
        </p>
      )}
      {failure && (
        <p
          role="alert"
          className="mt-2 rounded-control border border-err-border bg-surface-2 p-3 text-ui leading-base text-err"
        >
          {failure}
        </p>
      )}
    </div>
  );
}

export function ClaudeRuntimeChoices({
  choices,
  error,
  submitting,
  disabled,
  onChoose,
}: {
  choices: NonNullable<WrapperInfo['runtimeModels']> | null;
  error: string | null;
  submitting: boolean;
  disabled: boolean;
  onChoose: (model: string) => void;
}) {
  if (error) {
    return (
      <p
        role="alert"
        className="mt-2 rounded-control border border-err-border bg-surface-2 p-3 text-ui leading-base text-err"
      >
        Account-aware model choices are unavailable: {error}
      </p>
    );
  }
  if (choices === null) {
    return (
      <div role="status" className="mt-2 flex min-h-[44px] items-center gap-sm text-ui text-muted">
        <LoaderCircle size={15} aria-hidden="true" className="animate-spin" />
        Loading account-aware model choices…
      </div>
    );
  }
  if (choices.length === 0) {
    return (
      <p className="mt-2 text-meta leading-base text-muted">
        This account does not advertise any in-place model choices. Reasoning effort is set separately below.
      </p>
    );
  }
  return (
    <div className="mt-3">
      <p className="m-0 text-meta leading-base text-muted">
        Only this account’s advertised Claude choices are shown. Verification updates after the next model response.
      </p>
      <div className="mt-2 grid gap-2" aria-label="Switch Claude model in place">
        {choices.map(choice => (
          <button
            key={choice.value}
            type="button"
            disabled={disabled}
            onClick={() => onChoose(choice.value)}
            aria-label={`Switch model in place to ${choice.label}`}
            className="kt-btn flex min-h-[44px] w-full items-center justify-between gap-sm text-left"
          >
            <span className="min-w-0">
              <span className="block truncate text-ui font-semibold">{choice.label}</span>
              {choice.label !== choice.value && (
                <span className="mono block truncate text-meta text-muted">{choice.value}</span>
              )}
            </span>
            {submitting && <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin" />}
          </button>
        ))}
      </div>
    </div>
  );
}

interface RuntimeEffortControlsProps {
  view: SessionView;
  canControl: boolean;
  /** Claude reports a level took as a persisted default the moment the command
   *  completes; the caller uses this to reflect the new value on the bar chip. */
  onEffortSwitch?: (level: string) => void;
  /** Codex tunes effort inside its native picker, which lives in the Terminal
   *  view; the page owns that tab switch, exactly as the model control does. */
  onOpenTerminal?: () => boolean;
  onClose: () => void;
}

/**
 * The reasoning-effort sibling of RuntimeModelControls. It is deliberately a
 * SEPARATE surface, not a section grafted into the model control, because the
 * two harnesses answer "change the thinking level" very differently:
 *
 *   - Claude has a real in-session `/effort` command with four persistable
 *     levels. It writes the account's settings.json (now that kfleet
 *     materialises it writable) and the next turn uses it. Claude does not echo
 *     the level back in a transcript we parse, so — unlike the model switch —
 *     there is no stale-until-evidence spinner: the persist is synchronous and
 *     confirmed by the command completing.
 *   - Codex combines model AND reasoning in one native two-stage picker; there
 *     is no `/reasoning <x>` verb. So its "effort" control is the same Terminal
 *     hand-off the model control uses, surfaced from the thinking chip too.
 *
 * Anything a harness cannot actually do is never rendered as a live control.
 */
export function RuntimeEffortControls({
  view,
  canControl,
  onEffortSwitch,
  onOpenTerminal,
  onClose,
}: RuntimeEffortControlsProps) {
  const { config, state } = view;
  const terminal = TERMINAL_STATUSES.has(state.status);
  const promptReady = state.promptReady === true;
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    setRestartRequired(false);
    setFailure(null);
    setNotice(null);
  }, [config.id]);

  async function runEffortCommand(level: string) {
    if (!canControl || terminal || !promptReady || submitting || restartRequired) return;
    setSubmitting(true);
    setFailure(null);
    setNotice(null);
    try {
      // A fresh id per click, so the daemon applies it exactly once and a retry
      // is a new user decision.
      await api.runtime(config.id, { action: 'effort', effort: level }, crypto.randomUUID());
      onEffortSwitch?.(level);
      setNotice(`Effort set to ${level}. Saved as this account’s default for new sessions, and the next turn uses it.`);
    } catch (error) {
      if (isRuntimeEndpointUnavailable(error) || isEffortActionUnsupported(error)) {
        setRestartRequired(true);
        return;
      }
      setFailure(error instanceof ApiError ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function openCodexPicker() {
    if (!canControl || terminal || !promptReady || submitting || restartRequired) return;
    setSubmitting(true);
    setFailure(null);
    setNotice(null);
    try {
      await api.runtime(config.id, { action: 'model' }, crypto.randomUUID());
      if (onOpenTerminal?.()) {
        onClose();
        return;
      }
      setNotice('Codex opened its native picker. Select Terminal, then choose a model and its reasoning level.');
    } catch (error) {
      if (isRuntimeEndpointUnavailable(error)) {
        setRestartRequired(true);
        return;
      }
      setFailure(error instanceof ApiError ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  const title = 'Reasoning effort';
  if (terminal) {
    return (
      <div className="mt-4 border-t border-border-soft pt-3">
        <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
        <p className="mt-1 text-meta leading-base text-muted">
          Changing the reasoning level requires a running session. Resume or relaunch this session first.
        </p>
      </div>
    );
  }
  if (!canControl) {
    return (
      <div className="mt-4 border-t border-border-soft pt-3">
        <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
        <p className="mt-1 text-meta leading-base text-muted">
          This origin is read-only, so it cannot change the running session’s reasoning level.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-border-soft pt-3">
      <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
      {!promptReady && (
        <p className="mt-2 text-meta leading-base text-warn">
          Wait for an idle prompt before changing the reasoning level. The daemon refuses a busy pane instead of
          queueing this command.
        </p>
      )}

      {restartRequired ? (
        <p role="alert" className="mt-2 rounded-control border border-warn-border bg-surface-2 p-3 text-ui text-warn">
          Daemon restart required to enable in-session effort switching.
        </p>
      ) : config.harness === 'claude' ? (
        <ClaudeEffortChoices disabled={submitting || !promptReady} onChoose={level => void runEffortCommand(level)} />
      ) : config.harness === 'codex' ? (
        <div className="mt-3">
          <p className="m-0 text-meta leading-base text-muted">
            Codex sets reasoning inside its native picker — it asks for a model, then the reasoning level that model
            supports. There is no separate reasoning command, so this opens the same picker.
          </p>
          <button
            type="button"
            disabled={submitting || !promptReady}
            onClick={() => void openCodexPicker()}
            className="kt-btn mt-3 flex min-h-[44px] w-full items-center justify-between gap-sm text-left"
          >
            <span>{submitting ? 'Opening native picker…' : 'Open model + reasoning picker in Terminal'}</span>
            {submitting ? (
              <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin" />
            ) : (
              <Terminal size={15} aria-hidden="true" className="shrink-0" />
            )}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-meta leading-base text-muted">
          In-session effort switching is not available for this harness, so no nonfunctional control is shown.
        </p>
      )}

      {notice && (
        <p role="status" className="mt-2 text-ui leading-base text-ok">
          {notice}
        </p>
      )}
      {failure && (
        <p
          role="alert"
          className="mt-2 rounded-control border border-err-border bg-surface-2 p-3 text-ui leading-base text-err"
        >
          {failure}
        </p>
      )}
    </div>
  );
}

/** The four Claude effort levels as a 2-column grid of 44px targets, mirroring
 *  ClaudeRuntimeChoices. Presentational: the parent owns the submit + notices. */
export function ClaudeEffortChoices({
  disabled,
  onChoose,
}: {
  disabled: boolean;
  onChoose: (level: ClaudeEffortLevel) => void;
}) {
  return (
    <div className="mt-3">
      <p className="m-0 text-meta leading-base text-muted">
        Reasoning effort for new Claude turns. Persists to this account’s settings (saved as the default for new
        sessions). Claude does not echo the level back, so it is shown as sent, not re-verified.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2" aria-label="Set Claude reasoning effort">
        {CLAUDE_EFFORT_LEVELS.map(level => (
          <button
            key={level}
            type="button"
            disabled={disabled}
            onClick={() => onChoose(level)}
            aria-label={`Set reasoning effort to ${level}`}
            className="kt-btn flex min-h-[44px] items-center justify-center capitalize"
          >
            {level}
          </button>
        ))}
      </div>
    </div>
  );
}

function Group({
  icon,
  title,
  tone,
  children,
  headerAction,
  footerAction,
  as = 'h2',
}: {
  icon: ReactNode;
  title: string;
  tone: keyof typeof GROUP_TONE;
  children: ReactNode;
  headerAction?: ReactNode;
  footerAction?: ReactNode;
  /** Lineage folds UNDER Identity inside its panel, so it is a subheading, not a
   *  peer group. Everything else keeps the panel-level h2. Same visual class. */
  as?: 'h2' | 'h3';
}) {
  const Heading = as;
  const heading = (
    <Heading className={cn('kt-label m-0 flex items-center gap-xs border-l-heavy pl-cell-x', GROUP_TONE[tone])}>
      {icon}
      {title}
    </Heading>
  );
  return (
    <section className="kt-details__group">
      {headerAction ? (
        <div className="mb-xs flex min-h-[44px] items-center justify-between gap-sm">
          {heading}
          {headerAction}
        </div>
      ) : (
        <div className="mb-xs">{heading}</div>
      )}
      <dl className="m-0 grid gap-xs">{children}</dl>
      {footerAction && <div className="mt-3">{footerAction}</div>}
    </section>
  );
}

/** The retained session pane keeps SessionDetails mounted while closed, so a
 *  normal useFleet() here would subscribe every hidden pane to every fleet
 *  update. Keep the hook order stable but attach the store listener only while
 *  the sheet is genuinely open; the closing frame reads the last snapshot. */
function useOpenFleet(open: boolean) {
  const store = useStore();
  const subscribe = useCallback(
    (notify: () => void) => (open ? store.subscribe(notify) : () => undefined),
    [open, store],
  );
  return useSyncExternalStore(subscribe, store.getFleet, store.getFleet);
}

function sessionName(view: SessionView): string {
  return displayCallsign(view.config.teammate) || view.config.name?.trim() || shortSessionId(view.config.id);
}

function sessionPath(id: string): string {
  return `/session/${encodeURIComponent(id)}`;
}

function LineageGroup({
  open,
  sessionId,
  parentId,
  onNavigate,
}: {
  open: boolean;
  sessionId: string;
  parentId?: string;
  onNavigate: () => void;
}) {
  const store = useStore();
  const { sessions, byId } = useOpenFleet(open);
  const lineage = useMemo(() => buildLineage(sessions ?? []), [sessions]);
  const parent = useMemo(() => parentDisplay(parentId, byId), [parentId, byId]);
  const children = useMemo(
    () => [...(lineage.childrenOf.get(sessionId) ?? [])].sort(byNewestActivity),
    [lineage, sessionId],
  );

  if (!parent && children.length === 0) return null;

  const shownChildren = children.slice(0, MAX_DIRECT_CHILDREN);
  const hiddenChildren = children.length - shownChildren.length;
  // Use the undecorated prefix: shortSessionId() adds an ellipsis for display,
  // but the fleet haystack contains the raw parent id this query must match.
  const parentQuery = sessionId.slice(0, 8);
  const closeBeforeRoute = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    onNavigate();
  };
  const showAllChildren = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    // The router intentionally parses only pathnames, so mirror the honest URL
    // query into the persisted dashboard controls before its click handler runs.
    store.setControls({ query: parentQuery });
    onNavigate();
  };

  return (
    <Group icon={<GitFork size={13} aria-hidden="true" />} title="Lineage" tone="lineage" as="h3">
      {parent && (
        <div className="flex items-start gap-sm">
          <dt className="w-[104px] shrink-0 text-meta text-muted">Parent</dt>
          <dd className="m-0 min-w-0 flex-1 text-cell">
            {parent.kind === 'resolved' ? (
              <Link
                to={sessionPath(parent.view.config.id)}
                data-lineage-nav="parent"
                onClickCapture={closeBeforeRoute}
                className="inline-flex min-w-0 max-w-full items-center gap-xs text-accent hover:underline"
                title={`${parent.name} · ${parent.view.config.id}`}
              >
                <span className="min-w-0 truncate">{parent.name}</span>
                <span className="mono shrink-0 text-meta text-faint">{shortSessionId(parent.view.config.id)}</span>
              </Link>
            ) : (
              <span className="text-faint" title={parentId}>
                missing record · <span className="mono">{parent.shortId}</span>
              </span>
            )}
          </dd>
        </div>
      )}

      {children.length > 0 && (
        <div className="flex items-start gap-sm">
          <dt className="w-[104px] shrink-0 text-meta text-muted">Direct children</dt>
          <dd className="m-0 grid min-w-0 flex-1 gap-xs">
            {shownChildren.map(child => {
              const name = sessionName(child);
              return (
                <Link
                  key={child.config.id}
                  to={sessionPath(child.config.id)}
                  data-lineage-nav="child"
                  onClickCapture={closeBeforeRoute}
                  className="flex min-w-0 items-center gap-xs rounded-control px-1.5 py-1 text-cell text-fg-soft hover:bg-surface-2 hover:text-accent"
                  title={`${name} · ${child.config.id}`}
                >
                  <StatusMark view={child} size={7} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span className="mono shrink-0 text-meta text-faint">{shortSessionId(child.config.id)}</span>
                </Link>
              );
            })}
            {hiddenChildren > 0 && (
              <Link
                to={`/?q=${encodeURIComponent(parentQuery)}`}
                onClickCapture={showAllChildren}
                className="px-1.5 text-meta text-accent hover:underline"
              >
                +{hiddenChildren} more direct children
              </Link>
            )}
          </dd>
        </div>
      )}
    </Group>
  );
}

function Row({
  label,
  value,
  mono,
  hint,
  tone,
}: {
  label: string;
  value?: string | number | null;
  mono?: boolean;
  hint?: string;
  /** Extra colour on the VALUE only, always alongside the value's own words. */
  tone?: string;
}) {
  const text = value === undefined || value === null || value === '' ? '—' : String(value);
  return (
    <div className="flex items-baseline gap-sm">
      <dt className="w-[104px] shrink-0 text-meta text-muted" title={hint}>
        {label}
      </dt>
      <dd
        className={cn(
          'm-0 min-w-0 flex-1 break-words text-cell',
          text === '—' ? 'text-faint' : (tone ?? 'text-fg-soft'),
          mono && 'mono',
        )}
        title={typeof value === 'string' && value.length > 40 ? value : undefined}
      >
        {text}
      </dd>
    </div>
  );
}

/** Liveness ages tick every second, so they are isolated in their own memo —
 *  the same pattern the old header strip used, and the reason a 1s interval
 *  here does not re-render the drawer's other three groups. */
const ProgressRows = memo(function ProgressRows({ view, liveStatus }: { view: SessionView; liveStatus: LiveStatus }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const { state } = view;
  const ctx = state.contextPercent;
  const ctxTone = ctx == null ? undefined : ctx >= 90 ? 'text-err' : ctx >= 75 ? 'text-warn' : undefined;

  return (
    <>
      <Row label="Status" value={state.status} />
      {state.waiting && (
        <Row
          label="Parked on"
          value={`${state.waiting.condition ?? 'external condition'}${
            state.waiting.until ? ` · until ${fmtAbsolute(state.waiting.until)}` : ''
          }`}
          tone="text-warn"
        />
      )}
      {state.waiting?.peer && (
        <Row label="Waiting for" value={state.waiting.peerName ?? state.waiting.peer} mono tone="text-warn" />
      )}
      <Row label="Health" value={state.health} />
      <Row label="Turn" value={state.turn} />
      <Row label="Context used" value={ctx == null ? undefined : `${ctx}%`} tone={ctxTone} />
      <Row label="Activity" value={state.activity} />
      <Row label="Last activity" value={state.lastActivityAt ? fmtRelative(state.lastActivityAt) : undefined} />
      {state.nudgedAt && <Row label="Nudged" value={fmtRelative(state.nudgedAt)} tone="text-warn" />}
      {state.needsHuman && <Row label="Needs human" value={state.needsHuman} tone="text-err" />}
      {state.retryAttempt != null && state.retryAttempt > 0 && <Row label="Retry attempt" value={state.retryAttempt} />}
      {/* The A6 liveness ledger: which life-signs the daemon has seen and how
          long ago. Written out with names rather than the old `txn 4s · tok 9s`
          shorthand, which needed a tooltip to be readable at all. */}
      <Row
        label="Transcript"
        value={ageOf(state.lastTranscriptAt)}
        mono
        hint="seconds since the last transcript write"
      />
      <Row
        label="Tokens"
        value={ageOf(state.lastTokenAdvanceAt)}
        mono
        hint="seconds since the token counter advanced"
      />
      <Row
        label="Counters"
        value={ageOf(state.lastCounterAdvanceAt)}
        mono
        hint="seconds since a pane counter advanced"
      />
      <Row label="Subprocess" value={ageOf(state.lastSubprocessAt)} mono hint="seconds since a subprocess life-sign" />
      <Row label="Pane" value={ageOf(state.lastPaneAt)} mono hint="seconds since the tmux pane changed" />
      <Row
        label="Socket"
        value={liveStatus}
        tone={liveStatus === 'open' ? 'text-ok' : liveStatus === 'connecting' ? 'text-warn' : 'text-err'}
        hint="live event stream to the daemon"
      />
    </>
  );
});

const BudgetRows = memo(function BudgetRows({ view, quota }: { view: SessionView; quota: Quota | null }) {
  const { config } = view;
  const nothing =
    !quota ||
    (quota.authOk !== false &&
      quota.fiveHourPercent == null &&
      quota.weeklyPercent == null &&
      quota.atLimit !== true &&
      quota.fiveHourResetAt == null &&
      quota.weeklyResetAt == null);

  if (nothing) {
    return (
      <>
        <Row label="Account" value={config.binary} mono />
        <Row label="Quota" value={undefined} hint="the usage feed has no record for this wrapper yet" />
        <p className="m-0 text-meta leading-base text-faint">
          No usage data for this wrapper yet — that is “unknown”, not “nothing used”.
        </p>
      </>
    );
  }

  return (
    <>
      <Row label="Account" value={config.binary} mono />
      {quota.authOk === false && <Row label="Auth" value="login required" tone="text-err" />}
      <Row
        label="5-hour window"
        value={quota.fiveHourPercent == null ? undefined : `${quota.fiveHourPercent}% used`}
        tone={pctTone(quota.fiveHourPercent)}
      />
      <Row label="5-hour resets" value={resetAt(quota.fiveHourResetAt)} mono />
      <Row
        label="Weekly window"
        value={quota.weeklyPercent == null ? undefined : `${quota.weeklyPercent}% used`}
        tone={pctTone(quota.weeklyPercent)}
      />
      <Row label="Weekly resets" value={resetAt(quota.weeklyResetAt)} mono />
      {quota.atLimit === true && (
        <div className="flex items-center gap-xs text-meta text-err">
          <AlertTriangle size={12} aria-hidden="true" />
          at limit — the wrapper is rate-limited until the window rolls over
        </div>
      )}
    </>
  );
});

function pctTone(pct?: number): string | undefined {
  if (pct == null) return undefined;
  return pct >= 90 ? 'text-err' : pct >= 75 ? 'text-warn' : undefined;
}

function resetAt(at?: number): string | undefined {
  if (at == null) return undefined;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.toLocaleTimeString()} · ${fmtRelative(date.toISOString())}`;
}

function ageOf(at?: string): string | undefined {
  return at ? fmtAge(at) : undefined;
}
