import { describe, expect, test } from 'bun:test';
import { TEAMMATE_NAMES, displayName, normalizeTeammateName, pickTeammateName } from './names';

describe('teammate names', () => {
  test('pool has ~10,000 unique names', () => {
    expect(new Set(TEAMMATE_NAMES).size).toBeGreaterThanOrEqual(9000);
    expect(new Set(TEAMMATE_NAMES).size).toBe(TEAMMATE_NAMES.length);
  });

  test('every pool entry survives normalizeTeammateName unchanged', () => {
    // An entry that normalises to something else (or to null) is a latent bug
    // that only surfaces the day that name is drawn — assert over the WHOLE pool.
    for (const name of TEAMMATE_NAMES) {
      expect(normalizeTeammateName(name)).toBe(name);
    }
  });

  test('pool entries are single-word ASCII names, no initials', () => {
    for (const name of TEAMMATE_NAMES) {
      expect(name).toMatch(/^[a-z]{2,32}$/); // letters only: no digits, hyphens, spaces
    }
  });

  test('drawing from the full pool stays fast', () => {
    // pickTeammateName is O(pool + used) per draw. A draw happens once per
    // session start (suggestNames caps at 50), so per-draw is what matters:
    // measured 0.3-4.7ms at 10,000 names. Guard against an accidental
    // quadratic (which would be seconds per draw), not against CI jitter.
    const used = TEAMMATE_NAMES.slice(0, Math.floor(TEAMMATE_NAMES.length / 2));
    const draws = 100;
    const start = performance.now();
    for (let i = 0; i < draws; i++) pickTeammateName(used);
    const perDraw = (performance.now() - start) / draws;
    expect(perDraw).toBeLessThan(50);
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
