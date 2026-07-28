import { describe, expect, test } from 'bun:test';
import { billingFromUsageFeed, estimateModelCost } from './model-cost';

const base = {
  migrated: false,
  pricingModel: 'gpt-5.6-sol',
  createdAt: '2026-07-28T00:00:00.000Z',
  inputTokens: 1_000_000,
  cachedInputTokens: 200_000,
  cacheWriteInputTokens: 100_000,
  outputTokens: 1_000_000,
};

describe('billingFromUsageFeed', () => {
  test('uses only the exact current account usageBased boolean', () => {
    const now = Date.parse('2026-07-28T12:05:00.000Z');
    const fresh = { at: '2026-07-28T12:00:00.000Z', stale: false } as const;
    expect(
      billingFromUsageFeed({ ...fresh, accounts: [{ binary: 'codex', usageBased: false }] }, 'codex', now),
    ).toEqual({ billing: 'api_metered' });
    expect(billingFromUsageFeed({ ...fresh, accounts: [{ binary: 'zai', usageBased: true }] }, 'zai', now)).toEqual({
      billing: 'subscription',
    });
    expect(billingFromUsageFeed({ ...fresh, accounts: [{ binary: 'codex' }] }, 'codex', now)).toEqual({
      billing: 'unknown',
      reason: 'missing_usage_based',
    });
    expect(
      billingFromUsageFeed({ ...fresh, stale: true, accounts: [{ binary: 'codex', usageBased: false }] }, 'codex', now),
    ).toEqual({ billing: 'unknown', reason: 'stale_usage_feed' });
    expect(billingFromUsageFeed(undefined, 'codex', now)).toEqual({ billing: 'unknown', reason: 'missing_usage_feed' });
    expect(billingFromUsageFeed({ ...fresh, accounts: [] }, 'codex', now)).toEqual({
      billing: 'unknown',
      reason: 'missing_usage_account',
    });
    expect(billingFromUsageFeed({ stale: false, accounts: [] }, 'codex', now)).toEqual({
      billing: 'unknown',
      reason: 'missing_usage_observed_at',
    });
    expect(billingFromUsageFeed({ ...fresh, at: '2026-07-28T11:54:59.999Z', accounts: [] }, 'codex', now)).toEqual({
      billing: 'unknown',
      reason: 'stale_usage_observation',
    });
  });
});

describe('estimateModelCost', () => {
  test('subtracts cached reads and cache writes from gross input before pricing', () => {
    const cost = estimateModelCost('api_metered', base);
    // 0.7M uncached × $5 + 0.2M cached × $0.5 + 0.1M write × $6.25 + 1M output × $30 = $34.225
    expect(cost).toMatchObject({ kind: 'known', usdMicros: 34_225_000n, pricingKey: 'openai:gpt-5.6-sol@2026-07-28' });
  });

  test('never derives subscription dollars and reports complete-counter failures', () => {
    expect(estimateModelCost('subscription', base)).toEqual({ kind: 'unknown', reason: 'subscription_billing' });
    expect(estimateModelCost('api_metered', { ...base, migrated: true })).toEqual({
      kind: 'unknown',
      reason: 'billing_attribution_unavailable',
    });
    expect(estimateModelCost('api_metered', { ...base, migrated: undefined })).toEqual({
      kind: 'unknown',
      reason: 'billing_attribution_unavailable',
    });
    expect(estimateModelCost('api_metered', { ...base, inputTokens: 1 })).toMatchObject({
      kind: 'unknown',
      reason: 'negative_uncached_input',
    });
    expect(estimateModelCost('api_metered', { ...base, outputTokens: null })).toMatchObject({
      kind: 'unknown',
      reason: 'incomplete_token_counts',
    });
    expect(estimateModelCost('api_metered', { ...base, pricingModel: 'gpt-5.6-sol-preview' })).toEqual({
      kind: 'unknown',
      reason: 'unknown_pricing_model',
    });
    expect(estimateModelCost('api_metered', { ...base, createdAt: '2026-07-27T23:59:59.999Z' })).toMatchObject({
      kind: 'unknown',
      reason: 'pricing_outside_validity_window',
    });
    expect(estimateModelCost('api_metered', { ...base, createdAt: null })).toMatchObject({
      kind: 'unknown',
      reason: 'pricing_outside_validity_window',
    });
  });

  test("requires exact Anthropic TTL splits and honours Sonnet's bounded price window", () => {
    const anthropic = {
      ...base,
      pricingModel: 'claude-fable-5',
      cacheWrite5mInputTokens: 40_000,
      cacheWrite1hInputTokens: 60_000,
    };
    expect(estimateModelCost('api_metered', anthropic)).toMatchObject({ kind: 'known' });
    expect(estimateModelCost('api_metered', { ...anthropic, cacheWrite1hInputTokens: undefined })).toMatchObject({
      kind: 'unknown',
      reason: 'missing_anthropic_cache_write_split',
    });
    expect(estimateModelCost('api_metered', { ...anthropic, cacheWrite1hInputTokens: 10_000 })).toMatchObject({
      kind: 'unknown',
      reason: 'inconsistent_anthropic_cache_write_split',
    });
    expect(
      estimateModelCost('api_metered', {
        ...anthropic,
        pricingModel: 'claude-sonnet-5',
        createdAt: '2026-09-01T00:00:00.000Z',
      }),
    ).toMatchObject({ kind: 'unknown', reason: 'pricing_outside_validity_window' });
    expect(estimateModelCost('api_metered', { ...anthropic, pricingModel: 'claude-haiku-4-5-20251001' })).toMatchObject(
      { kind: 'known', pricingModel: 'claude-haiku-4-5-20251001' },
    );
  });
});
