import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GLOBAL_ANALYTICS_DEFAULT_QUERY, GLOBAL_ANALYTICS_STARTERS, GlobalAnalyticsPage } from './GlobalAnalyticsPage';

describe('GlobalAnalyticsPage', () => {
  test('starts with the daily sum that drives sessions, tokens, and equivalent API cost', () => {
    expect(GLOBAL_ANALYTICS_DEFAULT_QUERY).toBe('sum by (day)');
    expect(GLOBAL_ANALYTICS_STARTERS[0]?.query).toBe(GLOBAL_ANALYTICS_DEFAULT_QUERY);
    expect(GLOBAL_ANALYTICS_STARTERS[0]?.hint).toContain('equivalent API cost');
  });

  test('is a separate fleet query destination with phone-safe layout primitives', () => {
    const html = renderToStaticMarkup(<GlobalAnalyticsPage />);
    expect(html).toContain('Global analytics');
    expect(html).toContain('Query the fleet');
    expect(html).toContain('sum by (day)');
    expect(html).toContain('Reading the fleet ledger');
    expect(html).toContain('min-w-0');
    expect(html).toContain('overflow-x-auto');
    expect(html).not.toContain('This session');
    expect(html).not.toContain('cdn');
  });

  test('keeps all useful global starters visible as real editable queries', () => {
    expect(GLOBAL_ANALYTICS_STARTERS.map(starter => starter.query)).toEqual([
      'sum by (day)',
      'sum by (week)',
      'sum by (model)',
      'avg by (model)',
      'max by (model)',
      'count by (status)',
    ]);
  });
});
