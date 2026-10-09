import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type { Harness, SessionConfig, SessionState } from './types';
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
  if (base.startsWith('glm52')) return 'GLM-5.3';
  if (base.startsWith('dsv4f')) return 'DeepSeek V4.1 Flash';
  if (base.startsWith('dsv4p')) return 'DeepSeek V4 Pro';
  if (base.startsWith('f5-') || base === 'loge') return 'F5/frontier account';
  return base;
}

/** Wrappers whose alias mapping makes the CONFIGURED model meaningless: their
 *  kfleet default is an alias (`opus`) that the proxy resolves to something
 *  else entirely, so `ps` showed `model=opus` for a pane running GLM-5.3. */
const WRAPPER_RESOLVED_MODEL: Array<[RegExp, string]> = [
  [/^claude-auto-glm52[ab]?$/, 'glm-5.3'],
  [/^claude-auto-mm3$/, 'minimax-m3'],
  [/^claude-auto-dsv4f$/, 'deepseek-flash'],
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
  /** Org overage / usage-credit pool utilization (0–100), for accounts that
   *  bill it instead of 5h/weekly windows. Counts only when `overageInUse`. */
  overagePercent?: number | null;
  overageResetAt?: number | null;
  overageInUse?: boolean;
  /** Set (to the reason) when kteam saw this account's interactive TUI demand
   *  usage-credit consent for Fable (model-availability.ts). Not from kfleet:
   *  `claude -p` serves Fable on such accounts, so only the TUI reveals it. */
  fableUnavailable?: string;
}

/** How "spent" an account is: the tighter of its 5h and weekly windows. */
export function usageScore(usage: AgentUsage | undefined): number {
  if (!usage) return 0;
  return Math.max(
    usage.fiveHourPercent ?? 0,
    usage.weeklyPercent ?? 0,
    usage.overageInUse === true ? (usage.overagePercent ?? 0) : 0,
  );
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
            : usage.availability === undefined && usage.error
              ? usage.error
              : 'proxy/provider unavailable';
  const retry = typeof usage.retryAt === 'number' ? ` (retry after ${new Date(usage.retryAt).toISOString()})` : '';
  return `${reason}${retry}`;
}

// ---------------------------------------------------------------------------
// `kteam recommend` — decision guide (the CLI-facing behavior)
// ---------------------------------------------------------------------------

/** The ONLY models kteam routes to. The owner (2026-10-09): "always use
 *  opus5.5, or sonnet 5.5 or haiku 5.5 — that's the best 3". Fable, the codex
 *  GPT models, GLM, MiniMax and DeepSeek stay DEFINED as wrappers for manual
 *  use, but nothing in kteam recommends or auto-selects them. `alias` is the
 *  `--model` value on direct Anthropic accounts; `proxyId` is the real id the
 *  claude-auto-loge CLIProxyAPI lane needs (raw CLIProxyAPI has no aliases). */
export const ROUTING_MODELS = [
  { model: 'Opus 5.5', alias: 'opus', proxyId: 'claude-opus-5-5[1m]' },
  { model: 'Sonnet 5.5', alias: 'sonnet', proxyId: 'claude-sonnet-5-5[1m]' },
  { model: 'Haiku 5.5', alias: 'haiku', proxyId: 'claude-haiku-5-5' },
] as const;

export type RoutingModel = (typeof ROUTING_MODELS)[number]['model'];

export interface RoutingDoctrineModel {
  model: RoutingModel;
  caution?: string;
}

export interface RoutingDoctrineRow {
  work: string;
  /** Preference order, left to right. */
  models: RoutingDoctrineModel[];
}

/** Human-authored routing doctrine, encoded as editable data. 2026-10-09: the
 *  owner restricted routing to the three Claude 5.5 models — Opus 5.5 plans,
 *  takes the hardest/most critical implementation and reviews; Sonnet 5.5 is
 *  the generic implementer; Haiku 5.5 takes trivial/mechanical work. */
export const ROUTING_DOCTRINE: RoutingDoctrineRow[] = [
  {
    work: 'Planning — normal and mission-critical (where a blindspot causes large rework or impact)',
    models: [{ model: 'Opus 5.5' }],
  },
  { work: 'Hardest / most critical implementation', models: [{ model: 'Opus 5.5' }] },
  { work: 'Review', models: [{ model: 'Opus 5.5' }] },
  {
    work: 'Generic implementation and mid-complexity work (incl. research, docs/HTML)',
    models: [{ model: 'Sonnet 5.5' }, { model: 'Opus 5.5', caution: 'when it proves harder than expected' }],
  },
  {
    work: 'Trivial / mechanical',
    models: [{ model: 'Haiku 5.5' }, { model: 'Sonnet 5.5', caution: 'when Haiku stumbles' }],
  },
];

/** Named policy constants: these numbers must never be buried in scoring code. */
export const LOGE_SELECTION_WEIGHT = 9;
export const NON_LOGE_SELECTION_WEIGHT = 1;
export const LOGE_WEEKLY_REMAINING_FLOOR_PERCENT = 15;
export const LOGE_WEEKLY_UTILIZATION_CUTOFF_PERCENT = 100 - LOGE_WEEKLY_REMAINING_FLOOR_PERCENT;

/** The Claude wrappers whose interactive TUI offers Fable (2026-10-08): liftoff
 *  (native `fable` alias) and the loge CLIProxyAPI lane (real id). Only the
 *  manual model picker uses this — Fable is not a routing target. */
export const FABLE_ACCOUNTS = ['claude-auto-liftoff', 'claude-auto-loge'] as const;
/** The loge proxy has no aliases, so Fable is requested by its real 1M id. */
export const FABLE_PROXY_MODEL_ID = 'claude-fable-5-1[1m]';

export const MODEL_ALLOWLIST_GUARD = {
  rule:
    'Route ONLY to Opus 5.5, Sonnet 5.5 or Haiku 5.5. Never Fable, GPT (codex), GLM, MiniMax or DeepSeek — ' +
    'those wrappers are for manual use only.',
  models: ROUTING_MODELS.map(item => item.model),
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
] as const;

/** Wrappers that cannot serve a ROUTING_MODELS model: they stay installed for
 *  manual use, but recommend and every automatic failover skip them. */
const NON_ROUTING_WRAPPERS: Array<{ match: RegExp; reason: string }> = [
  { match: /^codex-/, reason: 'Codex (GPT) wrapper — kteam routes only Opus/Sonnet/Haiku 5.5; manual use only' },
  {
    match: /^claude-auto-(?:glm52[ab]?|mm3|dsv4[fp])$/,
    reason: 'GLM/MiniMax/DeepSeek provider wrapper — not a Claude 5.5 model; manual use only',
  },
];

/** Why `binary` must never be routed to (hard exclusion or non-Claude-5.5
 *  wrapper), or undefined when it is a valid routing/failover target. */
export function routingExclusionReason(binary: string): string | undefined {
  const base = path.basename(binary);
  return (
    HARD_ACCOUNT_EXCLUSIONS.find(item => item.binary === base)?.reason ??
    NON_ROUTING_WRAPPERS.find(item => item.match.test(base))?.reason
  );
}

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
    'Pick the model with `--model`: on direct Anthropic accounts use the alias ' +
      `(${ROUTING_MODELS.map(item => item.alias).join(' / ')}); on claude-auto-loge (CLIProxyAPI, no aliases) ` +
      `use the real id (${ROUTING_MODELS.map(item => item.proxyId).join(' / ')}).`,
    'Codex, GLM, MiniMax and DeepSeek wrappers are never routing targets, even when they have headroom.',
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
  /** In-use overage-pool utilization; null when the account has no in-use
   *  overage reading (then the 5h/weekly fields are what matter). */
  overagePercent: number | null;
  overageResetAt: number | null;
  /** null means the threshold cannot be evaluated from real weekly quota. */
  logePreferenceEligible: boolean | null;
  probeError: string | null;
}

export interface RecommendationDecisionGuide {
  schemaVersion: 2;
  kind: 'decision-guide';
  task: string;
  decisionOwner: 'calling-agent';
  doctrine: {
    rows: RoutingDoctrineRow[];
    modelGuard: typeof MODEL_ALLOWLIST_GUARD;
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
  if (routingExclusionReason(binary)) return 'never-route';
  if (/^claude-auto-loge(?:[1-6])?$/.test(binary)) return 'loge';
  if ((ACCOUNT_SELECTION_POLICY.ownAccountFallbacks as readonly string[]).includes(account)) return 'own-fallback';
  return 'other';
};

function usabilityFor(
  binary: string,
  usage: AgentUsage | undefined,
  usageProbed: boolean,
): { usable: RecommendationUsability; reason: string } {
  const excluded = routingExclusionReason(binary);
  if (excluded) return { usable: 'unusable', reason: excluded };
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
  // An account billing an overage pool has no 5h/weekly windows; its in-use
  // overage reading is the complete quota verdict.
  const completeQuota =
    (percentOrNull(usage.fiveHourPercent) !== null && percentOrNull(usage.weeklyPercent) !== null) ||
    (usage.overageInUse === true && percentOrNull(usage.overagePercent) !== null);
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
  const unique = [...new Set(agents)].sort();
  // Non-routing wrappers (codex/GLM/MiniMax/DeepSeek, daily drivers) are not
  // offered as accounts at all; they appear only in hardExclusions.
  const excluded = new Map(HARD_ACCOUNT_EXCLUSIONS.map(item => [item.binary as string, item.reason as string]));
  for (const binary of unique) {
    const reason = routingExclusionReason(binary);
    if (reason) excluded.set(binary, reason);
  }
  const accounts = unique
    .filter(binary => !excluded.has(binary))
    .map((binary): RecommendationAccountState => {
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
      const overagePercent = numericalQuota && feed?.overageInUse === true ? percentOrNull(feed.overagePercent) : null;
      const overageResetAt = overagePercent === null ? null : timestampOrNull(feed?.overageResetAt);
      // The loge cutoff is about the pool the account actually spends; for an
      // overage-billed account that is the overage pool, not a weekly window.
      const logePoolPercent = weeklyPercent ?? overagePercent;
      const verdict = usabilityFor(binary, feed, usageProbed);
      return {
        binary,
        account,
        pool,
        usable: verdict.usable,
        usabilityReason: verdict.reason,
        provider: feed?.provider ?? null,
        quotaState: !usageProbed
          ? 'skipped'
          : fiveHourPercent !== null || weeklyPercent !== null || overagePercent !== null
            ? 'live'
            : 'unknown',
        fiveHourPercent,
        weeklyPercent,
        weeklyRemainingPercent,
        weeklyResetAt,
        weeklyResetAtIso: weeklyResetAt === null ? null : new Date(weeklyResetAt).toISOString(),
        overagePercent,
        overageResetAt,
        logePreferenceEligible:
          pool !== 'loge' || logePoolPercent === null ? null : logePoolPercent < LOGE_WEEKLY_UTILIZATION_CUTOFF_PERCENT,
        probeError: usageProbed ? (feed?.error ?? null) : null,
      };
    });

  const anyRealNumbers = accounts.some(
    account => account.fiveHourPercent !== null || account.weeklyPercent !== null || account.overagePercent !== null,
  );
  const warnings = !usageProbed
    ? ['Quota inputs are missing because --no-usage skipped probing; every quota field is unknown.']
    : anyRealNumbers
      ? []
      : ['The usage feed returned no real 5h/weekly values; quota fields are unknown, not zero.'];

  return {
    schemaVersion: 2,
    kind: 'decision-guide',
    task,
    decisionOwner: 'calling-agent',
    doctrine: {
      rows: ROUTING_DOCTRINE.map(row => ({ ...row, models: row.models.map(model => ({ ...model })) })),
      modelGuard: MODEL_ALLOWLIST_GUARD,
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
    hardExclusions: [...excluded].map(([binary, reason]) => ({ binary, reason })),
    instructions: [
      'Match the work to the routing-doctrine row; use its model order as the capability preference.',
      `Route only to ${MODEL_ALLOWLIST_GUARD.models.join(', ')} — never any other model, whatever its headroom.`,
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
        `(remaining ${remaining}); weekly reset ${reset}` +
        (account.overagePercent === null
          ? ''
          : `; overage ${formatQuotaPercent(account.overagePercent)} (reset ${
              account.overageResetAt === null ? 'unknown' : new Date(account.overageResetAt).toISOString()
            })`) +
        `${preference}; ${account.usabilityReason}`
      );
    }),
    '',
    'Hard exclusions:',
    ...guide.hardExclusions.map(item => `  - ${item.binary}: ${item.reason}`),
    '',
    `Model guard: ${guide.doctrine.modelGuard.rule}`,
  ];
  if (guide.warnings.length) lines.push('', 'Warnings:', ...guide.warnings.map(warning => `  - ${warning}`));
  lines.push('', ...guide.instructions.map((instruction, index) => `${index + 1}. ${instruction}`));
  return lines.join('\n');
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
    const sessionFlag = config.turn === 1 || config.harnessSessionFresh ? '--session-id' : '--resume';
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

/** The STATUS cell of `kteam ps`. A declared park reports the same 'waiting'
 *  status as an unanswered question; the marker is the only fleet-level way to
 *  tell them apart, and a PEER park says who it is on. A session merely
 *  detached by a daemon restart is `failed (resumable)` — plain `failed` read
 *  as lost work and invited duplicate re-spawns. */
export function psStatusLabel(state: Pick<SessionState, 'status' | 'waiting' | 'resumable'>): string {
  if (state.waiting)
    return `${state.status} PARKED${state.waiting.peer ? `←${state.waiting.peerName ?? state.waiting.peer}` : ''}`;
  if (state.resumable && state.status === 'failed') return 'failed (resumable)';
  return state.status;
}
