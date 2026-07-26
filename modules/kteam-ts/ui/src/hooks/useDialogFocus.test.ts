// The Escape LAYER STACK, tested without a DOM.
//
// The rest of `useDialogFocus` is focus plumbing that only means anything inside
// a real document (the browser gate covers it end to end). The ordering rule is
// not: it is pure bookkeeping, it is what decides whether one Escape closes one
// overlay or all of them, and it is the part a future edit is most likely to
// break by "simplifying" the dependency array. So it lives as three exported
// functions and is asserted here directly.

import { afterEach, describe, expect, test } from 'bun:test';
import { escapeLayerCount, isTopEscapeLayer, pushEscapeLayer } from './useDialogFocus';

/** The stack is module state shared by every test in this file; leaving a layer
 *  behind would make the next test's assertions depend on run order. */
const opened: Array<() => void> = [];
function open(): { token: object; release: () => void } {
  const token = {};
  const release = pushEscapeLayer(token);
  opened.push(release);
  return { token, release };
}

afterEach(() => {
  while (opened.length) opened.pop()!();
});

describe('escape layers', () => {
  test('an unopened layer owns nothing, even with an empty stack', () => {
    expect(escapeLayerCount()).toBe(0);
    expect(isTopEscapeLayer({})).toBe(false);
  });

  test('the most recently opened overlay owns Escape', () => {
    const sheet = open();
    expect(isTopEscapeLayer(sheet.token)).toBe(true);

    // …then the palette is summoned over it.
    const palette = open();
    expect(isTopEscapeLayer(palette.token)).toBe(true);
    expect(isTopEscapeLayer(sheet.token)).toBe(false);
    expect(escapeLayerCount()).toBe(2);
  });

  test('closing the top layer hands Escape back to the one underneath', () => {
    const sheet = open();
    const palette = open();

    // One Escape closes the palette only.
    palette.release();
    expect(isTopEscapeLayer(sheet.token)).toBe(true);
    expect(isTopEscapeLayer(palette.token)).toBe(false);
    expect(escapeLayerCount()).toBe(1);

    // The next Escape closes the sheet.
    sheet.release();
    expect(isTopEscapeLayer(sheet.token)).toBe(false);
    expect(escapeLayerCount()).toBe(0);
  });

  test('a layer closed out of order leaves the rest of the stack intact', () => {
    // The sheet can close without Escape — a scrim click, a swipe, or the route
    // changing under it — while the palette is still up.
    const sheet = open();
    const palette = open();

    sheet.release();
    expect(escapeLayerCount()).toBe(1);
    expect(isTopEscapeLayer(palette.token)).toBe(true);
  });

  test('releasing twice is a no-op, not a pop of somebody else', () => {
    const sheet = open();
    const palette = open();

    palette.release();
    palette.release();
    palette.release();

    expect(escapeLayerCount()).toBe(1);
    expect(isTopEscapeLayer(sheet.token)).toBe(true);
  });

  test("StrictMode's setup / cleanup / setup keeps one layer in its original place", () => {
    const sheet = open();
    const palette = open();

    // React 19 in StrictMode mounts an effect, tears it down, and mounts it
    // again with the SAME hook instance — so the same token is re-pushed.
    const remount = pushEscapeLayer(sheet.token);
    remount();

    expect(escapeLayerCount()).toBe(2);
    expect(isTopEscapeLayer(palette.token)).toBe(true);
  });

  test('three deep unwinds one layer at a time, newest first', () => {
    const drawer = open();
    const sheet = open();
    const palette = open();

    // Simulate three Escapes: each one closes whichever layer is on top.
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      if (isTopEscapeLayer(palette.token)) {
        order.push('palette');
        palette.release();
      } else if (isTopEscapeLayer(sheet.token)) {
        order.push('sheet');
        sheet.release();
      } else if (isTopEscapeLayer(drawer.token)) {
        order.push('drawer');
        drawer.release();
      }
    }

    expect(order).toEqual(['palette', 'sheet', 'drawer']);
    expect(escapeLayerCount()).toBe(0);
  });
});
