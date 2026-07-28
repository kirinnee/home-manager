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
  type UIEvent as ReactUIEvent,
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
import type { SessionView } from '../types';
import type { Quota } from '../lib/usage';
import { api, ApiError } from '../lib/api';
import {
  fetchRuntimeModelCatalog,
  requireRuntimeModelCatalogHarness,
  type RuntimeModelCatalog,
  type RuntimeModelChoice,
} from '../lib/runtime-models';
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
  /** The page owns the Chat/Terminal state. Used only when Codex's live model
   * catalog is unavailable and the reader falls back to its native picker. */
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
  /** ONE fixed height instead of sizing to the content. A tabbed sheet must
   *  not change height when the reader switches tabs — the tab bar they just
   *  tapped would relocate under their thumb — so the tabbed caller pins the
   *  sheet to its ceiling and lets only the content area scroll. Callers whose
   *  content is a single fixed form keep the shrink-to-fit default. */
  height?: string;
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
  height,
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
          // `height` (when given) still yields to `maxHeight`: the fixed
          // height is the tall-end pick and maxHeight is the keyboard-safe
          // ceiling, so an open keyboard shrinks the sheet rather than letting
          // it run underneath.
          ...(height ? { height } : {}),
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
  const clearModelVerificationPending = useCallback(() => {
    observedAtSwitchRef.current = undefined;
    setModelVerificationPending(false);
  }, []);
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

  // PER-TAB SCROLL MEMORY. The sheet is one fixed-height shell with ONE
  // scroller carrying whichever panel is selected, so without this a scroll on
  // Progress would leak into Budget and coming back would land wherever the
  // other tab left the scroller. Each tab's offset is recorded on every scroll
  // (cheap: a ref write, no render) and put back before paint when its panel
  // returns. A tab never visited starts at 0. The memory is per-mount — a
  // remembered offset can never outlive the panel content it was measured in
  // longer than this SessionDetails instance.
  const panelScrollerRef = useRef<HTMLDivElement | null>(null);
  const tabScrollRef = useRef(new Map<DetailsTab, number>());
  const rememberPanelScroll = useCallback(
    (event: ReactUIEvent<HTMLDivElement>) => {
      tabScrollRef.current.set(tab, event.currentTarget.scrollTop);
    },
    [tab],
  );
  // Before paint, so the reader never sees the wrong offset flash. `open` is a
  // dependency because the scroller REMOUNTS on reopen (the closed sheet
  // renders nothing) and the remembered tab should come back where it was left.
  useLayoutEffect(() => {
    if (!open) return;
    const el = panelScrollerRef.current;
    if (el) el.scrollTop = tabScrollRef.current.get(tab) ?? 0;
  }, [tab, open]);
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
      // FIXED, not content-sized. Measured before this (390x844): the sheet was
      // 407px tall on Budget and 760px on Runtime, so every tab switch moved
      // the tab bar itself — you tapped a tab and the strip you tapped jumped
      // up to 353px. The sheet now RESTS at its ceiling: the same 90dvh /
      // keyboard-safe expression as maxHeight, so the height is one stable
      // number per viewport state and only the panel scroller's content varies.
      // Height changes only when the viewport itself changes (keyboard, rotate)
      // — never on a tab switch, and nothing animates height.
      height="min(90dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
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
      <div ref={panelScrollerRef} onScroll={rememberPanelScroll} className="min-h-0 flex-1 overflow-y-auto scroll-thin">
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
                    onModelSwitchFailed={clearModelVerificationPending}
                    onOpenTerminal={onOpenTerminal}
                    onClose={onClose}
                  />
                  {/* Codex already chooses an advertised reasoning level after a
                      model above, so a second details control would be redundant;
                      Claude has a real /effort command, so it gets its own. */}
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

interface RuntimeModelControlsProps {
  view: SessionView;
  open: boolean;
  canControl: boolean;
  onModelSwitch: () => void;
  onModelSwitchFailed?: () => void;
  onOpenTerminal?: () => boolean;
  onClose: () => void;
}

function useRuntimeModelCatalog(sessionId: string, enabled: boolean, expectedHarness: RuntimeModelCatalog['harness']) {
  const [catalog, setCatalog] = useState<RuntimeModelCatalog | null>(null);
  const [error, setError] = useState<unknown>(null);
  const requestKey = `${sessionId}\0${expectedHarness}`;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setCatalog(null);
    setError(null);
    setLoadedFor(null);
    void fetchRuntimeModelCatalog(sessionId)
      .then(value => {
        if (!cancelled) {
          setCatalog(requireRuntimeModelCatalogHarness(value, expectedHarness));
          setLoadedFor(requestKey);
        }
      })
      .catch(reason => {
        if (!cancelled) {
          setError(reason);
          setLoadedFor(requestKey);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, expectedHarness, requestKey, sessionId]);
  return loadedFor === requestKey ? { catalog, error } : { catalog: null, error: null };
}

export function codexPickerFallbackNeeded(
  catalog: RuntimeModelCatalog | null,
  error: unknown,
  choice?: RuntimeModelChoice,
  requireChoice = false,
): boolean {
  if (error) return true;
  if (!catalog) return false;
  if (catalog.choices.length === 0) return true;
  if (requireChoice && !choice) return true;
  return choice?.reasoningEfforts.length === 0;
}

/** One account-aware list for both harnesses. Claude's values come from its
 * wrapper allowlist; Codex's come from that wrapper's app-server model/list. */
export function RuntimeModelControls({
  view,
  open,
  canControl,
  onModelSwitch,
  onModelSwitchFailed,
  onOpenTerminal,
  onClose,
}: RuntimeModelControlsProps) {
  const { config, state } = view;
  const terminal = TERMINAL_STATUSES.has(state.status);
  const promptReady = state.promptReady === true;
  const { catalog, error: catalogError } = useRuntimeModelCatalog(
    config.id,
    open && canControl && !terminal,
    config.harness,
  );
  const [selectedCodexModel, setSelectedCodexModel] = useState<RuntimeModelChoice | null>(null);
  const [submittingTarget, setSubmittingTarget] = useState<{ model: string; effort?: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const submitting = submittingTarget !== null;

  useEffect(() => {
    setRestartRequired(false);
    setFailure(null);
    setNotice(null);
    setSelectedCodexModel(null);
    setSubmittingTarget(null);
  }, [config.id]);

  useEffect(() => {
    if (open) return;
    setRestartRequired(false);
    setSelectedCodexModel(null);
  }, [open]);

  // Claude has no safe manual fallback for a missing catalog route. Codex
  // does: keep its established bare native picker available on version skew.
  useEffect(() => {
    if (config.harness === 'claude' && isRuntimeEndpointUnavailable(catalogError)) setRestartRequired(true);
  }, [catalogError, config.harness]);

  const codexPickerFallback =
    config.harness === 'codex' && codexPickerFallbackNeeded(catalog, catalogError, selectedCodexModel ?? undefined);

  async function runModelCommand(model?: string, effort?: string) {
    if (!canControl || terminal || !promptReady || submitting || restartRequired) return;
    const targeted = Boolean(model);
    setSubmittingTarget({ model: model ?? 'native-picker', ...(effort ? { effort } : {}) });
    setFailure(null);
    setNotice(null);
    if (targeted) onModelSwitch();
    try {
      await api.runtime(
        config.id,
        { action: 'model', ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
        crypto.randomUUID(),
      );
      if (config.harness === 'codex' && !model) {
        if (onOpenTerminal?.()) {
          onClose();
          return;
        }
        setNotice('Codex opened its native picker in Terminal. No switch is claimed until Codex reports one.');
      } else if (config.harness === 'codex') {
        setSelectedCodexModel(null);
        setNotice(`Codex confirmed ${model} · ${effort} from its runtime settings.`);
      } else {
        setNotice('Model command sent. Verification updates after the next model response.');
      }
    } catch (error) {
      if (targeted) onModelSwitchFailed?.();
      if (isRuntimeEndpointUnavailable(error)) {
        setRestartRequired(true);
        return;
      }
      setFailure(error instanceof ApiError ? error.message : String(error));
    } finally {
      setSubmittingTarget(null);
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
      ) : config.harness === 'claude' || config.harness === 'codex' ? (
        selectedCodexModel && config.harness === 'codex' ? (
          <RuntimeReasoningStep
            model={selectedCodexModel}
            currentEffort={state.observedModel === selectedCodexModel.value ? state.observedReasoningEffort : undefined}
            submittingEffort={submittingTarget?.effort}
            disabled={submitting || !promptReady}
            backDisabled={submitting}
            onBack={() => setSelectedCodexModel(null)}
            onChoose={effort => void runModelCommand(selectedCodexModel.value, effort)}
          />
        ) : (
          <RuntimeModelChoices
            harness={config.harness}
            choices={catalog?.choices ?? null}
            error={catalogError}
            currentModel={state.observedModel}
            submittingModel={submittingTarget?.model}
            disabled={submitting || !promptReady}
            onChoose={choice => {
              if (config.harness === 'codex') setSelectedCodexModel(choice);
              else void runModelCommand(choice.value);
            }}
          />
        )
      ) : (
        <p className="mt-2 text-meta leading-base text-muted">
          In-session model switching is not available for this harness, so no nonfunctional control is shown.
        </p>
      )}

      {codexPickerFallback && !restartRequired && (
        <button
          type="button"
          disabled={submitting || !promptReady}
          onClick={() => void runModelCommand()}
          className="kt-btn mt-3 flex min-h-[44px] min-w-[44px] w-full items-center justify-between gap-sm text-left"
        >
          <span>{submitting ? 'Opening native picker…' : 'Use native picker in Terminal'}</span>
          {submitting ? (
            <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin" />
          ) : (
            <Terminal size={15} aria-hidden="true" className="shrink-0" />
          )}
        </button>
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

export function RuntimeModelChoices({
  harness,
  choices,
  error,
  currentModel,
  submittingModel,
  disabled,
  onChoose,
}: {
  harness: 'claude' | 'codex';
  choices: RuntimeModelChoice[] | null;
  error: unknown;
  currentModel?: string;
  submittingModel?: string;
  disabled: boolean;
  onChoose: (model: RuntimeModelChoice) => void;
}) {
  if (error) {
    return (
      <p
        role="alert"
        className="mt-2 rounded-control border border-err-border bg-surface-2 p-3 text-ui leading-base text-err"
      >
        Account-aware model choices are unavailable: {error instanceof ApiError ? error.message : String(error)}
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
        This account does not advertise any in-place model choices.
      </p>
    );
  }
  return (
    <div className="mt-3">
      <p role="status" aria-live="polite" className="m-0 text-meta leading-base text-muted">
        {harness === 'codex'
          ? 'Live choices from this account’s Codex model catalog. Choose a model, then one of its advertised reasoning levels.'
          : 'Only this account’s advertised Claude choices are shown. Verification updates after the next model response.'}
      </p>
      <div className="mt-2 grid gap-2" aria-label={`Switch ${harness} model in place`}>
        {choices.map(choice => {
          const current = choice.value === currentModel;
          const pending = choice.value === submittingModel;
          return (
            <button
              key={choice.value}
              type="button"
              disabled={disabled}
              onClick={() => onChoose(choice)}
              aria-label={`Switch model in place to ${choice.label}${current ? ', current' : ''}`}
              aria-current={current ? 'true' : undefined}
              aria-busy={pending || undefined}
              className="kt-btn flex min-h-[44px] min-w-[44px] w-full items-center justify-between gap-sm text-left"
            >
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-sm">
                  <span className="truncate text-ui font-semibold">{choice.label}</span>
                  {current && <span className="kt-label shrink-0">Current</span>}
                  {!current && choice.isDefault && <span className="kt-label shrink-0">Default</span>}
                </span>
                {choice.label !== choice.value && (
                  <span className="mono block truncate text-meta text-muted">{choice.value}</span>
                )}
                {choice.description && (
                  <span className="mt-1 block text-meta leading-base text-muted">{choice.description}</span>
                )}
              </span>
              {pending && <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function effortDisplayName(effort: string): string {
  if (effort === 'xhigh') return 'Extra high';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function RuntimeReasoningStep({
  model,
  currentEffort,
  submittingEffort,
  disabled,
  backDisabled,
  onBack,
  onChoose,
}: {
  model: RuntimeModelChoice;
  currentEffort?: string;
  submittingEffort?: string;
  disabled: boolean;
  backDisabled: boolean;
  onBack: () => void;
  onChoose: (effort: string) => void;
}) {
  return (
    <div className="mt-3">
      <button
        type="button"
        autoFocus
        disabled={backDisabled}
        onClick={onBack}
        className="kt-btn flex min-h-[44px] min-w-[44px] items-center px-3"
      >
        Back to models
      </button>
      <RuntimeReasoningChoices
        model={model}
        currentEffort={currentEffort}
        submittingEffort={submittingEffort}
        disabled={disabled}
        onChoose={onChoose}
      />
    </div>
  );
}

export function RuntimeReasoningChoices({
  model,
  currentEffort,
  submittingEffort,
  disabled,
  onChoose,
}: {
  model: RuntimeModelChoice;
  currentEffort?: string;
  submittingEffort?: string;
  disabled: boolean;
  onChoose: (effort: string) => void;
}) {
  if (model.reasoningEfforts.length === 0)
    return (
      <p role="alert" className="mt-2 rounded-control border border-err-border bg-surface-2 p-3 text-ui text-err">
        {model.label} did not advertise any supported reasoning levels. Use Codex’s native Terminal picker instead.
      </p>
    );
  return (
    <div className="mt-3">
      <p role="status" aria-live="polite" className="m-0 text-meta leading-base text-muted">
        Reasoning for <span className="mono text-fg-soft">{model.value}</span>. The switch stays pending until Codex
        reports this exact model and level.
      </p>
      <div className="mt-2 grid gap-2" aria-label={`Set reasoning for ${model.label}`}>
        {model.reasoningEfforts.map(effort => {
          const current = effort.value === currentEffort;
          const pending = effort.value === submittingEffort;
          const isDefault = effort.value === model.defaultReasoningEffort;
          return (
            <button
              key={effort.value}
              type="button"
              disabled={disabled}
              onClick={() => onChoose(effort.value)}
              aria-label={`Set ${model.label} reasoning to ${effortDisplayName(effort.value)}${current ? ', current' : ''}`}
              aria-current={current ? 'true' : undefined}
              aria-busy={pending || undefined}
              className="kt-btn flex min-h-[44px] min-w-[44px] w-full items-center justify-between gap-sm text-left"
            >
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-sm">
                  <span className="truncate text-ui font-semibold">{effortDisplayName(effort.value)}</span>
                  {current && <span className="kt-label shrink-0">Current</span>}
                  {!current && isDefault && <span className="kt-label shrink-0">Default</span>}
                </span>
                {effort.description && (
                  <span className="mt-1 block text-meta leading-base text-muted">{effort.description}</span>
                )}
              </span>
              {pending && <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin" />}
            </button>
          );
        })}
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
   *  view only as a fallback when its live catalog cannot be probed. */
  onOpenTerminal?: () => boolean;
  /** Codex's model and effort are applied as one verified native-picker action. */
  onCodexSwitchStart?: () => void;
  onCodexSwitchFailed?: () => void;
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
 *     is no `/reasoning <x>` verb. The sheet reads the current model's ordered
 *     efforts from model/list, then asks the daemon to drive that native picker
 *     and wait for thread_settings_applied.
 *
 * Anything a harness cannot actually do is never rendered as a live control.
 */
export function RuntimeEffortControls({
  view,
  canControl,
  onEffortSwitch,
  onOpenTerminal,
  onCodexSwitchStart,
  onCodexSwitchFailed,
  onClose,
}: RuntimeEffortControlsProps) {
  const { config, state } = view;
  const terminal = TERMINAL_STATUSES.has(state.status);
  const promptReady = state.promptReady === true;
  const [submitting, setSubmitting] = useState(false);
  const [codexSubmittingEffort, setCodexSubmittingEffort] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const { catalog, error: catalogError } = useRuntimeModelCatalog(
    config.id,
    canControl && !terminal && config.harness === 'codex',
    config.harness,
  );

  useEffect(() => {
    setRestartRequired(false);
    setFailure(null);
    setNotice(null);
    setCodexSubmittingEffort(null);
  }, [config.id]);

  const currentCodexModel = catalog?.choices.find(choice => choice.value === state.observedModel);
  const codexPickerFallback =
    config.harness === 'codex' && codexPickerFallbackNeeded(catalog, catalogError, currentCodexModel, true);

  async function runEffortCommand(level: string) {
    if (!canControl || terminal || !promptReady || submitting || restartRequired) return;
    setSubmitting(true);
    setCodexSubmittingEffort(null);
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
      setCodexSubmittingEffort(null);
      setSubmitting(false);
    }
  }

  async function runCodexEffort(model: RuntimeModelChoice, effort: string) {
    if (!canControl || terminal || !promptReady || submitting || restartRequired) return;
    setSubmitting(true);
    setCodexSubmittingEffort(effort);
    setFailure(null);
    setNotice(null);
    onCodexSwitchStart?.();
    try {
      await api.runtime(config.id, { action: 'model', model: model.value, effort }, crypto.randomUUID());
      setNotice(`Codex confirmed ${model.value} · ${effort} from its runtime settings.`);
    } catch (error) {
      onCodexSwitchFailed?.();
      if (isRuntimeEndpointUnavailable(error)) {
        setRestartRequired(true);
        return;
      }
      setFailure(error instanceof ApiError ? error.message : String(error));
    } finally {
      setCodexSubmittingEffort(null);
      setSubmitting(false);
    }
  }

  async function openCodexPickerFallback() {
    if (!canControl || terminal || !promptReady || submitting || restartRequired) return;
    setSubmitting(true);
    setCodexSubmittingEffort(null);
    setFailure(null);
    setNotice(null);
    try {
      await api.runtime(config.id, { action: 'model' }, crypto.randomUUID());
      if (onOpenTerminal?.()) {
        onClose();
        return;
      }
      setNotice('Codex opened its native picker in Terminal. No switch is claimed until Codex reports one.');
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
          {catalogError ? (
            <p
              role="alert"
              className="m-0 rounded-control border border-err-border bg-surface-2 p-3 text-ui leading-base text-err"
            >
              Account-aware reasoning choices are unavailable:{' '}
              {catalogError instanceof ApiError ? catalogError.message : String(catalogError)}
            </p>
          ) : catalog === null ? (
            <div role="status" className="flex min-h-[44px] items-center gap-sm text-ui text-muted">
              <LoaderCircle size={15} aria-hidden="true" className="animate-spin" />
              Loading account-aware reasoning choices…
            </div>
          ) : (
            (() => {
              return currentCodexModel ? (
                <RuntimeReasoningChoices
                  model={currentCodexModel}
                  currentEffort={state.observedReasoningEffort}
                  submittingEffort={codexSubmittingEffort ?? undefined}
                  disabled={submitting || !promptReady}
                  onChoose={effort => void runCodexEffort(currentCodexModel, effort)}
                />
              ) : (
                <p
                  role="alert"
                  className="m-0 rounded-control border border-err-border bg-surface-2 p-3 text-ui text-err"
                >
                  The observed model ({state.observedModel || 'unknown'}) is not in this account’s current Codex
                  catalog. Refresh the session or use the native Terminal picker.
                </p>
              );
            })()
          )}
          {codexPickerFallback && !restartRequired && (
            <button
              type="button"
              disabled={submitting || !promptReady}
              onClick={() => void openCodexPickerFallback()}
              className="kt-btn mt-3 flex min-h-[44px] min-w-[44px] w-full items-center justify-between gap-sm text-left"
            >
              <span>{submitting ? 'Opening native picker…' : 'Use native picker in Terminal'}</span>
              {submitting ? (
                <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin" />
              ) : (
                <Terminal size={15} aria-hidden="true" className="shrink-0" />
              )}
            </button>
          )}
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
 *  RuntimeModelChoices. Presentational: the parent owns submit + notices. */
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
