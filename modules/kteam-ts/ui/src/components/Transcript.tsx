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
/** How long after a real input event a scroll-up still counts as the reader's.
 *
 *  Generous on purpose: momentum/inertial scrolling keeps dispatching `scroll`
 *  long after the last `wheel`, and a scrollbar drag dispatches `pointerdown`
 *  once at the start of a gesture that may last seconds. Erring long only risks
 *  honouring a detach the reader did in fact ask for; erring short brings back
 *  the "it won't let me scroll up" half of this bug. */
const INTENT_WINDOW_MS = 1200;

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
  /** scrollHeight as of the last paint — the baseline a prepend is measured against. */
  const prevScrollHeight = useRef(0);
  /** scrollTop we last OBSERVED or SET. `onScroll` compares against this to tell
   *  a user's scroll-up from our own pin; every programmatic write updates it, so
   *  our own scrolls can never be mistaken for the reader's. */
  const lastScrollTop = useRef(0);
  /** clientHeight as of the last paint. A viewport that got SHORTER pushes
   *  scrollTop down by itself — indistinguishable from a scroll-up unless it is
   *  measured. */
  const prevClientHeight = useRef(0);
  /** performance.now() of the last real input event on the viewport. */
  const intentAt = useRef(-Infinity);

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
  useEffect(() => {
    const v = viewportRef.current;
    if (!v) return;
    const mark = () => {
      intentAt.current = performance.now();
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
    v.addEventListener('touchstart', mark, opts);
    v.addEventListener('touchmove', mark, opts);
    v.addEventListener('pointerdown', mark, opts);
    window.addEventListener('keydown', onKey, opts);
    return () => {
      v.removeEventListener('wheel', mark);
      v.removeEventListener('touchstart', mark);
      v.removeEventListener('touchmove', mark);
      v.removeEventListener('pointerdown', mark);
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
  useLayoutEffect(() => {
    const v = viewportRef.current;
    if (!v) return;
    const prependedAbove = firstId !== null && prevFirstId.current !== null && firstId !== prevFirstId.current;
    if (prependedAbove && !followRef.current) {
      const delta = v.scrollHeight - prevScrollHeight.current;
      if (delta > 0) {
        v.scrollTop += delta;
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
  //   byReader  — a real input event landed within INTENT_WINDOW_MS;
  //   !shrank   — neither the content nor the viewport got shorter in this
  //               frame, which is the one way scrollTop falls without input
  //               (clamping) and the trigger for scroll anchoring's own rewrite.
  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const scrollTop = el.scrollTop;
    const gap = el.scrollHeight - scrollTop - el.clientHeight;
    // 1px of slack: fractional-DPR displays report fractional scroll metrics,
    // which would otherwise look like a sub-pixel "scroll up" every frame.
    const movedUp = scrollTop < lastScrollTop.current - 1;
    const nearBottom = gap <= REENGAGE_PX;
    const byReader = performance.now() - intentAt.current < INTENT_WINDOW_MS;
    const shrank = el.scrollHeight < prevScrollHeight.current - 1 || el.clientHeight < prevClientHeight.current - 1;

    if (movedUp && byReader && !shrank && followRef.current) {
      followRef.current = false;
      setDetached(true);
    } else if (movedUp && !byReader && followRef.current) {
      // Layout moved the viewport out from under a FOLLOWING reader. Put it
      // back in this same handler rather than waiting for the next resize, so
      // the shrink never paints as a gap at the bottom.
      el.scrollTop = el.scrollHeight;
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

    // Read back, because the branches above may have written scrollTop.
    lastScrollTop.current = el.scrollTop;
    prevScrollHeight.current = el.scrollHeight;
    prevClientHeight.current = el.clientHeight;
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
        <div
          ref={contentRef}
          className="kt-content mx-auto flex w-full max-w-[880px] flex-col gap-0.5 px-2 py-2 sm:px-4"
        >
          {header}
          {blocks.map((b, idx) => (
            <TranscriptRow key={b.id} block={b} live={live} isLast={idx === last} />
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
