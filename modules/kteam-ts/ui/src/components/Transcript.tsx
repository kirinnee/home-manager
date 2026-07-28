// The transcript scroll region.
//
// ONE scroll controller, on purpose (round 4). The previous version wrapped
// @shadcn/react's MessageScroller and ALSO hand-rolled stick-to-bottom on top
// of it, which is what made the thread "jump up and down":
//
//   MessageScroller.Item was given `scrollAnchor` on every row, and the
//   library's handleContentChange reacts to appended anchored items by calling
//   scrollToElement(newItem, {align: 'start'}) — it scrolls the NEW BLOCK TO THE
//   TOP OF THE VIEWPORT. It does that regardless of where the reader is (the
//   "already following the bottom" early-out it has requires autoScroll, which
//   we deliberately passed as false), and its handleResize re-anchors again on
//   every resize. So each streaming delta produced two competing scrolls in one
//   frame — the library pulling the newest block to the top, our ResizeObserver
//   pushing to the bottom — plus a spacer element the library resizes under us,
//   which is why the tail so often landed "almost" at the bottom.
//
// So the library is gone from this path and the three behaviours it was there
// for are implemented directly, each with exactly one owner:
//
//   FOLLOWING (reader at the bottom): a ResizeObserver on the content pins to
//     the bottom. It fires after layout and before paint, so a block growing in
//     place (assistant text gaining tokens) or laying out late (markdown, code,
//     images) is followed without a visible intermediate frame. Assignment to
//     scrollTop, never scrollTo({behavior:'smooth'}) — an animation started on
//     every delta IS the bounce.
//
//   DETACHED (reader scrolled up): NOTHING here ever writes scrollTop. New
//     blocks are counted for the "N new" pill instead. Content that grows above
//     or inside the viewport (a late image, syntax highlighting) is held steady
//     by the browser's own scroll anchoring — `overflow-anchor: auto` is the
//     default and this file is careful not to defeat it, because it is the only
//     mechanism that compensates sub-frame without a measure-then-correct
//     flicker.
//
//   PREPEND (an older page loads): the reader's last settled gap from the bottom
//     is restored before paint, so their content does not move. Browser anchoring
//     cannot cover this case: the whole DOM above the viewport is replaced at
//     once, and an in-commit scrollHeight delta is not trustworthy here.
//
// Follow is a sticky STATE, not a distance test on each event: it disengages as
// soon as the reader scrolls up at all and re-engages only at the true bottom
// (or via the pill). A generous "close enough to the bottom" band would mean a
// reader who scrolled up 50px still gets yanked down — movement they did not
// ask for, which is the complaint.
//
// ROUND 4 — WHAT BREAKING FOLLOW ACTUALLY REQUIRES.
//
// The previous round detached on any DECREASE in scrollTop, on the theory that
// "pin() only raises it, content growth leaves it untouched… only a person moves
// it backwards". That theory is false, and it is why the bug survived: scrollTop
// also falls, with nobody touching anything, whenever
//
//   (1) the CONTENT shrinks   — the ThinkingIndicator footer is removed the
//       instant `busy` clears, a pending optimistic message is reaped when its
//       real chat.user record lands, a run of turn markers collapses;
//   (2) the VIEWPORT shrinks  — anything outside the scroller changing height
//       squeezes `flex-1`: the composer's busy chrome, a header notice, the
//       on-screen keyboard;
//   (3) SCROLL ANCHORING fires — `overflow-anchor: auto` (index.css sets it on
//       purpose, for the detached reader) compensates size changes above the
//       viewport by rewriting scrollTop directly.
//
// Measured in a real browser on a live streaming session: at the frame where
// `busy` flipped, clientHeight fell 566→529, scrollHeight fell 959→928, and
// scrollTop fell 393→323 on its own. The handler read that 70px as a scroll-up,
// killed follow, and put up the "Jump to latest" pill — with the mouse untouched.
// That is the reported "still does not auto-scroll to the bottom".
//
// So detaching now needs POSITIVE evidence of a person, which the previous round
// claimed to have but did not: an actual input event. `wheel`, `touchmove`,
// `pointerdown` (scrollbar drag) and the scrolling keys stamp `intentAt`; a
// scroll-up only detaches if one of them happened in the last INTENT_WINDOW_MS.
// A shrink in the same frame vetoes it as well, since a shrink can only push
// scrollTop down. Layout can no longer impersonate the reader.
//
// ROUND 5 — THE RAPID FLICKER. TWO BUGS, ONE MEASUREMENT.
//
// Reported: "the chat when scrolling flickers VERY rapidly and bugs out."
// Measured in a real headless Chromium against a live 2.6k-record session, by
// hooking the viewport's own `scrollTop` setter so every programmatic write is
// timestamped. Gesture: drag the scrollbar upward for ~3.6s. Result:
//
//   t=0…1.92s   scrollTop walks 784 → 260   (the drag; smooth, correct)
//   t=2.23s     scrollTop JUMPS 288 → 5249  (+4961px, to the very bottom)
//   t=2.2…6.0s  19 further writes of scrollTop = scrollHeight, ~5/s
//   pill:       never shown — follow was never released
//
// The reader was dragged back to the bottom five times a second and could not
// escape. Two independent defects produce that:
//
//   (1) THE INTENT WINDOW EXPIRES MID-GESTURE. A scrollbar drag announces
//       itself ONCE, with a single `pointerdown`, and then scrolls for as long
//       as the button is held. `pointermove` was never listened for, so after
//       INTENT_WINDOW_MS the stamp went stale WHILE THE GESTURE WAS STILL
//       RUNNING, and every further scroll-up was classified as layout. Trackpad
//       momentum and touch inertia have the same shape: the scroll outlives the
//       last input event. So intent is now tracked as GESTURE STATE — a pointer
//       latched down between `pointerdown` and `pointerup`/`pointercancel` is
//       the reader, for however long the drag lasts — with the timestamp kept
//       only for the sources that genuinely are discrete (wheel, keys) and for
//       the inertial tail after a finger or button is released.
//
//   (2) THE SCROLL HANDLER WROTE scrollTop. `movedUp && !byReader` used to
//       "put it back" with `el.scrollTop = el.scrollHeight`. A write inside a
//       scroll handler dispatches another scroll event; if the reader is still
//       scrolling the other way, the two take turns every frame. That is not a
//       symptom of a bad heuristic, it is a feedback loop that AMPLIFIES one:
//       a wrong verdict costs a 5000px oscillation instead of a wrong pill.
//       So: NOTHING in onScroll writes scrollTop any more, ever. Re-pinning a
//       following reader after a shrink belongs to the two ResizeObservers,
//       which already fire for exactly that (content shrink, viewport shrink)
//       and run after layout and before paint — so the gap the old branch was
//       closing is closed one frame earlier, without a scroll event.
//
// Both halves matter: (1) makes the verdict right for real gestures, (2) makes
// a wrong verdict cheap. Note what the measurement did NOT show — DOM mutations
// stayed at 13.6/s during the drag against 2.7/s idle, i.e. there was no render
// storm. The flicker was the scroll position fighting itself, not React.
//
// ROUND 8 — THE SCROLL WAS NEVER THE THING THAT BROKE THE SELECTION.
//
// Rounds 6 and 7 both attacked selection loss by stopping `scrollTop` writes
// (and, on touch, by gating them on a held pointer). Both shipped; the reader
// still could not highlight a live conversation. This round finally ran WebKit
// instead of reasoning about it (headless WPE, mobile context, real drag
// selection — full result table in hooks/useLiveTick.ts), and the answer is
// narrower than every previous round assumed:
//
//   A WEBKIT SELECTION DIES IF, AND ESSENTIALLY ONLY IF, THE ELEMENT IT IS IN
//   IS RE-RENDERED. A React text update (`nodeValue =`), a structural change
//   from a markdown re-parse, or an unmount/remount of that one block all kill
//   it. The same mutations in ANY other block do not. Neither does appending a
//   block, removing one, a timer ticking elsewhere, or a scrollTop write.
//
// Which identifies the culprit exactly: STREAMING TEXT IN THE BLOCK THE READER
// IS SELECTING. An assistant turn arrives token by token; every delta re-renders
// that block; the reader is selecting from it precisely because it is the answer
// they just watched arrive. Nothing guarded that — not the round-6 scroll fix,
// not the round-7 timer freeze (measured to be in the harmless column, which is
// why it changed nothing). Measured end to end: selecting inside a block
// streaming at 4 deltas/sec lost the selection immediately; deferring the deltas
// while the gate is held kept it alive across 3s and 12 deferred deltas.
//
// So the guard is no longer only "do not MOVE the transcript while a selection
// is held" — it is "do not RE-RENDER it". While the hold gate is engaged (a held
// selection, or a pointer down, which is the touch long-press window the
// selection check is blind to — see hooks/useLiveTick.ts) this component keeps
// rendering the content it had when the hold began, and flushes everything at
// once when the reader lets go. The scroll guards below are unchanged and still
// necessary; this sits on top of them.
//
// Freezing the WHOLE content is broader than the measurement strictly requires —
// only the selected block matters — but the narrow version would put a
// selection test in every row's render, and this is one subscription in one
// place that is a strict superset of it.
//
// THE TRADE, STATED PLAINLY: while you hold a highlight, the transcript stops
// updating. Streaming text keeps arriving in the store and is applied the
// instant you release (follow re-pins itself through the content ResizeObserver,
// which fires on the flush). You cannot both watch a stream and hold a selection
// in it — but today you cannot hold the selection at all, so this only trades a
// few seconds of visible streaming for the ability to copy anything. The hold is
// capped (MAX_HOLD_MS) so a forgotten selection can never leave the transcript
// looking dead.
//
// Not virtualized; tail-first pagination keeps only the loaded window in the
// DOM (see SessionChatPage.loadOlder).

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Pin, Quote } from 'lucide-react';
import type { TranscriptBlock } from '../lib/transcript';
import { TranscriptRow } from './TranscriptRow';
import { useInputModality } from '../hooks/useInputModality';
import { useTranscriptHold } from '../hooks/useLiveTick';
import { registerJumpController, type JumpOutcome } from '../lib/pin-bridge';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { insertQuoteIntoComposer } from '../lib/quote';
import { blockIdOfSelection, pinSelection } from '../lib/pin-selection';

interface Props {
  blocks: TranscriptBlock[];
  live: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  pinSignal: number;
  header?: ReactNode;
  footer?: ReactNode;
}

/** How close to the bottom counts as "back at the bottom" for RE-ENGAGING follow.
 *
 *  Deliberately generous (~3 lines). It can be, because detaching is driven by an
 *  explicit upward scroll and not by this number — so a wide band cannot cause
 *  the oscillation that a wide band in a symmetric gap test would. And it needs
 *  to be: on a fast-streaming session the bottom MOVES AWAY while you scroll
 *  toward it, so a tight band means a reader wheeling down never quite catches it
 *  and follow never resumes (measured: they land ~64px short and stay detached).
 *
 *  Following itself is still exact — pin() assigns scrollTop = scrollHeight, so
 *  re-engaging inside this band immediately snaps to the true bottom. */
const REENGAGE_PX = 96;
/** Distance from the top that triggers the next older page. */
const LOAD_OLDER_PX = 280;
/** How long after a DISCRETE input event a scroll-up still counts as the
 *  reader's: a wheel tick, a scrolling key, and the inertial tail that follows a
 *  released finger or scrollbar button.
 *
 *  A window is the wrong tool for a CONTINUOUS gesture and that is what made the
 *  round-4 version flicker (see the header): a scrollbar drag stamps once and
 *  then scrolls for seconds. Those are handled by `pointerHeld` instead, so this
 *  number no longer has to cover a whole gesture — only the coast after one.
 *  Erring long merely honours a detach the reader did ask for. */
const INTENT_WINDOW_MS = 1500;

/** How long after a finger/pointer is released to wait before resuming follow.
 *
 *  Long enough for a touch selection to actually EXIST: on a long-press the
 *  range materialises on or shortly after `touchend`, so a guard evaluated at the
 *  instant of release samples a collapsed selection and lets the pin through (see
 *  the round-8 note on the `up` handler). Short enough to be imperceptible — and
 *  it delays only the resumption of follow, never a scroll the reader asked for. */
const SELECTION_SETTLE_MS = 220;

/** How many older pages a pin jump will page in while LOCATING a message that
 *  is not in the loaded window, before it gives up honestly (pinning-design.md
 *  §6). Matches PinSheet's displayed cap. */
const LOCATE_PAGE_CAP = 10;

/** The touch Quote/Pin pair's box, used to keep it on screen AND off the
 *  message's own chrome. Width is the measured pair at the reduced type ramp
 *  (was 176 for the larger buttons); height is one 44px touch target; the gap
 *  clears the selection handles that iOS/Android draw at the range edge. */
const TOUCH_QUOTE_WIDTH = 148;
const TOUCH_QUOTE_HEIGHT = 44;
const TOUCH_QUOTE_GAP = 10;

/** Where the touch Quote/Pin pair goes, as pure policy (exported for tests —
 *  this package has no DOM to measure in).
 *
 *  BELOW the selection by default, above only when there is no room below.
 *  The previous above-first placement was measured at 390x844 covering the
 *  selected message's own timestamp: a user bubble draws its clock in a header
 *  row directly above the prose, so "above the selection" lands exactly on it
 *  (buttons at y=177–221 over a clock at y=203–222). Below the range there is
 *  only text the reader has already read past, and the OS selection handle gap
 *  is respected on both sides. */
export function touchQuotePlacement(
  anchor: { x: number; top: number; bottom: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.min(
    Math.max(8, anchor.x - TOUCH_QUOTE_WIDTH / 2),
    Math.max(8, viewport.width - TOUCH_QUOTE_WIDTH - 8),
  );
  const below = anchor.bottom + TOUCH_QUOTE_GAP;
  const fitsBelow = below + TOUCH_QUOTE_HEIGHT <= viewport.height - 8;
  const top = fitsBelow ? below : Math.max(8, anchor.top - TOUCH_QUOTE_GAP - TOUCH_QUOTE_HEIGHT);
  return { left, top };
}
/** How long to wait for an older page to settle into `blocks` before treating
 *  the load as stalled/exhausted during a locate. */
const LOCATE_SETTLE_MS = 2500;
/** How long the jumped-to message keeps its outline. */
const JUMP_HIGHLIGHT_MS = 2000;

/** The minimal shape of a `Selection` this module needs. Declared locally so the
 *  decision below is testable without a DOM (this package has no DOM impl; see
 *  Transcript.test.ts). */
export interface SelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  anchorNode: Node | null;
  focusNode: Node | null;
}

/** MAY FOLLOW WRITE scrollTop RIGHT NOW? — the pure decision behind the whole
 *  selection fix.
 *
 *  Measured (see transcript-selection-diagnosis.md): a `scrollTop` write while
 *  the reader holds a text selection COLLAPSES that selection (3/3 repro on the
 *  live page). The transcript re-pins to the tail on every streaming delta, so
 *  during a live turn that collapse fires continuously and the convo becomes
 *  unhighlightable. So follow must NOT pin while a non-collapsed selection is
 *  anchored inside the viewport.
 *
 *  Returns true when a pin would destroy an active selection, i.e. follow must
 *  hold off. A collapsed selection (a bare caret), an empty one, or one anchored
 *  entirely OUTSIDE the transcript (composer, another pane) is no obstacle — a
 *  scroll cannot ruin what the reader is not selecting here.
 *
 *  Either endpoint inside counts: a selection can be anchored above the fold and
 *  extended into the viewport (or vice versa), and pinning would wreck it just
 *  the same. `contains` is injected so the logic is assertable with plain data. */
export function pinBlockedBySelection(sel: SelectionLike | null, contains: (node: Node | null) => boolean): boolean {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  return contains(sel.anchorNode) || contains(sel.focusNode);
}

/** MAY FOLLOW WRITE scrollTop RIGHT NOW? — the FULL decision, both signals.
 *
 *  Blocks the pin when EITHER a non-collapsed selection is anchored inside
 *  ({@link pinBlockedBySelection}) OR a pointer/finger is currently held down on
 *  the viewport (a gesture in progress).
 *
 *  ROUND 7 — WHY THE SELECTION SIGNAL ALONE IS NOT ENOUGH ON TOUCH.
 *
 *  `pinBlockedBySelection` cannot see a touch long-press. A finger selects by
 *  long-pressing (finger DOWN, held still) until the word range materialises —
 *  and for those first few hundred milliseconds the selection is still COLLAPSED
 *  (or absent), so the selection guard is false and a streaming delta is allowed
 *  to pin. Measured in a mobile browser against the live page (final-probe.mjs,
 *  probe G2): with the finger down and the selection still collapsed, a single
 *  content-resize pin moved the viewport 2136 → 2709 — the prose jumps ~570px out
 *  from under the finger, the long-press target is gone, and the highlight never
 *  forms. That is "can't highlight the convo at all" on a phone.
 *
 *  A MOUSE never hits this window: mousedown + the first mousemove produce a
 *  non-collapsed range at once, so `pinBlockedBySelection` covers the whole drag
 *  (probe G3: 0 pins mid-drag, selection survives). That asymmetry is exactly why
 *  desktop was fixed by the selection guard and touch was not.
 *
 *  `pointerHeld` is the gesture latch the intent tracker already keeps (see the
 *  intent effect). A held pointer means the reader is doing something with it —
 *  selecting, or about to scroll — and the viewport must not be yanked to the
 *  tail under it either way. When the finger lifts, follow resumes (the pointer
 *  `up` handler re-pins if still following, and the selectionchange listener
 *  re-pins when a selection is later cleared). */
export function followPinBlocked(
  pointerHeld: boolean,
  sel: SelectionLike | null,
  contains: (node: Node | null) => boolean,
): boolean {
  return pointerHeld || pinBlockedBySelection(sel, contains);
}

/** The `Selection` shape the Quote reader needs — {@link SelectionLike} plus the
 *  text itself. Declared locally so the decision is testable without a DOM (this
 *  package has no DOM impl; see Transcript.test.ts). */
export interface QuoteSelectionLike extends SelectionLike {
  toString(): string;
}

/** The trimmed text a "Quote" would insert for the current selection, or '' when
 *  there is nothing to quote. Empty for a collapsed/absent selection, for one
 *  anchored entirely OUTSIDE the transcript (the composer, another pane), or for
 *  a whitespace-only range. `contains` is injected so the whole gate is asserted
 *  with plain data. Either endpoint inside counts — a selection can start above
 *  the fold and reach into the transcript, and it is still ours to quote.
 *
 *  READ BEFORE FOCUS. Both callers capture this the moment the menu/affordance
 *  opens: inserting into the composer focuses it, which collapses the selection,
 *  so the captured text — not a re-read — is what gets quoted. */
export function quotableSelectionText(
  sel: QuoteSelectionLike | null,
  contains: (node: Node | null) => boolean,
): string {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
  if (!contains(sel.anchorNode) && !contains(sel.focusNode)) return '';
  return sel.toString().trim();
}

/** PANE-BOUNDED TABLES — the safe width for an intrinsically wide table before
 *  it would push a page scroll. The pure geometry behind `--kt-table-bleed`
 *  (published below) stays exported so it is assertable without a DOM (this
 *  package has no DOM implementation; see Transcript.test.ts).
 *
 *  This began as an escape hatch from a permanent centred 880px column. Chat
 *  width now governs the column itself: full makes it pane-wide and readable
 *  narrows the scroller, so both live modes normally have no centring gutter to
 *  escape. The geometry remains a harmless exact ceiling and still covers a
 *  future or out-of-chat embedding whose column is narrower than its pane.
 *
 *  A table stays anchored at the column's LEFT edge and may grow rightward only
 *  through the column's right-hand centring gutter. `paneWidth` is the
 *  scroller's inner width (already minus any vertical scrollbar), while
 *  `columnWidth` is the content column's border-box. The matching left gutter
 *  cannot be used without moving the table away from the prose above it, so the
 *  formula subtracts that gutter plus both content paddings. It never returns a
 *  negative width. */
export function paneUsableTableWidth(
  paneWidth: number,
  columnWidth: number,
  padLeft: number,
  padRight: number,
): number {
  const sideGutter = Math.max(0, (paneWidth - columnWidth) / 2);
  return Math.max(0, paneWidth - padLeft - padRight - sideGutter);
}

/** DOM adapter over {@link followPinBlocked}: is a pin unsafe right now, because
 *  a finger/pointer is held on the viewport or a non-collapsed selection is
 *  anchored inside `el`? Returns false when there is no window (SSR/tests) or no
 *  element, so a missing environment never blocks follow. */
function pinBlockedNow(el: HTMLElement | null, pointerHeld: boolean): boolean {
  if (!el || typeof window === 'undefined') return pointerHeld;
  const sel = window.getSelection();
  return followPinBlocked(pointerHeld, sel, node => !!node && el.contains(node));
}

/** Return `value`, except while `hold` is engaged — then keep returning whatever
 *  `value` was at the moment the hold began, and flush to the current one when it
 *  releases.
 *
 *  A ref written during render, deliberately: it is a pure cache of the last
 *  un-held value, so it is idempotent under a double render, and the release is
 *  driven by `hold` (external-store state) changing, which re-renders this
 *  component anyway. An effect would be a frame late — and a frame late here is
 *  one more mutation under a live selection, which is the entire bug. */
function useHeldStill<T>(value: T, hold: boolean): T {
  const shown = useRef(value);
  if (!hold) shown.current = value;
  return shown.current;
}

function Inner(props: Props) {
  const { hasOlder, loadingOlder, onLoadOlder, pinSignal } = props;
  // ---- HOLD STILL WHILE THE READER IS SELECTING (round 8) -------------------
  // The reader is holding a highlight (or a finger, mid long-press). On WebKit
  // ANY mutation near the range collapses it, so the transcript's whole rendered
  // content — blocks, the busy flag that mounts/unmounts the running-tool line,
  // and the header/footer nodes — is pinned to what it was when the hold began.
  // The store keeps receiving deltas; this just stops SHOWING them until the
  // reader lets go (see the round-8 note in the file header for the trade).
  const hold = useTranscriptHold();
  const { blocks, live, header, footer } = useHeldStill(
    { blocks: props.blocks, live: props.live, header: props.header, footer: props.footer },
    hold,
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** Sticky: is the reader pinned to the bottom? The single source of truth for
   *  whether anything is allowed to move the viewport. */
  const followRef = useRef(true);
  const [detached, setDetached] = useState(false);
  const [newCount, setNewCount] = useState(0);
  // Resolved ONCE here and threaded into every row, so the pin affordance's
  // touch-vs-mouse choice costs one media subscription, not one per row.
  const { touchAffected } = useInputModality();

  // ---- QUOTE A SELECTION -----------------------------------------------------
  // Desktop: right-click over a transcript selection opens the shared context
  // menu with "Quote". Touch: a small floating "Quote" affordance appears once a
  // selection SETTLES (it must not compete with the OS long-press that MAKES the
  // selection — see the effect below), and quotes on tap. Both capture the
  // selection TEXT up front and quote through the same insertQuoteIntoComposer,
  // so focusing the composer (which collapses the live selection) can never lose
  // the text. The captured text is stored, never re-read at insert time.
  const [quoteMenu, setQuoteMenu] = useState<{ x: number; y: number; text: string; blockId: string | null } | null>(
    null,
  );
  const [touchQuote, setTouchQuote] = useState<{
    x: number;
    y: number;
    /** Bottom edge of the selection rect — the anchor for the default
     *  below-the-selection placement (see touchQuotePos). */
    bottom: number;
    text: string;
    blockId: string | null;
  } | null>(null);
  const quoteTriggerRef = useRef<HTMLElement | null>(null);

  const last = blocks.length - 1;
  const lastId = blocks.length ? blocks[last]!.id : null;
  const firstId = blocks.length ? blocks[0]!.id : null;
  const prevLastId = useRef<string | null>(null);
  const prevFirstId = useRef<string | null>(null);
  /** scrollHeight as of the last paint — the shrink test's baseline. */
  const prevScrollHeight = useRef(0);
  /** Distance from the bottom as of the last settled scroll or resize callback.
   *  It is the one quantity a prepend leaves untouched, so it is what the
   *  prepend correction restores. */
  const gapFromBottom = useRef(0);
  /** scrollTop we last OBSERVED or SET. `onScroll` compares against this to tell
   *  a user's scroll-up from our own pin; every programmatic write updates it, so
   *  our own scrolls can never be mistaken for the reader's. */
  const lastScrollTop = useRef(0);
  /** clientHeight as of the last paint. A viewport that got SHORTER pushes
   *  scrollTop down by itself — indistinguishable from a scroll-up unless it is
   *  measured. */
  const prevClientHeight = useRef(0);
  /** performance.now() of the last DISCRETE input event on the viewport. */
  const intentAt = useRef(-Infinity);
  /** Is a pointer currently held down on the viewport (scrollbar drag, finger)?
   *  Latched for the WHOLE gesture, which is the part a timestamp cannot express
   *  — a drag emits one `pointerdown` and then scrolls for as long as it lasts. */
  const pointerHeld = useRef(false);
  /** Pending deferred re-pin after a gesture ends (see SELECTION_SETTLE_MS). */
  const repinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pin = useCallback(() => {
    const v = viewportRef.current;
    if (!v) return;
    // Never yank the viewport out from under a live text selection OR an
    // in-progress pointer gesture. A scrollTop write collapses a held selection
    // (measured), and a touch long-press dwells with the selection still
    // COLLAPSED — so `pointerHeld` covers the window the selection check is blind
    // to (round 7; see followPinBlocked). Follow resumes when the finger lifts
    // (pointer `up` re-pin) or the selection is cleared (selectionchange re-pin).
    // This is the ONE guard that covers every pin() caller (both ResizeObservers,
    // the layout effect, the initial settle, the onScroll re-engage, and jump()).
    if (pinBlockedNow(v, pointerHeld.current)) return;
    // Assignment, not scrollTo({behavior:'smooth'}): instant and idempotent. The
    // browser clamps to scrollHeight - clientHeight, so this lands EXACTLY at the
    // bottom — never "almost". A smooth animation restarted on every delta is
    // itself the bounce, and it also makes the position unobservable mid-flight.
    v.scrollTop = v.scrollHeight;
    lastScrollTop.current = v.scrollTop;
    prevScrollHeight.current = v.scrollHeight;
    prevClientHeight.current = v.clientHeight;
  }, []);

  // ---- INTENT: the only thing allowed to break follow ------------------------
  // Every device that can scroll a region announces itself before the scroll
  // event lands: wheel (mouse/trackpad), touchstart+touchmove (finger),
  // pointerdown (scrollbar drag — the scrollbar is part of the element, so this
  // fires on the viewport), and the scrolling keys. Nothing that layout does can
  // forge one of these.
  //
  // Two shapes, tracked differently, because conflating them is what made the
  // transcript flicker (see header, round 5):
  //
  //   DISCRETE  — a wheel tick, a scrolling key: one event per movement, so a
  //               short window after it covers the whole movement.
  //   CONTINUOUS — a scrollbar drag or a finger: one `pointerdown`, then an
  //               arbitrarily long scroll. A window cannot cover that, so the
  //               gesture is LATCHED until the pointer is released. Release also
  //               stamps, so the inertial coast afterwards stays covered.
  useEffect(() => {
    const v = viewportRef.current;
    if (!v) return;
    const mark = () => {
      intentAt.current = performance.now();
    };
    const down = () => {
      pointerHeld.current = true;
      mark();
    };
    // On WINDOW, not on the viewport: a drag that ends with the cursor outside
    // the element (very common when dragging a scrollbar) would otherwise leave
    // the latch stuck on — which is safe, but it would keep honouring "the
    // reader" long after they let go.
    // ROUND 8 — WHY THIS RE-PIN IS DELAYED, AND WHY THAT MATTERS ON A SESSION
    // WITH NOTHING HAPPENING.
    //
    // This handler releases `pointerHeld` and then re-pins, relying on the
    // SELECTION half of the guard to veto the pin if the reader just made one.
    // That ordering assumes the selection already EXISTS the moment the finger
    // lifts. On a touch long-press that assumption is exactly backwards: the
    // whole reason round 7 added `pointerHeld` is that the selection is still
    // collapsed for the duration of the press — and if it materialises on, or a
    // beat after, `touchend`, then at this instant the guard sees a collapsed
    // selection, waves the pin through, and `scrollTop = scrollHeight` lands
    // straight into the gesture that was about to produce the highlight.
    //
    // This fires on an IDLE session, which is what makes it worth closing here:
    // a transcript nobody has scrolled is still `followRef.current === true`, so
    // every finger lifted anywhere in the window runs a pin. With nothing
    // streaming there is no other mutation and no other scroll — this is the only
    // thing the app does during a long-press on a quiet session.
    //
    // So the re-pin waits a beat and re-checks the guard instead of trusting a
    // single sample taken at the worst possible moment. Cost: follow resumes
    // ~a fifth of a second later after a gesture, which nothing can perceive (the
    // ResizeObserver re-pins on the next delta regardless). Benefit: a selection
    // that appears anywhere in that window vetoes the pin, as it always should
    // have.
    const up = () => {
      pointerHeld.current = false;
      mark();
      // Gesture over. If the reader is still following (they long-pressed or
      // tapped without scrolling away), resume the tail — but only once the
      // selection state has settled, and only through pin(), which re-runs the
      // full guard at that later moment and is a no-op if a selection now stands
      // or the reader scrolled off the tail.
      if (repinTimer.current !== null) clearTimeout(repinTimer.current);
      repinTimer.current = setTimeout(() => {
        repinTimer.current = null;
        if (followRef.current) pin();
      }, SELECTION_SETTLE_MS);
    };
    const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ', 'Spacebar']);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Typing in the composer moves a caret, not the transcript.
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (SCROLL_KEYS.has(e.key)) mark();
    };
    const opts = { passive: true } as AddEventListenerOptions;
    v.addEventListener('wheel', mark, opts);
    v.addEventListener('touchstart', down, opts);
    v.addEventListener('touchmove', mark, opts);
    v.addEventListener('pointerdown', down, opts);
    window.addEventListener('pointerup', up, opts);
    window.addEventListener('pointercancel', up, opts);
    window.addEventListener('touchend', up, opts);
    window.addEventListener('touchcancel', up, opts);
    // A drag can also be abandoned by the tab losing focus (alt-tab mid-drag),
    // which dispatches no pointerup at all.
    window.addEventListener('blur', up, opts);
    window.addEventListener('keydown', onKey, opts);
    return () => {
      v.removeEventListener('wheel', mark);
      v.removeEventListener('touchstart', down);
      v.removeEventListener('touchmove', mark);
      v.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', up);
      window.removeEventListener('blur', up);
      window.removeEventListener('keydown', onKey);
      if (repinTimer.current !== null) {
        clearTimeout(repinTimer.current);
        repinTimer.current = null;
      }
    };
  }, [pin]);

  // ---- SELECTION RELEASES FOLLOW'S HOLD -------------------------------------
  // While a selection is held, pin() and the content ResizeObserver both hold
  // off writing scrollTop (a write collapses the selection — measured). That
  // leaves a following reader OFF the tail if the stream kept growing during the
  // selection. Nothing re-pins on its own until the next delta or resize, so a
  // stream that goes idle mid-selection would strand them just short of the
  // bottom. So: the instant the selection clears, re-pin if still following.
  // pin() is a no-op when the selection is still live, so an intermediate
  // selectionchange during a drag cannot fight the drag.
  useEffect(() => {
    const onSelChange = () => {
      const s = typeof window !== 'undefined' ? window.getSelection() : null;
      if ((!s || s.isCollapsed || s.rangeCount === 0) && followRef.current) pin();
    };
    document.addEventListener('selectionchange', onSelChange, { passive: true });
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [pin]);

  // ---- FOLLOWING: pin on any content resize ---------------------------------
  // Covers all three growth shapes with one mechanism: a new block, a block
  // growing in place (streaming text), and a block that lays out late (image,
  // highlighted code). Runs after layout, before paint.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const v = viewportRef.current;
      if (!v) return;
      // This write does NOT go through pin(), so it needs the same guard: a
      // scrollTop write here on a streaming delta would collapse a held selection
      // (and, mid touch long-press, yank the prose out from under the finger —
      // see followPinBlocked). Holding off leaves follow armed; the pointer `up`
      // re-pin or the next delta after the selection clears re-pins.
      if (followRef.current && !pinBlockedNow(v, pointerHeld.current)) {
        v.scrollTop = v.scrollHeight;
        // Record OUR write, so the scroll event it triggers is not read as the
        // reader moving. Without this the very act of following looks like input.
        lastScrollTop.current = v.scrollTop;
      } else if (!followRef.current) {
        // Reflow and responsive content padding can change the true gap without
        // a scroll event. Refresh the prepend baseline from this settled layout,
        // but NEVER write scrollTop while the reader is detached.
        gapFromBottom.current = Math.max(0, v.scrollHeight - v.scrollTop - v.clientHeight);
      }
      prevScrollHeight.current = v.scrollHeight;
      prevClientHeight.current = v.clientHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // The viewport itself changing size (window resize, keyboard open, composer
  // growing) must not move a detached reader either — only re-pin if following.
  useEffect(() => {
    const v = viewportRef.current;
    if (!v || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (followRef.current) pin();
      else {
        // A breakpoint, keyboard or composer resize can change both the viewport
        // and content reflow. Keep the detached prepend baseline current without
        // opposing the reader with a scrollTop write.
        gapFromBottom.current = Math.max(0, v.scrollHeight - v.scrollTop - v.clientHeight);
        prevClientHeight.current = v.clientHeight;
      }
    });
    ro.observe(v);
    return () => ro.disconnect();
  }, [pin]);

  // ---- TABLE WIDTH: publish the exact pane-safe ceiling ----------------------
  // Chat width now changes `.kt-content` itself, so full and readable normally
  // leave no centred-column gutter for a table to escape. Keep publishing the
  // general pane bound for intrinsically wide tables and any future embedding
  // where the column is narrower than the scroller (see paneUsableTableWidth).
  // clientWidth excludes the scrollbar; stopping one content-pad short of the
  // pane edge prevents page-level horizontal scroll, while genuinely unshrinkable
  // content still scrolls inside its own table wrapper. useLayoutEffect publishes
  // before paint and ResizeObserver keeps the value current across sidebar,
  // keyboard, and chat-width changes. A custom property cannot resize the
  // scroller, so this does not feed the follow observers a spurious resize.
  useLayoutEffect(() => {
    const v = viewportRef.current;
    const content = contentRef.current;
    if (!v || !content) return;
    const publish = () => {
      const cs = getComputedStyle(content);
      const usable = paneUsableTableWidth(
        v.clientWidth,
        content.offsetWidth,
        parseFloat(cs.paddingLeft) || 0,
        parseFloat(cs.paddingRight) || 0,
      );
      content.style.setProperty('--kt-table-bleed', `${usable}px`);
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(publish);
    ro.observe(v);
    return () => ro.disconnect();
  }, []);

  // ---- PREPEND: hold the reader's content still -----------------------------
  // Before paint, so the older page is never visible at the wrong offset.
  //
  // STATED AS A TARGET, NOT AS A DELTA — because every delta available here is
  // measured against a height that is wrong in this exact commit.
  //
  // The old version did `scrollTop += scrollHeight - prevScrollHeight`. Measured
  // with a stack-traced scrollTop setter, on a live session, during a scrollbar
  // drag: the settled height for the prepended page was 3615, but INSIDE this
  // layout effect scrollHeight read 5324 — ~1700px, one page, more than it is one
  // frame later. So the delta came out at 3447 for a 1738px page, `scrollTop`
  // was pushed past the end, the browser clamped it to the bottom (gap 0), and
  // the re-engage band then re-armed follow: the reader lost both their place and
  // their detachment in one frame. Anchoring on the previously-top element's
  // `offsetTop` reads the same transient and fails identically — it is the
  // measurement that is untrustworthy here, not the formula.
  //
  // What IS trustworthy is the reader's distance from the bottom, refreshed
  // from the last settled scroll or ResizeObserver callback (one layout, three
  // metrics) — and a prepend inserts content ABOVE, so that distance is exactly
  // invariant across it. Restoring it needs no baseline height at all, and it
  // cannot overshoot: the worst case is being off by whatever streamed in below
  // since that observation, which is a delta, never a page.
  useLayoutEffect(() => {
    const v = viewportRef.current;
    if (!v) return;
    const prependedAbove = firstId !== null && prevFirstId.current !== null && firstId !== prevFirstId.current;
    if (prependedAbove && !followRef.current && gapFromBottom.current > 0) {
      const target = v.scrollHeight - v.clientHeight - gapFromBottom.current;
      if (target > v.scrollTop) {
        v.scrollTop = target;
        lastScrollTop.current = v.scrollTop;
      }
    }
    prevFirstId.current = firstId;
    prevScrollHeight.current = v.scrollHeight;
    prevClientHeight.current = v.clientHeight;
  }, [firstId, blocks.length]);

  // While following, re-pin in the SAME commit that added the content. The
  // ResizeObserver above is the safety net for growth React knows nothing about
  // (late images, highlighting, font swap), but it is dispatched after the commit
  // — leaving one frame in which the new row is laid out and the viewport has not
  // moved yet. Measured as a ~31px transient gap on a fast-streaming session:
  // small, but it is exactly the visible "settling" twitch. useLayoutEffect runs
  // before paint, so the reader never sees the intermediate state.
  useLayoutEffect(() => {
    if (followRef.current) pin();
  }, [blocks, pin]);

  // ---- initial settle / explicit re-pin ------------------------------------
  useEffect(() => {
    if (pinSignal <= 0) return;
    followRef.current = true;
    setDetached(false);
    setNewCount(0);
    // A stale intent stamp must not survive into the new session's first frames
    // — otherwise the settling layout of a freshly opened transcript could be
    // read as the reader scrolling.
    intentAt.current = -Infinity;
    // Now, then next frame. The synchronous call puts a first open at the tail
    // immediately (this effect runs after the mount that has the first page, so
    // "opened a session" lands at the newest message, never at the top); the
    // frame after covers layout that settles within the same tick. Everything
    // slower — markdown, highlighting, images, webfonts — is the content
    // ResizeObserver's job, which is why there is no timeout chain here.
    pin();
    const raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [pinSignal, pin]);

  // ---- DETACHED: count new tail blocks for the pill -------------------------
  useEffect(() => {
    const prev = prevLastId.current;
    if (lastId && prev !== null && lastId !== prev && !followRef.current) {
      const idx = blocks.findIndex(b => b.id === prev);
      const added = idx >= 0 ? blocks.length - 1 - idx : 1;
      setNewCount(c => c + Math.max(1, added));
    }
    prevLastId.current = lastId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  // Follow may only be broken by a scroll-up the READER performed.
  //
  // Three independent conditions, all required, because each on its own has a
  // known false positive (see the header comment):
  //   movedUp   — scrollTop actually went backwards;
  //   byReader  — a pointer is held down on the viewport, or a discrete input
  //               event landed within INTENT_WINDOW_MS;
  //   !shrank   — neither the content nor the viewport got shorter in this
  //               frame, which is the one way scrollTop falls without input
  //               (clamping) and the trigger for scroll anchoring's own rewrite.
  //
  // INVARIANT (round 5): this function never assigns scrollTop AGAINST the
  // direction the reader is moving. A write here dispatches another scroll
  // event, so a write that opposes an in-progress gesture is a feedback loop at
  // frame rate — the measured "flickers very rapidly and bugs out". The old
  // `movedUp && !byReader → scrollTop = scrollHeight` branch was exactly that,
  // and it is gone: re-pinning a following reader after a shrink is the
  // ResizeObservers' job, which fires for the same shrinks one frame earlier and
  // produces no scroll event of its own.
  //
  // The one write left is the re-engage pin below, and it is safe by
  // construction: it only fires for a reader who has arrived within
  // REENGAGE_PX of the bottom, and it moves DOWN — the direction they were
  // already going — so it cannot oppose the gesture that triggered it.
  //
  // ROUND 6 — THAT LAST CLAIM WAS UNTESTED, AND ON A PHONE IT IS FALSE.
  //
  // "They were already going down" was an assumption about how a reader reaches
  // the band, never a condition. A reader can also be INSIDE the band while
  // moving UP — for the first ~96px of every scroll-up that starts at the tail,
  // which is where every scroll-up starts, because the transcript opens pinned.
  //
  // On a mouse that window is invisible: one wheel tick is 100px+, so the very
  // first scroll event already leaves the band. A FINGER delivers the same
  // 300px drag as ~10-20 touchmoves of 20-40px each. Measured on a real
  // transcript at 390x844 (headless Chromium, genuine touch events, session
  // mrwirdnf-9f80826f, scrollHeight 3094 / clientHeight 621, bottom = 2473):
  //
  //   touchmove → scroll 2473→2428   (the finger moves it up, correctly)
  //   scroll 2428 → gap 45 ≤ 96 → RE-ENGAGE → pin() → scroll 2473
  //   touchmove → scroll 2473→2443 → gap 30 → RE-ENGAGE → pin() → 2473
  //   …every frame, for the whole gesture
  //
  // Net movement after a full 360px drag: 0px. The transcript is FROZEN at the
  // tail on touch devices — not "hard to scroll", immovable — and it is exactly
  // the feedback loop this comment forbids, arriving through the one branch it
  // exempted. (Detach itself worked; follow was re-armed a frame later.)
  //
  // The fix is to make the assumption a condition: re-engage only when the
  // reader is NOT moving up in this event. Arriving at the bottom going down
  // still re-engages on the same frame it always did (the streaming-tail case
  // REENGAGE_PX exists for is untouched); passing through the band on the way UP
  // no longer re-arms follow behind the reader's back.
  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const scrollTop = el.scrollTop;
    const gap = el.scrollHeight - scrollTop - el.clientHeight;
    // 1px of slack: fractional-DPR displays report fractional scroll metrics,
    // which would otherwise look like a sub-pixel "scroll up" every frame.
    const movedUp = scrollTop < lastScrollTop.current - 1;
    const nearBottom = gap <= REENGAGE_PX;
    const byReader = pointerHeld.current || performance.now() - intentAt.current < INTENT_WINDOW_MS;
    const shrank = el.scrollHeight < prevScrollHeight.current - 1 || el.clientHeight < prevClientHeight.current - 1;

    if (movedUp && byReader && !shrank && followRef.current) {
      followRef.current = false;
      setDetached(true);
    } else if (nearBottom && !movedUp && !followRef.current) {
      // Scrolled back down to the bottom under their own steam — resume
      // following, and pin so we land exactly at the tail rather than wherever
      // in the band they stopped.
      //
      // `!movedUp` is what keeps this from opposing a gesture: a reader who is
      // inside the band but travelling UPWARD is leaving, not arriving (see the
      // round-6 note above).
      followRef.current = true;
      setDetached(false);
      setNewCount(0);
      pin();
    }
    if (followRef.current && newCount) setNewCount(0);

    // Read back, because the re-engage branch above may have pinned.
    lastScrollTop.current = el.scrollTop;
    prevScrollHeight.current = el.scrollHeight;
    prevClientHeight.current = el.clientHeight;
    // Settled layout, all three metrics from one read: the baseline the prepend
    // correction restores.
    gapFromBottom.current = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    // Not while holding still: the page that came back would not be RENDERED
    // (the hold pins `blocks`), so the next scroll event would see the same
    // scrollTop with the same `blocks` and ask for another one — paging the whole
    // history in behind a selection nobody asked to spend. The reader is at the
    // top of the loaded window either way, so the request simply happens on the
    // scroll event after they release.
    if (!hold && el.scrollTop < LOAD_OLDER_PX && hasOlder && !loadingOlder) onLoadOlder();
  }

  function jump() {
    followRef.current = true;
    setDetached(false);
    setNewCount(0);
    pin();
  }

  // ---- QUOTE: read the selection, then hand it to the composer ---------------
  // Only the foreground pane is interactable; a background pane is aria-hidden
  // (App.tsx), so its selection can never be ours.
  const isForegroundViewport = useCallback(() => {
    const v = viewportRef.current;
    return !!v && !v.closest('[aria-hidden="true"]');
  }, []);

  // The quotable text of the current selection AND where it sits — captured
  // together so the touch affordance can anchor to the range and the desktop
  // menu can quote the same text. Returns null when there is nothing to quote.
  const readTranscriptSelection = useCallback((): {
    text: string;
    rect: DOMRect | null;
    blockId: string | null;
  } | null => {
    const v = viewportRef.current;
    if (!v || typeof window === 'undefined') return null;
    const sel = window.getSelection();
    const text = quotableSelectionText(sel as QuoteSelectionLike | null, node => !!node && v.contains(node));
    if (!text) return null;
    let rect: DOMRect | null = null;
    try {
      rect = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null;
    } catch {
      rect = null;
    }
    // Cheap provenance: which transcript block the snippet sits in, off the
    // row's existing data-block-id. Used only for a pin's "jump back" action.
    const blockId = sel ? blockIdOfSelection(sel.anchorNode, sel.focusNode, v) : null;
    return { text, rect, blockId };
  }, []);

  const runQuote = useCallback((text: string) => {
    setQuoteMenu(null);
    setTouchQuote(null);
    insertQuoteIntoComposer(text);
  }, []);

  // Pin the same captured snippet as a note for the foreground session. Reading
  // it up front means a collapse-on-tap cannot lose it; blockId preserves the
  // source jump.
  const runPin = useCallback((text: string, blockId: string | null) => {
    setQuoteMenu(null);
    setTouchQuote(null);
    pinSelection(text, blockId);
  }, []);

  // DESKTOP: right-click over a selection opens the shared menu. With NO
  // selection we do nothing — the browser's own menu is left completely alone
  // (right-click a link, an image), which is the "do not globally suppress"
  // rule. Never attached to pointerdown/touchstart, so it cannot break making a
  // selection in the first place.
  const onQuoteContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const found = readTranscriptSelection();
      if (!found) return;
      event.preventDefault();
      quoteTriggerRef.current = event.currentTarget;
      setTouchQuote(null);
      setQuoteMenu({ x: event.clientX, y: event.clientY, text: found.text, blockId: found.blockId });
    },
    [readTranscriptSelection],
  );

  // TOUCH: the OS long-press IS the selection gesture, so the affordance must
  // NOT compete with making a selection — it appears only once a selection
  // EXISTS. The touch range materialises ON or AFTER release (sampling during
  // the press sees it collapsed — the exact round-7/8 hazard), so we (a) wait a
  // settle beat after every selectionchange and pointer release, and (b) refuse
  // while a pointer is still down. Then a small "Quote" button sits below the
  // range (see touchQuotePos) and quotes on tap, using the text captured here.
  useEffect(() => {
    if (!touchAffected) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const evaluate = () => {
      timer = null;
      if (!isForegroundViewport() || pointerHeld.current) {
        setTouchQuote(null);
        return;
      }
      const found = readTranscriptSelection();
      if (!found) {
        setTouchQuote(null);
        return;
      }
      const v = viewportRef.current;
      const vr = v?.getBoundingClientRect();
      const x = found.rect ? found.rect.left + found.rect.width / 2 : (vr?.left ?? 0) + 48;
      const y = found.rect ? found.rect.top : (vr?.top ?? 0) + 48;
      const bottom = found.rect ? found.rect.bottom : y + 24;
      setTouchQuote({ x, y, bottom, text: found.text, blockId: found.blockId });
    };
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(evaluate, SELECTION_SETTLE_MS);
    };
    const hide = () => setTouchQuote(null);
    document.addEventListener('selectionchange', schedule, { passive: true });
    window.addEventListener('pointerup', schedule, { passive: true });
    window.addEventListener('touchend', schedule, { passive: true });
    const v = viewportRef.current;
    v?.addEventListener('scroll', hide, { passive: true });
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('selectionchange', schedule);
      window.removeEventListener('pointerup', schedule);
      window.removeEventListener('touchend', schedule);
      v?.removeEventListener('scroll', hide);
    };
  }, [touchAffected, isForegroundViewport, readTranscriptSelection]);

  const quoteMenuItems: ContextMenuItem[] = quoteMenu
    ? [
        {
          key: 'quote',
          label: 'Quote in composer',
          icon: <Quote size={13} aria-hidden="true" />,
          onSelect: () => runQuote(quoteMenu.text),
        },
        {
          key: 'pin',
          label: 'Pin selection',
          icon: <Pin size={13} aria-hidden="true" />,
          onSelect: () => runPin(quoteMenu.text, quoteMenu.blockId),
        },
      ]
    : [];

  // Placement policy lives in touchQuotePlacement (pure, tested); this only
  // feeds it the live viewport.
  const touchQuotePos =
    touchQuote && typeof window !== 'undefined'
      ? touchQuotePlacement(
          { x: touchQuote.x, top: touchQuote.y, bottom: touchQuote.bottom },
          { width: window.innerWidth, height: window.innerHeight },
        )
      : null;

  // ---- PIN JUMP: scroll to a pinned message, honestly ------------------------
  //
  // The Pins sheet (mounted in the header) hands a blockId to the FOREGROUND
  // transcript via the bridge; this is that transcript's executor. It integrates
  // with the scroll controller instead of fighting it (pinning-design.md §6):
  //
  //   1. Detach follow FIRST. A programmatic scroll carries no reader intent, so
  //      without an explicit detach the next streaming delta's re-pin would yank
  //      the reader straight back to the tail. Detaching by flag (not a simulated
  //      input) keeps the round-5 invariant — nothing writes scrollTop against
  //      the reader — because the reader asked for this scroll.
  //   2. Assign scrollTop directly (never scrollTo({behavior:'smooth'}) — the
  //      file's own rule), then refresh every baseline from the settled read so
  //      onScroll cannot misread our write as input and the prepend correction
  //      keeps a true baseline.
  //   3. If the block is not loaded, page older history up to the cap, re-checking
  //      after each page settles. Exact-id match only — a wrong jump is worse than
  //      an honest "can't find it".
  //
  // Latest props are read through refs so the one registered controller never
  // closes over a stale `blocks`/`hasOlder`/`onLoadOlder`.
  const blocksRef = useRef(blocks);
  const hasOlderRef = useRef(hasOlder);
  const onLoadOlderRef = useRef(onLoadOlder);
  useEffect(() => {
    blocksRef.current = blocks;
    hasOlderRef.current = hasOlder;
    onLoadOlderRef.current = onLoadOlder;
  });

  useEffect(() => {
    const isForeground = () => {
      const v = viewportRef.current;
      // Retained background panes are visibility:hidden with an aria-hidden
      // ancestor (App.tsx). The foreground transcript is the one that is not.
      return !!v && !v.closest('[aria-hidden="true"]');
    };

    const highlight = (el: HTMLElement) => {
      el.setAttribute('data-jump-target', 'true');
      // Inline styles, so no shared stylesheet is touched. A static outline
      // (not an animated flash) is correct under prefers-reduced-motion and
      // perfectly legible otherwise.
      const prevOutline = el.style.outline;
      const prevOffset = el.style.outlineOffset;
      const prevRadius = el.style.borderRadius;
      el.style.outline = '2px solid var(--accent)';
      el.style.outlineOffset = '2px';
      el.style.borderRadius = '6px';
      window.setTimeout(() => {
        el.style.outline = prevOutline;
        el.style.outlineOffset = prevOffset;
        el.style.borderRadius = prevRadius;
        el.removeAttribute('data-jump-target');
      }, JUMP_HIGHLIGHT_MS);
    };

    const scrollToBlock = (blockId: string): boolean => {
      const v = viewportRef.current;
      const content = contentRef.current;
      if (!v || !content) return false;
      let el: HTMLElement | null = null;
      for (const node of content.querySelectorAll<HTMLElement>('[data-block-id]')) {
        if (node.getAttribute('data-block-id') === blockId) {
          el = node;
          break;
        }
      }
      if (!el) return false;
      const vRect = v.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      v.scrollTop = Math.max(0, v.scrollTop + (eRect.top - vRect.top) - 8);
      // Baselines from this settled read, exactly as onScroll would set them.
      lastScrollTop.current = v.scrollTop;
      prevScrollHeight.current = v.scrollHeight;
      prevClientHeight.current = v.clientHeight;
      gapFromBottom.current = Math.max(0, v.scrollHeight - v.scrollTop - v.clientHeight);
      highlight(el);
      return true;
    };

    // Resolve when an older page has settled into `blocks` (first id changed or
    // the list grew), or when the wait times out (no more history / a stall).
    const waitForOlder = (beforeFirstId: string | null, beforeLen: number): Promise<boolean> =>
      new Promise(resolve => {
        const started = performance.now();
        const tick = () => {
          const cur = blocksRef.current;
          if ((cur[0]?.id ?? null) !== beforeFirstId || cur.length > beforeLen) {
            resolve(true);
            return;
          }
          if (performance.now() - started > LOCATE_SETTLE_MS) {
            resolve(false);
            return;
          }
          window.setTimeout(tick, 80);
        };
        window.setTimeout(tick, 80);
      });

    const controller = {
      isForeground,
      jumpTo: async (blockId: string, onProgress?: (pages: number) => void): Promise<JumpOutcome> => {
        if (!isForeground()) return 'no-transcript';
        // Detach BEFORE any scroll so a streaming re-pin cannot fight us.
        followRef.current = false;
        setDetached(true);
        if (scrollToBlock(blockId)) return 'jumped';
        let pages = 0;
        while (pages < LOCATE_PAGE_CAP && hasOlderRef.current) {
          const beforeFirst = blocksRef.current[0]?.id ?? null;
          const beforeLen = blocksRef.current.length;
          onLoadOlderRef.current();
          pages += 1;
          onProgress?.(pages);
          const advanced = await waitForOlder(beforeFirst, beforeLen);
          if (!advanced) break;
          if (scrollToBlock(blockId)) return 'jumped';
        }
        return 'not-found';
      },
    };
    return registerJumpController(controller);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col">
      <div
        ref={viewportRef}
        // The chrome-to-content gate measures CONTENT as this element's box, so
        // the name sits on the real scroll viewport rather than on the bordered
        // panel around it — the two differ by the border and would quietly
        // flatter the ratio.
        data-density-region="transcript-scroller"
        className="kt-viewport min-h-0 min-w-0 flex-1 overflow-y-auto scroll-thin"
        onScroll={onScroll}
        onContextMenu={onQuoteContextMenu}
        role="log"
        aria-label="Transcript"
      >
        {/* NO container `gap` — spacing is asymmetric by design (see index.css
            "ASYMMETRIC DENSITY"). A uniform gap is exactly what made tools cost
            as much vertical space as conversation. Each row declares its own
            top margin from what it is and what precedes it.

            Desktop gets extra tail padding INSIDE this measured content box.
            Padding participates in scrollHeight, so exact pinning and bottom
            detection already include it; because it is constant across a
            prepend, the settled gap-from-bottom invariant also stays exact. */}
        <div
          ref={contentRef}
          // MOBILE INSET: 8px sides / 12px top. The card melts away below sm
          // (SessionChatPage: border/rounding/bg are sm-only), so this content pad
          // plus the route pane's 4px gutter (App.tsx `px-1`) is the ENTIRE reserve
          // between prose and the screen edge. A previous pass cut this to 4px
          // (8px total per side) chasing edge-to-edge; with no card the reader read
          // that as prose slammed against the glass, so it is back up to 8px sides
          // (12px total) and 12px top — a little breathing room, still no card, and
          // still deliberately tighter than the composer, which the reader asked to
          // keep edge-close. NOT the full desktop 16px: this is a phone, not a
          // narrow desktop. Desktop keeps sm:px-4 / sm:pt-2 unchanged.
          className="kt-content mx-auto flex min-w-0 w-full flex-col px-2 pb-2 pt-3 sm:px-4 sm:pb-8 sm:pt-2"
        >
          {header}
          {blocks.map((b, idx) => (
            <TranscriptRow
              key={b.id}
              block={b}
              live={live}
              isLast={idx === last}
              previous={idx > 0 ? blocks[idx - 1] : undefined}
              touch={touchAffected}
            />
          ))}
          {footer}
        </div>
      </div>

      {/* The pill sits in a gradient strip rather than bare over the prose:
          floating directly on top of a live transcript, it was hard to read
          against the text and made the text behind it hard to read too. */}
      {detached && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-surface via-surface/85 to-transparent pb-3 pt-8">
          <button
            type="button"
            onClick={jump}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg shadow-md transition hover:bg-accent-strong"
          >
            <ArrowDown size={13} />
            {newCount > 0 ? `${newCount} new — jump to latest` : 'Jump to latest'}
          </button>
        </div>
      )}

      {/* TOUCH: the settled-selection affordance — Quote AND Pin, side by side.
          Buttons (not a menu) act on the text captured when they appeared, so
          the tap collapsing the selection cannot lose it. */}
      {touchQuote && touchQuotePos && (
        <div
          className="fixed z-40 inline-flex items-center gap-1"
          style={{ left: touchQuotePos.left, top: touchQuotePos.top }}
        >
          {/* Visually smaller ("a bit too big" was the report) but never below
              the 44px touch target: the shrink is horizontal padding and type,
              the hit height stays. */}
          <button
            type="button"
            onClick={() => runQuote(touchQuote.text)}
            aria-label="Quote the selected text in the composer"
            className="inline-flex min-h-[44px] items-center gap-xs rounded-full border border-accent-border bg-accent px-2.5 text-[12px] font-semibold text-accent-fg shadow-popover"
          >
            <Quote size={13} aria-hidden="true" />
            Quote
          </button>
          <button
            type="button"
            onClick={() => runPin(touchQuote.text, touchQuote.blockId)}
            aria-label="Pin the selected text"
            className="inline-flex min-h-[44px] items-center gap-xs rounded-full border border-border bg-surface px-2.5 text-[12px] font-semibold text-fg shadow-popover"
          >
            <Pin size={13} aria-hidden="true" />
            Pin
          </button>
        </div>
      )}

      {/* DESKTOP: the shared context menu, over a right-clicked selection. */}
      <ContextMenu
        open={quoteMenu !== null}
        anchor={quoteMenu ?? { x: 0, y: 0 }}
        items={quoteMenuItems}
        onClose={() => setQuoteMenu(null)}
        ariaLabel="Quote menu"
        triggerRef={quoteTriggerRef}
        touch={touchAffected}
      />
    </div>
  );
}

export const Transcript = memo(Inner);
