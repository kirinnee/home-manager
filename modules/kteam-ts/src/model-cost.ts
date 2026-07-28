// Transcript-evidenced API cost estimation. This dependency-free shared
// module intentionally owns the complete price registry: callers must never
// guess a model price.

export type BillingKind = 'api_metered' | 'subscription' | 'unknown';

export type BillingEvidence =
  | { billing: 'api_metered' }
  | { billing: 'subscription' }
  | {
      billing: 'unknown';
      reason:
        | 'missing_usage_feed'
        | 'stale_usage_feed'
        | 'missing_usage_observed_at'
        | 'stale_usage_observation'
        | 'missing_usage_account'
        | 'missing_usage_based';
    };

export interface UsageAccountForBilling {
  binary: string;
  usageBased?: boolean;
}

export interface UsageFeedForBilling {
  stale: boolean;
  at?: string;
  accounts: readonly UsageAccountForBilling[];
}

/** kteam refreshes kfleet every five minutes. A second interval of grace
 * avoids boundary flicker while ensuring an indefinitely retained last-good
 * quota snapshot can never be treated as current billing truth. */
export const BILLING_EVIDENCE_MAX_AGE_MS = 10 * 60 * 1000;

/** Classify only the current exact wrapper account. Provider/auth/quota data is
 * deliberately not accepted here because none of it proves billing mode. */
export function billingFromUsageFeed(
  feed: UsageFeedForBilling | null | undefined,
  wrapper: string | null | undefined,
  now = Date.now(),
): BillingEvidence {
  if (!feed) return { billing: 'unknown', reason: 'missing_usage_feed' };
  if (feed.stale) return { billing: 'unknown', reason: 'stale_usage_feed' };
  if (!feed.at) return { billing: 'unknown', reason: 'missing_usage_observed_at' };
  const observedAt = Date.parse(feed.at);
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > BILLING_EVIDENCE_MAX_AGE_MS) {
    return { billing: 'unknown', reason: 'stale_usage_observation' };
  }
  const account = wrapper ? feed.accounts.find(candidate => candidate.binary === wrapper) : undefined;
  if (!account) return { billing: 'unknown', reason: 'missing_usage_account' };
  if (account.usageBased === false) return { billing: 'api_metered' };
  if (account.usageBased === true) return { billing: 'subscription' };
  return { billing: 'unknown', reason: 'missing_usage_based' };
}

export interface PricingTokenFields {
  /** Schema-v6 durable event evidence. Only explicit false is safe for billed
   * cost attribution; equivalent API pricing deliberately ignores it. */
  migrated?: boolean | null;
  /** Transcript-derived exact model name; never substitute a mutable display model. */
  pricingModel: string | null | undefined;
  /** Session creation time, used by prices with a bounded validity window. */
  createdAt: string | null | undefined;
  /** Gross input, including cached reads and cache writes. */
  inputTokens: number | null | undefined;
  cachedInputTokens: number | null | undefined;
  /** Total cache writes (OpenAI) and the sum of Anthropic TTL writes. */
  cacheWriteInputTokens: number | null | undefined;
  /** Required for Anthropic when total cache writes is nonzero. */
  cacheWrite5mInputTokens?: number | null;
  /** Required for Anthropic when total cache writes is nonzero. */
  cacheWrite1hInputTokens?: number | null;
  outputTokens: number | null | undefined;
}

export type ModelCostUnknownReason =
  | 'billing_unknown'
  | 'subscription_billing'
  | 'billing_attribution_unavailable'
  | 'missing_pricing_model'
  | 'unknown_pricing_model'
  | 'pricing_outside_validity_window'
  | 'incomplete_token_counts'
  | 'invalid_token_counts'
  | 'negative_uncached_input'
  | 'missing_anthropic_cache_write_split'
  | 'inconsistent_anthropic_cache_write_split';

export type ModelCost =
  | { kind: 'known'; usdMicros: bigint; pricingKey: string; pricingModel: string }
  | { kind: 'unknown'; reason: ModelCostUnknownReason; pricingKey?: string };

type Provider = 'openai' | 'anthropic';
type Rates = {
  input: bigint;
  cachedRead: bigint;
  cacheWrite?: bigint;
  cacheWrite5m?: bigint;
  cacheWrite1h?: bigint;
  output: bigint;
};

export interface PricingEntry {
  aliases: readonly string[];
  provider: Provider;
  /** A stable rate/version identity, suitable for peer comparisons. */
  pricingKey: string;
  ratesUsdMicrosPerMillion: Rates;
  verifiedAt: string;
  validCreatedAt: { from: string; through?: string };
}

const USD_MICROS_PER_USD = 1_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;
const rate = (usdPerMillion: string): bigint => {
  const [whole, fraction = ''] = usdPerMillion.split('.');
  return BigInt(whole) * USD_MICROS_PER_USD + BigInt(`${fraction}000000`.slice(0, 6));
};

/**
 * Official sources, verified 2026-07-28:
 * - https://developers.openai.com/api/docs/pricing.md
 * - https://docs.anthropic.com/en/docs/about-claude/pricing.md
 *
 * Update procedure: check those sources, append a new dated rate identity
 * rather than mutating historical prices, set its created-at validity window,
 * and add formula/validity tests before changing an alias.
 */
export const PRICING_REGISTRY: readonly PricingEntry[] = [
  {
    aliases: ['gpt-5.6-sol'],
    provider: 'openai',
    pricingKey: 'openai:gpt-5.6-sol@2026-07-28',
    ratesUsdMicrosPerMillion: {
      input: rate('5'),
      cachedRead: rate('0.5'),
      cacheWrite: rate('6.25'),
      output: rate('30'),
    },
    verifiedAt: '2026-07-28',
    validCreatedAt: { from: '2026-07-28T00:00:00.000Z' },
  },
  {
    aliases: ['gpt-5.6-terra'],
    provider: 'openai',
    pricingKey: 'openai:gpt-5.6-terra@2026-07-28',
    ratesUsdMicrosPerMillion: {
      input: rate('2.5'),
      cachedRead: rate('0.25'),
      cacheWrite: rate('3.125'),
      output: rate('15'),
    },
    verifiedAt: '2026-07-28',
    validCreatedAt: { from: '2026-07-28T00:00:00.000Z' },
  },
  {
    aliases: ['gpt-5.6-luna'],
    provider: 'openai',
    pricingKey: 'openai:gpt-5.6-luna@2026-07-28',
    ratesUsdMicrosPerMillion: {
      input: rate('1'),
      cachedRead: rate('0.1'),
      cacheWrite: rate('1.25'),
      output: rate('6'),
    },
    verifiedAt: '2026-07-28',
    validCreatedAt: { from: '2026-07-28T00:00:00.000Z' },
  },
  {
    aliases: ['claude-fable-5'],
    provider: 'anthropic',
    pricingKey: 'anthropic:claude-fable-5@2026-07-28',
    ratesUsdMicrosPerMillion: {
      input: rate('10'),
      cachedRead: rate('1'),
      cacheWrite5m: rate('12.5'),
      cacheWrite1h: rate('20'),
      output: rate('50'),
    },
    verifiedAt: '2026-07-28',
    validCreatedAt: { from: '2026-07-28T00:00:00.000Z' },
  },
  {
    aliases: ['claude-opus-5', 'claude-opus-4-8'],
    provider: 'anthropic',
    pricingKey: 'anthropic:claude-opus-5@2026-07-28',
    ratesUsdMicrosPerMillion: {
      input: rate('5'),
      cachedRead: rate('0.5'),
      cacheWrite5m: rate('6.25'),
      cacheWrite1h: rate('10'),
      output: rate('25'),
    },
    verifiedAt: '2026-07-28',
    validCreatedAt: { from: '2026-07-28T00:00:00.000Z' },
  },
  {
    aliases: ['claude-sonnet-5'],
    provider: 'anthropic',
    pricingKey: 'anthropic:claude-sonnet-5@2026-07-28',
    ratesUsdMicrosPerMillion: {
      input: rate('2'),
      cachedRead: rate('0.2'),
      cacheWrite5m: rate('2.5'),
      cacheWrite1h: rate('4'),
      output: rate('10'),
    },
    verifiedAt: '2026-07-28',
    validCreatedAt: { from: '2026-07-28T00:00:00.000Z', through: '2026-08-31T23:59:59.999Z' },
  },
  {
    aliases: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
    provider: 'anthropic',
    pricingKey: 'anthropic:claude-haiku-4-5@2026-07-28',
    ratesUsdMicrosPerMillion: {
      input: rate('1'),
      cachedRead: rate('0.1'),
      cacheWrite5m: rate('1.25'),
      cacheWrite1h: rate('2'),
      output: rate('5'),
    },
    verifiedAt: '2026-07-28',
    validCreatedAt: { from: '2026-07-28T00:00:00.000Z' },
  },
];

/** Latest source-verification date across the registry, for honest UI/CLI copy. */
export const PRICING_REGISTRY_VERIFIED_AT =
  PRICING_REGISTRY.reduce((latest, entry) => (entry.verifiedAt > latest ? entry.verifiedAt : latest), '') || 'unknown';

/** The one sentence every surface must print beside an equivalent cost. */
export const EQUIVALENT_API_COST_CAVEAT =
  'Equivalent API cost is what this usage would cost at public API rates — a comparison, not a bill.';

function tokenCount(value: number | null | undefined): bigint | undefined {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) return undefined;
  return BigInt(value!);
}

function withinValidityWindow(entry: PricingEntry, createdAt: string | null | undefined): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  const through = entry.validCreatedAt.through;
  return (
    Number.isFinite(created) &&
    created >= Date.parse(entry.validCreatedAt.from) &&
    (through === undefined || created <= Date.parse(through))
  );
}

export type PricingEntryResolution =
  | { kind: 'known'; entry: PricingEntry }
  | { kind: 'unknown_model' }
  | { kind: 'outside_validity_window'; pricingKey: string };

/**
 * Resolve the newest rate identity whose validity window contains the session
 * creation time. The SQL rates join uses the same greatest-`valid_from` rule,
 * so appending a new overlapping version cannot make the two estimators drift.
 * Supplying a registry is useful for isolated resolver tests; production
 * callers use the shared registry by default.
 */
export function resolvePricingEntry(
  model: string,
  createdAt: string | null | undefined,
  registry: readonly PricingEntry[] = PRICING_REGISTRY,
): PricingEntryResolution {
  const candidates = registry.filter(entry => entry.aliases.includes(model));
  if (!candidates.length) return { kind: 'unknown_model' };

  let newest = candidates[0]!;
  let resolved: PricingEntry | undefined;
  for (const candidate of candidates) {
    if (candidate.validCreatedAt.from > newest.validCreatedAt.from) newest = candidate;
    if (
      withinValidityWindow(candidate, createdAt) &&
      (resolved === undefined || candidate.validCreatedAt.from > resolved.validCreatedAt.from)
    ) {
      resolved = candidate;
    }
  }
  return resolved
    ? { kind: 'known', entry: resolved }
    : { kind: 'outside_validity_window', pricingKey: newest.pricingKey };
}

/** Round once, half-up, so each returned amount is an integer USD micro. */
function microsFromNumerator(numerator: bigint): bigint {
  return (numerator + TOKENS_PER_MILLION / 2n) / TOKENS_PER_MILLION;
}

/** Shared per-token pricing used by both billed and equivalent estimates. */
function estimateTokenCost(row: PricingTokenFields): ModelCost {
  if (!row.pricingModel) return { kind: 'unknown', reason: 'missing_pricing_model' };
  const resolution = resolvePricingEntry(row.pricingModel, row.createdAt);
  if (resolution.kind === 'unknown_model') return { kind: 'unknown', reason: 'unknown_pricing_model' };
  if (resolution.kind === 'outside_validity_window')
    return {
      kind: 'unknown',
      reason: 'pricing_outside_validity_window',
      pricingKey: resolution.pricingKey,
    };
  const entry = resolution.entry;

  const input = tokenCount(row.inputTokens);
  const cachedRead = tokenCount(row.cachedInputTokens);
  const cacheWrite = tokenCount(row.cacheWriteInputTokens);
  const output = tokenCount(row.outputTokens);
  if (input === undefined || cachedRead === undefined || cacheWrite === undefined || output === undefined) {
    const supplied = [row.inputTokens, row.cachedInputTokens, row.cacheWriteInputTokens, row.outputTokens];
    return {
      kind: 'unknown',
      reason: supplied.some(value => typeof value === 'number' && value < 0)
        ? 'invalid_token_counts'
        : 'incomplete_token_counts',
      pricingKey: entry.pricingKey,
    };
  }
  const uncached = input - cachedRead - cacheWrite;
  if (uncached < 0n) return { kind: 'unknown', reason: 'negative_uncached_input', pricingKey: entry.pricingKey };

  let numerator =
    uncached * entry.ratesUsdMicrosPerMillion.input +
    cachedRead * entry.ratesUsdMicrosPerMillion.cachedRead +
    output * entry.ratesUsdMicrosPerMillion.output;
  if (entry.provider === 'openai') {
    numerator += cacheWrite * entry.ratesUsdMicrosPerMillion.cacheWrite!;
  } else if (cacheWrite !== 0n) {
    const cacheWrite5m = tokenCount(row.cacheWrite5mInputTokens);
    const cacheWrite1h = tokenCount(row.cacheWrite1hInputTokens);
    if (cacheWrite5m === undefined || cacheWrite1h === undefined) {
      return { kind: 'unknown', reason: 'missing_anthropic_cache_write_split', pricingKey: entry.pricingKey };
    }
    if (cacheWrite5m + cacheWrite1h !== cacheWrite) {
      return { kind: 'unknown', reason: 'inconsistent_anthropic_cache_write_split', pricingKey: entry.pricingKey };
    }
    numerator +=
      cacheWrite5m * entry.ratesUsdMicrosPerMillion.cacheWrite5m! +
      cacheWrite1h * entry.ratesUsdMicrosPerMillion.cacheWrite1h!;
  }
  return {
    kind: 'known',
    usdMicros: microsFromNumerator(numerator),
    pricingKey: entry.pricingKey,
    pricingModel: row.pricingModel,
  };
}

/**
 * Estimates dollars only for an API-metered session with transcript-derived
 * pricing evidence and complete counters. `row.model` is intentionally absent
 * from this contract, making it impossible to use as pricing evidence.
 */
export function estimateModelCost(billing: BillingKind, row: PricingTokenFields): ModelCost {
  if (billing === 'unknown') return { kind: 'unknown', reason: 'billing_unknown' };
  if (billing === 'subscription') return { kind: 'unknown', reason: 'subscription_billing' };
  // A current wrapper/account cannot attribute historical tokens across a
  // migration. Missing schema-v6 evidence is equally unsafe (legacy daemon or
  // response), so only an explicit false may proceed to token pricing.
  if (row.migrated !== false) return { kind: 'unknown', reason: 'billing_attribution_unavailable' };
  return estimateTokenCost(row);
}

/**
 * What the transcript-evidenced usage would cost at public API rates. This is
 * billing-mode and migration-attribution independent: it is a comparison, not
 * a statement about money actually billed.
 */
export function estimateEquivalentApiCost(row: PricingTokenFields): ModelCost {
  return estimateTokenCost(row);
}
