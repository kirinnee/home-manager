import { expect, test } from 'bun:test';
import { renderAnalytics } from './analytics-cli';
import type {
  AnalyticsAggregateResponse,
  AnalyticsAggregateResult,
  AnalyticsMeasure,
  AnalyticsRawResponse,
} from './analytics-types';

function known(value: number): AnalyticsMeasure {
  return { value, known: 1, total: 1 };
}

function result(model: string, cost: AnalyticsMeasure, tokens: number): AnalyticsAggregateResult {
  return {
    labels: { model },
    sessions: 1,
    rates: { stall: 0, failure: 0, completion: 100 },
    tokens: known(tokens),
    inputTokens: known(tokens - 100),
    outputTokens: known(100),
    cachedInputTokens: known(250),
    cacheWriteInputTokens: known(50),
    equivalentApiCostUsdMicros: cost,
    turns: known(2),
    durationMs: known(1_000),
    timeToFirstOutputMs: known(100),
    contextEndPercent: known(10),
  };
}

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
        equivalentApiCostUsdMicros: { value: null, known: 2, total: 3 },
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

test('analytics CLI shows token breakdowns, sorts priced rows first, and retains unpriced models', () => {
  const response: AnalyticsAggregateResponse = {
    kind: 'aggregate',
    query: 'sum by (model)',
    aggregation: 'sum',
    parsed: { aggregation: 'sum', groupBy: ['model'], matchers: [] },
    scope: { allSessions: true, indexed: 2, matched: 2 },
    index: {
      schemaVersion: 6,
      sessions: 2,
      tokenSessions: 2,
      transcriptSources: 2,
      indexedTranscriptSources: 2,
      pendingTranscriptSources: 0,
      sourceErrors: 0,
      refreshing: false,
    },
    results: [
      result('unpriced-model', { value: null, known: 0, total: 1 }, 9_876),
      result('priced-model', known(2_500_000), 1_234),
    ],
  };

  const rendered = renderAnalytics(response);
  expect(rendered).toContain('INPUT');
  expect(rendered).toContain('OUTPUT');
  expect(rendered).toContain('CACHE READ');
  expect(rendered).toContain('CACHE WRITE');
  expect(rendered).toContain('TOTAL');
  expect(rendered).toContain('EQUIV API COST');
  expect(rendered.indexOf('priced-model')).toBeLessThan(rendered.indexOf('unpriced-model'));
  expect(rendered).toContain('9.9k');
  expect(rendered).toContain('—[0/1]');
  expect(rendered).toContain('comparison, not a bill');
  expect(rendered).toContain('Rates verified 2026-07-28');
});

test('analytics CLI labels an unpriced raw row unknown without hiding its tokens', () => {
  const response: AnalyticsRawResponse = {
    kind: 'raw',
    query: '{model=unpriced-model}',
    parsed: { groupBy: [], matchers: [] },
    scope: { allSessions: true, indexed: 1, matched: 1 },
    index: {
      schemaVersion: 6,
      sessions: 1,
      tokenSessions: 1,
      transcriptSources: 1,
      indexedTranscriptSources: 1,
      pendingTranscriptSources: 0,
      sourceErrors: 0,
      refreshing: false,
    },
    limit: 200,
    truncated: false,
    results: [
      {
        id: 'unpriced-session',
        wrapper: 'claude-auto-loge',
        model: 'unpriced-model',
        harness: 'claude',
        mode: 'auto',
        status: 'completed',
        label: 'cost-check',
        cwd: '/work/repo',
        parent: null,
        day: '2026-07-28',
        week: '2026-W31',
        createdAt: '2026-07-28T00:00:00.000Z',
        pricingModel: 'unpriced-model',
        equivalentApiCostUsdMicros: null,
        tokens: 9_876,
        inputTokens: 9_000,
        outputTokens: 876,
        cachedInputTokens: 2_000,
        cacheWriteInputTokens: 100,
        cacheWrite5mInputTokens: 100,
        cacheWrite1hInputTokens: 0,
        turns: 2,
        durationMs: 1_000,
        timeToFirstOutputMs: 100,
        contextEndPercent: 10,
        stalled: false,
        failed: false,
        migrated: false,
        completed: true,
      },
    ],
  };

  const rendered = renderAnalytics(response);
  expect(rendered).toContain('unpriced-model');
  expect(rendered).toContain('9.9k');
  expect(rendered).toContain('unknown');
});

test('analytics CLI keeps the concise count table', () => {
  const response: AnalyticsAggregateResponse = {
    kind: 'aggregate',
    query: 'count by (model)',
    aggregation: 'count',
    parsed: { aggregation: 'count', groupBy: ['model'], matchers: [] },
    scope: { allSessions: true, indexed: 1, matched: 1 },
    index: {
      schemaVersion: 6,
      sessions: 1,
      tokenSessions: 1,
      transcriptSources: 1,
      indexedTranscriptSources: 1,
      pendingTranscriptSources: 0,
      sourceErrors: 0,
      refreshing: false,
    },
    results: [result('priced-model', { value: null, known: 0, total: 0 }, 0)],
  };

  const header = renderAnalytics(response).split('\n')[3];
  expect(header).toContain('SESSIONS');
  expect(header).toContain('STALL');
  expect(header).not.toContain('INPUT');
  expect(header).not.toContain('EQUIV API COST');
});
