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

import { useEffect, useState } from 'react';
import { DRAWER_MAX } from './useLayoutMode';

/** Below this, a shrunken visual viewport is a keyboard rather than a browser
 *  chrome collapse (address bar shrink is ~60-90px, keyboards are 250px+). */
const KEYBOARD_MIN_PX = 120;

/** Is the reader typing into something? The baseline detector below only trusts
 *  a shrunken viewport as a KEYBOARD when a text-entry field holds focus — a
 *  viewport that shrinks with nothing focused is browser chrome, a docked
 *  devtools panel, or a resized window, and none of those is a keyboard. */
function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  const node = el as HTMLElement;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = (node as HTMLInputElement).type;
  return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'range';
}

/** How many layout widths are remembered. A phone produces two; a window that
 *  gets dragged around produces a few more, and the oldest is the least useful. */
const MAX_BASELINES = 6;

export function useAppViewport(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const vv = window.visualViewport;
    let frame = 0;
    let settle: number[] = [];
    // THE TALLEST VISIBLE HEIGHT SEEN WHILE NOBODY WAS TYPING, PER LAYOUT WIDTH.
    //
    // Keyed on `window.innerWidth` and NOT on an orientation label, which is the
    // second thing this got wrong. `screen.orientation.type` can lag a rotation
    // (an independent gate caught exactly that: the screen metrics rotated to
    // 844x390 while the API still said `portrait-primary`), and a stale label
    // means the 844px PORTRAIT baseline gets applied to a 390px landscape frame
    // — which reads as a 454px keyboard and leaves `data-keyboard` stuck open on
    // a fully visible screen. The layout width cannot be stale: it IS the
    // geometry being measured. Keying on it also covers the cases an orientation
    // enum cannot describe at all, like a split-screen or desktop resize.
    //
    // Per width rather than one stamp because rotating WHILE TYPING is a real
    // sequence (turn the phone to get a wider keyboard) and focus may never
    // leave the field afterwards: a design that can only learn from an unfocused
    // frame would be stuck on whatever it last decided, in either direction.
    const seen: Array<{ w: number; h: number }> = [];
    const coarse = window.matchMedia?.('(pointer: coarse)');
    // A SOFTWARE KEYBOARD IS A PHONE-SHAPED IDEA. Without this, typing into a
    // textarea on a desktop and dragging the window >120px shorter at an
    // unchanged width sets `data-keyboard='open'` — harmless today, because
    // every consumer (`[data-kb-hide]`, `.kt-session-bar`, the composer's growth
    // cap) only exists inside the compact branch, and precisely for that reason
    // a latent trap for whoever adds the first ungated one. Same condition the
    // compact markup itself is rendered under, plus coarse pointers so a tablet
    // with a real IME above DRAWER_MAX still works.
    const rotatable = () => (coarse?.matches ?? false) || window.innerWidth < DRAWER_MAX;
    // Suppressed across a ROTATION specifically — the one width change that
    // arrives with untrustworthy metrics, because iOS reports the PRE-rotation
    // size on the event and settles a few frames later. One mixed reading (the
    // new width paired with the old height) would otherwise be filed as that
    // width's permanent maximum. A width change that arrives as a bare `resize`
    // is not blocked and does not need to be: those transitions are atomic.
    const LEARN_BLOCK_MS = 800;
    let learnBlockedUntil = 0;

    /** Record a full height for a width. The `typing` test lives HERE so that
     *  the whole "when may a baseline be recorded" rule is in one place. */
    const learn = (typing: boolean, w: number, h: number) => {
      if (typing || performance.now() < learnBlockedUntil) return;
      const hit = seen.find(b => b.w === w);
      if (hit) {
        // Max, because an unfocused viewport also grows when the address bar
        // collapses, and the FULL height is the one to compare against.
        hit.h = Math.max(hit.h, h);
        // Most-recently-used to the end: eviction below takes from the front,
        // and the phone's portrait baseline — learned at mount, and the one
        // every later decision leans on — must not be the first thing dropped
        // just because it was learned first.
        seen.splice(seen.indexOf(hit), 1);
        seen.push(hit);
        return;
      }
      seen.push({ w, h });
      if (seen.length > MAX_BASELINES) seen.shift();
    };

    const baselineFor = (w: number, visible: number): number => {
      if (!rotatable()) return 0;
      // EXACT WIDTH ONLY. A baseline learned at another width is a different
      // device metric — a rotation, a split-screen change, a resized window —
      // and says nothing about how tall THIS frame is with nothing covering it.
      const exact = seen.find(b => b.w === w);
      if (exact) return exact.h;
      // AN UNMEASURED WIDTH REACHED BY ROTATING. The two orientations swap, so
      // the new layout WIDTH is the old orientation's full HEIGHT (give or take
      // the browser chrome only one of them pays) and the new full height is
      // that orientation's WIDTH. Matching on the swap — rather than grabbing
      // any other entry — is what keeps a plain resize out of this branch.
      //
      // The band is the FIXED keyboard threshold, not a fraction of the width:
      // what it has to absorb is the browser chrome one orientation pays and the
      // other does not (~60-90px on a phone), which does not scale with the
      // display. A proportional band would reach 288px on a 1920px coarse panel
      // and start reading split-screen changes as rotations. A browser whose
      // chrome asymmetry somehow exceeded 120px in one orientation only would
      // match nothing here and fall through to no baseline — closed, chrome
      // visible, corrected by the next unfocused frame. That is cheaper to state
      // than to guard, and it is the same direction every other failure here
      // takes.
      //
      // CLOSEST match, not the first one in the array: with several widths
      // remembered, two can sit inside the band at once, and taking whichever
      // was recorded first is how an unrelated 1440px entry ends up standing in
      // for a 390px phone — which is the stuck-open bug this whole function
      // exists to remove, re-entering through its own estimate.
      let best = 0;
      let bestDelta = Infinity;
      for (const entry of seen) {
        const delta = Math.abs(entry.h - w);
        if (delta <= KEYBOARD_MIN_PX && delta < bestDelta) {
          bestDelta = delta;
          best = entry.w;
        }
      }
      // PLAUSIBILITY. An estimate is a claim about this frame's FULL height, so
      // it cannot be smaller than what is already visible, and the gap it
      // implies cannot be a larger share of the screen than a keyboard actually
      // takes. Anything else is a different device's metric wearing the right
      // number. Failing to 0 is the safe direction: no baseline means no
      // baseline-driven open, and the next unfocused frame learns the truth.
      if (!best || best < visible || visible < best * 0.3) return 0;
      return best;
    };

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

      // THE ATTRIBUTE CANNOT BE DRIVEN OFF `hidden` ALONE.
      //
      //   iOS      keeps the layout viewport at full height and pans over it, so
      //            innerHeight stays 844 and `hidden` ≈ the keyboard. Works.
      //   Android  with `interactive-widget=resizes-content` (index.html) RESIZES
      //            the layout viewport too, so innerHeight shrinks in lockstep
      //            with visualViewport.height and `hidden` is ≈ 0 — the attribute
      //            never fired and every keyboard-open rule was dead there.
      //
      // So the attribute is a comparison against a BASELINE: the tallest visible
      // height observed while no text field had focus. `hidden` still drives
      // --kb-h, which is the raw number CSS may want.
      const typing = isTextEntry(document.activeElement);
      const width = window.innerWidth;
      learn(typing, width, height);
      const baseline = baselineFor(width, height);
      // Focus is required, deliberately: without it a docked devtools panel or a
      // resized desktop window reads as a keyboard for the rest of the session.
      const open = hidden > KEYBOARD_MIN_PX || (typing && baseline > 0 && height < baseline - KEYBOARD_MIN_PX);
      if (open) root.setAttribute('data-keyboard', 'open');
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
      // Nothing is LEARNED while the metrics are settling: one mixed reading —
      // the new width paired with the old height — would be filed as that
      // width's permanent maximum and every later frame would read as a
      // keyboard. The rotation is still applied immediately (the shell must
      // track the viewport), it is only the baseline that waits; until it
      // arrives, `baselineFor` infers from the orientation we just left, which
      // is exactly the right answer. The last rung is past the block, so the
      // settled geometry is what gets learned.
      learnBlockedUntil = performance.now() + LEARN_BLOCK_MS;
      schedule();
      settle.forEach(clearTimeout);
      // The last rung is DERIVED from the block, not written next to it: exactly
      // one reading has to land after the block clears, or post-rotation
      // learning stops silently and the state rides on the estimate forever.
      settle = [120, 320, 700, LEARN_BLOCK_MS + 120].map(ms => window.setTimeout(apply, ms));
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

/** Reads the `data-keyboard` state as React state.
 *
 *  It OBSERVES the attribute rather than re-deriving the geometry: the attribute
 *  is already the one place the rule lives (above), CSS keys off exactly the same
 *  signal, and a second measurement path would be a second thing to keep true.
 *  The observer is per-consumer and detaches with the component. */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(
    () => typeof document !== 'undefined' && document.documentElement.getAttribute('data-keyboard') === 'open',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const read = () => setOpen(root.getAttribute('data-keyboard') === 'open');
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-keyboard'] });
    return () => observer.disconnect();
  }, []);
  return open;
}
