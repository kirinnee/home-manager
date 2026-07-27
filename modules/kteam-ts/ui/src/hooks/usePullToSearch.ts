// PULL-DOWN TO SEARCH (touch drawer only).
//
// On the fleet list scroller, a deliberate pull-down FROM THE TOP focuses the
// search box (via lib/search-focus). The whole point is to tell a real pull
// apart from an ordinary scroll, and to never fight the machinery around it:
//
//   • DELIBERATE vs SCROLLED-UP. The gesture ARMS only when the scroller is at
//     its top (`scrollTop <= 0`) at touchstart. From there, only DOWNWARD finger
//     travel counts, and it must cross a threshold before release to fire. A
//     normal scroll-up starts with the list already moving (scrollTop > 0), so it
//     never arms; a short accidental tug that does not cross the threshold is
//     ignored on release.
//   • NO BROWSER PULL-TO-REFRESH. We never preventDefault (listeners stay
//     passive, so scrolling is never janked). Suppressing the browser's own
//     overscroll is CSS's job: the scroller carries `overscroll-y-contain`
//     (set where this hook is wired), which stops the pull chaining to the page.
//   • DOES NOT FIGHT THE ROW LONG-PRESS. A row's long-press (open the session
//     menu) is a STATIONARY dwell that a drift cancels; a pull-down is exactly
//     such a drift, so the two are mutually exclusive by construction — a pull
//     cancels a nascent long-press rather than racing it.
//   • DOES NOT FIGHT THE TRANSCRIPT GUARDS. Those (selection hold, pointer-held
//     re-pin) live on the transcript viewport, a different scroller entirely.
//     This hook only ever touches the fleet list element it is handed.
//
// The transcript's selection/scroll guards are NOT in play here; this is the
// sidebar list, its own scroller (AgentSidebar.tsx header note).

import { useEffect, useRef, useState } from 'react';

/** How far the finger must travel down from the top before a release fires. */
export const PULL_THRESHOLD_PX = 64;

/** 0..1 how close a pull is to firing — drives the indicator. Pure. */
export function pullProgress(distance: number, threshold = PULL_THRESHOLD_PX): number {
  if (!(distance > 0) || !(threshold > 0)) return 0;
  return Math.min(1, distance / threshold);
}

/** Would releasing at this distance fire the search focus? Pure. */
export function pullTriggered(distance: number, threshold = PULL_THRESHOLD_PX): boolean {
  return distance >= threshold;
}

export interface PullToSearch {
  /** Raw downward travel in px (0 when not pulling). */
  distance: number;
  /** 0..1 toward the threshold, for the indicator. */
  progress: number;
  /** Past the threshold — the indicator can flip to "release to search". */
  armed: boolean;
}

/** Attach the gesture to `scrollerRef` while `enabled`. Fires `onTrigger` on a
 *  release that crossed the threshold. Returns live pull state for an indicator.
 *  The DOM wiring is intentionally thin; the decision lives in the pure helpers
 *  above (tested without a DOM — this package renders tests with
 *  react-dom/server). */
export function usePullToSearch(
  scrollerRef: { current: HTMLElement | null },
  {
    enabled,
    onTrigger,
    threshold = PULL_THRESHOLD_PX,
  }: { enabled: boolean; onTrigger: () => void; threshold?: number },
): PullToSearch {
  const [distance, setDistance] = useState(0);
  // Latest onTrigger without re-binding listeners every render.
  const triggerRef = useRef(onTrigger);
  triggerRef.current = onTrigger;

  useEffect(() => {
    const el = scrollerRef.current;
    if (!enabled || !el) return undefined;

    let armed = false;
    let startY = 0;
    let dist = 0;

    const reset = () => {
      armed = false;
      dist = 0;
      setDistance(0);
    };

    const onStart = (e: TouchEvent) => {
      // Ignore multitouch (pinch/zoom) and any start that is not at the top —
      // that is an ordinary scroll, not a pull.
      if (e.touches.length !== 1) {
        reset();
        return;
      }
      if (el.scrollTop <= 0) {
        armed = true;
        startY = e.touches[0]!.clientY;
        dist = 0;
      } else {
        armed = false;
      }
    };

    const onMove = (e: TouchEvent) => {
      if (!armed) return;
      // The moment the list is actually scrolled, this was a scroll, not a pull.
      if (el.scrollTop > 0) {
        reset();
        return;
      }
      const d = e.touches[0]!.clientY - startY;
      dist = d > 0 ? d : 0;
      setDistance(dist);
    };

    const onEnd = () => {
      const fired = armed && dist >= threshold;
      reset();
      if (fired) triggerRef.current();
    };

    // Passive: we never call preventDefault (overscroll-contain handles
    // pull-to-refresh), so scrolling is never janked.
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', reset, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', reset);
    };
  }, [enabled, scrollerRef, threshold]);

  return { distance, progress: pullProgress(distance, threshold), armed: pullTriggered(distance, threshold) };
}
