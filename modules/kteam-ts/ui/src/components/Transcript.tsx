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
//   PREPEND (an older page loads): scrollHeight is measured before paint and
//     the delta is added back to scrollTop, so the reader's content does not
//     move. Browser anchoring cannot cover this case: the whole DOM above the
//     viewport is replaced at once.
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
// Not virtualized; tail-first pagination keeps only the loaded window in the
// DOM (see SessionChatPage.loadOlder).

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import type { TranscriptBlock } from '../lib/transcript';
import { TranscriptRow } from './TranscriptRow';

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

function Inner({ blocks, live, hasOlder, loadingOlder, onLoadOlder, pinSignal, header, footer }: Props) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** Sticky: is the reader pinned to the bottom? The single source of truth for
   *  whether anything is allowed to move the viewport. */
  const followRef = useRef(true);
  const [detached, setDetached] = useState(false);
  const [newCount, setNewCount] = useState(0);

  const last = blocks.length - 1;
  const lastId = blocks.length ? blocks[last]!.id : null;
  const firstId = blocks.length ? blocks[0]!.id : null;
  const prevLastId = useRef<string | null>(null);
  const prevFirstId = useRef<string | null>(null);
  /** scrollHeight as of the last paint — the shrink test's baseline. */
  const prevScrollHeight = useRef(0);
  /** Distance from the bottom as of the last SETTLED scroll event. The one
   *  quantity a prepend leaves untouched, and the only one measured outside a
   *  commit — so it is what the prepend correction restores. */
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

  const pin = useCallback(() => {
    const v = viewportRef.current;
    if (!v) return;
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
    const up = () => {
      pointerHeld.current = false;
      mark();
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
    };
  }, []);

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
      if (followRef.current) {
        v.scrollTop = v.scrollHeight;
        // Record OUR write, so the scroll event it triggers is not read as the
        // reader moving. Without this the very act of following looks like input.
        lastScrollTop.current = v.scrollTop;
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
      else prevClientHeight.current = v.clientHeight;
    });
    ro.observe(v);
    return () => ro.disconnect();
  }, [pin]);

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
  // What IS trustworthy is the reader's distance from the bottom, read from the
  // last SETTLED scroll event (one layout, three metrics, no commit in flight) —
  // and a prepend inserts content ABOVE, so that distance is exactly invariant
  // across it. Restoring it needs no baseline height at all, and it cannot
  // overshoot: the worst case is being off by whatever streamed in below since
  // that scroll event, which is a delta, never a page.
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
    } else if (nearBottom && !followRef.current) {
      // Scrolled back down to the bottom under their own steam — resume
      // following, and pin so we land exactly at the tail rather than wherever
      // in the band they stopped.
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
    if (el.scrollTop < LOAD_OLDER_PX && hasOlder && !loadingOlder) onLoadOlder();
  }

  function jump() {
    followRef.current = true;
    setDetached(false);
    setNewCount(0);
    pin();
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={viewportRef}
        className="kt-viewport min-h-0 flex-1 overflow-y-auto scroll-thin"
        onScroll={onScroll}
        role="log"
        aria-label="Transcript"
      >
        {/* NO container `gap` — spacing is asymmetric by design (see index.css
            "ASYMMETRIC DENSITY"). A uniform gap is exactly what made tools cost
            as much vertical space as conversation. Each row declares its own
            top margin from what it is and what precedes it. */}
        <div ref={contentRef} className="kt-content mx-auto flex w-full max-w-[880px] flex-col px-2 py-2 sm:px-4">
          {header}
          {blocks.map((b, idx) => (
            <TranscriptRow
              key={b.id}
              block={b}
              live={live}
              isLast={idx === last}
              previous={idx > 0 ? blocks[idx - 1] : undefined}
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
    </div>
  );
}

export const Transcript = memo(Inner);
