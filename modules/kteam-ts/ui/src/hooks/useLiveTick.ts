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
): boolean {
  if (!transcriptHeldStill(pointerHeld, sel)) return false;
  return !holdExpired(heldSince, now, capMs);
}

// ---------------------------------------------------------------------------
// The gate itself: ONE document-level singleton, subscribed by every consumer.
//
// A singleton and not a per-component effect because the signal is global (one
// document, one selection, one pointer) and because two transcript panes plus
// every live timer would otherwise each attach their own copy of six listeners.
// Listeners attach on the first subscriber and detach on the last.
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let pointerDown = false;
/** When the current uninterrupted hold began; null when nothing is holding. */
let heldSince: number | null = null;
/** Published value: true = hold still, do not mutate the transcript. */
let holding = false;
let capTimer: ReturnType<typeof setTimeout> | null = null;

function readSelection(): TickSelectionLike | null {
  return typeof window === 'undefined' ? null : window.getSelection();
}

function publish(next: boolean): void {
  if (next === holding) return;
  holding = next;
  for (const listener of listeners) listener();
}

/** Recompute the gate from the current pointer + selection state. Called from
 *  every input listener; cheap and idempotent, so over-calling is fine. */
function recompute(): void {
  const wants = transcriptHeldStill(pointerDown, readSelection());
  if (!wants) {
    // Released. Clear the cap so the NEXT hold gets a full window rather than
    // inheriting the last one's age.
    heldSince = null;
    if (capTimer !== null) {
      clearTimeout(capTimer);
      capTimer = null;
    }
    publish(false);
    return;
  }
  if (heldSince === null) {
    heldSince = Date.now();
    // Fire once at the cap. Nothing else is scheduled while holding, so this is
    // the only thing that can end a hold the reader never releases.
    capTimer = setTimeout(() => {
      capTimer = null;
      publish(false);
    }, MAX_HOLD_MS);
  }
  publish(shouldHoldStill(pointerDown, readSelection(), heldSince, Date.now()));
}

function onPointerDown(): void {
  pointerDown = true;
  recompute();
}

function onPointerUp(): void {
  pointerDown = false;
  recompute();
}

function attach(): void {
  if (typeof document === 'undefined') return;
  const opts = { passive: true } as AddEventListenerOptions;
  document.addEventListener('selectionchange', recompute, opts);
  // Capture, so a handler that stops propagation cannot hide the gesture from
  // the gate.
  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  document.addEventListener('touchstart', onPointerDown, opts);
  // Release on WINDOW: a gesture very often ends with the pointer outside the
  // element it started in, and a latch stuck "down" would hold the transcript
  // still until the cap.
  window.addEventListener('pointerup', onPointerUp, opts);
  window.addEventListener('pointercancel', onPointerUp, opts);
  window.addEventListener('touchend', onPointerUp, opts);
  window.addEventListener('touchcancel', onPointerUp, opts);
  // A tab that lost focus or went to the background is not mid-gesture, and
  // neither dispatches a pointerup.
  window.addEventListener('blur', onPointerUp, opts);
  document.addEventListener('visibilitychange', onPointerUp, opts);
}

function detach(): void {
  if (typeof document === 'undefined') return;
  document.removeEventListener('selectionchange', recompute);
  document.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
  document.removeEventListener('touchstart', onPointerDown);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
  window.removeEventListener('touchend', onPointerUp);
  window.removeEventListener('touchcancel', onPointerUp);
  window.removeEventListener('blur', onPointerUp);
  document.removeEventListener('visibilitychange', onPointerUp);
  if (capTimer !== null) {
    clearTimeout(capTimer);
    capTimer = null;
  }
  pointerDown = false;
  heldSince = null;
  holding = false;
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) attach();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detach();
  };
}

const getSnapshot = (): boolean => holding;
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
