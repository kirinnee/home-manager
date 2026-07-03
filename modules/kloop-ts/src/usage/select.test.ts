import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, implementerCandidates, selectFromPool, selectImplementer } from '../types';
import type { Config } from '../types';

const cfg = (over: Partial<Config>): Config => ({ ...DEFAULT_CONFIG, ...over });

describe('selectFromPool with usage weight', () => {
  test('0-weight accounts are excluded; only positive-weight picked', () => {
    const pool = { 'claude-a': 1, 'claude-b': 1, 'claude-c': 1 };
    const w = (b: string) => (b === 'claude-b' ? 1 : 0);
    for (let i = 0; i < 50; i++) expect(selectFromPool(pool, undefined, w)).toBe('claude-b');
  });

  test('all-zero ⇒ falls back to the full pool (never empty/throws)', () => {
    const pool = { 'claude-a': 1, 'claude-b': 1 };
    const got = new Set<string>();
    for (let i = 0; i < 50; i++) got.add(selectFromPool(pool, undefined, () => 0));
    expect([...got].every(b => b === 'claude-a' || b === 'claude-b')).toBe(true);
  });

  test('weekly headroom biases the distribution (more headroom → picked more)', () => {
    const pool = { 'claude-a': 1, 'claude-b': 1 }; // equal configured weight
    const w = (b: string) => (b === 'claude-a' ? 0.9 : 0.1); // a has 9× the headroom
    let a = 0;
    for (let i = 0; i < 2000; i++) if (selectFromPool(pool, undefined, w) === 'claude-a') a++;
    expect(a).toBeGreaterThan(1500); // ≈ 90%
  });

  test('weight is keyed by the BARE binary (harness/flags stripped)', () => {
    const pool = { 'claude-a:claude': 1, 'claude-b:claude': 1 };
    expect(selectFromPool(pool, undefined, b => (b === 'claude-a' ? 1 : 0))).toBe('claude-a:claude');
  });

  test('no weight fn ⇒ unchanged behavior', () => {
    expect(selectFromPool('solo:claude')).toBe('solo:claude');
  });
});

describe('selectImplementer with usage weight', () => {
  test('a 0-weight implementer is never picked when another is positive', () => {
    const config = cfg({ implementers: { 'claude-x': 5, 'claude-y': 5 } });
    for (let i = 0; i < 50; i++) {
      expect(selectImplementer(config, 1, b => (b === 'claude-y' ? 1 : 0))).toBe('claude-y');
    }
  });

  test('all-zero ⇒ still returns a valid implementer (caller blocks separately)', () => {
    const config = cfg({ implementers: { 'claude-x': 1, 'claude-y': 1 } });
    const pick = selectImplementer(config, 1, () => 0);
    expect(pick === 'claude-x' || pick === 'claude-y').toBe(true);
  });

  test('weekly headroom biases implementer picks', () => {
    const config = cfg({ implementers: { 'claude-x': 1, 'claude-y': 1 } });
    const w = (b: string) => (b === 'claude-x' ? 0.8 : 0.2);
    let x = 0;
    for (let i = 0; i < 2000; i++) if (selectImplementer(config, 2, w) === 'claude-x') x++;
    expect(x).toBeGreaterThan(1300); // ≈ 80%
  });

  test('a pool-profile key weights per member, gated members drop out', () => {
    const config = cfg({
      implementers: { fast: 1, 'claude-solo': 1 },
      poolProfiles: { fast: { 'claude-a': 1, 'claude-b': 1 } },
    });
    // Only claude-b (inside `fast`) has weight ⇒ must resolve through `fast`.
    for (let i = 0; i < 50; i++) {
      expect(selectImplementer(config, 1, b => (b === 'claude-b' ? 1 : 0))).toBe('claude-b');
    }
  });
});

describe('implementerCandidates', () => {
  test('expands pool profiles and strips flags', () => {
    const config = cfg({
      implementers: { fast: 1, 'claude-solo*': 1 },
      poolProfiles: { fast: { 'claude-a:claude': 1, 'claude-b': 1 } },
    });
    expect(new Set(implementerCandidates(config))).toEqual(new Set(['claude-a', 'claude-b', 'claude-solo']));
  });
});
