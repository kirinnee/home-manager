import { expect, test } from 'bun:test';
import { renderAnalytics } from './analytics-cli';
import type { AnalyticsAggregateResponse } from './analytics-types';

test('analytics CLI renders rates and makes incomplete measures conspicuous', () => {
  const response: AnalyticsAggregateResponse = {
    kind: 'aggregate',
    query: 'avg by (model)',
    aggregation: 'avg',
    parsed: { aggregation: 'avg', groupBy: ['model'], matchers: [] },
    scope: { allSessions: true, indexed: 3, matched: 3 },
    index: {
      schemaVersion: 1,
      sessions: 3,
      tokenSessions: 2,
      transcriptSources: 3,
      indexedTranscriptSources: 2,
      pendingTranscriptSources: 1,
      sourceErrors: 0,
      refreshing: true,
    },
    results: [
      {
        labels: { model: 'gpt-5.6-sol' },
        sessions: 3,
        rates: { stall: 10, failure: 20, completion: 70 },
        tokens: { value: null, known: 2, total: 3 },
        inputTokens: { value: null, known: 2, total: 3 },
        outputTokens: { value: null, known: 2, total: 3 },
        cachedInputTokens: { value: null, known: 2, total: 3 },
        cacheWriteInputTokens: { value: null, known: 2, total: 3 },
        turns: { value: 2, known: 3, total: 3 },
        durationMs: { value: 65_000, known: 3, total: 3 },
        timeToFirstOutputMs: { value: null, known: 0, total: 3 },
        contextEndPercent: { value: 42, known: 3, total: 3 },
      },
    ],
  };
  const rendered = renderAnalytics(response);
  expect(rendered).toContain('All sessions: 3 indexed, 3 matched');
  expect(rendered).toContain('model=gpt-5.6-sol');
  expect(rendered).toContain('—[2/3]');
  expect(rendered).toContain('10.0%');
  expect(rendered).toContain('Token backfill is running');
  expect(rendered).toContain('does not substitute zero or a partial value');
});
