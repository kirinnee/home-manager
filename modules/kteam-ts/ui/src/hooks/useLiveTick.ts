// THE TRANSCRIPT'S "HOLD STILL" GATE — and the live clock that obeys it.
//
// WHAT ACTUALLY COLLAPSES A WEBKIT SELECTION. MEASURED, ROUND 8.
//
// Rounds 1 and 2 both shipped a fix and the reader still could not highlight a
// live conversation, because both were built on an inherited guess — "WebKit
// clears a selection on ANY nearby DOM mutation" — that nobody had ever run.
// It is wrong. Measured in headless WebKit (playwright WPE 2311, 390x844 mobile
// context, selection made with a real mouse drag; probes in the coordination
// dir), against a selection held in block b3:
//
//   BROKE     a React text update INSIDE the selected block
//               (`textNode.nodeValue = next` — React's commitTextUpdate)
//   BROKE     the selected block's children restructured (a markdown re-parse:
//               the closing ** of a **bold** span arrives and one text node
//               becomes text + <strong>)
//   BROKE     the selected block unmounted/remounted (a React key change)
//   SURVIVED  the same nodeValue write in ANY OTHER block — the streaming tail,
//               a block above, a one-second timer span
//   SURVIVED  a new block appended, the tail block removed, another block
//               re-created from scratch
//   SURVIVED  a scrollTop write after the drag ended
//   SURVIVED  `characterData.appendData()` even inside the selected block —
//               a true append is fine; it is the wholesale nodeValue ASSIGNMENT
//               React performs that kills it
//
// So the rule is narrow and specific: WHATEVER ELEMENT THE SELECTION IS IN MUST
// NOT BE RE-RENDERED. Everything else in the transcript may mutate freely.
//
// THE CONSEQUENCE FOR THE LIVE TIMERS: they were never the bug. `<Elapsed/>` and
// `<ThinkingIndicator/>` live in their own elements, so their per-second write is
// in the SURVIVED column — which is precisely why round 2's freeze changed
// nothing for the user. What IS the bug is the streaming assistant block being
// re-rendered while the reader selects text in it: every delta rewrites that
// block's text node, and that is the top line of the BROKE list. End to end, on
// the same engine: a reader selecting inside a block streaming at 4 deltas/sec
// lost the selection immediately; with the deltas deferred while the gate is
// held, the selection survived 3 seconds and 12 deferred deltas intact.
//
// THE TIMER FREEZE IS KEPT ANYWAY, in a corrected form — it costs nothing, it
// removes real per-second churn, and it is unconditionally safe. But note WHY
// the old form was ineffective even on its own terms, because the shape recurs:
//
//   FREEZING A RE-RENDER FREEZES NOTHING IF SOMEONE ELSE RE-RENDERS YOU.
//   The old hook returned a counter that stopped incrementing while a selection
//   was held, and the callers read `Date.now()` themselves in render.
//   `ThinkingIndicator` is built inline in SessionChatPage's `transcriptFooter`
//   and is not memoized, so EVERY store notification re-renders it — and the
//   store coalesces stream events at 250ms (store.tsx NOTIFY_COALESCE_MS), i.e.
//   ~4 times a second for a whole live turn. Each of those read a fresh
//   `Date.now()` and emitted a new string, so the label mutated on schedule no
//   matter what the tick did. So freeze THE VALUE, not the render:
//   `useLiveClock()` returns a timestamp that stops advancing while the gate is
//   held, callers render a pure function of it, and a re-render forced by
//   anything else now produces byte-identical output that React does not write.
//
// AND WHY THE GATE NEEDS THE POINTER, NOT JUST THE SELECTION. `selectionHeld`
// only sees a finished, non-collapsed range. A finger selects by long-pressing
// and DWELLING, and for those first few hundred milliseconds the selection is
// still collapsed or absent. The measurement shows this is not academic: in the
// "before" run above the selection was already destroyed DURING the drag, by a
// delta that landed before a non-collapsed range existed. Transcript.tsx learned
// this for the scroll pin in round 7 (`followPinBlocked`); the gate needs it for
// the same reason.
//
// RELEASE IS ALSO PART OF THE TOUCH GESTURE. WebKit can materialise the finished
// range on or just after `touchend`. Releasing this gate synchronously at that
// event used to flush every deferred stream delta into the selected block during
// the exact blind window above: pointer already up, selection still collapsed.
// That is the same race Transcript's scroll guard already settled for 220ms.
// A plausible touch/pen selection release now keeps the existing hold for that
// beat; an ordinary tap and every mouse release are unchanged. A mouse drag has
// a non-collapsed range before button-up, so the selection signal itself keeps
// its hold without a blind-window timer.
//
// WHAT THE GATE IS FOR. Transcript.tsx suspends the transcript's whole rendered
// content on this one signal. Freezing only the block the selection is in would
// match the measurement exactly, but it would mean every row testing the
// selection against itself on every render; one gate on the container is a
// single subscription in a single place and is a strict superset of what the
// evidence requires.
//
// THE CAP IS NOT OPTIONAL. A gate with no time limit means a reader who leaves a
// highlight standing gets a transcript that has silently stopped updating, which
// is a worse and much more confusing bug than the one being fixed. After
// MAX_HOLD_MS the gate gives up, everything deferred flushes, and the selection
// may well collapse — the same outcome as before the fix, just deferred past the
// length of any real copy gesture.

import { useEffect, useState, useSyncExternalStore } from 'react';

/** Minimal shape of a `Selection` this module needs — declared locally so the
 *  decisions are testable without a DOM (this package has no DOM impl; see
 *  useLiveTick.test.ts). */
export interface TickSelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
}

/** Is a text selection currently HELD? A non-collapsed selection with at least
 *  one range. A bare caret (collapsed) or an empty selection is no obstacle.
 *
 *  NOT sufficient on its own — see hole (2) in the file header: a touch
 *  selection is collapsed for the whole time it is being made. Use
 *  {@link transcriptHeldStill}. */
export function selectionHeld(sel: TickSelectionLike | null): boolean {
  return !!sel && !sel.isCollapsed && sel.rangeCount > 0;
}

/** Does the transcript have to hold still right now? Either signal is enough:
 *
 *    a HELD SELECTION — the mouse/desktop case, and a finished touch selection
 *      the reader is still adjusting or about to copy;
 *    a HELD POINTER   — the touch long-press window the selection check is blind
 *      to, plus any drag. Erring wide is free: the pointer is released within a
 *      gesture, so a spurious hold lasts milliseconds.
 *
 *  Deliberately NOT scoped to a selection anchored inside the transcript. The
 *  scroll pin can afford that test because it runs against one element it owns;
 *  this gate is a document-level singleton shared by every timer and both
 *  transcript panes, and the failure modes are asymmetric — holding still a
 *  fraction of a second too often costs nothing visible, missing a hold costs
 *  the reader their highlight. */
export function transcriptHeldStill(pointerHeld: boolean, sel: TickSelectionLike | null): boolean {
  return pointerHeld || selectionHeld(sel);
}

/** How long the transcript will hold still before giving up and flushing. Long
 *  enough to cover any real copy gesture (long-press, drag the handles, hit
 *  Copy — measured in single-digit seconds), short enough that a forgotten
 *  selection cannot masquerade as a dead transcript. */
export const MAX_HOLD_MS = 20_000;

/** Touch selection may become non-collapsed on or just after release. Shared by
 *  the render hold and Transcript's re-pin/Quote evaluation so neither samples
 *  that unreliable window with a different policy. */
export const SELECTION_RELEASE_SETTLE_MS = 220;

/** The earliest a touch dwell is treated as a possible native long-press.
 *
 *  Native selection normally appears at roughly 500ms. Stopping row mutations
 *  at 350ms intentionally leaves a safety margin: a 350–500ms press may reveal
 *  neither the row Pin bar nor a selection, but it cannot mount new DOM during
 *  the browser's selection-recognition window. Ordinary taps still release the
 *  render hold immediately. */
export const TOUCH_SELECTION_DWELL_MS = 350;

/** Has a hold outlived the cap? `heldSince` is when the CURRENT uninterrupted
 *  hold began, or null when nothing is holding. */
export function holdExpired(heldSince: number | null, now: number, capMs: number = MAX_HOLD_MS): boolean {
  return heldSince !== null && now - heldSince >= capMs;
}

/** THE FULL DECISION: must the transcript hold still right now? Both signals and
 *  the cap, as one pure unit so the whole policy is assertable with plain data
 *  (see useLiveTick.test.ts). */
export function shouldHoldStill(
  pointerHeld: boolean,
  sel: TickSelectionLike | null,
  heldSince: number | null,
  now: number,
  capMs: number = MAX_HOLD_MS,
  releaseSettling = false,
): boolean {
  const activelyHeld = transcriptHeldStill(pointerHeld, sel);
  // The settle flag may only EXTEND a hold that began on pointerdown. A stray or
  // duplicated release event with no heldSince must never manufacture a hold.
  if (!activelyHeld && (!releaseSettling || heldSince === null)) return false;
  return !holdExpired(heldSince, now, capMs);
}

// ---------------------------------------------------------------------------
// The gate controller. Production owns ONE document-level instance, while the
// exported factory lets the DOM-free test suite drive the exact event handlers
// with virtual time. This is deliberately an event controller, not another pure
// predicate: deleting or misrouting mouse/touch release behaviour must fail a
// test even though this package has no jsdom/happy-dom environment.
// ---------------------------------------------------------------------------

export interface TranscriptHoldPointerEventLike {
  pointerId: number;
  pointerType: string;
}

export interface TranscriptHoldTouchEventLike {
  touches: { readonly length: number };
}

export interface TranscriptHoldController {
  getSnapshot(): boolean;
  onSelectionChange(): void;
  onPointerDown(event: TranscriptHoldPointerEventLike): void;
  onPointerUp(event: TranscriptHoldPointerEventLike): void;
  onPointerCancel(event: TranscriptHoldPointerEventLike): void;
  onTouchStart(event?: TranscriptHoldTouchEventLike): void;
  onTouchEnd(event?: TranscriptHoldTouchEventLike): void;
  onBlur(): void;
  reset(): void;
}

interface TranscriptHoldControllerDependencies {
  now(): number;
  readSelection(): TickSelectionLike | null;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
  onHoldChange(holding: boolean): void;
}

/** Build the event controller used by the singleton below. Dependencies are
 *  injectable solely so tests can advance both the release timer and hard cap
 *  without a DOM or wall-clock sleeps. */
export function createTranscriptHoldController(
  dependencies: TranscriptHoldControllerDependencies,
): TranscriptHoldController {
  let pointerDown = false;
  let pointerType = '';
  let pointerStartedAt: number | null = null;
  let selectionChangedDuringGesture = false;
  /** One-shot permission for a pointer that began AFTER a standing range was
   *  capped to prove it is making a new selection episode. A pointer that
   *  itself reaches the cap never gets this permission. */
  let mayRearmCappedSelection = false;
  let cancelledTouchPointerDuringGesture = false;
  const activePointerIds = new Set<number>();
  let activeLegacyTouches = 0;
  /** When the current hold window began; null while idle or after its cap. */
  let heldSince: number | null = null;
  let holding = false;
  let capTimer: unknown | null = null;
  /** Prevent selectionchange from silently starting another hold after the cap.
   *  Idle state or a genuinely new pointer gesture resets it. */
  let capReached = false;
  /** Extends an existing plausible selection gesture through WebKit's blind
   *  post-release window; it can never manufacture a hold from idle. */
  let releaseSettling = false;
  let releaseTimer: unknown | null = null;

  const publish = (next: boolean): void => {
    if (next === holding) return;
    holding = next;
    dependencies.onHoldChange(next);
  };

  const clearCapTimer = (): void => {
    if (capTimer === null) return;
    dependencies.clearTimer(capTimer);
    capTimer = null;
  };

  const clearReleaseSettle = (): void => {
    releaseSettling = false;
    if (releaseTimer === null) return;
    dependencies.clearTimer(releaseTimer);
    releaseTimer = null;
  };

  const expireHold = (): void => {
    clearCapTimer();
    // Clearing this timestamp is essential: a new gesture after the cap must
    // receive a fresh window rather than inherit the first gesture's age.
    heldSince = null;
    capReached = true;
    publish(false);
  };

  /** Recompute from current controller + selection state. Cheap and idempotent,
   *  so selectionchange and duplicate browser input events may over-call it. */
  const recompute = (): void => {
    const selection = dependencies.readSelection();
    const wants = transcriptHeldStill(pointerDown, selection) || releaseSettling;
    if (!wants) {
      heldSince = null;
      capReached = false;
      clearCapTimer();
      publish(false);
      return;
    }
    if (capReached) {
      publish(false);
      return;
    }
    if (heldSince === null) {
      heldSince = dependencies.now();
      capTimer = dependencies.setTimer(expireHold, MAX_HOLD_MS);
    }
    if (holdExpired(heldSince, dependencies.now(), MAX_HOLD_MS)) {
      expireHold();
      return;
    }
    publish(shouldHoldStill(pointerDown, selection, heldSince, dependencies.now(), MAX_HOLD_MS, releaseSettling));
  };

  const beginPointer = (nextPointerType: string): void => {
    // Pointer Events and legacy Touch Events commonly describe the SAME start.
    // Do not reset the gesture/cap when touchstart follows pointerdown.
    if (pointerDown) return;
    clearReleaseSettle();
    // A new scroll/tap gesture (no standing selection) needs a fresh cap so a
    // chain of slow flings cannot inherit the first one's age. A pointerdown
    // elsewhere while a finished selection stands MUST NOT renew that
    // selection indefinitely — its original 20s cap remains authoritative.
    const standingSelection = selectionHeld(dependencies.readSelection());
    mayRearmCappedSelection = capReached && standingSelection;
    if (!standingSelection) {
      clearCapTimer();
      heldSince = null;
      capReached = false;
    }
    pointerDown = true;
    pointerType = nextPointerType;
    pointerStartedAt = dependencies.now();
    selectionChangedDuringGesture = false;
    cancelledTouchPointerDuringGesture = false;
    recompute();
  };

  const shouldSettleRelease = (endingPointerType: string): boolean => {
    const kind = pointerType || endingPointerType;
    if (kind === 'mouse') return false;
    const duration = pointerStartedAt === null ? 0 : Math.max(0, dependencies.now() - pointerStartedAt);
    return (
      duration >= TOUCH_SELECTION_DWELL_MS ||
      selectionChangedDuringGesture ||
      selectionHeld(dependencies.readSelection())
    );
  };

  const endPointer = (endingPointerType: string): void => {
    // A browser may emit pointerup followed by touchend for one gesture. The
    // duplicate must preserve the original deadline, not restart or cancel it.
    if (!pointerDown) {
      recompute();
      return;
    }
    const settleRelease = cancelledTouchPointerDuringGesture || shouldSettleRelease(endingPointerType);
    pointerDown = false;
    pointerType = '';
    pointerStartedAt = null;
    selectionChangedDuringGesture = false;
    mayRearmCappedSelection = false;
    cancelledTouchPointerDuringGesture = false;
    activePointerIds.clear();
    activeLegacyTouches = 0;
    if (!settleRelease) {
      clearReleaseSettle();
      recompute();
      return;
    }
    releaseSettling = true;
    recompute();
    releaseTimer = dependencies.setTimer(() => {
      releaseTimer = null;
      releaseSettling = false;
      recompute();
    }, SELECTION_RELEASE_SETTLE_MS);
  };

  return {
    getSnapshot: () => holding,
    onSelectionChange: () => {
      if (pointerDown) {
        selectionChangedDuringGesture = true;
        // A capped, still-standing range must not be renewed by arbitrary app
        // taps. But selectionchange WHILE a pointer is down is evidence that the
        // reader is actively making/adjusting a range: that is a new hold
        // episode and deserves its own bounded window.
        if (capReached && mayRearmCappedSelection) {
          clearCapTimer();
          heldSince = null;
          capReached = false;
          mayRearmCappedSelection = false;
        }
      }
      recompute();
    },
    onPointerDown: event => {
      activePointerIds.add(event.pointerId);
      activeLegacyTouches = 0;
      beginPointer(event.pointerType);
    },
    onPointerUp: event => {
      activePointerIds.delete(event.pointerId);
      if (activePointerIds.size > 0) {
        recompute();
        return;
      }
      endPointer(event.pointerType);
    },
    onPointerCancel: event => {
      if (event.pointerType !== 'mouse') cancelledTouchPointerDuringGesture = true;
      activePointerIds.delete(event.pointerId);
      if (activePointerIds.size > 0) {
        recompute();
        return;
      }
      endPointer(event.pointerType);
    },
    onTouchStart: event => {
      // Pointer Events are authoritative when present; the following
      // touchstart describes the same contacts and must not double-count them.
      if (activePointerIds.size > 0) return;
      activeLegacyTouches = Math.max(1, event?.touches.length ?? activeLegacyTouches + 1);
      beginPointer('touch');
    },
    onTouchEnd: event => {
      if (activePointerIds.size > 0) return;
      activeLegacyTouches = event?.touches.length ?? Math.max(0, activeLegacyTouches - 1);
      if (activeLegacyTouches > 0) {
        recompute();
        return;
      }
      endPointer('touch');
    },
    onBlur: () => {
      // Native selection UI may blur the page. Never shorten an already active
      // settle; if blur replaces pointerup, apply the same gesture evidence.
      if (releaseSettling) {
        recompute();
        return;
      }
      if (pointerDown) {
        activePointerIds.clear();
        activeLegacyTouches = 0;
        endPointer(pointerType);
        return;
      }
      activePointerIds.clear();
      activeLegacyTouches = 0;
      recompute();
    },
    reset: () => {
      clearCapTimer();
      clearReleaseSettle();
      pointerDown = false;
      pointerType = '';
      pointerStartedAt = null;
      selectionChangedDuringGesture = false;
      mayRearmCappedSelection = false;
      cancelledTouchPointerDuringGesture = false;
      activePointerIds.clear();
      activeLegacyTouches = 0;
      heldSince = null;
      capReached = false;
      publish(false);
    },
  };
}

// ONE singleton and not a per-component controller because the signal is
// global (one document, one selection) and because two transcript panes plus
// every live timer must not each attach their own copy of the listeners.
const listeners = new Set<() => void>();
const holdController = createTranscriptHoldController({
  now: () => Date.now(),
  readSelection: () => (typeof window === 'undefined' ? null : window.getSelection()),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  onHoldChange: () => {
    for (const listener of listeners) listener();
  },
});

function attach(): void {
  if (typeof document === 'undefined') return;
  const opts = { passive: true } as AddEventListenerOptions;
  document.addEventListener('selectionchange', holdController.onSelectionChange, opts);
  // Capture, so a handler that stops propagation cannot hide the gesture from
  // the gate.
  document.addEventListener('pointerdown', holdController.onPointerDown, { capture: true, passive: true });
  document.addEventListener('touchstart', holdController.onTouchStart, opts);
  // Release on WINDOW: a gesture very often ends with the pointer outside the
  // element it started in, and a latch stuck "down" would hold the transcript
  // still until the cap.
  window.addEventListener('pointerup', holdController.onPointerUp, opts);
  window.addEventListener('pointercancel', holdController.onPointerCancel, opts);
  window.addEventListener('touchend', holdController.onTouchEnd, opts);
  window.addEventListener('touchcancel', holdController.onTouchEnd, opts);
  // A tab that lost focus or went to the background is not mid-gesture, and
  // neither dispatches a pointerup.
  window.addEventListener('blur', holdController.onBlur, opts);
  document.addEventListener('visibilitychange', holdController.onBlur, opts);
}

function detach(): void {
  if (typeof document === 'undefined') return;
  document.removeEventListener('selectionchange', holdController.onSelectionChange);
  document.removeEventListener('pointerdown', holdController.onPointerDown, {
    capture: true,
  } as EventListenerOptions);
  document.removeEventListener('touchstart', holdController.onTouchStart);
  window.removeEventListener('pointerup', holdController.onPointerUp);
  window.removeEventListener('pointercancel', holdController.onPointerCancel);
  window.removeEventListener('touchend', holdController.onTouchEnd);
  window.removeEventListener('touchcancel', holdController.onTouchEnd);
  window.removeEventListener('blur', holdController.onBlur);
  document.removeEventListener('visibilitychange', holdController.onBlur);
  holdController.reset();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) attach();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detach();
  };
}

const getSnapshot = (): boolean => holdController.getSnapshot();
/** Never hold during SSR/prerender: there is no reader and no selection. */
const getServerSnapshot = (): boolean => false;

/** Must the transcript hold still right now? True while the reader is holding a
 *  selection or a pointer, until {@link MAX_HOLD_MS} elapses. Everything that
 *  can mutate the transcript subtree subscribes to this ONE value, so it all
 *  stops and restarts together. */
export function useTranscriptHold(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** A wall-clock timestamp (ms) that advances about once a second and FREEZES
 *  while the transcript is holding still.
 *
 *  Callers must render a pure function of THIS value and never call `Date.now()`
 *  themselves — that is the whole point (hole (1) in the file header). Because
 *  the value is stable while frozen, a re-render forced by anything else — a
 *  store notification, a prop change, a parent rebuild — produces byte-identical
 *  output and React touches no DOM node. When the hold releases, the clock jumps
 *  straight to the current time, so a frozen count snaps to the right value. */
export function useLiveClock(): number {
  const hold = useTranscriptHold();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (hold) return undefined;
    // Catch up immediately on release, then keep ticking. Re-created when the
    // hold flips, so no interval fires while frozen at all.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hold]);

  return now;
}
