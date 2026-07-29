// PULL DOWN TO SEARCH EVERYTHING (touch drawer only).
//
// On a phone the app bar hands search a single icon-sized button, and on the
// session route the bar is not rendered at all — so the palette needs an opener
// that is reachable from the page itself. A deliberate pull-down from the top of
// the page's scroller opens ⌘K.
//
// It is the sibling of `usePullToSearch` (the fleet sidebar's pull, which
// focuses that list's own filter box) and keeps the same discipline:
//
//   OPT IN, NOT OPT OUT — the gesture only arms inside a scroller that carries
//     `data-pull-to-palette`. The transcript deliberately does NOT: a pull at
//     ITS top already means "load older messages" (Transcript's LOAD_OLDER_PX),
//     and stealing that would replace reading history with a dialog. A scroller
//     that has not opted in is untouched, which is also why this can be wired
//     once at the shell instead of page by page.
//   MID-LIST IS A NO-OP — the gesture arms only when the resolved scroller is at
//     its top on touchstart, and disarms the instant it scrolls. An ordinary
//     scroll starts with `scrollTop > 0` and never arms at all.
//   NEVER HIJACKS THE SCROLL — every listener is passive and nothing here calls
//     preventDefault, so the browser's own scrolling and its pull-to-refresh are
//     left exactly as they were. Containing the overscroll is CSS's job
//     (`overscroll-contain` on the opted-in scroller), the same division of
//     labour the sidebar uses.
//
// The decision lives in the pure helpers below so the threshold and the at-top
// guard can be asserted without a DOM (this package renders tests through
// react-dom/server).

import { useEffect, useRef, useState } from 'react';

/** Marks a scroller as one where a pull-down opens the palette. */
export const PULL_TO_PALETTE_ATTR = 'data-pull-to-palette';

/** How far the finger must travel down from the top before a release opens the
 *  palette. Longer than the sidebar's search pull (64px): this one replaces the
 *  whole screen with a dialog, so an accidental tug must not reach it. */
export const PALETTE_PULL_THRESHOLD_PX = 96;

/** A pull in progress. `armed` means it started at the top of an opted-in
 *  scroller and has not been invalidated since. */
export interface PalettePull {
  armed: boolean;
  /** Where the finger went down; only meaningful while armed. */
  startY: number;
  /** Downward travel in px, never negative. */
  distance: number;
}

export const NO_PULL: PalettePull = { armed: false, startY: 0, distance: 0 };

/** Touchstart. Arms only for a single finger at the very top of the scroller —
 *  multitouch is a pinch, and any scroll offset means the reader is mid-list. */
export function beginPull(input: { touches: number; scrollTop: number; clientY: number }): PalettePull {
  if (input.touches !== 1) return NO_PULL;
  if (input.scrollTop > 0) return NO_PULL;
  return { armed: true, startY: input.clientY, distance: 0 };
}

/** Touchmove. A second finger, or the list actually scrolling, means this was
 *  never a pull; upward travel simply reads as zero rather than disarming, so a
 *  wobble mid-pull does not cancel it. */
export function advancePull(
  state: PalettePull,
  input: { touches: number; scrollTop: number; clientY: number },
): PalettePull {
  if (!state.armed) return NO_PULL;
  if (input.touches !== 1) return NO_PULL;
  if (input.scrollTop > 0) return NO_PULL;
  const travel = input.clientY - state.startY;
  return { armed: true, startY: state.startY, distance: travel > 0 ? travel : 0 };
}

/** Touchend. Opens only if the pull is still armed and crossed the threshold. */
export function endPull(state: PalettePull, threshold = PALETTE_PULL_THRESHOLD_PX): boolean {
  return state.armed && state.distance >= threshold;
}

/** 0..1 toward the threshold, for the indicator. Pure. */
export function palettePullProgress(distance: number, threshold = PALETTE_PULL_THRESHOLD_PX): number {
  if (!(distance > 0) || !(threshold > 0)) return 0;
  return Math.min(1, distance / threshold);
}

export interface PullToPalette {
  /** Raw downward travel in px (0 when not pulling). */
  distance: number;
  /** 0..1 toward the threshold. */
  progress: number;
  /** Past the threshold — the indicator can flip to "release to search". */
  armed: boolean;
}

/** The scroller this gesture belongs to, or null when the touch did not start
 *  inside one that opted in. */
function pullScrollerOf(target: EventTarget | null): HTMLElement | null {
  const element = target as Element | null;
  if (!element || typeof element.closest !== 'function') return null;
  return element.closest<HTMLElement>(`[${PULL_TO_PALETTE_ATTR}]`);
}

/**
 * Attach the gesture to everything inside `rootRef` while `enabled`. Fires
 * `onOpen` on a release that crossed the threshold from the top of an opted-in
 * scroller. Returns live pull state for an indicator.
 *
 * Listening at the root rather than on each scroller is deliberate: the shell
 * mounts several pages at once (kept alive for their scroll offsets), and one
 * delegated set of passive listeners cannot get out of step with which page is
 * visible.
 */
export function usePullToPalette(
  rootRef: { current: HTMLElement | null },
  {
    enabled,
    onOpen,
    threshold = PALETTE_PULL_THRESHOLD_PX,
  }: { enabled: boolean; onOpen: () => void; threshold?: number },
): PullToPalette {
  const [distance, setDistance] = useState(0);
  // Latest callback without re-binding listeners every render.
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    const root = rootRef.current;
    // Turning the gesture off mid-pull (the palette just opened some other way,
    // or the layout stopped being a phone) must not leave the indicator frozen
    // at its last height with nothing left to clear it.
    if (!enabled || !root) {
      setDistance(0);
      return undefined;
    }

    let pull = NO_PULL;
    let scroller: HTMLElement | null = null;

    const reset = () => {
      pull = NO_PULL;
      scroller = null;
      setDistance(0);
    };

    const onStart = (event: TouchEvent) => {
      scroller = pullScrollerOf(event.target);
      const touch = event.touches[0];
      if (!scroller || !touch) {
        reset();
        return;
      }
      pull = beginPull({ touches: event.touches.length, scrollTop: scroller.scrollTop, clientY: touch.clientY });
      setDistance(pull.distance);
    };

    const onMove = (event: TouchEvent) => {
      if (!pull.armed || !scroller) return;
      const touch = event.touches[0];
      if (!touch) {
        reset();
        return;
      }
      pull = advancePull(pull, {
        touches: event.touches.length,
        scrollTop: scroller.scrollTop,
        clientY: touch.clientY,
      });
      setDistance(pull.distance);
    };

    const onEnd = () => {
      const opens = endPull(pull, threshold);
      reset();
      if (opens) openRef.current();
    };

    // Passive throughout: this gesture never takes a scroll away from the page.
    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: true });
    root.addEventListener('touchend', onEnd, { passive: true });
    root.addEventListener('touchcancel', reset, { passive: true });
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', reset);
      setDistance(0);
    };
  }, [enabled, rootRef, threshold]);

  return {
    distance,
    progress: palettePullProgress(distance, threshold),
    armed: distance >= threshold,
  };
}
