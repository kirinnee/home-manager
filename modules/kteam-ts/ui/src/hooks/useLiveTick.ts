// A once-per-second re-render signal for the live elapsed timers that FREEZES
// while the reader holds a text selection.
//
// WHY THIS EXISTS (turn: "selection disappears every time the second changes").
// The transcript's live timers — ToolGroup's <Elapsed/> ("— 12s") and Harness's
// <ThinkingIndicator/> ("Working… 12s") — re-render once a second to advance the
// count. Each tick mutates a text node INSIDE the transcript. On WebKit/iOS a DOM
// mutation next to an active selection COLLAPSES that selection (Blink/Chromium
// does not — which is why desktop testing never caught it and a phone user hits
// it every single second). So while the reader is holding a highlight anywhere in
// the document, we must not re-render the timers at all: no mutation, nothing for
// WebKit to collapse. The count simply freezes for the few seconds a selection is
// held and snaps to the correct value the instant it clears.
//
// This is deliberately engine-agnostic: it removes the per-second DOM churn
// rather than trying to make a specific mutation selection-safe, so it holds
// whether the collapse is WebKit's aggressive clear or a node replacement.

import { useEffect, useState } from 'react';

/** Minimal shape of a `Selection` this module needs — declared locally so the
 *  decision is testable without a DOM (this package has no DOM impl; see
 *  useLiveTick.test.ts). */
export interface TickSelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
}

/** Is a text selection currently HELD? A non-collapsed selection with at least
 *  one range. While this is true the live timers must not re-render (see file
 *  header). A bare caret (collapsed) or an empty selection is no obstacle. */
export function selectionHeld(sel: TickSelectionLike | null): boolean {
  return !!sel && !sel.isCollapsed && sel.rangeCount > 0;
}

/** A counter that increments about once a second — EXCEPT while a text selection
 *  is held, when it holds still. Resumes the instant the selection clears (the
 *  `selectionchange` listener bumps it then), so a frozen elapsed label jumps
 *  straight to the current value on release. Callers read the actual time
 *  (`Date.now()`) themselves in render; the return value only forces the
 *  re-render, so ignoring it is fine. */
export function useLiveTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const held = () => (typeof window !== 'undefined' ? selectionHeld(window.getSelection()) : false);
    const id = setInterval(() => {
      // Hold off the re-render while the reader is selecting; the value catches
      // up when the selection clears.
      if (!held()) setTick(n => n + 1);
    }, 1000);
    // The moment a selection is released, re-render once so the frozen count
    // snaps to now. selectionchange also fires WHILE selecting (held → true),
    // where this is intentionally a no-op — never re-render under a live drag.
    const onSel = () => {
      if (!held()) setTick(n => n + 1);
    };
    document.addEventListener('selectionchange', onSel, { passive: true });
    return () => {
      clearInterval(id);
      document.removeEventListener('selectionchange', onSel);
    };
  }, []);
  return tick;
}
