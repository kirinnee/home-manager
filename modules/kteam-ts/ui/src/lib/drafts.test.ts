import { describe, expect, test } from 'bun:test';
import {
  DRAFTS_VERSION,
  MAX_DRAFTS,
  MAX_DRAFT_LEN,
  emptyStore,
  evictLru,
  parseDraftStore,
  removeDraft,
  upsertDraft,
} from './drafts';

describe('parseDraftStore — defensive', () => {
  test('null / empty / malformed JSON degrade to an empty store', () => {
    expect(parseDraftStore(null)).toEqual(emptyStore());
    expect(parseDraftStore('')).toEqual(emptyStore());
    expect(parseDraftStore('not json{')).toEqual(emptyStore());
    expect(parseDraftStore('42')).toEqual(emptyStore());
    expect(parseDraftStore('"a string"')).toEqual(emptyStore());
    expect(parseDraftStore('null')).toEqual(emptyStore());
  });

  test('a wrong version is discarded rather than read', () => {
    const raw = JSON.stringify({ v: DRAFTS_VERSION + 1, drafts: { s1: { text: 'hi', at: 1 } } });
    expect(parseDraftStore(raw)).toEqual(emptyStore());
  });

  test('valid entries survive; non-conforming and empty ones are dropped', () => {
    const raw = JSON.stringify({
      v: DRAFTS_VERSION,
      drafts: {
        good: { text: 'keep me', at: 10 },
        noAt: { text: 'no timestamp' },
        badAt: { text: 'nan', at: Number.NaN },
        notObj: 'nope',
        empty: { text: '   \n\t', at: 5 },
      },
    });
    const store = parseDraftStore(raw);
    expect(store.drafts).toEqual({ good: { text: 'keep me', at: 10 } });
  });

  test('a missing or non-object drafts field is empty, not a throw', () => {
    expect(parseDraftStore(JSON.stringify({ v: DRAFTS_VERSION }))).toEqual(emptyStore());
    expect(parseDraftStore(JSON.stringify({ v: DRAFTS_VERSION, drafts: 7 }))).toEqual(emptyStore());
  });
});

describe('upsertDraft', () => {
  test('stores a non-empty draft with the given timestamp', () => {
    const store = upsertDraft(emptyStore(), 's1', 'hello', 100);
    expect(store.drafts['s1']).toEqual({ text: 'hello', at: 100 });
  });

  test('an empty or whitespace-only draft is dropped, not stored', () => {
    const seeded = upsertDraft(emptyStore(), 's1', 'hello', 1);
    expect(upsertDraft(seeded, 's1', '', 2).drafts['s1']).toBeUndefined();
    expect(upsertDraft(seeded, 's1', '   \n ', 2).drafts['s1']).toBeUndefined();
  });

  test('an oversized draft is refused (not truncated), leaving no partial copy', () => {
    const huge = 'x'.repeat(MAX_DRAFT_LEN + 1);
    const store = upsertDraft(emptyStore(), 's1', huge, 1);
    expect(store.drafts['s1']).toBeUndefined();
    // exactly at the cap is allowed
    const atCap = 'y'.repeat(MAX_DRAFT_LEN);
    expect(upsertDraft(emptyStore(), 's1', atCap, 1).drafts['s1']?.text.length).toBe(MAX_DRAFT_LEN);
  });

  test('re-touching an existing draft refreshes its timestamp', () => {
    let store = upsertDraft(emptyStore(), 's1', 'a', 1);
    store = upsertDraft(store, 's1', 'ab', 2);
    expect(store.drafts['s1']).toEqual({ text: 'ab', at: 2 });
  });

  test('the store is LRU-capped as drafts accumulate', () => {
    let store = emptyStore();
    for (let i = 0; i < MAX_DRAFTS + 5; i++) store = upsertDraft(store, `s${i}`, `draft ${i}`, i);
    expect(Object.keys(store.drafts).length).toBe(MAX_DRAFTS);
    // The oldest (lowest `at`) are the ones evicted; the newest remain.
    expect(store.drafts['s0']).toBeUndefined();
    expect(store.drafts[`s${MAX_DRAFTS + 4}`]).toBeDefined();
  });
});

describe('evictLru', () => {
  test('keeps the newest-touched up to the cap', () => {
    const store = {
      v: DRAFTS_VERSION,
      drafts: {
        old: { text: 'o', at: 1 },
        mid: { text: 'm', at: 2 },
        new: { text: 'n', at: 3 },
      },
    };
    const capped = evictLru(store, 2);
    expect(Object.keys(capped.drafts).sort()).toEqual(['mid', 'new']);
  });

  test('a store within the cap is returned unchanged', () => {
    const store = { v: DRAFTS_VERSION, drafts: { a: { text: 'a', at: 1 } } };
    expect(evictLru(store, 5)).toBe(store);
  });
});

describe('removeDraft', () => {
  test('drops a present draft and returns the same reference when absent', () => {
    const store = upsertDraft(emptyStore(), 's1', 'hi', 1);
    expect(removeDraft(store, 's1').drafts['s1']).toBeUndefined();
    expect(removeDraft(store, 'missing')).toBe(store);
  });
});
