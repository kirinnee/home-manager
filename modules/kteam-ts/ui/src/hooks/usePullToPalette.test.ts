import { describe, expect, test } from 'bun:test';
import {
  NO_PULL,
  PALETTE_PULL_THRESHOLD_PX,
  advancePull,
  beginPull,
  endPull,
  palettePullProgress,
} from './usePullToPalette';

const start = (over: Partial<{ touches: number; scrollTop: number; clientY: number }> = {}) =>
  beginPull({ touches: 1, scrollTop: 0, clientY: 100, ...over });

describe('beginPull', () => {
  test('arms one finger at the top of the scroller', () => {
    expect(start()).toEqual({ armed: true, startY: 100, distance: 0 });
  });

  test('mid-list is a no-op — a scrolled list is being scrolled, not pulled', () => {
    expect(start({ scrollTop: 1 })).toEqual(NO_PULL);
    expect(start({ scrollTop: 900 })).toEqual(NO_PULL);
  });

  test('ignores multitouch, which is a pinch', () => {
    expect(start({ touches: 2 })).toEqual(NO_PULL);
  });
});

describe('advancePull', () => {
  test('measures downward travel from where the finger went down', () => {
    const pull = advancePull(start(), { touches: 1, scrollTop: 0, clientY: 160 });
    expect(pull).toEqual({ armed: true, startY: 100, distance: 60 });
  });

  test('upward travel reads as zero and does not cancel the pull', () => {
    const pull = advancePull(start(), { touches: 1, scrollTop: 0, clientY: 40 });
    expect(pull).toEqual({ armed: true, startY: 100, distance: 0 });
  });

  test('the list actually scrolling ends the pull — that was a scroll', () => {
    expect(advancePull(start(), { touches: 1, scrollTop: 12, clientY: 300 })).toEqual(NO_PULL);
  });

  test('a second finger mid-pull ends it', () => {
    expect(advancePull(start(), { touches: 2, scrollTop: 0, clientY: 300 })).toEqual(NO_PULL);
  });

  test('a move that never armed stays disarmed', () => {
    expect(advancePull(NO_PULL, { touches: 1, scrollTop: 0, clientY: 999 })).toEqual(NO_PULL);
  });
});

describe('endPull', () => {
  const pulled = (distance: number) => ({ armed: true, startY: 0, distance });

  test('opens only once the threshold is crossed', () => {
    expect(endPull(pulled(PALETTE_PULL_THRESHOLD_PX - 1))).toBe(false);
    expect(endPull(pulled(PALETTE_PULL_THRESHOLD_PX))).toBe(true);
    expect(endPull(pulled(PALETTE_PULL_THRESHOLD_PX * 2))).toBe(true);
  });

  test('an accidental tug never opens the palette', () => {
    expect(endPull(pulled(9))).toBe(false);
  });

  test('a disarmed gesture never opens it, however far the finger went', () => {
    expect(endPull({ ...NO_PULL, distance: 1000 })).toBe(false);
  });

  test('the threshold is longer than the sidebar search pull, so the two cannot be confused', () => {
    expect(PALETTE_PULL_THRESHOLD_PX).toBeGreaterThan(64);
  });

  test('honours a custom threshold', () => {
    expect(endPull(pulled(30), 20)).toBe(true);
    expect(endPull(pulled(30), 40)).toBe(false);
  });
});

describe('palettePullProgress', () => {
  test('is 0 at or below zero travel', () => {
    expect(palettePullProgress(0)).toBe(0);
    expect(palettePullProgress(-40)).toBe(0);
  });

  test('ramps linearly and clamps at the threshold', () => {
    expect(palettePullProgress(PALETTE_PULL_THRESHOLD_PX / 2)).toBeCloseTo(0.5);
    expect(palettePullProgress(PALETTE_PULL_THRESHOLD_PX)).toBe(1);
    expect(palettePullProgress(PALETTE_PULL_THRESHOLD_PX * 4)).toBe(1);
  });

  test('never divides by a zero threshold', () => {
    expect(palettePullProgress(50, 0)).toBe(0);
  });
});
