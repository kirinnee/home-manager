import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalyticsAggregateResponse, AnalyticsMeasure } from '../../../src/analytics-types';
import {
  AnalyticsTimeSeries,
  analyticsLineSegments,
  analyticsTimeDomainSize,
  analyticsTimeSeriesData,
  latestAnalyticsTimePoints,
} from './AnalyticsTimeSeries';

const measure = (value: number | null, known = value === null ? 0 : 1, total = 1): AnalyticsMeasure => ({
  value,
  known,
  total,
});

function response(): AnalyticsAggregateResponse {
  return {
    kind: 'aggregate',
    aggregation: 'sum',
    query: 'sum by (day)',
    parsed: { aggregation: 'sum', groupBy: ['day'], matchers: [] },
    scope: { allSessions: true, indexed: 4, matched: 4 },
    index: {
      schemaVersion: 6,
      sessions: 4,
      tokenSessions: 3,
      transcriptSources: 0,
      indexedTranscriptSources: 0,
      pendingTranscriptSources: 1,
      sourceErrors: 0,
      refreshing: false,
    },
    results: [
      {
        labels: { day: '2026-07-03' },
        sessions: 1,
        rates: { stall: 0, failure: 0, completion: 100 },
        tokens: measure(300),
        inputTokens: measure(200),
        outputTokens: measure(100),
        cachedInputTokens: measure(0),
        cacheWriteInputTokens: measure(0),
        equivalentApiCostUsdMicros: measure(1_500_000),
        turns: measure(1),
        durationMs: measure(1),
        timeToFirstOutputMs: measure(1),
        contextEndPercent: measure(1),
      },
      {
        labels: { day: '2026-07-01' },
        sessions: 2,
        rates: { stall: 0, failure: 0, completion: 100 },
        tokens: measure(100, 2, 2),
        inputTokens: measure(75, 2, 2),
        outputTokens: measure(25, 2, 2),
        cachedInputTokens: measure(0, 2, 2),
        cacheWriteInputTokens: measure(0, 2, 2),
        equivalentApiCostUsdMicros: measure(500_000, 2, 2),
        turns: measure(2, 2, 2),
        durationMs: measure(2, 2, 2),
        timeToFirstOutputMs: measure(2, 2, 2),
        contextEndPercent: measure(2, 2, 2),
      },
      {
        labels: { day: '2026-07-02' },
        sessions: 1,
        rates: { stall: 0, failure: 0, completion: 0 },
        tokens: measure(null),
        inputTokens: measure(null),
        outputTokens: measure(null),
        cachedInputTokens: measure(null),
        cacheWriteInputTokens: measure(null),
        equivalentApiCostUsdMicros: measure(null),
        turns: measure(1),
        durationMs: measure(null),
        timeToFirstOutputMs: measure(null),
        contextEndPercent: measure(null),
      },
      {
        labels: { day: null },
        sessions: 1,
        rates: { stall: 0, failure: 0, completion: 0 },
        tokens: measure(9),
        inputTokens: measure(9),
        outputTokens: measure(0),
        cachedInputTokens: measure(0),
        cacheWriteInputTokens: measure(0),
        equivalentApiCostUsdMicros: measure(null),
        turns: measure(1),
        durationMs: measure(null),
        timeToFirstOutputMs: measure(null),
        contextEndPercent: measure(null),
      },
    ],
  };
}

describe('analytics time series', () => {
  test('sorts dated groups, preserves unknown measures, and counts undated rows', () => {
    expect(analyticsTimeSeriesData(response())).toEqual({
      dimension: 'day',
      omittedUntimed: 1,
      points: [
        { bucket: '2026-07-01', sessions: 2, tokens: 100, equivalentApiCostUsdMicros: 500_000 },
        { bucket: '2026-07-02', sessions: 1, tokens: null, equivalentApiCostUsdMicros: null },
        { bucket: '2026-07-03', sessions: 1, tokens: 300, equivalentApiCostUsdMicros: 1_500_000 },
      ],
    });
  });

  test('breaks lines at unknowns instead of interpolating through them', () => {
    const segments = analyticsLineSegments([1, 2, null, 4, null, 2, 3], 100, 50);
    expect(segments.map(segment => segment.length)).toEqual([2, 1, 2]);
  });

  test('bounds phone charts to the newest points while leaving the table unbounded', () => {
    const points = Array.from({ length: 40 }, (_, index) => ({
      bucket: String(index).padStart(2, '0'),
      sessions: index,
      tokens: index,
      equivalentApiCostUsdMicros: index,
    }));
    expect(latestAnalyticsTimePoints(points)).toHaveLength(30);
    expect(latestAnalyticsTimePoints(points)[0]?.bucket).toBe('10');
  });

  test('materializes absent calendar days as unknown gaps before applying the phone window', () => {
    const sparse = response();
    sparse.results = sparse.results.filter(
      result => result.labels.day === '2026-07-01' || result.labels.day === '2026-07-03',
    );
    const series = analyticsTimeSeriesData(sparse);
    if (!series) throw new Error('expected a daily series');

    const points = latestAnalyticsTimePoints(series.points, 30, series.dimension);
    expect(analyticsTimeDomainSize(series.points, series.dimension)).toBe(3);
    expect(points).toEqual([
      { bucket: '2026-07-01', sessions: 2, tokens: 100, equivalentApiCostUsdMicros: 500_000 },
      { bucket: '2026-07-02', sessions: null, tokens: null, equivalentApiCostUsdMicros: null },
      { bucket: '2026-07-03', sessions: 1, tokens: 300, equivalentApiCostUsdMicros: 1_500_000 },
    ]);
    expect(
      analyticsLineSegments(
        points.map(point => point.tokens),
        100,
        50,
      ).map(segment => segment.length),
    ).toEqual([1, 1]);
    // Each of the three charts reports the gap in both its accessible SVG
    // description and its visible footer.
    expect(renderToStaticMarkup(<AnalyticsTimeSeries response={sparse} />).match(/1 unknown bucket/g)).toHaveLength(6);
  });

  test('renders three self-contained charts and never paints unknown cost as zero', () => {
    const html = renderToStaticMarkup(<AnalyticsTimeSeries response={response()} />);
    expect(html.match(/<svg/g)).toHaveLength(3);
    expect(html).toContain('Sessions / day');
    expect(html).toContain('Tokens / day');
    expect(html).toContain('Equivalent API cost / day');
    expect(html).toContain('1 unknown bucket');
    expect(html).toContain('no time position was invented');
    expect(html).not.toContain('$0.00');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('<script');
  });

  test('declines to chart a non-temporal or multi-dimensional aggregate', () => {
    const other = response();
    other.parsed.groupBy = ['day', 'model'];
    expect(analyticsTimeSeriesData(other)).toBeNull();
    expect(renderToStaticMarkup(<AnalyticsTimeSeries response={other} />)).toContain('sum by (day)');
  });
});
