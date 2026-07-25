// WHICH SHAPE THE SIDEBAR IS ALLOWED TO TAKE, from the viewport alone.
//
// Three regimes, and the point of computing them here is that the preference
// ("I collapsed it") and the constraint ("there is no room for it") are
// different facts and must not be stored in the same boolean:
//
//   drawer  < 768px   no room for any permanent column. The sidebar is an
//                     overlay the reader opens deliberately.
//   rail    < 1100px  room for a 48px rail only. The expanded preference is
//                     IGNORED here rather than overwritten — widening the
//                     window brings the reader's expanded sidebar back.
//   full    ≥ 1100px  the reader's own choice applies (expanded or rail).
//
// `matchMedia` rather than a resize listener: the browser fires it on the
// crossing, not on every intermediate pixel of a drag.

import { useEffect, useState } from 'react';

export type LayoutMode = 'drawer' | 'rail' | 'full';

/** Below this a permanent column of any width steals too much of the content. */
export const DRAWER_MAX = 768;
/** Below this an EXPANDED sidebar squeezes the main pane; a rail still fits. */
export const RAIL_MAX = 1100;

function read(): LayoutMode {
  if (typeof window === 'undefined') return 'full';
  const w = window.innerWidth;
  if (w < DRAWER_MAX) return 'drawer';
  if (w < RAIL_MAX) return 'rail';
  return 'full';
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(read);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const queries = [
      window.matchMedia(`(max-width: ${DRAWER_MAX - 1}px)`),
      window.matchMedia(`(max-width: ${RAIL_MAX - 1}px)`),
    ];
    const on = () => setMode(read());
    for (const q of queries) q.addEventListener('change', on);
    // One read after mount: a hard load at a width the initial state guessed
    // from `window.innerWidth` is already correct, but an SSR/hydration path or
    // a restored window size is not.
    on();
    return () => {
      for (const q of queries) q.removeEventListener('change', on);
    };
  }, []);
  return mode;
}
