import { beforeEach, describe, expect, test } from 'bun:test';
import { readTab, resetDetailsTabMemory, touchTab, writeTab, type DetailsTab } from './useDetailsTab';

describe('details tab memory (pure LRU helpers)', () => {
  beforeEach(() => resetDetailsTabMemory());

  test('a fresh id reads the identity default and earns no entry', () => {
    const map = new Map<string, DetailsTab>();
    expect(readTab(map, 'never-seen')).toBe('identity');
    expect(map.size).toBe(0);
    // touch is a no-op until a value exists.
    touchTab(map, 'never-seen');
    expect(map.size).toBe(0);
  });

  test('write then read round-trips the chosen tab', () => {
    const map = new Map<string, DetailsTab>();
    writeTab(map, 'a', 'budget');
    expect(readTab(map, 'a')).toBe('budget');
    writeTab(map, 'a', 'progress');
    expect(readTab(map, 'a')).toBe('progress');
  });

  test('eviction drops the oldest recency beyond the cap', () => {
    const map = new Map<string, DetailsTab>();
    for (let i = 0; i < 50; i++) writeTab(map, `s${i}`, 'runtime', 50);
    expect(map.size).toBe(50);
    expect(map.has('s0')).toBe(true);
    writeTab(map, 's50', 'runtime', 50); // 51st → oldest (s0) evicted
    expect(map.size).toBe(50);
    expect(map.has('s0')).toBe(false);
    expect(map.has('s50')).toBe(true);
  });

  test('touch refreshes recency so a touched id survives later eviction', () => {
    const map = new Map<string, DetailsTab>();
    for (let i = 0; i < 50; i++) writeTab(map, `s${i}`, 'runtime', 50);
    // s0 is oldest; touching it moves it to newest.
    touchTab(map, 's0');
    writeTab(map, 's50', 'runtime', 50); // evicts the now-oldest (s1), not s0
    expect(map.has('s0')).toBe(true);
    expect(map.has('s1')).toBe(false);
  });
});
