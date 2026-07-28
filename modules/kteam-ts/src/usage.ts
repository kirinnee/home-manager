import type { AgentUsage } from './core';
import type { SessionState } from './types';

/** `kfleet usage.interval` is 300 seconds. The daemon shares one refresh
 *  across every session instead of multiplying probes by the fleet size. */
export const USAGE_REFRESH_MS = 300_000;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Fallback = () => Promise<AgentUsage[] | undefined>;

export interface UsageFeedOptions {
  fetcher?: Fetcher;
  fallback?: Fallback;
  now?: () => number;
  refreshMs?: number;
}

const usageAccounts = (payload: unknown): AgentUsage[] | undefined => {
  const raw = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { accounts?: unknown }).accounts)
      ? (payload as { accounts: unknown[] }).accounts
      : undefined;
  return raw?.filter(
    (account): account is AgentUsage =>
      typeof account === 'object' && account !== null && typeof (account as AgentUsage).binary === 'string',
  );
};

/** CLI fallback for hosts where `kfleet serve` is not running. UsageFeed calls
 *  this at most once per refresh interval for the whole daemon. */
export async function fetchKfleetUsage(command = 'kfleet'): Promise<AgentUsage[] | undefined> {
  try {
    // `--all` is billing-critical: without it kfleet intentionally hides raw
    // API-metered accounts (`usageBased:false`) from the human quota display.
    // The daemon needs those explicit false rows so the cost surface can
    // distinguish API billing from a missing/unknown account.
    const child = Bun.spawn([command, 'usage', '--json', '--all', '--no-relogin'], {
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (exitCode !== 0) return undefined;
    return usageAccounts(JSON.parse(output));
  } catch {
    return undefined;
  }
}

/** Cached view of kfleet's already-refreshed `/usage` feed. Concurrent readers
 *  share one request; failed refreshes retain the last good snapshot. */
export class UsageFeed {
  private cached?: { at: number; accounts: AgentUsage[] };
  private pending?: Promise<AgentUsage[]>;
  private retryAfter = 0;
  private readonly fetcher: Fetcher;
  private readonly fallback?: Fallback;
  private readonly clock: () => number;
  private readonly refreshMs: number;

  constructor(
    private readonly url: string,
    options: UsageFeedOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.fallback = options.fallback;
    this.clock = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? USAGE_REFRESH_MS;
  }

  hasSnapshot(): boolean {
    return this.cached !== undefined;
  }

  /** Epoch ms of the last successful refresh, or undefined before the first.
   *  The API surfaces this so the UI can say "as of …" rather than implying
   *  the numbers are live. */
  snapshotAt(): number | undefined {
    return this.cached?.at;
  }

  async accounts(signal?: AbortSignal): Promise<AgentUsage[]> {
    if (signal?.aborted) return [];
    const at = this.clock();
    if (this.cached && at - this.cached.at < this.refreshMs) return this.cached.accounts;
    if (at < this.retryAfter) return this.cached?.accounts ?? [];

    const pending = this.pending ?? this.refresh();
    this.pending = pending;
    try {
      const accounts = await pending;
      return signal?.aborted ? [] : accounts;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  private async refresh(): Promise<AgentUsage[]> {
    let accounts: AgentUsage[] | undefined;
    try {
      const response = await this.fetcher(this.url, { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error(`usage feed returned HTTP ${response.status}`);
      accounts = usageAccounts(await response.json());
    } catch {}
    if ((accounts === undefined || accounts.length === 0) && this.fallback) {
      const fallback = await this.fallback().catch(() => undefined);
      if (fallback !== undefined) accounts = fallback;
    }
    if (accounts === undefined) {
      this.retryAfter = this.clock() + this.refreshMs;
      return this.cached?.accounts ?? [];
    }
    this.cached = { at: this.clock(), accounts };
    this.retryAfter = 0;
    return accounts;
  }
}

/** Providers whose credential is an OAuth login — the only class `kfleet login`
 *  can fix. Everything else is a static API key that `kfleet login` SKIPS
 *  (`cli/login.ts` filters to `oauth` identities), so telling the user to log in
 *  is a no-op for those accounts. */
const OAUTH_PROVIDERS = new Set(['anthropic', 'codex']);

/** The ACHIEVABLE remedy for an account kfleet reports as auth-failed, chosen by
 *  the account's provider so we never hand out advice that is impossible for that
 *  account class. OAuth (anthropic/codex) → `kfleet login`; API-key (minimax/zai)
 *  → rotate the key in sops, since `kfleet login` cannot touch it. Unknown/absent
 *  provider → name both paths rather than guess wrong. */
export function authFailureRemedy(provider?: string): string {
  if (provider && OAUTH_PROVIDERS.has(provider)) return 'run `kfleet login`';
  if (provider === 'minimax') return 'rotate $MINIMAX_API_KEY in sops (secrets.yaml), then run `kfleet apply`';
  if (provider === 'zai') return "rotate the account's z.ai API key in sops (secrets.yaml), then run `kfleet apply`";
  return 'for an API-key account rotate its key in sops then `kfleet apply`; for an OAuth account run `kfleet login`';
}

const percent = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
const timestamp = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/** Normalize one wrapper record without ever turning absent/error data into 0%.
 *  `ok:false` records are treated as authentication failures, matching the
 *  launch preflight contract, and their placeholder usage numbers are hidden. */
export function quotaFromUsage(account: AgentUsage): NonNullable<SessionState['quota']> {
  // kfleet emits raw API-metered rows as `usageBased:false, ok:false`: no
  // quota probe was attempted because there is no subscription window. That
  // is positive billing evidence, not an authentication failure.
  const authOk = account.usageBased === false ? account.authOk : account.ok === false ? false : account.authOk;
  const usable = account.ok !== false && account.usageBased !== false && authOk !== false;
  const fiveHourPercent = usable ? percent(account.fiveHourPercent) : undefined;
  const weeklyPercent = usable ? percent(account.weeklyPercent) : undefined;
  const fiveHourResetAt = usable ? timestamp(account.fiveHourResetAt) : undefined;
  const weeklyResetAt = usable ? timestamp(account.weeklyResetAt) : undefined;
  const resets = [fiveHourResetAt, weeklyResetAt].filter((value): value is number => value !== undefined);
  return {
    ...(typeof account.usageBased === 'boolean' ? { usageBased: account.usageBased } : {}),
    ...(usable && typeof account.atLimit === 'boolean' ? { atLimit: account.atLimit } : {}),
    ...(authOk !== undefined ? { authOk } : {}),
    ...(account.provider ? { provider: account.provider } : {}),
    ...(fiveHourPercent !== undefined ? { fiveHourPercent } : {}),
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
    ...(fiveHourResetAt !== undefined ? { fiveHourResetAt } : {}),
    ...(weeklyResetAt !== undefined ? { weeklyResetAt } : {}),
    ...(resets.length ? { resetAt: Math.min(...resets) } : {}),
  };
}

/** Project one feed record into the wire shape the browser consumes. Reuses
 *  quotaFromUsage so the API can never disagree with what the session state
 *  and `kteam ps` show — same normalization, same "unknown is not zero" and
 *  "auth failure is not a quota" rules, one place. */
export function usageAccountView(account: AgentUsage): { binary: string } & NonNullable<SessionState['quota']> {
  const { resetAt: _resetAt, ...quota } = quotaFromUsage(account);
  return { binary: account.binary, ...quota };
}

export interface SessionUsageStatePatch {
  usage5hPercent: number | undefined;
  usageWeeklyPercent: number | undefined;
  usage5hResetAt: number | undefined;
  usageWeeklyResetAt: number | undefined;
  usageAtLimit: boolean | undefined;
  usageAuthOk: boolean | undefined;
}

/** Explicit undefined values are intentional: a newly-invalid feed record must
 *  clear stale percentages from state instead of displaying a fake old value. */
export function usageStateFromQuota(quota: NonNullable<SessionState['quota']>): SessionUsageStatePatch {
  const authenticated = quota.authOk !== false;
  return {
    usage5hPercent: authenticated ? quota.fiveHourPercent : undefined,
    usageWeeklyPercent: authenticated ? quota.weeklyPercent : undefined,
    usage5hResetAt: authenticated ? quota.fiveHourResetAt : undefined,
    usageWeeklyResetAt: authenticated ? quota.weeklyResetAt : undefined,
    usageAtLimit: authenticated ? quota.atLimit : undefined,
    usageAuthOk: quota.authOk,
  };
}

/** Defined usage fields for websocket payloads; unknown values stay omitted. */
export function usageEventData(state: SessionState): Record<string, number | boolean> {
  return {
    ...(state.usage5hPercent !== undefined ? { usage5hPercent: state.usage5hPercent } : {}),
    ...(state.usageWeeklyPercent !== undefined ? { usageWeeklyPercent: state.usageWeeklyPercent } : {}),
    ...(state.usage5hResetAt !== undefined ? { usage5hResetAt: state.usage5hResetAt } : {}),
    ...(state.usageWeeklyResetAt !== undefined ? { usageWeeklyResetAt: state.usageWeeklyResetAt } : {}),
    ...(state.usageAtLimit !== undefined ? { usageAtLimit: state.usageAtLimit } : {}),
    ...(state.usageAuthOk !== undefined ? { usageAuthOk: state.usageAuthOk } : {}),
  };
}

type UsageDisplayState = Pick<SessionState, 'usage5hPercent' | 'usageWeeklyPercent' | 'usageAtLimit' | 'usageAuthOk'>;

export function usageQuotaLabel(state: UsageDisplayState): string | undefined {
  if (state.usageAuthOk === false) return 'AUTH REQUIRED';
  const parts = [
    state.usage5hPercent !== undefined ? `5h ${state.usage5hPercent}%` : '',
    state.usageWeeklyPercent !== undefined ? `wk ${state.usageWeeklyPercent}%` : '',
    state.usageAtLimit === true ? 'AT LIMIT' : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

export function compactUsageQuota(state: UsageDisplayState): string {
  if (state.usageAuthOk === false) return 'AUTH!';
  if (state.usage5hPercent === undefined && state.usageWeeklyPercent === undefined) return '—';
  const fiveHour = state.usage5hPercent === undefined ? '—' : `${state.usage5hPercent}%`;
  const weekly = state.usageWeeklyPercent === undefined ? '—' : `${state.usageWeeklyPercent}%`;
  return `${fiveHour}/${weekly}${state.usageAtLimit === true ? '!' : ''}`;
}
