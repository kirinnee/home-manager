import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalyticsRawResponse } from '../../../src/analytics-types';
import { ApiError } from '../lib/api';
import { buildLineage } from '../lib/lineage';
import { peerMedianCost } from '../lib/lineage-costs';
import type { ModelCost } from '../lib/model-cost';
import type { SessionView } from '../types';
import {
  AnalyticsSurface,
  analyticsErrorMessage,
  analyticsIdQuery,
  analyticsRows,
  analyticsStarterQueries,
  analyticsTreeQuery,
  boundedTreeQueries,
  bucketCoverage,
  formatUsdMicros,
  ownCostCopy,
  resolveLineageRoot,
  type CostedRow,
} from './AnalyticsSurface';

function session(id: string, parent?: string): SessionView {
  return { config: { id, parent }, state: {}, directory: '/repo' } as unknown as SessionView;
}

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

  test('resolves the tree anchor through buildLineage rather than re-walking parents', () => {
    const lineage = buildLineage([
      session('root'),
      session('mid', 'root'),
      session('leaf', 'mid'),
      // buildLineage already drops self-parents, dangling parents and cycles;
      // this surface must inherit that judgement, not repeat it.
      session('self', 'self'),
      session('orphan', 'missing'),
      session('cycle-a', 'cycle-b'),
      session('cycle-b', 'cycle-a'),
    ]);
    expect(resolveLineageRoot('leaf', lineage)).toBe('root');
    expect(resolveLineageRoot('root', lineage)).toBe('root');
    expect(resolveLineageRoot('self', lineage)).toBe('self');
    expect(resolveLineageRoot('orphan', lineage)).toBe('orphan');
    expect(resolveLineageRoot('cycle-a', lineage)).toBe('cycle-a');
    expect(resolveLineageRoot('unindexed', lineage)).toBe('unindexed');
  });

  test('starter queries teach the grammar and anchor the tree at the resolved root', () => {
    expect(analyticsTreeQuery('ms1"a')).toBe('{tree="ms1\\"a"}');
    const starters = analyticsStarterQueries('root-1');
    expect(starters.map(starter => starter.query)).toEqual([
      'sum by (id) {tree="root-1"}',
      'sum {tree="root-1"}',
      'sum by (wrapper)',
      'sum by (model)',
      'avg by (model)',
      'count by (status)',
    ]);
    // Without a resolved lineage the tree starters are absent rather than
    // pointed at the focused session and quietly mislabelled "whole tree".
    expect(analyticsStarterQueries(null).map(starter => starter.id)).toEqual([
      'by-wrapper',
      'by-model',
      'avg-model',
      'count-status',
    ]);
  });

  test('keeps the pre-load surface useful and explains a 503', () => {
    expect(renderToStaticMarkup(<AnalyticsSurface sessionId="missing" />)).toContain('Loading session analytics');
    expect(analyticsErrorMessage(new ApiError(503, 'backfill'))).toContain('503');
  });
});
