// THE DECISION BEHIND "HOLD THE TRANSCRIPT STILL" (see useLiveTick.ts). This
// package has no DOM implementation, so — following pinBlockedBySelection and the
// other pure-decision tests — the policy is exported as plain functions and
// asserted with plain data.
//
// The bug it guards: on WebKit/iOS a DOM mutation next to an active selection
// collapses it. Two rounds of fixes shipped and the reader still could not
// highlight a live conversation, because the gate was wrong in two ways these
// tests now pin down:
//
//   - it only recognised a FINISHED selection, so a touch long-press — which
//     dwells with the selection still collapsed — sailed straight through it;
//   - it had no cap, so making it strong enough to also suspend streaming would
//     have risked a transcript that silently stopped updating.

import { describe, expect, test } from 'bun:test';
import {
  MAX_HOLD_MS,
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

  test('released → flush immediately, whatever the cap says', () => {
    expect(shouldHoldStill(false, sel({ isCollapsed: true }), 0, 1)).toBe(false);
  });

  test('an explicit cap overrides the default', () => {
    expect(shouldHoldStill(false, sel({}), 0, 500, 400)).toBe(false);
    expect(shouldHoldStill(false, sel({}), 0, 300, 400)).toBe(true);
  });
});
