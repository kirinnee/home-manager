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
    expect(PRICING_REGISTRY_VERIFIED_AT).toBe('2026-09-24');
  });

  test('prices the September 2026 Anthropic lineup from its own dated rate identity', () => {
    // Opus 5.5: 0.7M fresh × $4 + 0.2M cache read × $0.20 + 40k 5m-write × $5
    // + 60k 1h-write × $8 + 1M output × $20 = $23.52.
    expect(
      estimateEquivalentApiCost({
        ...base,
        pricingModel: 'claude-opus-5-5',
        createdAt: '2026-09-22T00:00:00.000Z',
        cacheWrite5mInputTokens: 40_000,
        cacheWrite1hInputTokens: 60_000,
      }),
    ).toMatchObject({
      kind: 'known',
      usdMicros: 23_520_000n,
      pricingKey: 'anthropic:claude-opus-5-5@2026-09-24',
    });

    // Fable 5.1: 0.7M × $10 + 0.2M × $0.25 + 40k × $12.5 + 60k × $20
    // + 1M output × $50 = $58.75.
    expect(
      estimateEquivalentApiCost({
        ...base,
        pricingModel: 'claude-fable-5-1',
        createdAt: '2026-08-29T00:00:00.000Z',
        cacheWrite5mInputTokens: 40_000,
        cacheWrite1hInputTokens: 60_000,
      }),
    ).toMatchObject({
      kind: 'known',
      usdMicros: 58_750_000n,
      pricingKey: 'anthropic:claude-fable-5-1@2026-09-24',
    });
  });

  test('the new lineup only prices sessions created on or after its release date', () => {
    expect(resolvePricingEntry('claude-opus-5-5', '2026-09-20T23:59:59.999Z')).toEqual({
      kind: 'outside_validity_window',
      pricingKey: 'anthropic:claude-opus-5-5@2026-09-24',
    });
    expect(resolvePricingEntry('claude-opus-5-5', '2026-09-21T00:00:00.000Z')).toMatchObject({
      kind: 'known',
      entry: { pricingKey: 'anthropic:claude-opus-5-5@2026-09-24' },
    });
    expect(resolvePricingEntry('claude-fable-5-1', '2026-08-27T23:59:59.999Z')).toEqual({
      kind: 'outside_validity_window',
      pricingKey: 'anthropic:claude-fable-5-1@2026-09-24',
    });
    expect(resolvePricingEntry('claude-fable-5-1', '2026-08-28T00:00:00.000Z')).toMatchObject({
      kind: 'known',
      entry: { pricingKey: 'anthropic:claude-fable-5-1@2026-09-24' },
    });
  });

  test('appending the new lineup left the retired models on their historical rates', () => {
    // Never mutate history: an old session keeps the price it was billed at.
    expect(resolvePricingEntry('claude-opus-5', '2026-09-22T00:00:00.000Z')).toMatchObject({
      kind: 'known',
      entry: { pricingKey: 'anthropic:claude-opus-5@2026-07-28' },
    });
    expect(resolvePricingEntry('claude-fable-5', '2026-09-22T00:00:00.000Z')).toMatchObject({
      kind: 'known',
      entry: { pricingKey: 'anthropic:claude-fable-5@2026-07-28' },
    });
    // The 5.5/5.1 ids are their own aliases — nothing inherits the old rates.
    const keys = PRICING_REGISTRY.map(entry => entry.pricingKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(PRICING_REGISTRY.filter(entry => entry.aliases.includes('claude-opus-5-5'))).toHaveLength(1);
    expect(PRICING_REGISTRY.filter(entry => entry.aliases.includes('claude-fable-5-1'))).toHaveLength(1);
  });

  test('prices the GPT-6 generation and the GPT-5.6 re-price from their own dated rows', () => {
    // Same token shape as `base`: 0.7M fresh + 0.2M cache read + 0.1M cache
    // write (1.25x input) + 1M output.
    const cases: Array<[string, string, bigint, string]> = [
      // 0.7 × $10 + 0.2 × $1 + 0.1 × $12.5 + 1 × $50 = $58.45
      ['gpt-6-astra', '2026-09-04T00:00:00.000Z', 58_450_000n, 'openai:gpt-6-astra@2026-09-24'],
      // 0.7 × $2 + 0.2 × $0.20 + 0.1 × $2.5 + 1 × $10 = $11.69
      ['gpt-6-sol', '2026-09-22T00:00:00.000Z', 11_690_000n, 'openai:gpt-6-sol@2026-09-24'],
      // 0.7 × $0.10 + 0.2 × $0.01 + 0.1 × $0.125 + 1 × $0.50 = $0.5845
      ['gpt-6-luna', '2026-09-22T00:00:00.000Z', 584_500n, 'openai:gpt-6-luna@2026-09-24'],
      // 0.7 × $4 + 0.2 × $0.40 + 0.1 × $5 + 1 × $20 = $23.38
      ['gpt-5.6-sol', '2026-09-24T00:00:00.000Z', 23_380_000n, 'openai:gpt-5.6-sol@2026-09-24'],
      // 0.7 × $2 + 0.2 × $0.20 + 0.1 × $2.5 + 1 × $12 = $13.69
      ['gpt-5.6-terra', '2026-09-24T00:00:00.000Z', 13_690_000n, 'openai:gpt-5.6-terra@2026-09-24'],
      // 0.7 × $0.20 + 0.2 × $0.02 + 0.1 × $0.25 + 1 × $1.20 = $1.369
      ['gpt-5.6-luna', '2026-09-24T00:00:00.000Z', 1_369_000n, 'openai:gpt-5.6-luna@2026-09-24'],
    ];
    for (const [pricingModel, createdAt, usdMicros, pricingKey] of cases) {
      expect(estimateEquivalentApiCost({ ...base, pricingModel, createdAt })).toMatchObject({
        kind: 'known',
        usdMicros,
        pricingKey,
      });
    }
  });

  test('GPT-6 rows start at release; the GPT-5.6 re-price never rewrites older sessions', () => {
    expect(resolvePricingEntry('gpt-6-astra', '2026-09-03T23:59:59.999Z')).toEqual({
      kind: 'outside_validity_window',
      pricingKey: 'openai:gpt-6-astra@2026-09-24',
    });
    for (const id of ['gpt-6-sol', 'gpt-6-luna']) {
      expect(resolvePricingEntry(id, '2026-09-21T23:59:59.999Z')).toEqual({
        kind: 'outside_validity_window',
        pricingKey: `openai:${id}@2026-09-24`,
      });
    }
    for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(resolvePricingEntry(id, '2026-09-23T23:59:59.999Z')).toMatchObject({
        kind: 'known',
        entry: { pricingKey: `openai:${id}@2026-07-28` },
      });
      expect(resolvePricingEntry(id, '2026-09-24T00:00:00.000Z')).toMatchObject({
        kind: 'known',
        entry: { pricingKey: `openai:${id}@2026-09-24` },
      });
    }
    // OpenAI rows keep the registry convention: cache write = 1.25x input.
    for (const entry of PRICING_REGISTRY.filter(item => item.provider === 'openai')) {
      const rates = entry.ratesUsdMicrosPerMillion;
      expect(rates.cacheWrite! * 4n).toBe(rates.input * 5n);
    }
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
