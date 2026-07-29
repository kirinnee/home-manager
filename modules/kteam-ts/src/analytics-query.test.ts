import { describe, expect, test } from 'bun:test';
import {
  AnalyticsQueryError,
  DEFAULT_ANALYTICS_QUERY,
  DEFAULT_SESSION_ANALYTICS_QUERY,
  matcherLikePattern,
  parseAnalyticsQuery,
  scopeAnalyticsQuery,
} from './analytics-query';

describe('analytics query language', () => {
  test('defaults to a daily fleet aggregate that includes token and cost measures', () => {
    const parsed = parseAnalyticsQuery();
    expect(parsed.source).toBe(DEFAULT_ANALYTICS_QUERY);
    expect(parsed.aggregation).toBe('sum');
    expect(parsed.groupBy).toEqual(['day']);
    expect(parsed.matchers).toEqual([]);
  });

  test('forces the session scope into the canonical query and replaces a caller-supplied id', () => {
    expect(scopeAnalyticsQuery(undefined, 'ms59')).toBe(`${DEFAULT_SESSION_ANALYTICS_QUERY} {id=ms59}`);
    expect(scopeAnalyticsQuery('avg by (model) {status=completed, id=some-other-session}', 'session/odd ?')).toBe(
      'avg by (model) {status=completed, id=="session/odd ?"}',
    );
    expect(parseAnalyticsQuery(scopeAnalyticsQuery('{id=~fleet-*}', 'one')).matchers).toContainEqual({
      label: 'id',
      op: '=',
      value: 'one',
      wildcard: false,
    });

    for (const id of ['session-*', 'session/odd ?']) {
      const scoped = parseAnalyticsQuery(scopeAnalyticsQuery('{}', id));
      expect(scoped.matchers).toEqual([{ label: 'id', op: '=', value: id, wildcard: false }]);
      expect(scoped.canonical).toBe(scopeAnalyticsQuery('{}', id));
    }
  });

  test('refuses an empty session scope', () => {
    expect(() => scopeAnalyticsQuery('sum', '   ')).toThrow('exact session id');
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

  test('parses exact tree grouping and root-included subtree selection', () => {
    expect(parseAnalyticsQuery('sum by (tree) {tree=ms1}')).toMatchObject({
      canonical: 'sum by (tree) {tree=ms1}',
      aggregation: 'sum',
      groupBy: ['tree'],
      matchers: [{ label: 'tree', op: '=', value: 'ms1', wildcard: false }],
    });
  });

  test('rejects glob and regex tree anchors clearly', () => {
    expect(() => parseAnalyticsQuery('{tree=ms1*}')).toThrow('tree filters take one exact session id');
    expect(() => parseAnalyticsQuery('{tree=~ms1}')).toThrow('tree filters take one exact session id');
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
