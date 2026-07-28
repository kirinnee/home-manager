import { describe, expect, test } from 'bun:test';
import {
  PRICING_REGISTRY,
  PRICING_REGISTRY_VERIFIED_AT,
  estimateEquivalentApiCost,
  estimateModelCost,
  resolvePricingEntry,
  type PricingEntry,
} from './model-cost';

const base = {
  migrated: true,
  pricingModel: 'gpt-5.6-sol',
  createdAt: '2026-07-28T00:00:00.000Z',
  inputTokens: 1_000_000,
  cachedInputTokens: 200_000,
  cacheWriteInputTokens: 100_000,
  outputTokens: 1_000_000,
};

describe('estimateEquivalentApiCost', () => {
  test('shares exact OpenAI token math while ignoring billing attribution', () => {
    expect(estimateModelCost('subscription', base)).toEqual({
      kind: 'unknown',
      reason: 'subscription_billing',
    });
    // 0.7M fresh × $5 + 0.2M cache read × $0.5 + 0.1M cache write × $6.25
    // + 1M output × $30 = $34.225.
    expect(estimateEquivalentApiCost(base)).toMatchObject({
      kind: 'known',
      usdMicros: 34_225_000n,
      pricingKey: 'openai:gpt-5.6-sol@2026-07-28',
    });
  });

  test('keeps model, validity, and token failures honest', () => {
    expect(estimateEquivalentApiCost({ ...base, pricingModel: null })).toEqual({
      kind: 'unknown',
      reason: 'missing_pricing_model',
    });
    expect(estimateEquivalentApiCost({ ...base, pricingModel: 'unpriced-model' })).toEqual({
      kind: 'unknown',
      reason: 'unknown_pricing_model',
    });
    expect(estimateEquivalentApiCost({ ...base, createdAt: '2026-07-27T23:59:59.999Z' })).toMatchObject({
      kind: 'unknown',
      reason: 'pricing_outside_validity_window',
    });
    expect(estimateEquivalentApiCost({ ...base, outputTokens: null })).toMatchObject({
      kind: 'unknown',
      reason: 'incomplete_token_counts',
    });
    expect(estimateEquivalentApiCost({ ...base, inputTokens: 1 })).toMatchObject({
      kind: 'unknown',
      reason: 'negative_uncached_input',
    });
  });

  test('requires an exact Anthropic TTL cache-write split', () => {
    const anthropic = {
      ...base,
      pricingModel: 'claude-fable-5',
      cacheWrite5mInputTokens: 40_000,
      cacheWrite1hInputTokens: 60_000,
    };
    expect(estimateEquivalentApiCost(anthropic)).toMatchObject({ kind: 'known', usdMicros: 58_900_000n });
    expect(estimateEquivalentApiCost({ ...anthropic, cacheWrite1hInputTokens: undefined })).toMatchObject({
      kind: 'unknown',
      reason: 'missing_anthropic_cache_write_split',
    });
    expect(estimateEquivalentApiCost({ ...anthropic, cacheWrite1hInputTokens: 10_000 })).toMatchObject({
      kind: 'unknown',
      reason: 'inconsistent_anthropic_cache_write_split',
    });
  });

  test('exposes the registry verification date for comparison copy', () => {
    expect(PRICING_REGISTRY_VERIFIED_AT).toBe('2026-07-28');
  });

  test('selects the newest validity-matching rate version like SQL', () => {
    const template = PRICING_REGISTRY[0]!;
    const registry: readonly PricingEntry[] = [
      {
        ...template,
        aliases: ['versioned-model'],
        pricingKey: 'versioned-model@old',
        validCreatedAt: {
          from: '2026-01-01T00:00:00.000Z',
          through: '2026-12-31T23:59:59.999Z',
        },
      },
      {
        ...template,
        aliases: ['versioned-model'],
        pricingKey: 'versioned-model@new',
        validCreatedAt: { from: '2026-07-01T00:00:00.000Z' },
      },
    ];

    expect(resolvePricingEntry('versioned-model', '2026-03-01T00:00:00.000Z', registry)).toMatchObject({
      kind: 'known',
      entry: { pricingKey: 'versioned-model@old' },
    });
    // Both windows match; greatest valid_from must win, regardless of array order.
    expect(resolvePricingEntry('versioned-model', '2026-08-01T00:00:00.000Z', registry)).toMatchObject({
      kind: 'known',
      entry: { pricingKey: 'versioned-model@new' },
    });
    expect(resolvePricingEntry('versioned-model', '2025-12-31T23:59:59.999Z', registry)).toMatchObject({
      kind: 'outside_validity_window',
    });
    expect(resolvePricingEntry('missing-model', '2026-08-01T00:00:00.000Z', registry)).toEqual({
      kind: 'unknown_model',
    });
  });
});
