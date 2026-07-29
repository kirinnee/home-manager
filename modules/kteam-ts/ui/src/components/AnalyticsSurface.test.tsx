import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalyticsAggregateResponse, AnalyticsRawResponse } from '../../../src/analytics-types';
import { ApiError } from '../lib/api';
import {
  AnalyticsResponseView,
  AnalyticsSurface,
  analyticsErrorMessage,
  analyticsIdQuery,
  sessionAnalyticsDefaultQuery,
  sessionAnalyticsStarterQueries,
} from './AnalyticsSurface';

const index = {
  schemaVersion: 6,
  sessions: 1,
  tokenSessions: 1,
  transcriptSources: 1,
  indexedTranscriptSources: 1,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
};

describe('session analytics query surface', () => {
  test('the default visibly teaches aggregate, grouping, and exact session scope', () => {
    expect(analyticsIdQuery('session"a\\b')).toBe('{id="session\\"a\\\\b"}');
    expect(analyticsIdQuery('session-*')).toBe('{id=="session-*"}');
    expect(sessionAnalyticsDefaultQuery('ms59')).toBe('sum by (model) {id="ms59"}');
    expect(sessionAnalyticsStarterQueries('ms59').map(starter => starter.label)).toEqual([
      'sum',
      'avg',
      'min',
      'max',
      'count',
    ]);
    expect(sessionAnalyticsStarterQueries('ms59')[0]?.hint).toContain('equivalent API cost');
  });

  test('renders one query-driven section, with no independent summary/tree/comparison panels', () => {
    const html = renderToStaticMarkup(<AnalyticsSurface sessionId="ms59" />);
    expect(html).toContain('Query this session');
    expect(html).toContain('sum by (model)');
    expect(html.match(/<section/g)).toHaveLength(1);
    expect(html).not.toContain('Resolved parent tree');
    expect(html).not.toContain('Comparable completed sessions');
    expect(html).not.toContain('Token ledger');
    expect(html).not.toContain('Explore fleet');
  });

  test('aggregate output labels equivalent API cost and preserves unknown coverage', () => {
    const response = {
      kind: 'aggregate',
      aggregation: 'sum',
      query: 'sum by (model) {id=ms59}',
      parsed: { aggregation: 'sum', groupBy: ['model'], matchers: [] },
      scope: { allSessions: true, indexed: 1, matched: 1 },
      index,
      results: [
        {
          labels: { model: 'unpriced-model' },
          sessions: 1,
          rates: { stall: 0, failure: 0, completion: 0 },
          tokens: { value: 12, known: 1, total: 1 },
          inputTokens: { value: 10, known: 1, total: 1 },
          outputTokens: { value: 2, known: 1, total: 1 },
          cachedInputTokens: { value: 0, known: 1, total: 1 },
          cacheWriteInputTokens: { value: 0, known: 1, total: 1 },
          equivalentApiCostUsdMicros: { value: null, known: 0, total: 1 },
          turns: { value: 1, known: 1, total: 1 },
          durationMs: { value: null, known: 0, total: 1 },
          timeToFirstOutputMs: { value: null, known: 0, total: 1 },
          contextEndPercent: { value: null, known: 0, total: 1 },
        },
      ],
    } as AnalyticsAggregateResponse;
    const html = renderToStaticMarkup(<AnalyticsResponseView response={response} />);
    expect(html).toContain('Equivalent API cost');
    expect(html).toContain('Cost unknown');
    expect(html).toContain('12');
    expect(html).not.toContain('$0.00');
  });

  test('raw output calls absent pricing unknown rather than zero', () => {
    const response = {
      kind: 'raw',
      query: '{id=ms59}',
      parsed: { groupBy: [], matchers: [] },
      scope: { allSessions: true, indexed: 1, matched: 1 },
      index,
      limit: 200,
      truncated: false,
      results: [{ id: 'ms59', status: 'running', tokens: 12, equivalentApiCostUsdMicros: null }],
    } as unknown as AnalyticsRawResponse;
    const html = renderToStaticMarkup(<AnalyticsResponseView response={response} />);
    expect(html).toContain('Cost unknown');
    expect(html).not.toContain('$0.00');
  });

  test('explains a transient unavailable index', () => {
    expect(analyticsErrorMessage(new ApiError(503, 'backfill'))).toContain('503');
  });
});
