// Normalize the loge pool credentials into CLIProxyAPI auth-file JSON, and map
// the direct Claude pool slots into the SOPS env names consumed by kfleet.
//
// This is a faithful port of pe-llm/loge `src/config.ts`
// (normalizeCodexTokenJson / normalizeClaudeTokenJson) so the files kloge
// writes are byte-identical to the ones loge renders into its CLIProxyAPI
// sidecar. If loge changes its normalization, update this to match.
import { parse } from 'yaml';

const DIRECT_LOGE_AGENT_RE = /^loge([1-6])$/;
const DIRECT_CLAUDE_SECRET_RE = /^CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_([1-6])$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ClaudeSopsEnvToken {
  source: string;
  destination: string;
  value: string;
}

/** Read the destination keys from kfleet's first-class credential declarations,
 *  keeping kloge from duplicating or drifting away from that source of truth. */
export function claudeCredentialDestinations(configYaml: string): ReadonlyMap<string, string> {
  const config = parse(configYaml) as {
    agents?: Array<{
      name?: unknown;
      kind?: unknown;
      credential?: { source?: unknown; key?: unknown };
    }>;
  };
  const destinations = new Map<string, string>();
  for (const agent of config?.agents ?? []) {
    if (agent.kind !== 'claude' || typeof agent.name !== 'string' || !DIRECT_LOGE_AGENT_RE.test(agent.name)) continue;
    if (
      agent.credential?.source !== 'secrets-file' ||
      typeof agent.credential.key !== 'string' ||
      !ENV_KEY_RE.test(agent.credential.key)
    ) {
      throw new Error(`kfleet agent ${agent.name} must declare a secrets-file credential key`);
    }
    destinations.set(agent.name, agent.credential.key);
  }
  return destinations;
}

/** Whether this pull contains a direct Claude slot that needs kfleet config. */
export function hasDirectClaudeCredential(credentials: Readonly<Record<string, string>>): boolean {
  return Object.keys(credentials).some(source => DIRECT_CLAUDE_SECRET_RE.test(source));
}

/**
 * Pick just the Secret slots backing the six direct `claude-logeN` wrappers.
 * The larger CLIProxyAPI pool is intentionally left unconstrained: its other
 * Claude credentials continue to be written only to the auth directory.
 */
export function claudeSopsEnvTokens(
  credentials: Readonly<Record<string, string>>,
  destinations: ReadonlyMap<string, string>,
): ClaudeSopsEnvToken[] {
  return Object.entries(credentials)
    .flatMap(([source, value]) => {
      const slot = source.match(DIRECT_CLAUDE_SECRET_RE)?.[1];
      if (slot === undefined) return [];
      const agent = `loge${slot}`;
      const destination = destinations.get(agent);
      if (destination === undefined) throw new Error(`kfleet agent ${agent} has no declared credential destination`);
      return [{ source, destination, value: normalizeClaudeOAuthAccessToken(source, value) }];
    })
    .sort((a, b) => a.destination.localeCompare(b.destination, undefined, { numeric: true }));
}

/** Codex OAuth token JSON -> CLIProxyAPI `type: codex` auth record. */
export function normalizeCodexTokenJson(name: string, tokenJson: string): string {
  try {
    const parsed = JSON.parse(tokenJson) as Record<string, unknown>;
    for (const key of ['access_token', 'id_token', 'refresh_token']) {
      if (!parsed[key]) throw new Error('missing ' + key);
    }
    return JSON.stringify({ type: 'codex', ...parsed });
  } catch (err) {
    throw new Error(name + ' is not valid CLIProxyAPI token JSON: ' + (err as Error).message);
  }
}

/**
 * Claude credential -> CLIProxyAPI `type: claude` auth record. Accepts either a
 * raw `sk-ant-oat...` OAuth token, an `api_key` JSON, or a full OAuth JSON with
 * access/refresh tokens.
 */
function normalizeClaudeToken(name: string, tokenJson: string): Record<string, unknown> {
  const raw = tokenJson.trim();
  if (raw.startsWith('sk-ant-oat')) {
    return { type: 'claude', access_token: raw };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const apiKey = parsed.api_key ?? parsed.apiKey;
    if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
      return { type: 'claude', ...parsed, api_key: apiKey.trim() };
    }

    const accessToken = parsed.access_token ?? parsed.accessToken;
    const refreshToken = parsed.refresh_token ?? parsed.refreshToken;
    if (!accessToken) throw new Error('missing access_token');
    if (!refreshToken) throw new Error('missing refresh_token');

    const normalized: Record<string, unknown> = { type: 'claude', ...parsed };
    normalized.access_token = accessToken;
    normalized.refresh_token = refreshToken;
    if (parsed.id_token ?? parsed.idToken) normalized.id_token = parsed.id_token ?? parsed.idToken;
    if (parsed.expired ?? parsed.expires_at ?? parsed.expiresAt) {
      normalized.expired = parsed.expired ?? parsed.expires_at ?? parsed.expiresAt;
    }
    if (parsed.last_refresh ?? parsed.lastRefresh) {
      normalized.last_refresh = parsed.last_refresh ?? parsed.lastRefresh;
    }
    return normalized;
  } catch (err) {
    throw new Error(name + ' is not valid CLIProxyAPI Claude token JSON: ' + (err as Error).message);
  }
}

export function normalizeClaudeTokenJson(name: string, tokenJson: string): string {
  return JSON.stringify(normalizeClaudeToken(name, tokenJson));
}

/** Extract the exact bearer value required by `CLAUDE_CODE_OAUTH_TOKEN` while
 *  sharing all accepted input-shape handling with the CLIProxy normalizer. */
export function normalizeClaudeOAuthAccessToken(name: string, tokenJson: string): string {
  const normalized = normalizeClaudeToken(name, tokenJson);
  const accessToken = normalized.access_token;
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw new Error(`${name} does not contain a Claude OAuth access token`);
  }
  return accessToken.trim();
}
