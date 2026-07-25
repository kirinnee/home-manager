// THE APP'S HEIGHT IS THE VISUAL VIEWPORT'S HEIGHT.
//
// The shell is a fixed box that never scrolls (App.tsx), and it used to be sized
// `100dvh`. On a phone that is wrong the moment the keyboard opens:
//
//   iOS Safari  — does NOT shrink `dvh` for the software keyboard. The layout
//                 viewport keeps its full height, the browser PANS the visual
//                 viewport up over it, and the bottom of a 100dvh app — the
//                 composer, the send button — ends up behind the keyboard with
//                 no page scroll to reach it, because the shell is
//                 `overflow:hidden` by design.
//   Android     — resizes the layout viewport, but only once the viewport meta
//                 says `interactive-widget=resizes-content` (index.html).
//
// `window.visualViewport` reports what is ACTUALLY on screen on both, so that is
// what drives the shell:
//
//   --app-h    the visible height. Everything full-height (shell, drawers) uses
//              `var(--app-h, 100dvh)`, so the fallback chain is
//              visualViewport → dvh → vh without a single JS-dependent layout.
//   --app-top  visualViewport.offsetTop — how far iOS has panned the visual
//              viewport down the layout viewport. The shell is positioned at
//              this offset so it stays exactly over what the user can see.
//   --kb-h     the space the keyboard (or any interactive widget) is taking.
//              `data-keyboard="open"` on <html> goes with it, so CSS can react
//              without another listener.
//
// Both listeners are rAF-throttled: visualViewport `scroll` fires at frame rate
// during a pan, and writing three custom properties on <html> in that handler
// would invalidate style on every one of them.

import { useEffect } from 'react';

/** Below this, a shrunken visual viewport is a keyboard rather than a browser
 *  chrome collapse (address bar shrink is ~60-90px, keyboards are 250px+). */
const KEYBOARD_MIN_PX = 120;

export function useAppViewport(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const vv = window.visualViewport;
    let frame = 0;
    let settle: number[] = [];

    const apply = () => {
      frame = 0;
      const height = Math.round(vv?.height ?? window.innerHeight);
      const offsetTop = Math.max(0, Math.round(vv?.offsetTop ?? 0));
      // What the layout viewport has that the visual one does not: the keyboard,
      // plus whatever the browser has panned away.
      const hidden = Math.max(0, Math.round(window.innerHeight - height - offsetTop));

      root.style.setProperty('--app-h', `${height}px`);
      root.style.setProperty('--app-top', `${offsetTop}px`);
      root.style.setProperty('--kb-h', `${hidden}px`);
      if (hidden > KEYBOARD_MIN_PX) root.setAttribute('data-keyboard', 'open');
      else root.removeAttribute('data-keyboard');

      // The app is `position: fixed` and sized to the visual viewport, so the
      // DOCUMENT never has anything to scroll. If iOS scrolled it anyway —
      // focusing an input near the bottom makes it try — put it back, or the
      // fixed shell is offset from the viewport it is supposed to cover.
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(apply);
    };

    // Rotation is the one event whose metrics are NOT correct when it fires:
    // iOS reports the pre-rotation size and settles a few frames later, and the
    // keyboard may dismiss itself as part of the same gesture. Re-measure on a
    // short ladder rather than trusting the first reading.
    const onOrientation = () => {
      schedule();
      settle.forEach(clearTimeout);
      settle = [120, 320, 700].map(ms => window.setTimeout(apply, ms));
    };

    apply();
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', onOrientation);
    // Coming back from the background can restore a different geometry than the
    // one we left with (rotated while hidden, keyboard dismissed elsewhere).
    document.addEventListener('visibilitychange', schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      settle.forEach(clearTimeout);
      vv?.removeEventListener('resize', schedule);
      vv?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', onOrientation);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, []);
}
