// `kslack-proxy status`: read-only report. Never refreshes (only `serve` owns
// the refresh token) and never prints a token.
import type { FetchLike } from './oauth';
import type { ProxyConfig } from './paths';
import type { TokenStore } from './store';

export interface StatusReport {
  loggedIn: boolean;
  tokenFile: string;
  user?: string;
  team?: string;
  identity?: 'verified' | 'unverified';
  expiresAt?: string;
  expiresInMinutes?: number;
  refreshable?: boolean;
  lastRefresh?: string;
  obtainedAt?: string;
  scopes?: string;
  port: number;
  listening: boolean;
  serviceLoggedIn?: boolean;
  readOnly: boolean;
  error?: string;
}

const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : undefined);

export async function status(
  cfg: ProxyConfig,
  store: TokenStore,
  o: { fetch?: FetchLike; now?: () => number; verify?: boolean } = {},
): Promise<StatusReport> {
  const fetchFn = o.fetch ?? fetch;
  const now = (o.now ?? Date.now)();
  const r: StatusReport = {
    loggedIn: false,
    tokenFile: store.file,
    port: cfg.port,
    listening: false,
    readOnly: !cfg.allowWrites,
  };

  try {
    const t = store.read();
    if (t) {
      r.loggedIn = true;
      r.user = t.user_id;
      r.team = t.team_name ?? t.team_id;
      r.expiresAt = iso(t.expires_at);
      r.expiresInMinutes = t.expires_at ? Math.round((t.expires_at - now) / 60000) : undefined;
      r.refreshable = Boolean(t.refresh_token);
      r.lastRefresh = iso(t.last_refresh_at);
      r.obtainedAt = iso(t.obtained_at);
      r.scopes = t.scope;
      // auth.test is the cheapest identity check; skip it for an expired token
      // (refreshing here would make `status` a second refresh-token owner).
      if (o.verify !== false && (!t.expires_at || t.expires_at > now)) {
        try {
          const res = await fetchFn('https://slack.com/api/auth.test', {
            method: 'POST',
            headers: { authorization: `Bearer ${t.access_token}` },
            signal: AbortSignal.timeout(5000),
          });
          const body = (await res.json()) as Record<string, unknown>;
          if (body.ok) {
            r.identity = 'verified';
            r.user = `${String(body.user ?? '')} (${String(body.user_id ?? t.user_id ?? '')})`;
            r.team = String(body.team ?? r.team ?? '');
          } else r.identity = 'unverified';
        } catch {
          r.identity = 'unverified';
        }
      }
    }
  } catch (e) {
    r.error = `token file unreadable: ${(e as Error).message}`;
  }

  try {
    const res = await fetchFn(`http://127.0.0.1:${cfg.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as Record<string, unknown>;
    r.listening = body.service === 'kslack-proxy';
    r.serviceLoggedIn = Boolean(body.loggedIn);
  } catch {
    r.listening = false;
  }
  return r;
}

export function formatStatus(r: StatusReport): string {
  const lines: string[] = [];
  if (r.loggedIn) {
    lines.push(
      `logged in:     yes${r.user ? ` — ${r.user}` : ''}${r.team ? ` @ ${r.team}` : ''}${r.identity ? ` [${r.identity}]` : ''}`,
    );
    if (r.expiresAt)
      lines.push(
        `token expires: ${r.expiresAt} (${r.expiresInMinutes! >= 0 ? `in ${r.expiresInMinutes} min` : `${-r.expiresInMinutes!} min ago`})`,
      );
    lines.push(`refreshable:   ${r.refreshable ? 'yes' : 'NO — re-run `kslack-proxy login` before it expires'}`);
    lines.push(`last refresh:  ${r.lastRefresh ?? 'never'} (logged in ${r.obtainedAt ?? '?'})`);
    if (r.scopes) lines.push(`scopes:        ${r.scopes}`);
  } else {
    lines.push('logged in:     no — run `kslack-proxy login`');
  }
  if (r.error) lines.push(`error:         ${r.error}`);
  lines.push(`token file:    ${r.tokenFile}`);
  lines.push(
    `service:       ${r.listening ? `listening on http://127.0.0.1:${r.port}/mcp${r.serviceLoggedIn ? '' : ' (reports NOT logged in)'}` : `NOT listening on 127.0.0.1:${r.port}`}`,
  );
  lines.push(
    `policy:        ${r.readOnly ? 'read-only (write tools hidden + blocked)' : 'WRITES ALLOWED (KSLACK_PROXY_ALLOW_WRITES=1)'}`,
  );
  return lines.join('\n');
}
