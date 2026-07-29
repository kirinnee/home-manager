import { describe, expect, test } from 'bun:test';
import {
  describeAttentionResponse,
  emptyAttentionCache,
  parseAttentionItem,
  parseAttentionSnapshot,
  parseResolvedAttentionItem,
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

  test('optional context flows through and legacy records without it still parse', () => {
    expect(parseAttentionItem(item)?.context).toBeUndefined();
    expect(parseAttentionItem({ ...item, context: null })?.context).toBeUndefined();
    expect(parseAttentionItem({ ...item, context: 'Background for a new reader.' })?.context).toBe(
      'Background for a new reader.',
    );
    expect(parseAttentionItem({ ...item, context: 42 })).toBeNull();
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

describe('kinds, responses and dispositions (&F138/&F139)', () => {
  const CHOICE = { kind: 'multiple-choice' as const, options: [{ label: 'eu' }, { label: 'us' }] };

  test('an ask round-trips; a malformed ask fails the whole item, never renders as a guess', () => {
    expect(parseAttentionItem({ ...item, ask: { kind: 'permission' } })?.ask).toEqual({ kind: 'permission' });
    expect(parseAttentionItem({ ...item, ask: CHOICE })?.ask).toEqual(CHOICE);
    expect(parseAttentionItem({ ...item, ask: { kind: 'nope' } })).toBeNull();
    expect(parseAttentionItem({ ...item, ask: { kind: 'multiple-choice', options: [{ label: 'one' }] } })).toBeNull();
  });

  test('resolved rows carry response and disposition when present', () => {
    const resolved = {
      ...item,
      resolvedAt: '2026-07-28T01:00:00.000Z',
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      resolutionNote: null,
    };
    expect(
      parseResolvedAttentionItem({
        ...resolved,
        ask: { kind: 'permission' },
        response: { kind: 'permission', decision: 'approve' },
        disposition: 'done',
      }),
    ).toMatchObject({ response: { kind: 'permission', decision: 'approve' }, disposition: 'done' });
    expect(parseResolvedAttentionItem({ ...resolved, disposition: 'dismissed' })?.disposition).toBe('dismissed');
    expect(parseResolvedAttentionItem({ ...resolved, disposition: 'shrugged' })).toBeNull();
    expect(parseResolvedAttentionItem({ ...resolved, response: { kind: 'permission' } })).toBeNull();
  });

  test('responses render as one honest line', () => {
    expect(describeAttentionResponse({ kind: 'permission', decision: 'reject' })).toBe('Rejected');
    expect(describeAttentionResponse({ kind: 'multiple-choice', choice: 'eu' })).toBe('Chose "eu"');
    expect(describeAttentionResponse({ kind: 'answer-review', verdict: 'good' })).toBe('Answer accepted');
    expect(describeAttentionResponse({ kind: 'open-question', answer: 'tonight' })).toBe('Answered: tonight');
  });
});
