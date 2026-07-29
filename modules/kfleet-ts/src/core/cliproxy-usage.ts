import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CLIProxyUsageSource, Kind, ResolvedAgent } from './types';

export type CLIProxyAvailability = 'available' | 'unavailable';
export type CLIProxyUnavailableReason = 'cooldown' | 'spend_limit' | 'auth' | 'provider' | 'no_credentials';

export interface CLIProxyUsageOverride {
  binary: string;
  provider: 'cliproxy';
  usageBased: false;
  ok: true;
  availability: CLIProxyAvailability;
  unavailable: boolean;
  unavailableReason?: CLIProxyUnavailableReason;
  authOk?: boolean;
  atLimit: boolean;
  retryAt?: number;
}

export interface CLIProxyUsageOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface AuthFile {
  provider: string;
  status: AuthStatus;
  disabled: boolean;
  unavailable: boolean;
  modelStates?: Record<string, ModelState>;
}

type AuthStatus = 'unknown' | 'active' | 'pending' | 'refreshing' | 'error' | 'disabled';

interface ModelState {
  status: AuthStatus;
  unavailable: boolean;
  nextRetryAt?: number;
  quota: {
    exceeded: boolean;
    nextRecoverAt?: number;
  };
  lastError?: {
    code?: string;
    httpStatus?: number;
  };
}

const expandEnv = (value: string, env: NodeJS.ProcessEnv): string | undefined => {
  const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value.trim());
  return match ? env[match[1]!] : value;
};

const expandHome = (value: string): string =>
  value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;

const managementKey = (source: CLIProxyUsageSource, env: NodeJS.ProcessEnv): string | undefined => {
  if (source.managementKey !== undefined) return expandEnv(source.managementKey, env)?.trim() || undefined;
  if (source.managementKeyFile === undefined) return undefined;
  const file = expandEnv(source.managementKeyFile, env);
  if (!file) return undefined;
  try {
    return readFileSync(expandHome(file), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
};

const retryAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
};

const boolean = (entry: Record<string, unknown>, name: string): boolean | undefined => {
  const value = entry[name];
  return value === undefined || typeof value === 'boolean' ? value : undefined;
};

const AUTH_STATUSES = new Set<AuthStatus>(['unknown', 'active', 'pending', 'refreshing', 'error', 'disabled']);

const authStatus = (value: unknown): AuthStatus | undefined =>
  typeof value === 'string' && AUTH_STATUSES.has(value as AuthStatus) ? (value as AuthStatus) : undefined;

const optionalTimestamp = (entry: Record<string, unknown>, name: string): number | null | undefined => {
  if (entry[name] === undefined) return undefined;
  return retryAt(entry[name]) ?? null;
};

function modelState(raw: unknown): ModelState | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const status = authStatus(entry.status);
  const unavailable = boolean(entry, 'unavailable');
  const nextRetryAt = optionalTimestamp(entry, 'next_retry_after');
  if (status === undefined || unavailable === undefined || nextRetryAt === null) return undefined;

  if (typeof entry.quota !== 'object' || entry.quota === null || Array.isArray(entry.quota)) return undefined;
  const quotaEntry = entry.quota as Record<string, unknown>;
  const exceeded = boolean(quotaEntry, 'exceeded');
  const nextRecoverAt = optionalTimestamp(quotaEntry, 'next_recover_at');
  if (exceeded === undefined || nextRecoverAt === null) return undefined;

  let lastError: ModelState['lastError'];
  if (entry.last_error !== undefined) {
    if (typeof entry.last_error !== 'object' || entry.last_error === null || Array.isArray(entry.last_error))
      return undefined;
    const errorEntry = entry.last_error as Record<string, unknown>;
    if (errorEntry.code !== undefined && typeof errorEntry.code !== 'string') return undefined;
    if (
      errorEntry.http_status !== undefined &&
      (typeof errorEntry.http_status !== 'number' ||
        !Number.isInteger(errorEntry.http_status) ||
        errorEntry.http_status <= 0)
    )
      return undefined;
    lastError = {
      ...(typeof errorEntry.code === 'string' && errorEntry.code.trim()
        ? { code: errorEntry.code.trim().toLowerCase() }
        : {}),
      ...(typeof errorEntry.http_status === 'number' ? { httpStatus: errorEntry.http_status } : {}),
    };
  }

  return {
    status,
    unavailable,
    ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
    quota: { exceeded, ...(nextRecoverAt !== undefined ? { nextRecoverAt } : {}) },
    ...(lastError && Object.keys(lastError).length > 0 ? { lastError } : {}),
  };
}

function modelStates(raw: unknown): Record<string, ModelState> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const states: Record<string, ModelState> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!model.trim()) return undefined;
    const parsed = modelState(value);
    if (!parsed) return undefined;
    states[model] = parsed;
  }
  return states;
}

/** Strictly parse the subset of the management response used for availability.
 * An unrecognised response is unknown, never a provider-down verdict. */
function authFiles(payload: unknown): AuthFile[] | undefined {
  if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { files?: unknown }).files))
    return undefined;
  const files: AuthFile[] = [];
  for (const raw of (payload as { files: unknown[] }).files) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.provider !== 'string') return undefined;
    const status = authStatus(entry.status);
    const disabled = boolean(entry, 'disabled');
    const unavailable = boolean(entry, 'unavailable');
    const states = modelStates(entry.model_states);
    if (status === undefined || disabled === undefined || unavailable === undefined) return undefined;
    if (entry.model_states !== undefined && states === undefined) return undefined;
    files.push({
      provider: entry.provider.toLowerCase(),
      status,
      disabled,
      unavailable,
      ...(states !== undefined ? { modelStates: states } : {}),
    });
  }
  return files;
}

const withoutThinkingSuffix = (model: string): string => {
  const trimmed = model.trim();
  const open = trimmed.lastIndexOf('(');
  return open > 0 && trimmed.endsWith(')') ? trimmed.slice(0, open).trim() : trimmed;
};

const primaryModel = (agent: ResolvedAgent): string | undefined => {
  const model = agent.env?.KTEAM_MODEL?.trim();
  if (!model || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(model)) return undefined;
  // Claude Code's [1m] marker is a wrapper-side context convention; the model
  // sent to and recorded by CLIProxyAPI is the bare served id. Preserve an
  // optional thinking suffix while removing that marker only for Claude.
  return agent.kind === 'claude' ? model.replace(/\[1m\](?=\(|$)/i, '') : model;
};

const reasonFor = (state: ModelState): CLIProxyUnavailableReason => {
  const code = state.lastError?.code;
  const status = state.lastError?.httpStatus;
  if (status === 401 || code === 'invalid_grant' || code === 'unauthorized') return 'auth';
  if (status === 402 || status === 403 || code === 'payment_required') return 'spend_limit';
  if (state.quota.exceeded || status === 429) return 'cooldown';
  return 'provider';
};

interface BlockedModel {
  reason: CLIProxyUnavailableReason;
  retryAt?: number;
}

/** Mirror pinned CLIProxyAPI v7.2.98 isAuthBlockedForModel after translating
 * the wrapper's primary model to its served id. Missing sparse state is
 * selectable; only a trailing parenthesized thinking suffix falls back. */
function blockedFor(file: AuthFile, model: string, nowMs: number): BlockedModel | undefined {
  const state = file.modelStates?.[model] ?? file.modelStates?.[withoutThinkingSuffix(model)];
  if (!state) return undefined;
  if (state.status === 'disabled') return { reason: reasonFor(state) };
  if (!state.unavailable || state.nextRetryAt === undefined || state.nextRetryAt <= nowMs) return undefined;
  const deadline =
    state.quota.nextRecoverAt !== undefined && state.quota.nextRecoverAt > nowMs
      ? state.quota.nextRecoverAt
      : state.nextRetryAt;
  return { reason: reasonFor(state), retryAt: deadline };
}

function overrideFor(
  binary: string,
  kind: Kind,
  model: string | undefined,
  files: AuthFile[],
  nowMs: number,
): CLIProxyUsageOverride | undefined {
  const matching = files.filter(file => file.provider === kind && !file.disabled && file.status !== 'disabled');
  if (matching.length === 0) {
    return {
      binary,
      provider: 'cliproxy',
      usageBased: false,
      ok: true,
      availability: 'unavailable',
      unavailable: true,
      unavailableReason: 'no_credentials',
      authOk: false,
      atLimit: false,
    };
  }
  if (!model) return undefined;
  const blocked = matching.map(file => blockedFor(file, model, nowMs));
  if (blocked.some(item => item === undefined)) return undefined;
  const confirmed = blocked as BlockedModel[];
  const reason: CLIProxyUnavailableReason = confirmed.every(item => item.reason === 'auth')
    ? 'auth'
    : confirmed.every(item => item.reason === 'spend_limit')
      ? 'spend_limit'
      : confirmed.every(item => item.reason === 'cooldown')
        ? 'cooldown'
        : 'provider';
  const retries = confirmed.map(item => item.retryAt).filter((value): value is number => value !== undefined);
  return {
    binary,
    provider: 'cliproxy',
    usageBased: false,
    ok: true,
    availability: 'unavailable',
    unavailable: true,
    unavailableReason: reason,
    ...(reason === 'auth' ? { authOk: false } : { authOk: true }),
    atLimit: reason === 'cooldown' || reason === 'spend_limit',
    ...(retries.length ? { retryAt: Math.min(...retries) } : {}),
  };
}

const targetsFor = (source: CLIProxyUsageSource, agents: ResolvedAgent[]): ResolvedAgent[] =>
  agents.filter(agent => source.baseAgents.includes(`${agent.kind}-${agent.base ?? agent.name}`));

/** Read one CLIProxyAPI management snapshot for every configured local source.
 * Source failure intentionally yields no rows so the existing raw rows remain unknown. */
export async function probeCLIProxyUsage(
  sources: CLIProxyUsageSource[],
  agents: ResolvedAgent[],
  options: CLIProxyUsageOptions = {},
): Promise<Map<string, CLIProxyUsageOverride>> {
  const out = new Map<string, CLIProxyUsageOverride>();
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const env = options.env ?? process.env;
  const nowMs = Date.now();

  for (const source of sources) {
    const targets = targetsFor(source, agents);
    if (targets.length === 0) continue;
    const key = managementKey(source, env);
    if (!key) continue;
    try {
      const response = await fetcher(`${source.url.replace(/\/+$/, '')}/v0/management/auth-files`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const files = authFiles(await response.json());
      if (!files) continue;
      for (const agent of targets) {
        const binary = `${agent.kind}-${agent.name}`;
        const override = overrideFor(binary, agent.kind, primaryModel(agent), files, nowMs);
        if (override) out.set(binary, override);
      }
    } catch {
      // Unknown source state must never turn into a quota/auth exclusion.
    }
  }
  return out;
}
