import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalyticsRawResponse } from '../../../src/analytics-types';
import { ApiError } from '../lib/api';
import { peerMedianCost } from '../lib/lineage-costs';
import type { ModelCost } from '../lib/model-cost';
import {
  AnalyticsSurface,
  analyticsErrorMessage,
  analyticsIdQuery,
  analyticsRows,
  boundedTreeQueries,
  bucketCoverage,
  formatUsdMicros,
  ownCostCopy,
  type CostedRow,
} from './AnalyticsSurface';

const known: ModelCost = {
  kind: 'known',
  usdMicros: 1_250_000n,
  pricingKey: 'openai:test',
  pricingModel: 'gpt-5.6-terra',
};
const apiRow = { billing: 'api_metered', billingEvidence: { billing: 'api_metered' }, cost: known } as CostedRow;

describe('analytics ledger facts', () => {
  test('shows API dollars, subscriptions, and unknown billing without inventing a zero', () => {
    expect(ownCostCopy(apiRow, { billing: 'api_metered' })).toBe('$1.25');
    expect(ownCostCopy(undefined, { billing: 'subscription' })).toBe('Not billed per token');
    expect(
      ownCostCopy(
        { ...apiRow, billing: 'unknown', billingEvidence: { billing: 'unknown', reason: 'stale_usage_feed' } },
        { billing: 'unknown', reason: 'stale_usage_feed' },
      ),
    ).toContain('Billing is unknown');
  });

  test('labels mixed tree coverage and never calls skipped rows zero', () => {
    expect(
      bucketCoverage(
        {
          knownApiUsdMicros: 3n,
          knownApiSessions: 1,
          unknownApiSessions: 1,
          subscriptionSessions: 2,
          unknownBillingSessions: 1,
        },
        5,
        8,
      ),
    ).toBe('1 API rows priced · 1 API costs unknown · 2 subscriptions · 1 billing-unknown · 3 unqueried');
  });

  test('uses safely escaped exact-id raw queries and preserves raw rows', () => {
    expect(analyticsIdQuery('session"a\\b')).toBe('{id="session\\"a\\\\b"}');
    const response = { kind: 'raw', results: [{ id: 'a' }] } as unknown as AnalyticsRawResponse;
    expect(analyticsRows(response).map(row => row.id)).toEqual(['a']);
  });

  test('formats bigint money without losing high-value micro precision', () => {
    expect(formatUsdMicros(9_007_199_254_740_993n)).toBe('$9,007,199,254.740993');
  });

  test('reserves bounded-query evidence for a deep selected session', () => {
    const ids = ['root', ...Array.from({ length: 40 }, (_, index) => `child-${index}`)];
    const selected = boundedTreeQueries(ids, 'child-39');
    expect(selected).toContain('root');
    expect(selected).toContain('child-39');
    expect(selected).toHaveLength(32);
  });

  test('requires five exact compatible peers before exposing a typical cost', () => {
    const target = {
      id: 'selected',
      completed: true,
      billing: 'api_metered' as const,
      cost: known,
      wrapper: 'codex',
      harness: 'codex',
    };
    const peers = (count: number) => Array.from({ length: count }, (_, index) => ({ ...target, id: `peer-${index}` }));
    expect(peerMedianCost(target, peers(4))).toBeUndefined();
    expect(peerMedianCost(target, peers(5))?.sampleSize).toBe(5);
  });

  test('keeps the pre-load surface useful and explains a 503', () => {
    expect(renderToStaticMarkup(<AnalyticsSurface sessionId="missing" />)).toContain('Loading session analytics');
    expect(analyticsErrorMessage(new ApiError(503, 'backfill'))).toContain('503');
  });
});
