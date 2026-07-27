import { describe, expect, test } from 'bun:test';
import { PULL_THRESHOLD_PX, pullProgress, pullTriggered } from './usePullToSearch';

describe('pullProgress', () => {
  test('is 0 at or below zero travel', () => {
    expect(pullProgress(0)).toBe(0);
    expect(pullProgress(-20)).toBe(0);
  });
  test('ramps linearly toward the threshold', () => {
    expect(pullProgress(PULL_THRESHOLD_PX / 2)).toBeCloseTo(0.5);
    expect(pullProgress(PULL_THRESHOLD_PX)).toBe(1);
  });
  test('clamps at 1 past the threshold', () => {
    expect(pullProgress(PULL_THRESHOLD_PX * 3)).toBe(1);
  });
  test('a non-positive threshold never divides by zero', () => {
    expect(pullProgress(50, 0)).toBe(0);
  });
});

describe('pullTriggered', () => {
  test('fires only once the threshold is reached', () => {
    expect(pullTriggered(PULL_THRESHOLD_PX - 1)).toBe(false);
    expect(pullTriggered(PULL_THRESHOLD_PX)).toBe(true);
    expect(pullTriggered(PULL_THRESHOLD_PX + 100)).toBe(true);
  });
  test('a short accidental tug does not fire', () => {
    expect(pullTriggered(12)).toBe(false);
  });
});
