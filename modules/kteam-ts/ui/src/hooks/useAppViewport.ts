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

type Orientation = 'portrait' | 'landscape';

/** Which way the device is held. `screen.orientation` is the authority where it
 *  exists; the two fallbacks are legacy iOS and, last, the viewport's own aspect
 *  — which is only wrong on a phone whose keyboard is taller than the remaining
 *  portrait viewport, and the callers below tolerate a wrong reading (they lose
 *  one baseline, not the state). */
function orientationOf(): Orientation {
  const type = window.screen?.orientation?.type;
  if (typeof type === 'string') return type.startsWith('landscape') ? 'landscape' : 'portrait';
  const legacy = (window as unknown as { orientation?: number }).orientation;
  if (typeof legacy === 'number') return Math.abs(legacy) === 90 ? 'landscape' : 'portrait';
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

export function useAppViewport(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const vv = window.visualViewport;
    let frame = 0;
    let settle: number[] = [];
    // The tallest visible viewport seen while NOBODY was typing, PER PHYSICAL
    // ORIENTATION. This is what makes the keyboard detectable on Android — see
    // the note in `apply()`. Keyed by orientation and not by a single stamp
    // because rotating WHILE TYPING is a real sequence (turn the phone to get a
    // wider keyboard) and focus may never leave the field afterwards: a design
    // that can only learn a baseline from an unfocused frame would then be stuck
    // on whatever it last decided, in either direction.
    const seen: Record<Orientation, { h: number; w: number }> = {
      portrait: { h: 0, w: 0 },
      landscape: { h: 0, w: 0 },
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
      const facing = orientationOf();
      if (!typing) {
        // A different width in the same orientation is a different device
        // metric (a resized desktop window, a split-screen change), not a
        // taller frame of the same one — relearn instead of keeping the max.
        const previous = seen[facing];
        seen[facing] = previous.w === width ? { h: Math.max(previous.h, height), w: width } : { h: height, w: width };
      }
      // AN ORIENTATION NEVER MEASURED UNFOCUSED still gets a usable baseline:
      // rotating swaps the two, so this one's full height is close to the
      // other's full WIDTH. That estimate ignores browser chrome and therefore
      // errs high by ~40-90px — comfortably inside the 120px band, so it is
      // safe in both directions: a full-height frame still reads as closed, and
      // a keyboard-shrunk one still reads as open. The state recovers on every
      // transition without ever having to wait for a blur.
      const other = facing === 'portrait' ? seen.landscape : seen.portrait;
      const baseline = seen[facing].h || other.w;
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
      // Baselines are per-orientation and relearn themselves in `apply()`; this
      // ladder exists because iOS reports PRE-rotation metrics on the event and
      // settles a few frames later, so the first reading would file the old
      // orientation's height under the new orientation's key.
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
