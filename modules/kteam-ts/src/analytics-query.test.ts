import { describe, expect, test } from 'bun:test';
import {
  AnalyticsQueryError,
  DEFAULT_ANALYTICS_QUERY,
  matcherLikePattern,
  parseAnalyticsQuery,
} from './analytics-query';

describe('analytics query language', () => {
  test('defaults to an all-session status count', () => {
    const parsed = parseAnalyticsQuery();
    expect(parsed.source).toBe(DEFAULT_ANALYTICS_QUERY);
    expect(parsed.aggregation).toBe('count');
    expect(parsed.groupBy).toEqual(['status']);
    expect(parsed.matchers).toEqual([]);
  });

  test('matches kloop aggregation, grouping, and matcher syntax', () => {
    const parsed = parseAnalyticsQuery(`avg by (model, harness) {label="ui-r28-*", status=completed}`);
    expect(parsed.aggregation).toBe('avg');
    expect(parsed.groupBy).toEqual(['model', 'harness']);
    expect(parsed.matchers).toEqual([
      { label: 'label', op: '=', value: 'ui-r28-*', wildcard: true },
      { label: 'status', op: '=', value: 'completed', wildcard: false },
    ]);
    expect(parsed.canonical).toBe('avg by (model, harness) {label=ui-r28-*, status=completed}');
  });

  test('supports bounded raw filtering and quoted commas', () => {
    const parsed = parseAnalyticsQuery(`{id=session-1, cwd='/tmp/a,b', wrapper=~claude-auto-*, label=don't-ship}`);
    expect(parsed.aggregation).toBeUndefined();
    expect(parsed.groupBy).toEqual([]);
    expect(parsed.matchers.map(matcher => matcher.value)).toEqual([
      'session-1',
      '/tmp/a,b',
      'claude-auto-*',
      "don't-ship",
    ]);
    expect(parseAnalyticsQuery(`{cwd="/tmp/o'brien,a"}`).matchers[0]?.value).toBe("/tmp/o'brien,a");
  });

  test('turns glob syntax into a safe SQL LIKE pattern', () => {
    expect(matcherLikePattern('a%_*?')).toBe('a\\%\\_%_');
  });

  test('rejects unknown labels and malformed suffixes instead of ignoring them', () => {
    expect(() => parseAnalyticsQuery('sum by (planet)')).toThrow(AnalyticsQueryError);
    expect(() => parseAnalyticsQuery('avg by model')).toThrow('grouping must look like');
    expect(() => parseAnalyticsQuery('sum by (model) trailing')).toThrow('unexpected analytics query suffix');
    expect(() => parseAnalyticsQuery('by (model)')).toThrow('requires an aggregation');
  });
});
