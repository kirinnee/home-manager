import { describe, expect, test } from 'bun:test';
import { TEAMMATE_NAMES, pickTeammateName } from './names';

describe('teammate names', () => {
  test('pool has at least a thousand unique names', () => {
    expect(new Set(TEAMMATE_NAMES).size).toBeGreaterThanOrEqual(1000);
    expect(new Set(TEAMMATE_NAMES).size).toBe(TEAMMATE_NAMES.length);
  });

  test('avoids names used within the window', () => {
    const recent = TEAMMATE_NAMES.slice(0, TEAMMATE_NAMES.length - 1);
    expect(pickTeammateName(recent)).toBe(TEAMMATE_NAMES[TEAMMATE_NAMES.length - 1]!);
  });

  test('falls back to least-recently-used when the pool is exhausted', () => {
    const lastUsedAt = new Map(TEAMMATE_NAMES.map((name, index) => [name, index + 1]));
    expect(pickTeammateName(TEAMMATE_NAMES, lastUsedAt)).toBe(TEAMMATE_NAMES[0]);
  });
});
