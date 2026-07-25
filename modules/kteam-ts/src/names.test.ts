import { describe, expect, test } from 'bun:test';
import { TEAMMATE_NAMES, displayName, normalizeTeammateName, pickTeammateName } from './names';

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

describe('normalizeTeammateName', () => {
  test('accepts and lowercases a valid slug', () => {
    expect(normalizeTeammateName('Hayden')).toBe('hayden');
    expect(normalizeTeammateName('  Hayden  ')).toBe('hayden');
    expect(normalizeTeammateName('agent-7')).toBe('agent-7');
  });

  test('rejects non-slugs rather than rewriting them', () => {
    expect(normalizeTeammateName('')).toBeNull();
    expect(normalizeTeammateName('   ')).toBeNull();
    expect(normalizeTeammateName('7up')).toBeNull(); // must start with a letter
    expect(normalizeTeammateName('-lead')).toBeNull();
    expect(normalizeTeammateName('has space')).toBeNull();
    expect(normalizeTeammateName('[Hayden]')).toBeNull(); // a TITLE, not a callsign
    expect(normalizeTeammateName('a'.repeat(33))).toBeNull(); // too long
  });
});

describe('displayName', () => {
  test('preserves the [Teammate] Task Title convention verbatim', () => {
    expect(displayName('[Hayden] Fix Transcript')).toBe('[Hayden] Fix Transcript');
  });

  test('flattens control characters and collapses whitespace', () => {
    expect(displayName('foo\n\tbar   baz')).toBe('foo bar baz');
    expect(displayName('  trim me  ')).toBe('trim me');
  });

  test('caps overlong titles at 120 chars', () => {
    expect(displayName('x'.repeat(200)).length).toBe(120);
  });
});
