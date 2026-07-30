// Account usage/quota probing. For every resolved agent we work out whether it's
// a usage-windowed subscription account (Anthropic OAuth, z.ai GLM coding plan, or
// Codex/ChatGPT) and, if so, fetch its 5-hour and weekly utilization. Stored
// Anthropic OAuth credentials use the read-only usage endpoint. Declared external
// Anthropic credentials lack that endpoint's scope, so they make one minimal Haiku
// inference request (max_tokens:1) and read the response quota headers instead.
//
// Probes are deduped by CREDENTIAL: many wrappers share one credential (e.g. every
// z.ai wrapper using $ZAI_API_KEY_A, or two claude wrappers pointing at the same
// OAuth keychain entry). We probe each unique credential once and fan the result
// back out to every binary that uses it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { probeCLIProxyUsage, type CLIProxyAvailability, type CLIProxyUnavailableReason } from './cliproxy-usage';
import { jwtExpMs, readClaudeCred } from './creds';
import { KIND_SPECS } from './kinds';
import { type Identity, isOAuth, pickDonor, scanIdentities, syncIdentity } from './login';
import { resolveAll } from './merge';
import type { Config, Kind, ResolvedAgent } from './types';

export { jwtExpMs } from './creds'; // re-export: existing consumers/tests import it from here

export type UsageProvider = 'anthropic' | 'codex' | 'zai' | 'minimax' | 'cliproxy';

/** Per-account usage snapshot. One per resolved agent (binary). */
export interface AccountUsage {
  binary: string; // e.g. "claude-auto-opus48"
  kind: Kind;
  name: string; // resolved name, e.g. "auto-opus48"
  account?: string; // login identity (base agent) this binary belongs to, e.g. "kirin"
  provider: UsageProvider | null; // null = not a tracked/usage-windowed account
  usageBased: boolean; // true iff numerical subscription windows exist (CLIProxy availability stays false)
  ok: boolean; // probe attempted AND succeeded
  error?: string; // short reason when !ok
  unavailable?: boolean; // true when a configured usage account is definitely unusable (e.g. missing token)
  /** Runtime availability for providers such as CLIProxyAPI that have no numerical usage window. */
  availability?: CLIProxyAvailability;
  unavailableReason?: CLIProxyUnavailableReason;
  retryAt?: number; // epoch ms of the next known proxy retry/recovery
  authOk?: boolean; // logged in? true=creds present/valid, false=missing/rejected, undefined=couldn't tell
  fiveHourPercent?: number; // 0–100 utilization of the 5h window
  weeklyPercent?: number; // 0–100 utilization of the weekly/long window
  fiveHourResetAt?: number; // epoch ms the 5h window resets (when known)
  weeklyResetAt?: number; // epoch ms the weekly window resets (when known)
  atLimit: boolean; // 5h OR weekly ≥ atLimitPercent (exhausted)
}

/** The windowed result a single provider probe returns. */
interface Windows {
  ok: boolean;
  error?: string;
  unavailable?: boolean;
  authOk?: boolean;
  fiveHourPercent?: number;
  weeklyPercent?: number;
  fiveHourResetAt?: number;
  weeklyResetAt?: number;
  /** The provider explicitly rejected a quota window, even if its utilization
   *  value was malformed or temporarily exceeded the documented range. */
  providerAtLimit?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_AT_LIMIT = 100;

/** Expand a kfleet env value that may be a shell var ref ($VAR or ${VAR}). The
 *  serve/usage process is launched through direnv, so the real secrets are in
 *  process.env. A literal (non-$) value is returned as-is. */
function expandEnv(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!value) return undefined;
  const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value.trim());
  if (m) return env[m[1]!];
  return value;
}

function envRefName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value.trim())?.[1];
}

/** Parse an ISO-8601 timestamp to epoch ms, or undefined. */
function isoToMs(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** GET with a timeout; returns the parsed JSON body or throws. HTTP errors carry a
 *  `.status` so callers can tell an auth rejection (401/403) from a transient failure. */
async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw Object.assign(new Error(`http ${res.status}`), { status: res.status });
    return await res.json();
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`timeout after ${Math.round(timeoutMs / 1000)}s`);
    throw e; // preserve .status (and message) for the caller's auth verdict
  } finally {
    clearTimeout(timer);
  }
}

/** Map a thrown probe error to an auth verdict for a key-authenticated endpoint:
 *  401/403 ⇒ the credential was rejected (false); anything else (timeout, 5xx,
 *  network) ⇒ we can't tell (undefined). */
function authFromHttpError(e: unknown): boolean | undefined {
  const status = (e as { status?: number }).status;
  return status === 401 || status === 403 ? false : undefined;
}

/** auth_ok for an OAuth credential = it currently has a USABLE access token: present
 *  and not expired. An expired token counts as NOT usable — by the time we check, the
 *  pre-probe relogin has already had its chance to refresh it, so if it's STILL expired
 *  the refresh token is dead/revoked and the account needs an interactive re-login.
 *  (Some usage endpoints, e.g. codex, will still serve data on a stale token — so we
 *  must judge auth by token validity, not by whether the usage probe returned 200.)
 *  Exported for tests. */
export function oauthTokenUsable(
  creds: { accessToken?: string; expiresAt?: number },
  now: number = Date.now(),
): boolean {
  const expired = typeof creds.expiresAt === 'number' && creds.expiresAt <= now;
  return Boolean(creds.accessToken) && !expired;
}

// ---------------------------------------------------------------------------
// Per-provider probes
// ---------------------------------------------------------------------------

interface AnthropicStoredUsageBody {
  five_hour?: UtilWindow;
  seven_day?: UtilWindow;
}

/** Parse the stored OAuth endpoint's JSON unit. Its utilization values are
 *  percentage points already; keeping this conversion separate from inference
 *  headers prevents an accidental 100x rescale. Exported for source-unit tests. */
export function parseAnthropicStoredUsage(j: unknown): Omit<Windows, 'ok'> {
  const body = (j && typeof j === 'object' ? j : {}) as AnthropicStoredUsageBody;
  return {
    fiveHourPercent: percentOrUndef(body.five_hour?.utilization),
    weeklyPercent: percentOrUndef(body.seven_day?.utilization),
    fiveHourResetAt: isoToMs(body.five_hour?.resets_at),
    weeklyResetAt: isoToMs(body.seven_day?.resets_at),
  };
}

/** Query the first-party Anthropic OAuth usage endpoint with one exact stored
 *  credential. This GET is read-only and does not consume inference quota. */
async function probeAnthropicStoredToken(token: string, timeoutMs: number, authOk = true): Promise<Windows> {
  try {
    const j = await getJson(
      'https://api.anthropic.com/api/oauth/usage',
      { Authorization: `Bearer ${token}` },
      timeoutMs,
    );
    return {
      ok: true,
      authOk,
      ...parseAnthropicStoredUsage(j),
    };
  } catch (e) {
    // Anthropic uses 401 + `authentication_error` for an invalid bearer token.
    // A 403 can instead be an org/spend policy response from a token Claude Code
    // still reports as logged in, so it is inconclusive here (as are 429/5xx).
    // This preserves real auth failures without recreating the false exclusion.
    const rejected = (e as { status?: number }).status === 401;
    return { ok: false, error: (e as Error).message, authOk: rejected ? false : authOk };
  }
}

const ANTHROPIC_EXTERNAL_PROBE_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_EXTERNAL_PROBE_BODY = JSON.stringify({
  model: ANTHROPIC_EXTERNAL_PROBE_MODEL,
  max_tokens: 1,
  messages: [{ role: 'user', content: '.' }],
});
const ANTHROPIC_QUOTA_STATUSES = new Set(['allowed', 'rejected']);

interface ParsedAnthropicInferenceHeaders {
  windows: Omit<Windows, 'ok'>;
  hasValidQuotaHeader: boolean;
}

/** Parse ONE inference quota window. These utilization headers are fractions in
 *  the inclusive 0..1 range, unlike the stored OAuth JSON's 0..100 values. */
function parseAnthropicInferenceWindow(
  headers: Headers,
  window: '5h' | '7d',
): {
  percent?: number;
  resetAt?: number;
  rejected: boolean;
  hasQuotaSignal: boolean;
} {
  const prefix = `anthropic-ratelimit-unified-${window}-`;
  const rawStatus = headers.get(`${prefix}status`)?.trim().toLowerCase();
  const status = rawStatus && ANTHROPIC_QUOTA_STATUSES.has(rawStatus) ? rawStatus : undefined;

  const rawUtilization = headers.get(`${prefix}utilization`)?.trim();
  const utilization = rawUtilization ? Number(rawUtilization) : Number.NaN;
  const percent = Number.isFinite(utilization) && utilization >= 0 && utilization <= 1 ? utilization * 100 : undefined;

  const rawReset = headers.get(`${prefix}reset`)?.trim();
  const resetSeconds = rawReset ? Number(rawReset) : Number.NaN;
  const resetAt =
    Number.isFinite(resetSeconds) && resetSeconds >= 0 && resetSeconds <= Number.MAX_SAFE_INTEGER / 1000
      ? resetSeconds * 1000
      : undefined;

  return {
    percent,
    resetAt,
    rejected: status === 'rejected',
    // A reset timestamp or `allowed` label alone cannot prove utilization or
    // headroom. An explicit rejection is useful even when Anthropic reports an
    // over-1 utilization such as the observed 1.01 snapshot.
    hasQuotaSignal: percent !== undefined || status === 'rejected',
  };
}

function parseAnthropicInferenceHeaders(headers: Headers): ParsedAnthropicInferenceHeaders {
  const fiveHour = parseAnthropicInferenceWindow(headers, '5h');
  const weekly = parseAnthropicInferenceWindow(headers, '7d');
  return {
    windows: {
      fiveHourPercent: fiveHour.percent,
      weeklyPercent: weekly.percent,
      fiveHourResetAt: fiveHour.resetAt,
      weeklyResetAt: weekly.resetAt,
      providerAtLimit: fiveHour.rejected || weekly.rejected,
    },
    hasValidQuotaHeader: fiveHour.hasQuotaSignal || weekly.hasQuotaSignal,
  };
}

/** Declared external OAuth tokens are inference-scoped and permanently lack
 *  `user:profile`, so GET /api/oauth/usage cannot work for them. Make the
 *  smallest valid inference request and read its quota headers. A rate-limited
 *  429 is a successful quota probe when Anthropic still supplies valid headers. */
async function probeAnthropicExternalToken(token: string, timeoutMs: number): Promise<Windows> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: ANTHROPIC_EXTERNAL_PROBE_BODY,
      signal: ctrl.signal,
    });
    const parsed = parseAnthropicInferenceHeaders(res.headers);
    try {
      await res.body?.cancel();
    } catch {
      /* headers are complete; body cleanup is best-effort */
    }

    if (!res.ok && res.status !== 429) {
      const rejected = res.status === 401;
      return { ok: false, error: `http ${res.status}`, authOk: rejected ? false : true };
    }
    if (!parsed.hasValidQuotaHeader) {
      const prefix = res.ok ? '' : `http ${res.status}: `;
      return { ok: false, error: `${prefix}missing or invalid Anthropic quota headers`, authOk: true };
    }
    return { ok: true, authOk: true, ...parsed.windows };
  } catch (e) {
    if ((e as Error).name === 'AbortError')
      return { ok: false, error: `timeout after ${Math.round(timeoutMs / 1000)}s` };
    return { ok: false, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Anthropic subscription (OAuth) stored in the macOS Keychain / Linux
 *  .credentials.json keyed by config dir. Declared external-token agents bypass
 *  this function entirely: falling back to an unrelated stored credential would
 *  attach the wrong account's quota and auth verdict to that binary. */
async function probeAnthropic(configDir: string, timeoutMs: number): Promise<Windows> {
  const blob = await readClaudeCred(configDir, timeoutMs);
  if (!blob) return { ok: false, error: 'not logged in (no stored credential)', authOk: false };
  let creds: Record<string, unknown>;
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    creds = (parsed.claudeAiOauth as Record<string, unknown>) ?? parsed;
  } catch {
    return { ok: false, error: 'bad credential json', authOk: false };
  }
  const token = creds.accessToken as string | undefined;
  const expiresAt = creds.expiresAt as number | undefined;
  const expired = typeof expiresAt === 'number' && expiresAt <= Date.now();
  // auth_ok = a present, non-expired token. The pre-probe relogin refreshes a
  // refreshable token first, so a token still expired here means it's dead.
  const authOk = oauthTokenUsable({ accessToken: token, expiresAt });
  if (!token) return { ok: false, error: 'no access token', authOk };
  if (expired) return { ok: false, error: 'token expired', authOk };
  return await probeAnthropicStoredToken(token, timeoutMs, authOk);
}
interface UtilWindow {
  utilization?: number;
  resets_at?: string | null;
}

/** Codex (ChatGPT plan). Token + account id live in the codex config dir's
 *  auth.json; one GET returns both rate-limit windows. */
async function probeCodex(configDir: string, timeoutMs: number): Promise<Windows> {
  const authPath = path.join(configDir, 'auth.json');
  if (!existsSync(authPath)) return { ok: false, error: 'no auth.json', authOk: false };
  let auth: { tokens?: { access_token?: string; account_id?: string; refresh_token?: string } };
  try {
    auth = JSON.parse(readFileSync(authPath, 'utf8'));
  } catch {
    return { ok: false, error: 'bad auth.json', authOk: false };
  }
  const token = auth.tokens?.access_token;
  const account = auth.tokens?.account_id;
  // auth_ok = a present, non-expired token (JWT exp). The codex usage endpoint will
  // serve data on a STALE token, so we judge login by token validity, not the probe —
  // and the pre-probe relogin already tried to refresh a refreshable one.
  const authOk = oauthTokenUsable({ accessToken: token, expiresAt: jwtExpMs(token) });
  if (!token || !account) return { ok: false, error: 'no chatgpt token', authOk: false };
  try {
    const j = (await getJson(
      'https://chatgpt.com/backend-api/codex/usage',
      {
        Authorization: `Bearer ${token}`,
        'chatgpt-account-id': account,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
      },
      timeoutMs,
    )) as { rate_limit?: { primary_window?: CodexWindow; secondary_window?: CodexWindow } };
    const rl = j.rate_limit ?? {};
    return {
      ok: true,
      authOk, // NOT hard-true: the endpoint serves data on a stale token; trust JWT expiry.
      fiveHourPercent: percentOrUndef(rl.primary_window?.used_percent),
      weeklyPercent: percentOrUndef(rl.secondary_window?.used_percent),
      fiveHourResetAt: secToMs(rl.primary_window?.reset_at),
      weeklyResetAt: secToMs(rl.secondary_window?.reset_at),
    };
  } catch (e) {
    // codex auto-refreshes an expired token, so a transient 401 isn't logged-out;
    // keep the presence-based verdict from the durable tokens on disk.
    return { ok: false, error: (e as Error).message, authOk };
  }
}
interface CodexWindow {
  used_percent?: number;
  reset_at?: number; // epoch SECONDS
}

/** z.ai GLM coding plan. The raw API key (NO "Bearer") authorizes a monitor
 *  endpoint returning two windows; we map the soonest-resetting to "5h". */
async function probeZai(token: string, timeoutMs: number): Promise<Windows> {
  try {
    const j = (await getJson(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      { Authorization: token, 'Accept-Language': 'en-US,en', 'Content-Type': 'application/json' },
      timeoutMs,
    )) as { data?: { limits?: ZaiLimit[] } };
    const limits = j.data?.limits;
    if (!Array.isArray(limits) || limits.length === 0) return { ok: false, error: 'no limits in response' };
    // The endpoint doesn't label windows; order by reset horizon — soonest = the
    // short (5-hour) window, latest = the long (weekly) window. Compare without
    // subtraction so two missing reset times (Infinity − Infinity = NaN) don't make
    // the sort undefined.
    const sorted = [...limits].sort((a, b) => {
      const at = a.nextResetTime ?? Infinity;
      const bt = b.nextResetTime ?? Infinity;
      return at === bt ? 0 : at < bt ? -1 : 1;
    });
    const short = sorted[0]!;
    const long = sorted[sorted.length - 1]!;
    return {
      ok: true,
      authOk: true, // the key authorized the request
      fiveHourPercent: percentOrUndef(short.percentage),
      weeklyPercent: percentOrUndef(long.percentage),
      fiveHourResetAt: numOrUndef(short.nextResetTime),
      weeklyResetAt: numOrUndef(long.nextResetTime),
    };
  } catch (e) {
    // Pure API key: a 401/403 means the key is bad (not logged in); otherwise unknown.
    return { ok: false, error: (e as Error).message, authOk: authFromHttpError(e) };
  }
}
interface ZaiLimit {
  percentage?: number;
  nextResetTime?: number; // epoch MS
}

interface MinimaxBody {
  model_remains?: MinimaxRemains[];
  base_resp?: { status_code?: number; status_msg?: string };
}

/** MiniMax's `1004` ("login fail") and `2049` are its auth-verify codes. A
 *  genuinely bad/empty key returns one on EVERY probe — but a VALID key also
 *  receives them transiently under load/throttle (confirmed empirically: 60
 *  spaced probes of a working key over 45 min were all `status_code:0`, yet a
 *  single `1004` blip is what condemned the account). So one occurrence is not
 *  proof the credential is bad; only a REPEATED one is (see `probeMinimax`). */
const MINIMAX_AUTH_CODES = new Set([1004, 2049]);
const MINIMAX_AUTH_ATTEMPTS = 3; // total probes that must agree before a key is declared dead
const MINIMAX_AUTH_SPACING_MS = 2_000; // gap between corroborating probes — spaced so we never hammer MiniMax

/** Classify ONE MiniMax /remains response body into a windows verdict. Pure (no
 *  network) so the auth decision can be unit-tested with fixtures. Exported for tests. */
export function classifyMinimaxBody(j: MinimaxBody): Windows {
  const code = j.base_resp?.status_code;
  if (code !== 0) {
    const authOk = code !== undefined && MINIMAX_AUTH_CODES.has(code) ? false : undefined; // login fail / invalid key
    return { ok: false, error: `minimax ${code ?? '?'}: ${j.base_resp?.status_msg ?? 'error'}`, authOk };
  }
  const gen = (j.model_remains ?? []).find(m => m.model_name === 'general') ?? j.model_remains?.[0];
  const used = (remaining?: number): number | undefined =>
    percentOrUndef(remaining) === undefined ? undefined : 100 - remaining!;
  return {
    ok: true,
    authOk: true,
    fiveHourPercent: used(gen?.current_interval_remaining_percent),
    weeklyPercent: used(gen?.current_weekly_remaining_percent),
    fiveHourResetAt: numOrUndef(gen?.end_time),
    weeklyResetAt: numOrUndef(gen?.weekly_end_time),
  };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Corroborate a hard auth rejection before trusting it. An `attempt` that reports
 *  `authOk === false` is re-run up to `attempts` times, SPACED (so we never hammer
 *  the API); the first result that is NOT a hard rejection wins and returns at once.
 *  A success (`authOk:true`) or an inconclusive verdict (`authOk:undefined`, e.g. a
 *  timeout/5xx) is returned on the first try — those are never retried. This means a
 *  transient `1004` on a valid key is cleared by the very next probe, while a
 *  genuinely dead key (rejected on every probe) is still reported on the SAME feed
 *  cycle, only ~`(attempts-1) * spacingMs` (≈4s) later. Exported for tests. */
export async function corroborateAuthFailure(
  attempt: () => Promise<Windows>,
  opts: { attempts?: number; spacingMs?: number; sleepMs?: (ms: number) => Promise<void> } = {},
): Promise<Windows> {
  const attempts = Math.max(1, opts.attempts ?? MINIMAX_AUTH_ATTEMPTS);
  const spacingMs = opts.spacingMs ?? MINIMAX_AUTH_SPACING_MS;
  const wait = opts.sleepMs ?? sleep;
  let last = await attempt();
  for (let i = 1; i < attempts && last.authOk === false; i++) {
    await wait(spacingMs);
    last = await attempt();
  }
  return last;
}

/** MiniMax coding plan (sk-cp-… key, .io region). One GET returns a per-model array;
 *  the "general" entry holds the text/coding windows. NOTE: this endpoint returns
 *  HTTP 200 even on a bad key — auth is signalled by `base_resp.status_code` (0 = ok,
 *  1004/2049 = bad key). Percentages are REMAINING, so used = 100 − remaining. A
 *  single auth-verify code is NOT trusted: it is corroborated by re-probing (see
 *  `corroborateAuthFailure`) so one transient blip can't condemn a working key. */
async function probeMinimax(token: string, timeoutMs: number): Promise<Windows> {
  const attempt = async (): Promise<Windows> => {
    try {
      const j = (await getJson(
        'https://api.minimax.io/v1/token_plan/remains',
        { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeoutMs,
      )) as MinimaxBody;
      return classifyMinimaxBody(j);
    } catch (e) {
      // A 401/403 ⇒ rejected (false, which corroboration will re-probe); a timeout/
      // 5xx/network error ⇒ inconclusive (undefined), returned without retry.
      return { ok: false, error: (e as Error).message, authOk: authFromHttpError(e) };
    }
  };
  return corroborateAuthFailure(attempt);
}
interface MinimaxRemains {
  model_name?: string;
  end_time?: number; // epoch MS — 5h window reset
  weekly_end_time?: number; // epoch MS — weekly window reset
  current_interval_remaining_percent?: number; // REMAINING % of the 5h window
  current_weekly_remaining_percent?: number; // REMAINING % of the weekly window
}

/** Accept only percentage points. Invalid provider data stays unknown instead
 *  of poisoning limit comparisons or rendered quota values. */
const percentOrUndef = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined;
const numOrUndef = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const secToMs = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v * 1000 : undefined;

// ---------------------------------------------------------------------------
// Pre-probe re-login: refresh an expired OAuth access token, token-free, by
// driving the CLI through a no-inference path so IT refreshes (and writes the
// rotated token back to its own store). Only OAuth providers (anthropic/codex)
// have a refresh; z.ai/minimax are static API keys. We trigger it ONLY when the
// access token is actually expired/near-expiry (a cheap LOCAL check) so it fires
// rarely — important because codex refresh tokens are single-use/rotating.
// ---------------------------------------------------------------------------

const REFRESH_SKEW_MS = 5 * 60_000; // refresh when within this of expiry
const DEFAULT_RELOGIN_TIMEOUT_MS = 30_000;

/** Whether an OAuth account's access token is expired/near-expiry AND refreshable
 *  (a durable refresh token is present). Zero-network — reads only local creds. */
async function oauthNeedsRefresh(kind: Kind, configDir: string, now: number, timeoutMs: number): Promise<boolean> {
  if (kind === 'claude') {
    const blob = await readClaudeCred(configDir, timeoutMs);
    if (!blob) return false;
    try {
      const parsed = JSON.parse(blob) as Record<string, unknown>;
      const creds = (parsed.claudeAiOauth as Record<string, unknown>) ?? parsed;
      if (!creds.refreshToken) return false; // nothing to refresh with
      const exp = creds.expiresAt as number | undefined;
      return typeof exp === 'number' && exp <= now + REFRESH_SKEW_MS;
    } catch {
      return false;
    }
  }
  // codex: access_token is a JWT; refresh only if it has a refresh_token too.
  const authPath = path.join(configDir, 'auth.json');
  if (!existsSync(authPath)) return false;
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as {
      tokens?: { access_token?: string; refresh_token?: string };
    };
    if (!auth.tokens?.refresh_token) return false;
    const exp = jwtExpMs(auth.tokens.access_token);
    return typeof exp === 'number' && exp <= now + REFRESH_SKEW_MS;
  } catch {
    return false;
  }
}

/** Run the token-free refresh path for one OAuth account. Spawns the real CLI with
 *  only the config-dir env set; no model/inference call is made. Best-effort: any
 *  failure is swallowed (the subsequent usage probe will just report the stale state). */
async function runRelogin(kind: Kind, configDir: string, timeoutMs: number): Promise<void> {
  const spec = KIND_SPECS[kind];
  const bin = Bun.which(spec.bin) ?? spec.bin;
  const env = { ...process.env, ...spec.wrapperEnv('', configDir) }; // CLAUDE_CONFIG_DIR / CODEX_HOME
  try {
    if (kind === 'claude') {
      // `claude mcp list` makes an authenticated (non-billable) connectors call,
      // which triggers Claude Code's refresh-if-expired path. Idempotent when fresh.
      const proc = Bun.spawn({ cmd: [bin, 'mcp', 'list'], env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      // SIGKILL (not the default SIGTERM): `mcp list` pings every configured MCP
      // server and may not honor a polite signal — guarantee it can't wedge the cycle.
      const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
      try {
        await proc.exited;
      } finally {
        clearTimeout(timer);
      }
      return;
    }
    // codex: drive app-server over stdio JSON-RPC; `initialize` + a forced
    // `getAuthStatus{refreshToken:true}` rotates the token via the OAuth endpoint.
    const proc = Bun.spawn({ cmd: [bin, 'app-server'], env, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    const rpc = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'kfleet-relogin', title: 'kfleet', version: '0.0.0' }, capabilities: {} },
      },
      { jsonrpc: '2.0', id: 2, method: 'getAuthStatus', params: { includeToken: false, refreshToken: true } },
    ];
    // app-server is a long-lived server: it never exits on its own, so we drive it,
    // wait for the refresh to land, then SIGKILL. The outer timer is the hard backstop.
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    try {
      proc.stdin.write(`${rpc.map(r => JSON.stringify(r)).join('\n')}\n`);
      await proc.stdin.flush();
      // Give the server a moment to perform the refresh + write auth.json, then stop it.
      await new Promise(r => setTimeout(r, Math.min(6_000, timeoutMs)));
      try {
        await proc.stdin.end();
      } catch {
        /* already closed */
      }
      proc.kill('SIGKILL');
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* best-effort — a failed refresh just means the usage probe sees the stale token */
  }
}

/** For every tracked OAuth account whose access token is expired/near-expiry, run a
 *  token-free refresh so the CLI rotates it before we read usage. Deduped per account
 *  (one credential = one refresh; codex refresh tokens are single-use). Returns the
 *  binaries that were refreshed. */
async function reloginExpiredOAuth(
  config: Config,
  opts: { concurrency?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<string[]> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RELOGIN_TIMEOUT_MS;
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  // One refresh per CONFIG DIR (not per identity credId): every dir keeps its own
  // token copy that expires independently, so each needs its own refresh pass.
  const seen = new Set<string>();
  const targets: { kind: Kind; configDir: string; binary: string }[] = [];
  for (const agent of resolveAll(config)) {
    // A declared external token is static from this process's perspective:
    // there is no refresh token/config-dir credential for the CLI to rotate.
    if (agent.credential) continue;
    const cls = classifyAgent(agent, env);
    if (!cls || (cls.provider !== 'anthropic' && cls.provider !== 'codex')) continue;
    const configDir = KIND_SPECS[agent.kind].configDir(agent.name);
    if (seen.has(configDir)) continue;
    seen.add(configDir);
    targets.push({ kind: agent.kind, configDir, binary: `${agent.kind}-${agent.name}` });
  }

  // The local credential read (keychain/auth.json) is fast — cap it short, independent
  // of the longer `timeoutMs` budget for the actual refresh spawn below.
  const credReadTimeoutMs = 15_000;
  const refreshed: string[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < targets.length) {
      const t = targets[next++]!;
      if (await oauthNeedsRefresh(t.kind, t.configDir, now, credReadTimeoutMs)) {
        await runRelogin(t.kind, t.configDir, timeoutMs);
        refreshed.push(t.binary);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, worker));
  return refreshed;
}

// ---------------------------------------------------------------------------
// Classification + aggregation
// ---------------------------------------------------------------------------

/** One unique credential to probe, plus every binary that shares it. */
interface CredTarget {
  credId: string;
  provider: UsageProvider;
  run: (timeoutMs: number) => Promise<Windows>;
  members: { binary: string; kind: Kind; name: string; account: string; configDir: string }[];
}

/** The login identity a resolved agent belongs to: all its variants (and any
 *  agent pointing at it via `identity:`) share one provider account — and thus
 *  ONE quota window, so OAuth usage probes dedupe on this. */
const identityOf = (agent: ResolvedAgent): string => agent.identity ?? agent.base ?? agent.name;

interface ResolvedExternalCredential {
  key: string;
  value?: string;
}

/** Test seam for the otherwise fixed `~/.secrets` credential lookup. */
type ExternalCredentialResolver = (agent: ResolvedAgent) => ResolvedExternalCredential | undefined;

const READ_SECRET_FILE_KEY = `
set -a
. "$1" >/dev/null 2>&1 || exit 1
exec "$2" -e 'const value = process.env[process.argv[1]]; if (value !== undefined) process.stdout.write(value)' "$3"
`;

const SECRETS_FILE = path.join(homedir(), '.secrets');

/** Resolve an explicitly declared secret without depending on ambient shell
 *  state. An inherited value wins when present; otherwise a bounded shell reads
 *  the generated `~/.secrets` syntax. Values never enter argv or logs. */
function createExternalCredentialResolver(env: NodeJS.ProcessEnv): ExternalCredentialResolver {
  const cache = new Map<string, ResolvedExternalCredential>();
  return agent => {
    const credential = agent.credential;
    if (!credential || credential.source !== 'secrets-file') return undefined;
    const cached = cache.get(credential.key);
    if (cached) return cached;

    let value = env[credential.key] || undefined;
    if (!value && existsSync(SECRETS_FILE)) {
      const child = Bun.spawnSync({
        cmd: [
          '/bin/sh',
          '-c',
          READ_SECRET_FILE_KEY,
          'kfleet-read-secret',
          SECRETS_FILE,
          process.execPath,
          credential.key,
        ],
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      if (child.success) value = child.stdout.toString() || undefined;
    }

    const resolved = { key: credential.key, value };
    cache.set(credential.key, resolved);
    return resolved;
  };
}

/** Decide an agent's usage provider + credential identity, or null if untracked.
 *  Exported for tests. */
export function classifyAgent(
  agent: ResolvedAgent,
  env: NodeJS.ProcessEnv = process.env,
  resolveExternal: ExternalCredentialResolver = createExternalCredentialResolver(env),
): {
  provider: UsageProvider;
  credId: string;
  missingToken?: string;
  missingTokenSource?: 'env' | 'secrets-file';
} | null {
  const configDir = KIND_SPECS[agent.kind].configDir(agent.name);
  if (agent.kind === 'claude') {
    const baseUrl = agent.env?.ANTHROPIC_BASE_URL ?? '';
    if (baseUrl.includes('z.ai')) {
      const token = expandEnv(agent.env?.ANTHROPIC_AUTH_TOKEN, env);
      if (!token) {
        const ref = envRefName(agent.env?.ANTHROPIC_AUTH_TOKEN) ?? `${agent.kind}-${agent.name}`;
        return { provider: 'zai', credId: `zai:missing:${ref}`, missingToken: ref };
      }
      return { provider: 'zai', credId: `zai:${createHash('sha256').update(token).digest('hex').slice(0, 12)}` };
    }
    if (baseUrl.includes('minimax')) {
      // MiniMax coding plan ($MINIMAX_API_KEY, sk-cp-…). Windowed like z.ai's.
      const token = expandEnv(agent.env?.ANTHROPIC_AUTH_TOKEN, env);
      if (!token) {
        const ref = envRefName(agent.env?.ANTHROPIC_AUTH_TOKEN) ?? `${agent.kind}-${agent.name}`;
        return { provider: 'minimax', credId: `minimax:missing:${ref}`, missingToken: ref };
      }
      return {
        provider: 'minimax',
        credId: `minimax:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`,
      };
    }
    // No base-url override (or an explicit anthropic host) ⇒ a real Anthropic
    // subscription account authenticated via the OAuth keychain. Any OTHER base
    // url (minimax/deepseek/…) is a non-windowed API-key account: untracked.
    // Keyed by IDENTITY (not config dir): the quota window is account-level, so
    // every variant dir of one account shares a single probe.
    if (!baseUrl || baseUrl.includes('anthropic.com')) {
      // Direct first-party wrappers (notably loge1..6) may explicitly declare
      // a secrets-file key. Key by the RESOLVED token so each account gets its
      // own real probe; never fall back to an identity donor or wrapper env.
      const external = resolveExternal(agent);
      if (external) {
        const token = external.value;
        if (!token)
          return {
            provider: 'anthropic',
            credId: `anthropic:secrets-file:missing:${external.key}`,
            missingToken: external.key,
            missingTokenSource: 'secrets-file',
          };
        return {
          provider: 'anthropic',
          credId: `anthropic:secrets-file:${createHash('sha256').update(token).digest('hex')}`,
        };
      }
      return { provider: 'anthropic', credId: `anthropic:id:${identityOf(agent)}` };
    }
    return null;
  }
  // codex: only ChatGPT-plan (OAuth) accounts have usage windows.
  // A declared external source must never fall back to a stale stored account.
  if (agent.credential) return null;
  const authPath = path.join(configDir, 'auth.json');
  if (!existsSync(authPath)) return null;
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as { auth_mode?: string; tokens?: { account_id?: string } };
    if (auth.auth_mode === 'chatgpt' && auth.tokens?.account_id) {
      // Keyed by IDENTITY: quota is account-level, so one probe covers every dir.
      // Each dir still keeps its OWN token copy that expires/refreshes independently
      // — auth_ok and relogin stay per DIR (see probeUsage's per-member override).
      return { provider: 'codex', credId: `codex:id:${identityOf(agent)}` };
    }
  } catch {
    /* unreadable auth.json — treat as untracked */
  }
  return null;
}

/** Build the dedup list of credentials to probe from the resolved fleet. OAuth
 *  targets probe through the identity's DONOR dir (freshest credential) when one
 *  is known — quota is account-level, so any valid member's token answers for all. */
function planTargets(
  agents: ResolvedAgent[],
  env: NodeJS.ProcessEnv,
  donorDirs: Map<string, string> = new Map(),
  resolveExternal: ExternalCredentialResolver = createExternalCredentialResolver(env),
): CredTarget[] {
  const byCred = new Map<string, CredTarget>();
  for (const agent of agents) {
    const cls = classifyAgent(agent, env, resolveExternal);
    if (!cls) continue;
    const configDir = KIND_SPECS[agent.kind].configDir(agent.name);
    const binary = `${agent.kind}-${agent.name}`;
    const member = { binary, kind: agent.kind, name: agent.name, account: identityOf(agent), configDir };
    const existing = byCred.get(cls.credId);
    if (existing) {
      existing.members.push(member);
      continue;
    }
    const probeDir = donorDirs.get(cls.credId) ?? configDir;
    const external = resolveExternal(agent);
    const run: CredTarget['run'] = cls.missingToken
      ? async () => ({
          ok: false,
          error:
            cls.missingTokenSource === 'secrets-file'
              ? `missing secrets-file key ${cls.missingToken}`
              : `missing env var ${cls.missingToken}`,
          unavailable: true,
          authOk: false,
        })
      : cls.provider === 'anthropic'
        ? external
          ? t => probeAnthropicExternalToken(external.value!, t)
          : t => probeAnthropic(probeDir, t)
        : cls.provider === 'codex'
          ? t => probeCodex(probeDir, t)
          : cls.provider === 'minimax'
            ? t => probeMinimax(expandEnv(agent.env?.ANTHROPIC_AUTH_TOKEN, env)!, t)
            : t => probeZai(expandEnv(agent.env?.ANTHROPIC_AUTH_TOKEN, env)!, t);
    byCred.set(cls.credId, { credId: cls.credId, provider: cls.provider, run, members: [member] });
  }
  return [...byCred.values()];
}

/** Probe `targets` with bounded concurrency. */
async function runProbes(targets: CredTarget[], concurrency: number, timeoutMs: number): Promise<Map<string, Windows>> {
  const out = new Map<string, Windows>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < targets.length) {
      const t = targets[next++]!;
      out.set(t.credId, await t.run(timeoutMs));
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), targets.length || 1) }, worker));
  return out;
}

/** Scan OAuth identities post-relogin; optionally heal dead member dirs from a
 *  valid sibling (credential sync). Returns donor probe dirs per credId and the
 *  per-binary auth verdict (its OWN credential copy usable, not the donor's). */
async function scanOAuthAuth(
  agents: ResolvedAgent[],
  heal: boolean,
): Promise<{ donorDirs: Map<string, string>; authByBinary: Map<string, boolean> }> {
  const donorDirs = new Map<string, string>();
  const authByBinary = new Map<string, boolean>();
  // isOAuth (not classifyAgent): a codex dir with NO auth.json yet is untracked
  // for probing but still belongs to its identity — heal can materialize it.
  // Declared external-token agents are classified out by isOAuth: they have no
  // durable credential directory to scan, heal, or use as an identity donor.
  const identities: Identity[] = await scanIdentities(agents.filter(isOAuth));
  for (const id of identities) {
    const donor = pickDonor(id.members);
    if (donor && heal) {
      const synced = await syncIdentity(id, donor); // skips already-valid members
      for (const m of id.members) if (synced.includes(m.name)) m.state = donor.state;
    }
    if (donor) donorDirs.set(`${id.kind === 'claude' ? 'anthropic' : 'codex'}:id:${id.base}`, donor.dir);
    // auth_ok mirrors oauthTokenUsable semantics: only a currently-VALID token
    // counts — relogin (and heal) already had their chance to fix it.
    for (const m of id.members) authByBinary.set(`${id.kind}-${m.name}`, m.state === 'valid');
  }
  return { donorDirs, authByBinary };
}

/** Probe the whole fleet's usage. Returns one AccountUsage per resolved agent —
 *  untracked agents get usageBased=false and no window data. */
export async function probeUsage(
  config: Config,
  opts: {
    concurrency?: number;
    timeoutMs?: number;
    atLimitPercent?: number;
    env?: NodeJS.ProcessEnv;
    relogin?: boolean;
    /** heal dead credential copies from a valid sibling before probing (default on) */
    sync?: boolean;
    /** Override only for tests; production always resolves declared keys from
     *  the ambient env or the fixed generated `~/.secrets` file. */
    resolveExternalCredential?: ExternalCredentialResolver;
  } = {},
): Promise<AccountUsage[]> {
  const env = opts.env ?? process.env;
  const concurrency = opts.concurrency ?? 6;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const atLimitPercent = opts.atLimitPercent ?? DEFAULT_AT_LIMIT;

  // Optionally refresh any expired OAuth tokens first (token-free), so the usage
  // read below sees a fresh token instead of reporting "token expired". Relogin
  // spawns a CLI (mcp list / app-server) which is slower than an HTTP probe, so it
  // gets at least its own floor; a larger caller timeout is honored, a smaller isn't.
  if (opts.relogin) {
    await reloginExpiredOAuth(config, { concurrency, env, timeoutMs: Math.max(timeoutMs, DEFAULT_RELOGIN_TIMEOUT_MS) });
  }

  const agents = resolveAll(config);
  // Per-dir auth verdicts + donor dirs for the identity-grouped OAuth probes,
  // healing dead copies from valid siblings first unless disabled.
  const { donorDirs, authByBinary } = await scanOAuthAuth(agents, opts.sync !== false);

  const targets = planTargets(agents, env, donorDirs, opts.resolveExternalCredential);
  const results = await runProbes(targets, concurrency, timeoutMs);

  // Map each credential's windows back onto its member binaries. Quota numbers
  // fan out identically (account-level window); auth_ok is overridden per member
  // so a dir whose own token copy is dead is never reported as logged in.
  const byBinary = new Map<string, AccountUsage>();
  for (const t of targets) {
    const w = results.get(t.credId) ?? { ok: false, error: 'no result' };
    for (const m of t.members) {
      const usage = windowsToUsage(m, t.provider, w, atLimitPercent);
      const memberAuth = authByBinary.get(m.binary);
      if (memberAuth !== undefined) usage.authOk = memberAuth;
      byBinary.set(m.binary, usage);
    }
  }

  // Proxy availability is an independent, read-only management snapshot rather
  // than a fabricated five-hour/weekly subscription window. Failed sources do
  // not override the ordinary untracked row: that remains unknown/fail-open.
  const cliProxy = await probeCLIProxyUsage(config.usage.cliProxy, agents, { timeoutMs, env });
  for (const [binary, override] of cliProxy)
    byBinary.set(binary, {
      ...override,
      kind: binary.startsWith('codex-') ? 'codex' : 'claude',
      name: binary.replace(/^(claude|codex)-/, ''),
    });

  // Emit one row per resolved agent (untracked ⇒ usageBased=false), stable order.
  return agents
    .map(a => {
      const binary = `${a.kind}-${a.name}`;
      return (
        byBinary.get(binary) ?? {
          binary,
          kind: a.kind,
          name: a.name,
          account: identityOf(a),
          provider: null,
          usageBased: false,
          ok: false,
          atLimit: false,
        }
      );
    })
    .sort((a, b) => a.binary.localeCompare(b.binary));
}

function windowsToUsage(
  m: { binary: string; kind: Kind; name: string; account: string },
  provider: UsageProvider,
  w: Windows,
  atLimitPercent: number,
): AccountUsage {
  const atLimit =
    w.providerAtLimit === true ||
    (w.fiveHourPercent ?? 0) >= atLimitPercent ||
    (w.weeklyPercent ?? 0) >= atLimitPercent;
  return {
    binary: m.binary,
    kind: m.kind,
    name: m.name,
    account: m.account,
    provider,
    usageBased: true,
    ok: w.ok,
    error: w.error,
    unavailable: w.unavailable,
    authOk: w.authOk,
    fiveHourPercent: w.fiveHourPercent,
    weeklyPercent: w.weeklyPercent,
    fiveHourResetAt: w.fiveHourResetAt,
    weeklyResetAt: w.weeklyResetAt,
    atLimit: w.ok ? atLimit : w.unavailable === true, // ordinary probe failure is unknown; missing configured token is unavailable
  };
}
