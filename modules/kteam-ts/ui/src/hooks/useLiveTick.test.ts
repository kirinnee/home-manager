// THE DECISION BEHIND "HOLD THE TRANSCRIPT STILL" (see useLiveTick.ts). This
// package has no DOM implementation, so the policy is exported as plain
// functions and the production event controller takes an injectable clock.
// That lets this suite exercise the actual pointer/touch/blur handler wiring,
// not merely a predicate that could stay green after a listener was disconnected.
//
// The bug it guards: on WebKit/iOS a DOM mutation next to an active selection
// collapses it. Two rounds of fixes shipped and the reader still could not
// highlight a live conversation, because the gate was wrong in two ways these
// tests now pin down:
//
//   - it only recognised a FINISHED selection, so a touch long-press — which
//     dwells with the selection still collapsed — sailed straight through it;
//   - it released synchronously at touchend, flushing deferred text during the
//     short window in which the pointer was up but the native range still had
//     not materialised;
//   - it had no cap, so making it strong enough to also suspend streaming would
//     have risked a transcript that silently stopped updating.

import { describe, expect, test } from 'bun:test';
import {
  MAX_HOLD_MS,
  SELECTION_RELEASE_SETTLE_MS,
  TOUCH_SELECTION_DWELL_MS,
  createTranscriptHoldController,
  holdExpired,
  selectionHeld,
  shouldHoldStill,
  transcriptHeldStill,
  type TickSelectionLike,
} from './useLiveTick';

const sel = (over: Partial<TickSelectionLike>): TickSelectionLike => ({ isCollapsed: false, rangeCount: 1, ...over });
/** What `window.getSelection()` looks like during a touch long-press, before the
 *  word range materialises: present, but collapsed. */
const DWELLING: TickSelectionLike = { isCollapsed: true, rangeCount: 1 };

describe('selectionHeld — is a finished selection being held?', () => {
  test('no selection object → not held', () => {
    expect(selectionHeld(null)).toBe(false);
  });

  test('a non-collapsed selection with a range → held', () => {
    expect(selectionHeld(sel({}))).toBe(true);
  });

  test('a collapsed selection (bare caret) → not held', () => {
    expect(selectionHeld(sel({ isCollapsed: true }))).toBe(false);
  });

  test('an empty selection (rangeCount 0) → not held', () => {
    expect(selectionHeld(sel({ rangeCount: 0 }))).toBe(false);
  });

  test('collapsed AND empty → not held', () => {
    expect(selectionHeld({ isCollapsed: true, rangeCount: 0 })).toBe(false);
  });
});

describe('transcriptHeldStill — must the transcript stop mutating?', () => {
  test('nothing happening → free to mutate', () => {
    expect(transcriptHeldStill(false, null)).toBe(false);
  });

  test('a held selection alone → hold still', () => {
    expect(transcriptHeldStill(false, sel({}))).toBe(true);
  });

  // The round-7 hole, and the reason a phone kept losing its highlight after the
  // desktop fix shipped: a finger selects by long-pressing, and for the whole
  // dwell the selection is still collapsed. The selection test cannot see it.
  test('a pointer held during a COLLAPSED selection → hold still (the touch long-press)', () => {
    expect(selectionHeld(DWELLING)).toBe(false);
    expect(transcriptHeldStill(true, DWELLING)).toBe(true);
  });

  test('a pointer held with no selection at all → hold still', () => {
    expect(transcriptHeldStill(true, null)).toBe(true);
  });
});

describe('holdExpired — the cap that stops a forgotten selection freezing the transcript', () => {
  test('nothing holding → never expired', () => {
    expect(holdExpired(null, 10_000_000)).toBe(false);
  });

  test('inside the window → not expired', () => {
    expect(holdExpired(1_000, 1_000 + MAX_HOLD_MS - 1)).toBe(false);
  });

  test('exactly at the cap → expired', () => {
    expect(holdExpired(1_000, 1_000 + MAX_HOLD_MS)).toBe(true);
  });

  test('well past the cap → expired', () => {
    expect(holdExpired(1_000, 1_000 + MAX_HOLD_MS * 10)).toBe(true);
  });

  test('a real copy gesture (long-press, adjust, tap Copy) fits inside the cap', () => {
    expect(holdExpired(0, 8_000)).toBe(false);
  });
});

describe('shouldHoldStill — the full policy', () => {
  test('idle reader → mutate freely', () => {
    expect(shouldHoldStill(false, null, null, 5_000)).toBe(false);
  });

  test('selection held, fresh → hold still', () => {
    expect(shouldHoldStill(false, sel({}), 4_000, 5_000)).toBe(true);
  });

  test('touch dwell (pointer down, selection collapsed), fresh → hold still', () => {
    expect(shouldHoldStill(true, DWELLING, 4_000, 5_000)).toBe(true);
  });

  test('selection STILL held but past the cap → give up and flush', () => {
    expect(shouldHoldStill(false, sel({}), 0, MAX_HOLD_MS + 1)).toBe(false);
  });

  test('ordinary release with no settle window → flush immediately', () => {
    expect(shouldHoldStill(false, sel({ isCollapsed: true }), 0, 1)).toBe(false);
  });

  test('touch just released while its range is still collapsed → keep the existing hold', () => {
    expect(shouldHoldStill(false, DWELLING, 0, 1, MAX_HOLD_MS, true)).toBe(true);
  });

  test('a stray touch release cannot create a hold that never began', () => {
    expect(shouldHoldStill(false, DWELLING, null, 1, MAX_HOLD_MS, true)).toBe(false);
  });

  test('the touch release settle cannot extend a hold beyond the hard cap', () => {
    expect(shouldHoldStill(false, DWELLING, 0, MAX_HOLD_MS + 1, MAX_HOLD_MS, true)).toBe(false);
  });

  test('the shared release window covers the measured post-touchend range delay', () => {
    expect(SELECTION_RELEASE_SETTLE_MS).toBeGreaterThanOrEqual(200);
    expect(SELECTION_RELEASE_SETTLE_MS).toBeLessThanOrEqual(300);
  });

  test('an explicit cap overrides the default', () => {
    expect(shouldHoldStill(false, sel({}), 0, 500, 400)).toBe(false);
    expect(shouldHoldStill(false, sel({}), 0, 300, 400)).toBe(true);
  });
});

interface VirtualTimer {
  at: number;
  callback: () => void;
}

function controllerHarness() {
  let now = 0;
  let nextTimer = 1;
  let selection: TickSelectionLike | null = null;
  const timers = new Map<number, VirtualTimer>();
  const changes: boolean[] = [];
  const controller = createTranscriptHoldController({
    now: () => now,
    readSelection: () => selection,
    setTimer: (callback, delayMs) => {
      const id = nextTimer++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimer: timer => timers.delete(timer as number),
    onHoldChange: holding => changes.push(holding),
  });

  const advance = (durationMs: number): void => {
    const target = now + durationMs;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    now = target;
  };

  return {
    controller,
    changes,
    advance,
    setSelection: (next: TickSelectionLike | null) => {
      selection = next;
    },
  };
}

const holdPointer = (pointerType: string, pointerId = 1) => ({ pointerId, pointerType });

describe('transcript hold controller — production event wiring', () => {
  test('an ordinary touch tap releases immediately instead of manufacturing a settle hold', () => {
    const h = controllerHarness();
    h.controller.onPointerDown(holdPointer('touch'));
    expect(h.controller.getSnapshot()).toBe(true);

    h.advance(60);
    h.controller.onPointerUp(holdPointer('touch'));
    expect(h.controller.getSnapshot()).toBe(false);
    h.advance(SELECTION_RELEASE_SETTLE_MS);
    expect(h.controller.getSnapshot()).toBe(false);
  });

  test('a plausible touch long-press stays held through the post-release selection window', () => {
    const h = controllerHarness();
    h.controller.onPointerDown(holdPointer('touch'));
    h.advance(TOUCH_SELECTION_DWELL_MS);
    h.controller.onPointerUp(holdPointer('touch'));

    expect(h.controller.getSnapshot()).toBe(true);
    h.advance(SELECTION_RELEASE_SETTLE_MS - 1);
    expect(h.controller.getSnapshot()).toBe(true);
    h.advance(1);
    expect(h.controller.getSnapshot()).toBe(false);
  });

  test('mouse release never takes the touch settle path, even after a long press', () => {
    const h = controllerHarness();
    h.controller.onPointerDown(holdPointer('mouse'));
    h.advance(TOUCH_SELECTION_DWELL_MS * 2);
    h.controller.onPointerUp(holdPointer('mouse'));
    expect(h.controller.getSnapshot()).toBe(false);
  });

  test('selectionchange evidence settles a touch release even before the dwell threshold', () => {
    const h = controllerHarness();
    h.controller.onTouchStart();
    h.advance(60);
    h.setSelection(DWELLING);
    h.controller.onSelectionChange();
    h.controller.onTouchEnd();

    expect(h.controller.getSnapshot()).toBe(true);
    h.advance(SELECTION_RELEASE_SETTLE_MS);
    expect(h.controller.getSnapshot()).toBe(false);
  });

  test('duplicate touchend and blur preserve the original settle deadline', () => {
    const h = controllerHarness();
    h.controller.onPointerDown(holdPointer('touch'));
    h.advance(TOUCH_SELECTION_DWELL_MS);
    h.controller.onPointerUp(holdPointer('touch'));
    h.advance(80);

    // Legacy touchend may follow pointerup; native selection UI may then blur
    // the page. Neither event may cancel OR restart the original 220ms timer.
    h.controller.onTouchEnd();
    h.controller.onBlur();
    h.advance(SELECTION_RELEASE_SETTLE_MS - 81);
    expect(h.controller.getSnapshot()).toBe(true);
    h.advance(1);
    expect(h.controller.getSnapshot()).toBe(false);
  });

  test('the cap callback ends one hold and a new pointer gesture receives a fresh window', () => {
    const h = controllerHarness();
    h.controller.onPointerDown(holdPointer('touch'));
    h.advance(MAX_HOLD_MS);
    expect(h.controller.getSnapshot()).toBe(false);

    // Further selection events from the capped gesture cannot restart it.
    h.setSelection(sel({}));
    h.controller.onSelectionChange();
    expect(h.controller.getSnapshot()).toBe(false);
    h.controller.onPointerUp(holdPointer('touch'));

    // A genuinely new gesture clears the capped state and starts at its own t0.
    h.setSelection(null);
    h.controller.onPointerDown(holdPointer('touch'));
    expect(h.controller.getSnapshot()).toBe(true);
    h.advance(MAX_HOLD_MS - 1);
    expect(h.controller.getSnapshot()).toBe(true);
  });

  test('unrelated app taps cannot renew the cap of a standing selection', () => {
    const h = controllerHarness();
    h.setSelection(sel({}));
    h.controller.onSelectionChange();
    expect(h.controller.getSnapshot()).toBe(true);

    // Keep tapping somewhere in the document every five seconds. The
    // document-level pointer signal must not turn a forgotten selection into an
    // indefinitely frozen transcript.
    for (let tap = 1; tap <= 3; tap += 1) {
      h.advance(tap === 1 ? 5_000 : 4_950);
      h.controller.onPointerDown(holdPointer('touch', tap));
      h.advance(50);
      h.controller.onPointerUp(holdPointer('touch', tap));
      expect(h.controller.getSnapshot()).toBe(true);
    }
    h.advance(4_950); // t=20s from the selection's original hold.
    expect(h.controller.getSnapshot()).toBe(false);

    h.controller.onPointerDown(holdPointer('touch', 9));
    h.controller.onPointerUp(holdPointer('touch', 9));
    expect(h.controller.getSnapshot()).toBe(false);
  });

  test('actively making a new selection after the old range was capped starts a new hold episode', () => {
    const h = controllerHarness();
    h.setSelection(sel({}));
    h.controller.onSelectionChange();
    h.advance(MAX_HOLD_MS);
    expect(h.controller.getSnapshot()).toBe(false);

    h.advance(10_000);
    h.controller.onPointerDown(holdPointer('touch'));
    expect(h.controller.getSnapshot()).toBe(false); // standing range alone cannot renew the cap

    // The old range collapses/changes under the active long-press: unlike an
    // unrelated tap, this is direct evidence of a new selection episode.
    h.setSelection(DWELLING);
    h.controller.onSelectionChange();
    expect(h.controller.getSnapshot()).toBe(true);
    h.advance(TOUCH_SELECTION_DWELL_MS);
    h.controller.onPointerUp(holdPointer('touch'));
    expect(h.controller.getSnapshot()).toBe(true);

    h.advance(100);
    h.setSelection(sel({}));
    h.controller.onSelectionChange();
    h.advance(SELECTION_RELEASE_SETTLE_MS - 100);
    expect(h.controller.getSnapshot()).toBe(true);
  });

  test('selection changes from the same pointer gesture cannot renew that gesture after its cap', () => {
    const h = controllerHarness();
    h.controller.onPointerDown(holdPointer('touch'));
    h.advance(MAX_HOLD_MS);
    expect(h.controller.getSnapshot()).toBe(false);

    h.setSelection(DWELLING);
    h.controller.onSelectionChange();
    expect(h.controller.getSnapshot()).toBe(false);
  });

  test('slow drag-scroll gestures may overlap settle windows without poisoning the next selection', () => {
    const h = controllerHarness();
    for (let gesture = 0; gesture < 60; gesture += 1) {
      h.controller.onPointerDown(holdPointer('touch'));
      h.advance(400); // long enough to take the plausible-selection path
      h.controller.onPointerUp(holdPointer('touch'));
      h.advance(100); // next drag begins before the 220ms settle expires
    }

    h.controller.onPointerDown(holdPointer('touch'));
    h.advance(TOUCH_SELECTION_DWELL_MS);
    h.controller.onPointerUp(holdPointer('touch'));
    expect(h.controller.getSnapshot()).toBe(true);
  });

  test('multi-touch ends only after the last pointer, preserving the earliest long-press start', () => {
    const h = controllerHarness();
    h.controller.onPointerDown(holdPointer('touch', 1));
    h.advance(100);
    h.controller.onPointerDown(holdPointer('touch', 2));
    h.advance(50);
    h.controller.onPointerUp(holdPointer('touch', 2));
    expect(h.controller.getSnapshot()).toBe(true);

    h.advance(400); // finger 1 has now been held for 550ms
    h.controller.onPointerUp(holdPointer('touch', 1));
    expect(h.controller.getSnapshot()).toBe(true);
    h.advance(SELECTION_RELEASE_SETTLE_MS);
    expect(h.controller.getSnapshot()).toBe(false);
  });

  test('touch pointercancel always receives a settle window below the dwell threshold', () => {
    const h = controllerHarness();
    h.controller.onPointerDown(holdPointer('touch'));
    h.advance(300);
    h.controller.onPointerCancel(holdPointer('touch'));
    expect(h.controller.getSnapshot()).toBe(true);
    h.advance(SELECTION_RELEASE_SETTLE_MS);
    expect(h.controller.getSnapshot()).toBe(false);
  });

  test('35 seconds of closely spaced quick flings cannot poison the next selection hold', () => {
    const h = controllerHarness();
    for (let gesture = 0; gesture < 240; gesture += 1) {
      h.controller.onPointerDown(holdPointer('touch'));
      h.advance(60);
      h.controller.onPointerUp(holdPointer('touch'));
      h.advance(90); // 150ms between starts — below the old 220ms settle.
    }
    expect(h.controller.getSnapshot()).toBe(false);

    h.controller.onPointerDown(holdPointer('touch'));
    h.advance(TOUCH_SELECTION_DWELL_MS);
    h.controller.onPointerUp(holdPointer('touch'));
    expect(h.controller.getSnapshot()).toBe(true);

    // The native range appears during the settle and takes ownership of the
    // hold after its deadline, exactly the race this gate exists to cover.
    h.advance(100);
    h.setSelection(sel({}));
    h.controller.onSelectionChange();
    h.advance(SELECTION_RELEASE_SETTLE_MS - 100);
    expect(h.controller.getSnapshot()).toBe(true);
  });
});
