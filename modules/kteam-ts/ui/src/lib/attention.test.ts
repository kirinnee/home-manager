import { describe, expect, test } from 'bun:test';
import {
  emptyAttentionCache,
  parseAttentionItem,
  parseAttentionSnapshot,
  sessionAttention,
  sessionAttentionCount,
} from './attention';

const item = {
  id: 'A1',
  source: 'question',
  sourceRef: 'q1',
  subject: 'Ship it?',
  why: 'The session is waiting.',
  waitingSince: '2026-07-28T00:00:00.000Z',
  howToResolve: 'Answer the question.',
  raisedBy: 'daemon',
  raisedBySession: null,
  raisedByName: null,
} as const;

describe('attention client parsing', () => {
  test('keeps the full required shape and rejects malformed provenance/time', () => {
    expect(parseAttentionItem(item)).toEqual(item);
    expect(parseAttentionItem({ ...item, waitingSince: 'bad' })).toBeNull();
    expect(parseAttentionItem({ ...item, source: 'unknown' })).toBeNull();
    expect(parseAttentionItem({ ...item, id: 'A01' })).toBeNull();
    expect(parseAttentionItem({ ...item, id: '?A1' })).toBeNull();
    expect(parseAttentionItem({ ...item, raisedBySession: 5 })).toBeNull();
    expect(parseAttentionItem({ ...item, raisedBy: 'agent', raisedBySession: null })).toBeNull();
  });

  test('a whole snapshot is all-or-nothing and session-addressed', () => {
    const value = {
      v: 1,
      sessionId: 's1',
      items: [item],
      resolved: [],
      count: 1,
      parseErrors: 0,
      updatedAt: '2026-07-28T00:00:00.000Z',
    };
    expect(parseAttentionSnapshot(value, 's1')?.count).toBe(1);
    expect(parseAttentionSnapshot(value, 's2')).toBeNull();
    expect(parseAttentionSnapshot({ ...value, items: [item, { id: 'bad' }] }, 's1')).toBeNull();
    expect(parseAttentionSnapshot({ ...value, count: 0 }, 's1')).toBeNull();
  });
});

test('cache readers keep count independent from full hydration', () => {
  const empty = emptyAttentionCache();
  expect(sessionAttention(empty, 's1')).toEqual([]);
  expect(sessionAttentionCount({ ...empty, counts: { s1: 3 } }, 's1')).toBe(3);
});
