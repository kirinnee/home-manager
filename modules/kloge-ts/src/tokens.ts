// Normalize the loge pool credentials into CLIProxyAPI auth-file JSON.
//
// This is a faithful port of pe-llm/loge `src/config.ts`
// (normalizeCodexTokenJson / normalizeClaudeTokenJson) so the files kloge
// writes are byte-identical to the ones loge renders into its CLIProxyAPI
// sidecar. If loge changes its normalization, update this to match.

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
export function normalizeClaudeTokenJson(name: string, tokenJson: string): string {
  const raw = tokenJson.trim();
  if (raw.startsWith('sk-ant-oat')) {
    return JSON.stringify({ type: 'claude', access_token: raw });
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const apiKey = parsed.api_key ?? parsed.apiKey;
    if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
      return JSON.stringify({ type: 'claude', ...parsed, api_key: apiKey.trim() });
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
    return JSON.stringify(normalized);
  } catch (err) {
    throw new Error(name + ' is not valid CLIProxyAPI Claude token JSON: ' + (err as Error).message);
  }
}
