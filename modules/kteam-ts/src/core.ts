import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type { Harness, Recommendation, SessionConfig } from './types';
import { authFailureRemedy, USAGE_REFRESH_MS } from './usage';

export function inferHarness(binary: string): Harness {
  const base = path.basename(binary);
  if (base.startsWith('claude-')) return 'claude';
  if (base.startsWith('codex-')) return 'codex';
  throw new Error(`unsupported harness wrapper "${binary}"; expected claude-* or codex-*`);
}

export function modelHint(binary: string): string {
  const base = path.basename(binary).replace(/^(claude|codex)-auto-/, '');
  if (base === 'mm3') return 'MiniMax M3';
  if (base.startsWith('glm52')) return 'GLM-5.2';
  if (base.startsWith('dsv4f')) return 'DeepSeek V4 Flash';
  if (base.startsWith('dsv4p')) return 'DeepSeek V4 Pro';
  if (base.startsWith('f5-') || base === 'loge') return 'F5/frontier account';
  return base;
}

/** Wrappers whose alias mapping makes the CONFIGURED model meaningless: their
 *  kfleet default is an alias (`opus`) that the proxy resolves to something
 *  else entirely, so `ps` showed `model=opus` for a pane running GLM-5.2. */
const WRAPPER_RESOLVED_MODEL: Array<[RegExp, string]> = [
  [/^claude-auto-glm52[ab]?$/, 'glm-5.2'],
  [/^claude-auto-mm3$/, 'minimax-m3'],
  [/^claude-auto-dsv4f$/, 'deepseek-v4-flash'],
  [/^claude-auto-dsv4p$/, 'deepseek-v4-pro'],
];

/** The model a session is ACTUALLY running, for display.
 *
 *  Precedence: what the harness reported in its own transcript usage records >
 *  the wrapper's known alias mapping > the configured model/alias > 'default'.
 *  An explicit non-alias override always wins over the wrapper mapping, since
 *  the caller asked for that exact id. */
export function resolveDisplayModel(
  binary: string,
  configuredModel?: string,
  observedModel?: string,
): { model: string; source: 'harness' | 'wrapper' | 'configured' | 'unknown' } {
  if (observedModel?.trim()) return { model: observedModel.trim(), source: 'harness' };
  const base = path.basename(binary);
  const mapped = WRAPPER_RESOLVED_MODEL.find(([pattern]) => pattern.test(base))?.[1];
  if (mapped) {
    // Aliases (`opus`, `sonnet`, `haiku`, `fable`) on these wrappers do not name
    // the served model; a full id does, so keep an explicit one.
    const alias = /^(opus|sonnet|haiku|fable)(-\d.*)?$/i.test(configuredModel?.trim() ?? '');
    if (!configuredModel?.trim() || alias) return { model: mapped, source: 'wrapper' };
  }
  if (configuredModel?.trim()) return { model: configuredModel.trim(), source: 'configured' };
  return { model: 'default', source: 'unknown' };
}

/** How long `kteam start` holds its request open for the TUI bootstrap before
 *  answering with the persisted `starting` session. Slow providers (GLM,
 *  MiniMax, DeepSeek) routinely need more than the base window just to paint a
 *  prompt, and behind a launch storm the whole queue is serialized — so they
 *  get a longer window. The CEILING is fixed: past it the launch is announced
 *  as backgrounded and RESOLVED later, never failed. */
export function startWaitMsFor(binary: string, base = 45_000, ceiling = 90_000): number {
  const name = path.basename(binary);
  const slow = /^claude-auto-(glm52[ab]?|mm3|dsv4[fp])$/.test(name);
  return Math.min(ceiling, slow ? Math.max(base, 90_000) : base);
}

export function discoverAutoAgents(binDir: string): string[] {
  if (!existsSync(binDir)) return [];
  return readdirSync(binDir)
    .filter(name => /^(claude|codex)-auto-/.test(name))
    .filter(name => {
      try {
        return existsSync(path.join(binDir, name));
      } catch {
        return false;
      }
    })
    .sort();
}

/** Per-binary account health from `kfleet usage` (the kfleet serve /usage feed). */
export type AgentAvailability = 'available' | 'unavailable';
export type AgentUnavailableReason = 'cooldown' | 'spend_limit' | 'auth' | 'provider' | 'no_credentials';

export interface AgentUsage {
  binary: string;
  /** Provider account identity from kfleet (for example `loge1` or `atomi`). */
  account?: string;
  /** The account's usage provider from the kfleet feed: `anthropic`/`codex` are
   *  OAuth logins, `zai`/`minimax` are static API keys. Drives auth-failure
   *  remedy advice (see `authFailureRemedy`) — carried through untouched from the
   *  kfleet `/usage` payload. */
  provider?: string;
  ok?: boolean;
  /** Probe failure detail. It is decision input, never a fabricated quota. */
  error?: string;
  usageBased?: boolean;
  /** Runtime provider/pool availability, independent of numerical quota. */
  availability?: AgentAvailability;
  unavailable?: boolean;
  unavailableReason?: AgentUnavailableReason;
  retryAt?: number | null;
  atLimit?: boolean;
  authOk?: boolean;
  fiveHourPercent?: number | null;
  weeklyPercent?: number | null;
  fiveHourResetAt?: number | null;
  weeklyResetAt?: number | null;
}

/** How "spent" an account is: the tighter of its 5h and weekly windows. */
export function usageScore(usage: AgentUsage | undefined): number {
  if (!usage) return 0;
  return Math.max(usage.fiveHourPercent ?? 0, usage.weeklyPercent ?? 0);
}

export function usableAgent(usage: AgentUsage | undefined): boolean {
  return usage?.unavailable !== true && usage?.atLimit !== true && usage?.authOk !== false;
}

/** Stricter than `usableAgent`: requires POSITIVELY confirmed headroom. Absent or
 *  unknown usage (undefined `atLimit`) is NOT confirmed-usable, so automatic
 *  account failover — which acts without a human in the loop — only ever targets
 *  an account the usage feed says is genuinely below its limit and logged in. */
export function confirmedUsableAgent(usage: AgentUsage | undefined): boolean {
  return usage?.ok !== false && usage?.unavailable !== true && usage?.atLimit === false && usage?.authOk !== false;
}

function unavailableAgentReason(usage: AgentUsage): string {
  const reason =
    usage.unavailableReason === 'cooldown'
      ? 'all proxy credentials are cooling down'
      : usage.unavailableReason === 'spend_limit'
        ? 'monthly spend limit reached'
        : usage.unavailableReason === 'no_credentials'
          ? 'no active proxy credentials'
          : usage.unavailableReason === 'auth'
            ? 'all proxy credentials were rejected'
            : 'proxy/provider unavailable';
  const retry = typeof usage.retryAt === 'number' ? ` (retry after ${new Date(usage.retryAt).toISOString()})` : '';
  return `${reason}${retry}`;
}

// ---------------------------------------------------------------------------
// `kteam recommend` — decision guide (the CLI-facing behavior)
// ---------------------------------------------------------------------------

export interface RoutingDoctrineModel {
  model: string;
  caution?: string;
}

export interface RoutingDoctrineRow {
  work: string;
  /** Preference order, left to right. */
  models: RoutingDoctrineModel[];
}

/** Human-authored routing doctrine, encoded as editable data. The human
 *  confirmed on 2026-07-30 that both earlier phrases "gpt-5.5 terra" and
 *  "5.5 terra" meant the SINGLE model gpt-5.6-terra. GPT-5.5 is therefore not
 *  present in this doctrine. */
export const ROUTING_DOCTRINE: RoutingDoctrineRow[] = [
  {
    work: 'Mission-critical thinking/planning — where a blindspot or missed understanding causes large rework or impact',
    models: [{ model: 'Fable 5' }],
  },
  { work: 'Normal planning', models: [{ model: 'Opus 5' }] },
  {
    work: 'Implementing',
    models: [{ model: 'Opus 5' }, { model: 'gpt-5.6-sol' }, { model: 'glm-5.2', caution: 'only if you must' }],
  },
  { work: 'Review', models: [{ model: 'gpt-5.6-terra' }, { model: 'Opus 5' }] },
  { work: 'Super-small mechanical', models: [{ model: 'MiniMax M3' }] },
  { work: 'Internal docs/HTML', models: [{ model: 'MiniMax M3' }] },
  { work: 'External docs/HTML', models: [{ model: 'gpt-5.6-sol' }] },
  {
    work: 'Small/medium mechanical',
    models: [{ model: 'Sonnet 5' }, { model: 'glm-5.2' }, { model: 'gpt-5.6-terra' }],
  },
];

/** Named policy constants: these numbers must never be buried in scoring code. */
export const LOGE_SELECTION_WEIGHT = 9;
export const NON_LOGE_SELECTION_WEIGHT = 1;
export const LOGE_WEEKLY_REMAINING_FLOOR_PERCENT = 15;
export const LOGE_WEEKLY_UTILIZATION_CUTOFF_PERCENT = 100 - LOGE_WEEKLY_REMAINING_FLOOR_PERCENT;

export const PRODUCT_FACING_MODEL_GUARD = {
  rule: 'Never route product-facing work to MiniMax M3 or DeepSeek V4.',
  models: ['MiniMax M3', 'DeepSeek V4'],
} as const;

export const HARD_ACCOUNT_EXCLUSIONS = [
  {
    binary: 'claude-auto-kirin',
    reason: 'personal daily-driver account — never route kteam work here',
  },
  {
    binary: 'codex-auto-personal',
    reason: 'personal daily-driver account — never route kteam work here',
  },
  {
    binary: 'claude-auto-dsv4p',
    reason: 'DeepSeek V4 Pro is too expensive for its capability — routed manually only',
  },
] as const;

export const ACCOUNT_SELECTION_POLICY = {
  logeToNonLogeRatio: {
    loge: LOGE_SELECTION_WEIGHT,
    nonLoge: NON_LOGE_SELECTION_WEIGHT,
  },
  logeWeeklyRemainingFloorPercent: LOGE_WEEKLY_REMAINING_FLOOR_PERCENT,
  logeWeeklyUtilizationCutoffPercent: LOGE_WEEKLY_UTILIZATION_CUTOFF_PERCENT,
  ownAccountFallbacks: ['atomi', 'liftoff'],
  rules: [
    `Prefer loge accounts at roughly ${LOGE_SELECTION_WEIGHT}:${NON_LOGE_SELECTION_WEIGHT} over non-loge accounts ` +
      `(about ${NON_LOGE_SELECTION_WEIGHT} in ${LOGE_SELECTION_WEIGHT + NON_LOGE_SELECTION_WEIGHT} selections goes to non-loge).`,
    `When a loge account reaches ${LOGE_WEEKLY_UTILIZATION_CUTOFF_PERCENT}% weekly utilization ` +
      `(about ${LOGE_WEEKLY_REMAINING_FLOOR_PERCENT}% weekly quota remaining), stop preferring it.`,
    'After that cutoff, move to the own-account fallbacks atomi and liftoff; kirin remains a hard never-route daily driver.',
    'Unknown quota is unknown: do not invent utilization or silently treat it as zero.',
  ],
} as const;

export type RecommendationAccountPool = 'loge' | 'own-fallback' | 'other' | 'never-route';
export type RecommendationUsability = 'usable' | 'unusable' | 'unknown';
export type RecommendationQuotaState = 'live' | 'unknown' | 'skipped';

export interface RecommendationAccountState {
  binary: string;
  account: string;
  pool: RecommendationAccountPool;
  usable: RecommendationUsability;
  usabilityReason: string;
  provider: string | null;
  quotaState: RecommendationQuotaState;
  fiveHourPercent: number | null;
  weeklyPercent: number | null;
  weeklyRemainingPercent: number | null;
  weeklyResetAt: number | null;
  weeklyResetAtIso: string | null;
  /** null means the threshold cannot be evaluated from real weekly quota. */
  logePreferenceEligible: boolean | null;
  probeError: string | null;
}

export interface RecommendationDecisionGuide {
  schemaVersion: 1;
  kind: 'decision-guide';
  task: string;
  decisionOwner: 'calling-agent';
  doctrine: {
    rows: RoutingDoctrineRow[];
    productFacingGuard: typeof PRODUCT_FACING_MODEL_GUARD;
  };
  accountSelection: typeof ACCOUNT_SELECTION_POLICY;
  quota: {
    probed: boolean;
    source: 'kfleet-usage-feed' | 'skipped';
    anyRealNumbers: boolean;
    note: string;
  };
  accounts: RecommendationAccountState[];
  hardExclusions: Array<{ binary: string; reason: string }>;
  instructions: string[];
  warnings: string[];
}

export interface RecommendationDecisionOptions {
  usage?: AgentUsage[];
  /** false is the explicit `--no-usage` path. */
  usageProbed?: boolean;
}

const percentOrNull = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;

const timestampOrNull = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
};

const accountNameFor = (binary: string, usage?: AgentUsage): string =>
  usage?.account ?? binary.replace(/^(claude|codex)-auto-/, '');

const accountPoolFor = (binary: string, account: string): RecommendationAccountPool => {
  if (HARD_ACCOUNT_EXCLUSIONS.some(item => item.binary === binary)) return 'never-route';
  if (/^(claude|codex)-auto-loge(?:[1-6])?$/.test(binary)) return 'loge';
  if ((ACCOUNT_SELECTION_POLICY.ownAccountFallbacks as readonly string[]).includes(account)) return 'own-fallback';
  return 'other';
};

function usabilityFor(
  binary: string,
  usage: AgentUsage | undefined,
  usageProbed: boolean,
): { usable: RecommendationUsability; reason: string } {
  const hard = HARD_ACCOUNT_EXCLUSIONS.find(item => item.binary === binary);
  if (hard) return { usable: 'unusable', reason: hard.reason };
  if (!usageProbed) return { usable: 'unknown', reason: 'quota/availability probe skipped by --no-usage' };
  if (!usage) return { usable: 'unknown', reason: 'no usage record was returned for this account' };
  if (usage.authOk === false)
    return {
      usable: 'unusable',
      reason: `credentials rejected — ${
        /^claude-auto-loge[1-6]$/.test(binary)
          ? 'refresh the declared token with `kloge pull`, run `hms`, then re-check `kfleet usage`'
          : authFailureRemedy(usage.provider)
      }`,
    };
  if (usage.unavailable === true || usage.availability === 'unavailable')
    return { usable: 'unusable', reason: unavailableAgentReason(usage) };
  if (usage.atLimit === true) return { usable: 'unusable', reason: 'at its reported usage limit' };
  if (usage.availability === 'available')
    return { usable: 'usable', reason: 'usage/availability feed positively reports headroom' };
  const completeQuota = percentOrNull(usage.fiveHourPercent) !== null && percentOrNull(usage.weeklyPercent) !== null;
  if (usage.ok === true && usage.usageBased !== false && usage.atLimit === false && completeQuota)
    return { usable: 'usable', reason: 'usage/availability feed positively reports headroom' };
  if (usage.ok === true)
    return {
      usable: 'unknown',
      reason: 'usage probe did not return both quota windows and a positive headroom verdict',
    };
  if (usage.ok === false)
    return {
      usable: 'unknown',
      reason: `usage probe did not return a usability verdict${usage.error ? `: ${usage.error}` : ''}`,
    };
  return { usable: 'unknown', reason: 'usage feed did not positively confirm availability' };
}

/** Build the inputs and rules the CALLING agent needs to decide. This function
 *  deliberately does not classify the task, rank models/accounts, choose a role,
 *  or generate a `kteam start` command. */
export function recommendDecisionGuide(
  task: string,
  agents: string[],
  options: RecommendationDecisionOptions = {},
): RecommendationDecisionGuide {
  const usage = options.usage ?? [];
  const usageProbed = options.usageProbed ?? true;
  const usageByBinary = new Map(usage.map(item => [item.binary, item]));
  const accounts = [...new Set(agents)].sort().map((binary): RecommendationAccountState => {
    const feed = usageByBinary.get(binary);
    const account = accountNameFor(binary, feed);
    const pool = accountPoolFor(binary, account);
    // A failed/auth-rejected probe may carry stale fields from an older
    // producer. Only a non-failed authenticated numerical record is real.
    const numericalQuota = usageProbed && feed?.ok !== false && feed?.authOk !== false && feed?.usageBased !== false;
    const fiveHourPercent = numericalQuota ? percentOrNull(feed?.fiveHourPercent) : null;
    const weeklyPercent = numericalQuota ? percentOrNull(feed?.weeklyPercent) : null;
    const weeklyRemainingPercent = weeklyPercent === null ? null : Math.max(0, 100 - weeklyPercent);
    const weeklyResetAt = numericalQuota ? timestampOrNull(feed?.weeklyResetAt) : null;
    const verdict = usabilityFor(binary, feed, usageProbed);
    return {
      binary,
      account,
      pool,
      usable: verdict.usable,
      usabilityReason: verdict.reason,
      provider: feed?.provider ?? null,
      quotaState: !usageProbed ? 'skipped' : fiveHourPercent !== null || weeklyPercent !== null ? 'live' : 'unknown',
      fiveHourPercent,
      weeklyPercent,
      weeklyRemainingPercent,
      weeklyResetAt,
      weeklyResetAtIso: weeklyResetAt === null ? null : new Date(weeklyResetAt).toISOString(),
      logePreferenceEligible:
        pool !== 'loge' || weeklyPercent === null ? null : weeklyPercent < LOGE_WEEKLY_UTILIZATION_CUTOFF_PERCENT,
      probeError: usageProbed ? (feed?.error ?? null) : null,
    };
  });

  const anyRealNumbers = accounts.some(account => account.fiveHourPercent !== null || account.weeklyPercent !== null);
  const warnings = !usageProbed
    ? ['Quota inputs are missing because --no-usage skipped probing; every quota field is unknown.']
    : anyRealNumbers
      ? []
      : ['The usage feed returned no real 5h/weekly values; quota fields are unknown, not zero.'];

  return {
    schemaVersion: 1,
    kind: 'decision-guide',
    task,
    decisionOwner: 'calling-agent',
    doctrine: {
      rows: ROUTING_DOCTRINE.map(row => ({ ...row, models: row.models.map(model => ({ ...model })) })),
      productFacingGuard: PRODUCT_FACING_MODEL_GUARD,
    },
    accountSelection: ACCOUNT_SELECTION_POLICY,
    quota: {
      probed: usageProbed,
      source: usageProbed ? 'kfleet-usage-feed' : 'skipped',
      anyRealNumbers,
      note: usageProbed
        ? `Numbers come from the cached kfleet usage feed (refreshed at most every ${Math.round(USAGE_REFRESH_MS / 1000)} seconds); failed probes stay unknown.`
        : 'Quota probing was skipped with --no-usage; no quota inference was made.',
    },
    accounts,
    hardExclusions: HARD_ACCOUNT_EXCLUSIONS.map(item => ({ ...item })),
    instructions: [
      'Match the work to the routing-doctrine row; use its model order as the capability preference.',
      'Remove hard exclusions and accounts positively reported unusable.',
      `Apply the ${LOGE_WEEKLY_UTILIZATION_CUTOFF_PERCENT}% weekly-utilization cutoff to each loge account only when its real weekly value is known.`,
      `Among eligible accounts, maintain the rough ${LOGE_SELECTION_WEIGHT}:${NON_LOGE_SELECTION_WEIGHT} loge-to-non-loge selection ratio; after the cutoff use atomi/liftoff.`,
      'The calling agent makes the final choice. This guide does not prescribe an agent or emit a launch command.',
    ],
    warnings,
  };
}

const formatQuotaPercent = (value: number | null): string => (value === null ? 'unknown' : `${value}% used`);

/** Human-readable form of the same machine-readable guide returned by --json. */
export function renderRecommendationDecisionGuide(guide: RecommendationDecisionGuide): string {
  const lines = [
    `Task: ${guide.task}`,
    'Decision owner: calling agent (this command supplies doctrine and live inputs; it does not choose).',
    '',
    'Routing doctrine (models are in preference order):',
    ...guide.doctrine.rows.map(
      row =>
        `  - ${row.work}: ${row.models.map(model => `${model.model}${model.caution ? ` (${model.caution})` : ''}`).join(', ')}`,
    ),
    '',
    'Account selection:',
    ...guide.accountSelection.rules.map(rule => `  - ${rule}`),
    '',
    'Account state:',
    `  Quota inputs: ${guide.quota.note}`,
    ...guide.accounts.map(account => {
      const reset = account.weeklyResetAtIso ?? 'unknown';
      const remaining = account.weeklyRemainingPercent === null ? 'unknown' : `${account.weeklyRemainingPercent}%`;
      const preference =
        account.pool !== 'loge'
          ? ''
          : account.logePreferenceEligible === null
            ? '; loge preference unknown (weekly quota missing)'
            : account.logePreferenceEligible
              ? '; loge preference eligible'
              : '; stop loge preference (weekly cutoff reached)';
      return (
        `  - ${account.binary} [${account.pool}]: usability ${account.usable}; ` +
        `5h ${formatQuotaPercent(account.fiveHourPercent)}; weekly ${formatQuotaPercent(account.weeklyPercent)} ` +
        `(remaining ${remaining}); weekly reset ${reset}${preference}; ${account.usabilityReason}`
      );
    }),
    '',
    'Hard exclusions:',
    ...guide.hardExclusions.map(item => `  - ${item.binary}: ${item.reason}`),
    '',
    `Product-facing guard: ${guide.doctrine.productFacingGuard.rule}`,
  ];
  if (guide.warnings.length) lines.push('', 'Warnings:', ...guide.warnings.map(warning => `  - ${warning}`));
  lines.push('', ...guide.instructions.map((instruction, index) => `${index + 1}. ${instruction}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// `kteam recommend` — model/account doctrine
//
// The authority is kfleet/skills/kteam/SKILL.md ("Pick the right model", tiers
// + handoff chain). This module ENCODES that table; when the skill changes,
// change the catalog below and the tests that pin its floors. The old
// implementation was a handful of keyword regexes that recommended GLM-5.2 for
// anything matching /hard|complex/ — the exact opposite of the doctrine, which
// restricts GLM to the mass-chore tier.
// ---------------------------------------------------------------------------

export type ModelKey =
  | 'fable5'
  | 'sol'
  | 'opus5'
  | 'opus48'
  | 'terra'
  | 'gpt55'
  | 'glm52'
  | 'mm3'
  | 'sonnet5'
  | 'dsv4f'
  | 'haiku';

export type TeamRole = 'planner' | 'implementer' | 'researcher' | 'reviewer' | 'fan-out';
export type Budget = 'cheap' | 'balanced' | 'max';
export type Complexity = 'mechanical' | 'mid' | 'hard';
export type TaskKind =
  | 'frontend'
  | 'backend'
  | 'research'
  | 'review'
  | 'migration'
  | 'bulk-chore'
  | 'debugging'
  | 'general';

interface ModelSpec {
  label: string;
  family: Harness;
  tier: string;
  speed: 'fastest' | 'fast' | 'medium' | 'slow';
  /** Relative spend, used by --budget and to break same-tier ties. */
  cost: 'low' | 'medium' | 'high' | 'very-high';
  /** Capability floor enforcement: doctrine tiers as a single number. */
  power: number;
  /** Per-role base scores. 0 = doctrine says never as PRIMARY for that role.
   *  `implementer` is NOT here — see implementerFit. */
  score: Partial<Record<Exclude<TeamRole, 'implementer'>, number>>;
  /** Implementer fitness is COMPLEXITY-RELATIVE, not absolute. A single "best
   *  implementer" number put GPT-5.6-sol on a 40-file rename and a CSS tweak:
   *  the top tier is the right answer for the hardest work and the wrong answer
   *  for a chore. Reading a column down this table is reading the doctrine. */
  implementerFit: Record<Complexity, number>;
  /** Doctrine: never let this model implement product-facing work. */
  noProductFacing?: boolean;
  /** Doctrine: may implement only from a plan written by a smarter model. */
  needsPlan?: boolean;
  note: string;
}

const MODELS: Record<ModelKey, ModelSpec> = {
  fable5: {
    label: 'Fable 5',
    family: 'claude',
    tier: 'frontier planner',
    speed: 'slow',
    cost: 'very-high',
    power: 100,
    score: { planner: 100, researcher: 95, reviewer: 78 },
    implementerFit: { mechanical: 5, mid: 40, hard: 78 },
    note: 'smartest: maps blindspots and complex relations before code exists',
  },
  sol: {
    label: 'GPT-5.6-sol @ ultra',
    family: 'codex',
    tier: 'top implementer',
    speed: 'slow',
    cost: 'very-high',
    power: 96,
    score: { planner: 82, researcher: 80, reviewer: 86 },
    implementerFit: { mechanical: 10, mid: 55, hard: 100 },
    note: 'most diligent implementer; expensive — reserve for the hardest work',
  },
  opus5: {
    label: 'Opus 5',
    family: 'claude',
    tier: 'top implementer',
    speed: 'medium',
    cost: 'high',
    power: 95,
    score: { planner: 86, researcher: 85, reviewer: 80 },
    implementerFit: { mechanical: 12, mid: 60, hard: 98 },
    note: 'same top tier as sol, faster; served by every Anthropic-backed account',
  },
  // RETIRED as a choice (2026-07-25): Opus 5 costs the same, so 4.8 is never
  // the right pick. Kept only as the 'strong implementer' power threshold.
  opus48: {
    label: 'Opus 4.8',
    family: 'claude',
    tier: 'strong implementer',
    speed: 'medium',
    cost: 'high',
    power: 80,
    score: { planner: 70, researcher: 78, reviewer: 72 },
    implementerFit: { mechanical: 25, mid: 100, hard: 70 },
    note: 'next-best after the top tier; the generic-to-mid-high workhorse',
  },
  terra: {
    label: 'GPT-5.6-terra',
    family: 'codex',
    tier: 'reviewer / plan-following implementer',
    speed: 'medium',
    cost: 'medium',
    power: 72,
    needsPlan: true,
    score: { researcher: 70, reviewer: 100 },
    implementerFit: { mechanical: 35, mid: 92, hard: 55 },
    note: 'very strong reviewer; implements only against someone else’s plan',
  },
  gpt55: {
    label: 'GPT-5.5',
    family: 'codex',
    tier: 'reviewer / plan-following implementer',
    speed: 'medium',
    cost: 'medium',
    power: 68,
    needsPlan: true,
    score: { researcher: 64, reviewer: 92 },
    implementerFit: { mechanical: 40, mid: 78, hard: 40 },
    note: 'second-opinion reviewer; cheaper than terra, same review strength class',
  },
  glm52: {
    label: 'GLM-5.2',
    family: 'claude',
    tier: 'mass-chore',
    speed: 'slow',
    cost: 'low',
    power: 55,
    score: { researcher: 50, 'fan-out': 100 },
    implementerFit: { mechanical: 94, mid: 60, hard: 20 },
    note: 'divide-and-conquer tier: 1 file = 1 agent; slow, cheap, use sparingly',
  },
  mm3: {
    label: 'MiniMax M3',
    family: 'claude',
    tier: 'mass-chore',
    speed: 'fast',
    cost: 'low',
    power: 45,
    noProductFacing: true,
    score: { researcher: 55, 'fan-out': 92 },
    implementerFit: { mechanical: 92, mid: 35, hard: 0 },
    note: 'fast; strong at UI/SVG/screenshot-to-code, but never product-facing',
  },
  sonnet5: {
    label: 'Sonnet 5',
    family: 'claude',
    tier: 'mass-chore',
    speed: 'fast',
    cost: 'low',
    power: 50,
    score: { researcher: 58, 'fan-out': 80 },
    implementerFit: { mechanical: 88, mid: 40, hard: 0 },
    note: 'well-guarded mechanical work with a bit of judgement',
  },
  dsv4f: {
    label: 'DeepSeek V4 Flash',
    family: 'claude',
    tier: 'mechanical',
    speed: 'fast',
    cost: 'low',
    power: 30,
    noProductFacing: true,
    score: { researcher: 40, 'fan-out': 70 },
    implementerFit: { mechanical: 80, mid: 15, hard: 0 },
    note: 'fully-specified mechanical work only — no blindspots allowed',
  },
  haiku: {
    label: 'Haiku 4.5',
    family: 'claude',
    tier: 'trivial',
    speed: 'fastest',
    cost: 'low',
    power: 20,
    noProductFacing: true,
    score: { 'fan-out': 50 },
    implementerFit: { mechanical: 60, mid: 5, hard: 0 },
    note: 'trivial mechanical work only',
  },
};

interface AccountSpec {
  match: RegExp;
  /** loge accounts absorb ~70% of token spend (loge-first bias). */
  loge?: boolean;
  /** Present = never recommend, with the reason shown in the exclusions list. */
  banned?: string;
  /** First entry is the wrapper's kfleet default (no --model needed). */
  options: Array<{ model: ModelKey; flag?: string }>;
}

const ACCOUNTS: AccountSpec[] = [
  {
    match: /^claude-auto-kirin$/,
    banned: 'personal daily-driver Anthropic account — never route kteam work here',
    options: [],
  },
  {
    match: /^codex-auto-personal$/,
    banned: 'personal daily-driver ChatGPT account — never route kteam work here',
    options: [],
  },
  {
    match: /^claude-auto-dsv4p$/,
    banned: 'DeepSeek V4 Pro — too expensive for what it gives (doctrine: do not use)',
    options: [],
  },
  {
    // The kloge proxy serves the whole Anthropic lineup by REAL id, not alias.
    match: /^claude-auto-loge$/,
    loge: true,
    options: [
      { model: 'fable5' },
      { model: 'opus5', flag: 'claude-opus-5' },
      { model: 'sonnet5', flag: 'claude-sonnet-5' },
    ],
  },
  {
    // Direct first-party Anthropic OAuth accounts: native aliases work here.
    // Fable is restored on the six direct accounts only; the pooled proxy above
    // remains governed separately by its real-ID configuration.
    match: /^claude-auto-loge[1-6]$/,
    options: [
      { model: 'opus5' },
      { model: 'fable5', flag: 'fable' },
      { model: 'sonnet5', flag: 'sonnet' },
      { model: 'haiku', flag: 'haiku' },
    ],
  },
  {
    match: /^claude-auto-atomi$/,
    options: [
      { model: 'opus5' },
      { model: 'fable5', flag: 'fable' },
      { model: 'sonnet5', flag: 'sonnet' },
      { model: 'haiku', flag: 'haiku' },
    ],
  },
  {
    match: /^claude-auto-liftoff$/,
    options: [
      { model: 'opus5' },
      { model: 'fable5', flag: 'fable' },
      { model: 'sonnet5', flag: 'sonnet' },
      { model: 'haiku', flag: 'haiku' },
    ],
  },
  { match: /^claude-auto-glm52[ab]$/, options: [{ model: 'glm52' }] },
  { match: /^claude-auto-mm3$/, options: [{ model: 'mm3' }] },
  { match: /^claude-auto-dsv4f$/, options: [{ model: 'dsv4f' }] },
  {
    match: /^codex-auto-loge$/,
    loge: true,
    options: [{ model: 'sol' }, { model: 'terra', flag: 'gpt-5.6-terra' }, { model: 'gpt55', flag: 'gpt-5.5' }],
  },
  {
    match: /^codex-auto-(loai|loio|ernest|atomi|kirin)$/,
    options: [{ model: 'terra' }, { model: 'sol', flag: 'gpt-5.6-sol' }, { model: 'gpt55', flag: 'gpt-5.5' }],
  },
];

function accountFor(binary: string): AccountSpec | undefined {
  const base = path.basename(binary);
  return ACCOUNTS.find(entry => entry.match.test(base));
}

// --- classification --------------------------------------------------------

export interface AxisEvidence {
  axis: 'complexity' | 'kind' | 'risk' | 'size' | 'ambiguity' | 'audience';
  value: string;
  /** The literal words that drove it — so a wrong call is obvious. */
  matched: string[];
}

export interface TaskClassification {
  complexity: Complexity;
  kind: TaskKind;
  risk: 'low' | 'normal' | 'critical';
  size: 'small' | 'medium' | 'large';
  ambiguity: 'low' | 'high';
  productFacing: boolean;
  evidence: AxisEvidence[];
}

const hits = (text: string, pattern: RegExp): string[] => [
  ...new Set((text.match(new RegExp(pattern.source, 'gi')) ?? []).map(word => word.toLowerCase().trim())),
];

const KIND_PATTERNS: Array<[TaskKind, RegExp]> = [
  // Order matters: the first kind with evidence wins, so the narrow,
  // strongly-signalled kinds come before the broad ones.
  [
    'bulk-chore',
    /\b\d{2,}\s*(files?|packages?|modules?|call ?sites?|tests?|repos?)|every file|each file|bulk|fan.?out/,
  ],
  ['migration', /migrat\w*|upgrade|port(ing)? to|codemod|convert \w+ to|rollout/],
  ['review', /review|critique|proofread|second opinion|sanity.?check/],
  ['research', /research|investigate|inventory|survey|compare|explore|find out|spike|read the docs|understand how/],
  ['debugging', /\bbugs?\b|debug|flaky|crash\w*|regression|broken|failing|stack ?trace|root.?cause|repro\w*/],
  ['frontend', /front.?end|\bui\b|react|css|tailwind|landing|dashboard|svg|screenshot|component|responsive|animation/],
  ['backend', /\bapi\b|server|database|\bsql\b|schema|endpoint|backend|queue|worker|daemon|microservice/],
];

const HARD =
  /hard|complex|complicated|tricky|architect\w*|re-?design|re-?write|from scratch|concurren\w*|distributed|race condition|deadlock|protocol|algorithm|subtle|performance|refactor\w*|root.?cause|end.?to.?end/;
const MECHANICAL =
  /rename|typo|reformat|format\w*|lint|bump|reorder|boilerplate|mechanical|one.?liner|changelog|add a comment|copy.paste|find and replace/;
const CRITICAL =
  /security|auth\w*|credential|secret|token|payment|billing|invoice|production|\bprod\b|data ?loss|outage|compliance|\bpii\b|\bp0\b|critical|irreversible/;
const LARGE =
  /\b\d{2,}\s*(files?|packages?|modules?|call ?sites?|places|repos?)|entire (repo|codebase|service)|whole (repo|codebase)|monorepo|large|big context|across (all|every)/;
const AMBIGUOUS =
  /figure out|decide|design|plan\b|unclear|ambiguous|explore|options|how should|what.s the best|somehow|investigate/;
const PLANNED = /per the plan|following the plan|as specified|spec:|checklist|step.by.step|already decided|the plan is/;
const PRODUCT = /user.?facing|customer|product|marketing|landing|public|end users?/;

export function classifyTask(task: string): TaskClassification {
  const text = task.toLowerCase();
  const evidence: AxisEvidence[] = [];
  const record = (axis: AxisEvidence['axis'], value: string, matched: string[]) => {
    evidence.push({ axis, value, matched });
  };

  const hardHits = hits(text, HARD);
  const mechanicalHits = hits(text, MECHANICAL);
  const criticalHits = hits(text, CRITICAL);
  const largeHits = hits(text, LARGE);
  const ambiguousHits = hits(text, AMBIGUOUS);
  const plannedHits = hits(text, PLANNED);
  const productHits = hits(text, PRODUCT);

  const kindEntry = KIND_PATTERNS.map(([kind, pattern]) => ({ kind, matched: hits(text, pattern) })).find(
    entry => entry.matched.length > 0,
  );
  const kind: TaskKind = kindEntry?.kind ?? 'general';
  record('kind', kind, kindEntry?.matched ?? []);

  // Mechanical only wins when nothing says the work is hard: "mechanically
  // rename every call site of a concurrent scheduler" is not mechanical.
  let complexity: Complexity = 'mid';
  if (hardHits.length > 0) complexity = 'hard';
  else if (mechanicalHits.length > 0) complexity = 'mechanical';
  else if (kind === 'bulk-chore') complexity = 'mechanical';
  record('complexity', complexity, complexity === 'hard' ? hardHits : mechanicalHits);

  const risk = criticalHits.length > 0 ? 'critical' : complexity === 'mechanical' ? 'low' : 'normal';
  record('risk', risk, criticalHits);

  const size = largeHits.length > 0 || kind === 'bulk-chore' ? 'large' : task.length > 400 ? 'medium' : 'small';
  record('size', size, largeHits);

  // A plan already in hand removes the ambiguity a hard task would otherwise
  // carry — that is exactly the condition under which terra may implement.
  const ambiguity: 'low' | 'high' =
    plannedHits.length > 0
      ? 'low'
      : ambiguousHits.length > 0 || (complexity === 'hard' && kind !== 'bulk-chore')
        ? 'high'
        : 'low';
  record('ambiguity', ambiguity, plannedHits.length > 0 ? plannedHits : ambiguousHits);

  const productFacing = productHits.length > 0 || kind === 'frontend';
  record('audience', productFacing ? 'product-facing' : 'internal', productHits);

  return { complexity, kind, risk, size, ambiguity, productFacing, evidence };
}

// --- candidate generation --------------------------------------------------

export interface RoleOption {
  binary: string;
  model: ModelKey;
  modelLabel: string;
  /** The `--model` value to pass; absent = the wrapper default. */
  modelFlag?: string;
  family: Harness;
  tier: string;
  /** One line: quality / speed / cost. */
  tradeoff: string;
  command: string;
  score: number;
  /** Why this option is offered but not preferred. Below-floor and
   *  same-family options stay on the menu (the lead may know something the
   *  classifier does not) but always rank last and carry the reason — a bare
   *  "below the doctrine floor" on the doctrine's own DEFAULT reviewer, which
   *  was merely the wrong family, is misleading advice. */
  caveat?: 'below-doctrine-floor' | 'same-model-family' | 'not-for-product-facing';
}

export interface RoleRecommendation {
  role: TeamRole;
  why: string;
  /** Suggested agent count (fan-out roles only). */
  count?: number;
  primary: RoleOption;
  alternatives: RoleOption[];
}

export interface TeamRecommendation {
  task: string;
  budget: Budget;
  classification: TaskClassification;
  reasoning: string;
  roles: RoleRecommendation[];
  exclusions: Array<{ binary: string; reason: string }>;
  warnings: string[];
}

export interface RecommendOptions {
  budget?: Budget;
  /** Force the team shape instead of deriving it from the classification. */
  roles?: TeamRole[];
  usage?: AgentUsage[];
  /** Label used in the generated `kteam start` commands. */
  label?: string;
}

const COST_PENALTY: Record<Budget, Record<ModelSpec['cost'], number>> = {
  // Steep on purpose: cost-first must be able to change the ANSWER, not just
  // the ordering inside one tier.
  cheap: { 'very-high': 60, high: 45, medium: 20, low: 0 },
  balanced: { 'very-high': 8, high: 4, medium: 1, low: 0 },
  max: { 'very-high': 0, high: 0, medium: 0, low: 0 },
};

/** The doctrine FLOOR: the least capable model allowed as primary for a role.
 *  This is what stops "hard/complex" from landing on GLM-5.2 again.
 *
 *  `--budget max` raises the floor a tier rather than nudging scores: buying
 *  quality means changing which tier is ELIGIBLE, not re-ranking within one.
 *  It never applies to mechanical work — the top tier on a rename is waste,
 *  not quality. `--budget cheap` leaves the floor alone (the doctrine's floors
 *  are not negotiable) and lets the cost penalties pick the cheapest model
 *  above it. */
function primaryFloor(role: TeamRole, classification: TaskClassification, budget: Budget): number {
  if (role === 'fan-out') return 0;
  if (role === 'reviewer') return MODELS.gpt55.power;
  if (role === 'planner') return MODELS.opus5.power;
  const { complexity, risk, size } = classification;
  const qualityFirst = budget === 'max' && complexity !== 'mechanical' ? MODELS.opus5.power : 0;
  // Big-context IMPLEMENTATION is a top-tier-only job per the skill.
  if (complexity === 'hard' && (risk === 'critical' || size === 'large')) return MODELS.opus5.power;
  if (complexity === 'hard' || risk === 'critical') return Math.max(qualityFirst, MODELS.opus48.power);
  if (complexity === 'mid') return Math.max(qualityFirst, MODELS.glm52.power);
  return qualityFirst;
}

function shortTask(task: string): string {
  const single = task.replace(/\s+/g, ' ').trim();
  return single.length <= 70 ? single : `${single.slice(0, 67)}…`;
}

function commandFor(binary: string, flag: string | undefined, role: TeamRole, task: string, label?: string): string {
  const parts = ['kteam start', `--agent ${binary}`];
  if (flag) parts.push(`--model ${flag}`);
  parts.push('--mode auto', '--cwd "$PWD"', `--name ${role}`);
  if (label) parts.push(`--label ${label}`);
  parts.push(`"${shortTask(task)}"`);
  return parts.join(' ');
}

function tradeoffLine(spec: ModelSpec, account: AccountSpec): string {
  const cost = { low: 'cheap', medium: 'mid-cost', high: 'expensive', 'very-high': 'very expensive' }[spec.cost];
  return `${spec.note} — ${spec.speed}, ${cost}${account.loge ? ', loge account (preferred spend)' : ''}`;
}

function candidatesFor(
  role: TeamRole,
  agents: string[],
  classification: TaskClassification,
  budget: Budget,
  usageByBinary: Map<string, AgentUsage>,
  task: string,
  label?: string,
): RoleOption[] {
  const options: RoleOption[] = [];
  for (const binary of agents) {
    const account = accountFor(binary);
    if (!account || account.banned) continue;
    for (const option of account.options) {
      const spec = MODELS[option.model];
      const base = role === 'implementer' ? spec.implementerFit[classification.complexity] : spec.score[role];
      if (base === undefined || base === 0) continue;
      let score = base;
      score -= COST_PENALTY[budget][spec.cost];
      if (account.loge) score += 6;
      // Same tier, least-spent account first.
      score -= usageScore(usageByBinary.get(binary)) / 8;
      // A wrapper default needs no override; prefer it over reaching the same
      // model through a flag on a busier account.
      if (!option.flag) score += 2;
      if (role === 'implementer' && classification.kind === 'frontend' && option.model === 'mm3') score += 12;
      // A plan-following implementer DRAGS A PLANNER onto the team (the
      // handoff chain forbids terra/5.5 planning their own work). On a cheap
      // budget that is the most expensive teammate in the shape, added to save
      // money — so cost-first prefers an implementer that needs no planner.
      if (role === 'implementer' && budget === 'cheap' && spec.needsPlan) score -= 25;
      if (role === 'researcher' && classification.size === 'large' && spec.power < MODELS.opus48.power) score -= 20;
      options.push({
        binary,
        model: option.model,
        modelLabel: spec.label,
        modelFlag: option.flag,
        family: spec.family,
        tier: spec.tier,
        tradeoff: tradeoffLine(spec, account),
        command: commandFor(binary, option.flag, role, task, label),
        score: Math.round(score * 10) / 10,
      });
    }
  }
  // One entry per model: the alternatives list is about MODEL choices, not the
  // same model on four interchangeable accounts.
  const byModel = new Map<ModelKey, RoleOption>();
  for (const option of options.sort((a, b) => b.score - a.score)) {
    if (!byModel.has(option.model)) byModel.set(option.model, option);
  }
  return [...byModel.values()].sort((a, b) => b.score - a.score);
}

function roleShape(classification: TaskClassification, budget: Budget): TeamRole[] {
  const { complexity, kind, risk, ambiguity, size } = classification;
  const roles: TeamRole[] = [];
  const wantsPlanner =
    budget === 'max' ||
    ambiguity === 'high' ||
    complexity === 'hard' ||
    (risk === 'critical' && complexity !== 'mechanical');
  if (wantsPlanner && !(budget === 'cheap' && ambiguity === 'low')) roles.push('planner');
  const fanOut = kind === 'bulk-chore' || (kind === 'migration' && size === 'large');
  if (kind === 'research') roles.push('researcher');
  // A pure chore has no single implementer — the fan-out IS the implementation.
  // Adding both put a top-tier implementer next to a 1-file-per-agent swarm.
  else if (kind !== 'review' && !(fanOut && kind === 'bulk-chore')) roles.push('implementer');
  if (fanOut) roles.push('fan-out');
  const wantsReviewer =
    budget === 'max' || risk === 'critical' || complexity !== 'mechanical' || kind === 'review' || kind === 'frontend';
  if (wantsReviewer && !(budget === 'cheap' && risk === 'low')) roles.push('reviewer');
  return roles.length > 0 ? roles : ['implementer'];
}

function roleWhy(role: TeamRole, classification: TaskClassification): string {
  const { complexity, kind, risk, size, ambiguity } = classification;
  switch (role) {
    case 'planner':
      return ambiguity === 'high'
        ? 'ambiguity is high — pin the design down before any code is written'
        : `${complexity} work with ${risk} risk: plan first, then hand the plan to an implementer`;
    case 'implementer':
      return `${complexity} ${kind} work, ${size} scope — this is the tier the doctrine allows here`;
    case 'researcher':
      return 'read-and-report work: no diff to defend, so favour reach and judgement over diligence';
    case 'reviewer':
      if (kind === 'research') return 'independent cross-family check of the findings before they are acted on';
      return risk === 'critical'
        ? 'security/production-critical change — review from a DIFFERENT model family'
        : 'independent cross-family review of the diff before it lands';
    case 'fan-out':
      return 'divide-and-conquer chore: 1 file = 1 agent on the mass-chore tier';
  }
}

function fanOutCount(classification: TaskClassification): number {
  return classification.size === 'large' ? 4 : 2;
}

/** Build a full team recommendation: classification with its evidence, a team
 *  SHAPE per the handoff chain, and per role a primary plus ranked
 *  alternatives with launch commands. Never launches anything. */
export function recommendTeam(task: string, agents: string[], options: RecommendOptions = {}): TeamRecommendation {
  const budget = options.budget ?? 'balanced';
  const usage = options.usage ?? [];
  const usageByBinary = new Map(usage.map(item => [item.binary, item]));
  const classification = classifyTask(task);
  const warnings: string[] = [];
  const exclusions: Array<{ binary: string; reason: string }> = [];

  const pool: string[] = [];
  for (const binary of agents) {
    const account = accountFor(binary);
    const health = usageByBinary.get(binary);
    if (account?.banned) exclusions.push({ binary, reason: account.banned });
    else if (!account) exclusions.push({ binary, reason: 'no doctrine entry for this wrapper — routed manually only' });
    else if (health?.authOk === false)
      exclusions.push({
        binary,
        reason: `credentials rejected (kfleet usage reports auth failure) — ${authFailureRemedy(health.provider)}`,
      });
    else if (health?.unavailable === true) exclusions.push({ binary, reason: unavailableAgentReason(health) });
    else if (health?.atLimit === true) exclusions.push({ binary, reason: 'at its usage limit' });
    else pool.push(binary);
  }

  const shape = options.roles?.length ? options.roles : roleShape(classification, budget);
  const roles: RoleRecommendation[] = [];
  for (const role of shape) {
    const ranked = candidatesFor(role, pool, classification, budget, usageByBinary, task, options.label);
    if (ranked.length === 0) {
      warnings.push(`no usable account could fill the ${role} role`);
      continue;
    }
    const floor = primaryFloor(role, classification, budget);
    // Cross-family review: if an implementer is already chosen, the reviewer
    // must come from the OTHER harness family.
    const implementerFamily = roles.find(item => item.role === 'implementer' || item.role === 'researcher')?.primary
      .family;
    // Doctrine: M3 and DeepSeek must never be the PRIMARY on product-facing
    // work — but M3 is also the doctrine's UI/SVG specialist, so dropping it
    // from a frontend menu entirely loses real advice. It stays as a marked
    // alternative instead.
    const productBarred = (option: RoleOption) =>
      role === 'implementer' && classification.productFacing && MODELS[option.model].noProductFacing === true;
    const caveatFor = (option: RoleOption): NonNullable<RoleOption['caveat']> =>
      MODELS[option.model].power < floor
        ? 'below-doctrine-floor'
        : productBarred(option)
          ? 'not-for-product-facing'
          : 'same-model-family';
    let eligible = ranked.filter(option => MODELS[option.model].power >= floor && !productBarred(option));
    if (role === 'reviewer' && implementerFamily) {
      const cross = eligible.filter(option => option.family !== implementerFamily);
      if (cross.length > 0) eligible = cross;
      else warnings.push('no cross-family reviewer is available; the reviewer shares the implementer’s model family');
    }
    if (eligible.length === 0) {
      const best = ranked[0]!;
      warnings.push(
        `no available account meets the ${role} floor for ${classification.complexity}/${classification.risk} work; ` +
          `falling back to ${best.modelLabel} — treat its output as provisional`,
      );
      eligible = ranked;
    }
    const primary = eligible[0]!;
    // Non-preferred options stay on the menu, ranked last and carrying the
    // REASON they are not preferred: a below-floor model and the doctrine's own
    // default reviewer sitting on the implementer's side are different advice.
    const rest = ranked
      .filter(option => !eligible.includes(option))
      .map(option => ({ ...option, caveat: caveatFor(option) }));
    const alternatives = [...eligible.slice(1), ...rest].slice(0, 3);
    roles.push({
      role,
      why: roleWhy(role, classification),
      ...(role === 'fan-out' ? { count: fanOutCount(classification) } : {}),
      primary,
      alternatives,
    });
  }

  // Handoff-chain invariant: terra / GPT-5.5 may implement ONLY from a plan
  // written by a smarter model. If one of them won the implementer slot and no
  // planner is on the team, add one rather than silently breaking the chain.
  const implementer = roles.find(item => item.role === 'implementer');
  if (implementer && MODELS[implementer.primary.model].needsPlan && !roles.some(item => item.role === 'planner')) {
    const ranked = candidatesFor('planner', pool, classification, budget, usageByBinary, task, options.label);
    const floor = primaryFloor('planner', classification, budget);
    const eligible = ranked.filter(option => MODELS[option.model].power >= floor);
    if (eligible.length > 0) {
      roles.unshift({
        role: 'planner',
        why: `${implementer.primary.modelLabel} implements only against a plan from a smarter model — that plan is this role`,
        primary: eligible[0]!,
        alternatives: eligible.slice(1, 4),
      });
    } else {
      warnings.push(
        `${implementer.primary.modelLabel} must not plan its own work, and no planner-tier account is available — ` +
          'write the plan in the lead thread first',
      );
    }
  }

  const evidenceWords = classification.evidence
    .filter(item => item.matched.length > 0)
    .map(item => `${item.axis}=${item.value} (${item.matched.slice(0, 3).join(', ')})`);
  const reasoning =
    `Read as ${classification.complexity} ${classification.kind} work, ${classification.risk} risk, ` +
    `${classification.size} scope, ${classification.ambiguity} ambiguity` +
    `${classification.productFacing ? ', product-facing' : ''}` +
    `${evidenceWords.length ? ` — from ${evidenceWords.join('; ')}` : ' — no strong keyword signal, defaults applied'}` +
    `. Team shape: ${roles.map(item => item.role).join(' → ') || 'none'}.`;

  return { task, budget, classification, reasoning, roles, exclusions, warnings };
}

/** Back-compat flat view of {@link recommendTeam} for callers that only want
 *  "which wrapper, which role, why" (the pre-rewrite shape). */
export function recommendAgents(task: string, agents: string[], usage: AgentUsage[] = []): Recommendation[] {
  return recommendTeam(task, agents, { usage }).roles.map(item => ({
    binary: item.primary.binary,
    role: item.role,
    reason: `${item.primary.modelLabel}: ${item.why}`,
  }));
}

/** The Remote Control shape, as kfleet declares it for the `crc-*` alias
 *  (`aliases.crc.claude: --dangerously-skip-permissions --chrome --rc`). We add
 *  the flags to OUR launcher rather than launching the `crc-*` binary: `crc-x`
 *  is literally `exec claude-x --dangerously-skip-permissions --chrome --rc "$@"`,
 *  so the two are identical in effect — but the alias is optional in kfleet
 *  config (not every account has one), kteam resolves the wrapper, its
 *  CLAUDE_CONFIG_DIR and its KTEAM_MODEL from the `claude-auto-*` name, and
 *  `--dangerously-skip-permissions` is already in our arg list. Appending
 *  keeps one launch path and one wrapper-resolution path.
 *
 *  `--rc` is claude's documented alias for `--remote-control [name]` (verified
 *  in the 2.1.219 bundle's flag table). The name is left AUTO-generated and only
 *  the prefix is pinned, so the RC surface labels the session with the teammate
 *  it belongs to while claude still guarantees uniqueness — passing a fixed name
 *  would collide across relaunches of the same session. */
export function remoteControlArgs(config: Pick<SessionConfig, 'harness' | 'teammate' | 'id'>): string[] {
  if (config.harness !== 'claude') return [];
  return ['--chrome', '--rc', '--remote-control-session-name-prefix', `kteam-${config.teammate ?? config.id}`];
}

/** Title-case a teammate callsign slug for display: "hayden" -> "Hayden",
 *  "mary-jane" -> "Mary-Jane". Slugs are lowercase letters/digits/hyphens, so
 *  capitalising the first letter of each hyphen segment is the whole job. */
function titleCaseTeammate(slug: string): string {
  return slug
    .split('-')
    .map(part => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join('-');
}

/** The display title kteam hands the harness (Claude's `--name`) so the RC
 *  surface — claude.ai/code and the resume picker — shows the SAME
 *  "[Teammate] Task" title as kteam's own TASK column.
 *
 *  - A task title that already opens with "[" is used VERBATIM. This keeps the
 *    prefixing IDEMPOTENT: a caller that (for whatever reason) hands us an
 *    already-composed "[Team] Task" — or any title that legitimately starts with
 *    a bracket — is passed through untouched instead of being double-prefixed
 *    into "[Team] [Team] …". Callers are now expected to pass a PLAIN task title
 *    and let this function add the "[Team]"; this guard is the safety net that
 *    keeps a stray pre-bracketed title from doubling. Keep it — its correctness
 *    stands on its own (bracket idempotency), independent of any caller.
 *  - Otherwise the Title-Cased teammate is prefixed: "hayden" + "Fix Login" ->
 *    "[Hayden] Fix Login".
 *  - With no task title, the bracketed teammate alone is the name.
 *  - With neither, returns undefined so the caller passes NO --name (an empty
 *    flag value is worse than an unnamed session). */
export function harnessDisplayName(config: { teammate?: string; name?: string }): string | undefined {
  const task = config.name?.trim();
  const teammate = config.teammate?.trim();
  const prefix = teammate ? `[${titleCaseTeammate(teammate)}]` : undefined;
  if (task && task.startsWith('[')) return task;
  if (task && prefix) return `${prefix} ${task}`;
  return task || prefix;
}

/** Resolve the parent session for a `kteam start`.
 *
 *  - An EXPLICIT `--parent <id>` always wins — the capability to parent any
 *    session (even an interactive one) is preserved for anyone who asks for it.
 *  - An `auto` teammate started from inside a pane INHERITS that pane
 *    (`KTEAM_SESSION_ID`) as its parent, so delegated teammate trees draw
 *    correctly in `ps`/UI and warden lineage.
 *  - An `interactive` session does NOT auto-inherit. It is the HUMAN's own
 *    terminal; the calling agent merely typed the `kteam start`. Parenting the
 *    user's own session under whichever agent happened to invoke it renders it
 *    backwards in the lineage sidebar (nested under an agent) — misleading now
 *    that lineage is visible. So env inheritance is gated to auto mode. */
export function resolveParent(opts: {
  explicit?: string;
  envSessionId?: string;
  mode: 'auto' | 'interactive';
}): string | undefined {
  const explicit = opts.explicit?.trim();
  if (explicit) return explicit;
  if (opts.mode === 'interactive') return undefined;
  return opts.envSessionId?.trim() || undefined;
}

export function interactiveHarnessArgs(config: SessionConfig): string[] {
  // Both harnesses take `--model <alias|id>`. When set it's the user override or
  // the wrapper's kfleet default (KTEAM_MODEL); when unset, omit it entirely.
  const model = config.model ? ['--model', config.model] : [];
  const extra = config.harnessFlags ?? [];

  if (config.harness === 'claude') {
    const sessionFlag = config.turn === 1 ? '--session-id' : '--resume';
    const args = ['--dangerously-skip-permissions', sessionFlag, config.harnessSessionId, ...model];
    // Name the session on Claude's side too — one argv element, so tmux-
    // controller's single-quote `quote()` keeps the spaces and [brackets]
    // intact. `--name` is a global flag accepted with BOTH --session-id and
    // --resume (verified: `--resume <id> --name …` fails only on a missing
    // session, never on the flag), so a relaunch after `kteam rename` re-applies
    // the current title.
    const displayName = harnessDisplayName(config);
    if (displayName) args.push('--name', displayName);
    if (config.mode === 'auto') args.push('--disallowedTools', 'AskUserQuestion');
    // RC composes with everything above: the session-id correlation, the model
    // flag and the automode tool ban are untouched — RC only adds a second
    // control surface onto the same TUI.
    if (config.remoteControl) args.push(...remoteControlArgs(config));
    return [...args, ...extra];
  }

  if (config.turn === 1) {
    return [...model, '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen', ...extra];
  }
  // `resume` is a subcommand and must stay first; the model flag follows it, and
  // the session id must stay LAST (positional) — extra flags go before it.
  return [
    'resume',
    ...model,
    '--dangerously-bypass-approvals-and-sandbox',
    '--no-alt-screen',
    ...extra,
    config.harnessSessionId,
  ];
}

export function shellSafeSessionName(id: string, suffix: string): string {
  return `kteam-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${suffix}`.slice(0, 80);
}

/** Context window for a model id, for transcript-based context accounting.
 *  Overrides (daemon config `contextWindows`) match by substring, longest
 *  pattern first, so specific ids beat family names. Built-ins: the `[1m]`
 *  suffix marks 1M-context Claude models; everything else defaults 200k. */
export function contextWindowForModel(model: string | undefined, overrides?: Record<string, number>): number {
  if (model && overrides) {
    const patterns = Object.keys(overrides)
      .filter(pattern => model.includes(pattern))
      .sort((a, b) => b.length - a.length);
    if (patterns.length > 0) return overrides[patterns[0]!]!;
  }
  if (model?.includes('[1m]')) return 1_000_000;
  return 200_000;
}

/** Context window for a LIVE session, resolving the `[1m]` asymmetry.
 *
 *  `[1m]` is a wrapper-alias convention that lives ONLY in `config.model`
 *  (`claude-opus-4-8[1m]`). The raw model id the harness records in its own
 *  transcript/usage records is always stripped of it — a live `[1m]` session
 *  reports `message.model = 'claude-opus-4-8'`, no suffix. So keying the 1M
 *  determination on the served/observed model (as the naive
 *  `contextWindowForModel(servedModel)` did) assigns every Claude `[1m]` session
 *  a 200k window and inflates its context percentage ~5x.
 *
 *  Precedence, mirroring the old caller chain plus the fix:
 *   1. `reportedWindow` — a harness that reports its own window is ground truth
 *      (Codex reports `model_context_window` accurately); trust it verbatim.
 *   2. `overrides` (daemon `contextWindows`) — real windows for GLM / MiniMax /
 *      DeepSeek, matched by substring against the SERVED model (aliases already
 *      resolved), longest pattern first. Overrides intentionally beat `[1m]`.
 *   3. `[1m]` marker — checked on `config.model`, which is the only string that
 *      still carries it. The served model is checked too, purely defensively.
 *   4. default 200k. */
export function contextWindowForSession(args: {
  configModel?: string;
  servedModel?: string;
  reportedWindow?: number;
  overrides?: Record<string, number>;
}): number {
  const { configModel, servedModel, reportedWindow, overrides } = args;
  if (typeof reportedWindow === 'number' && reportedWindow > 0) return reportedWindow;
  const forOverride = servedModel?.trim() || configModel?.trim();
  if (forOverride && overrides) {
    const patterns = Object.keys(overrides)
      .filter(pattern => forOverride.includes(pattern))
      .sort((a, b) => b.length - a.length);
    if (patterns.length > 0) return overrides[patterns[0]!]!;
  }
  if (configModel?.includes('[1m]') || servedModel?.includes('[1m]')) return 1_000_000;
  return 200_000;
}
