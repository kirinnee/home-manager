// OAuth against Slack MCP's authorization server: metadata discovery, PKCE,
// code exchange and refresh. Endpoints are discovered, never hard-coded.
import { createHash, randomBytes } from 'node:crypto';
import { registerSecret, scrub } from './redact';
import type { TokenSet } from './store';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AuthServer {
  authorization_endpoint: string;
  token_endpoint: string;
  /** RFC 8707 resource from the protected-resource metadata */
  resource?: string;
  scopes_supported: string[];
}

/** Read-only user scopes requested by default (writes are never granted). */
export const READ_SCOPES = [
  'canvases:read',
  'channels:history',
  'channels:read',
  'emoji:read',
  'files:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'lists:read',
  'mpim:history',
  'mpim:read',
  'reactions:read',
  'search:read.files',
  'search:read.im',
  'search:read.mpim',
  'search:read.private',
  'search:read.public',
  'search:read.users',
  'users:read',
  'users:read.email',
];

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(scrub(message));
    this.name = 'OAuthError';
  }
  /** the refresh token is spent/revoked — only a new `login` can recover */
  get needsLogin(): boolean {
    return [
      'invalid_grant',
      'invalid_refresh_token',
      'token_revoked',
      'token_expired',
      'invalid_auth',
      'not_authed',
      'account_inactive',
    ].includes(this.code);
  }
}

async function getJson(fetchFn: FetchLike, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** RFC 9728 protected-resource metadata → RFC 8414 authorization-server metadata. */
export async function discover(mcpUrl: string, fetchFn: FetchLike = fetch): Promise<AuthServer> {
  const u = new URL(mcpUrl);
  const prm =
    (await getJson(
      fetchFn,
      `${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`,
    )) ?? (await getJson(fetchFn, `${u.origin}/.well-known/oauth-protected-resource`));
  const issuer = (prm?.authorization_servers as string[] | undefined)?.[0] ?? u.origin;
  const iss = new URL(issuer);
  const as =
    (await getJson(
      fetchFn,
      `${iss.origin}/.well-known/oauth-authorization-server${iss.pathname === '/' ? '' : iss.pathname}`,
    )) ?? (await getJson(fetchFn, `${iss.origin}/.well-known/oauth-authorization-server`));
  if (!as || typeof as.authorization_endpoint !== 'string' || typeof as.token_endpoint !== 'string') {
    throw new Error(`could not discover OAuth endpoints for ${mcpUrl}`);
  }
  return {
    authorization_endpoint: as.authorization_endpoint,
    token_endpoint: as.token_endpoint,
    resource: typeof prm?.resource === 'string' ? prm.resource : undefined,
    scopes_supported: Array.isArray(as.scopes_supported) ? (as.scopes_supported as string[]) : [],
  };
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function authorizeUrl(
  as: AuthServer,
  p: { clientId: string; redirectUri: string; scopes: string[]; state: string; challenge: string },
): string {
  const url = new URL(as.authorization_endpoint);
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', p.scopes.join(' '));
  url.searchParams.set('state', p.state);
  url.searchParams.set('code_challenge', p.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (as.resource) url.searchParams.set('resource', as.resource);
  return url.toString();
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Normalize a token endpoint reply. Slack answers HTTP 200 + `ok:false` on
 * errors and may nest the user token under `authed_user`; RFC-style servers
 * answer 4xx + `error`. Never echoes the body back (it holds tokens).
 */
export function parseTokenResponse(
  status: number,
  body: Raw,
  now: number,
): Omit<TokenSet, 'client_id' | 'token_endpoint' | 'obtained_at'> {
  if (body.ok === false || body.error || status >= 400) {
    const code = str(body.error) ?? `http_${status}`;
    throw new OAuthError(
      code,
      `Slack token endpoint rejected the request: ${code}${str(body.error_description) ? ` (${str(body.error_description)})` : ''}`,
    );
  }
  const src = str(body.access_token) ? body : (body.authed_user as Raw | undefined);
  const access = str(src?.access_token);
  if (!src || !access) throw new OAuthError('no_access_token', 'Slack token endpoint returned no access token');
  const expiresIn = Number(src.expires_in ?? body.expires_in);
  const team = body.team as Raw | undefined;
  const out = {
    access_token: access,
    refresh_token: str(src.refresh_token) ?? str(body.refresh_token),
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    scope: str(src.scope) ?? str(body.scope),
    token_type: str(src.token_type) ?? str(body.token_type),
    user_id: str(src.id) ?? str((body.authed_user as Raw | undefined)?.id) ?? str(body.user_id),
    team_id: str(team?.id) ?? str(body.team_id),
    team_name: str(team?.name),
  };
  registerSecret(out.access_token);
  registerSecret(out.refresh_token);
  return out;
}

async function postToken(
  fetchFn: FetchLike,
  endpoint: string,
  form: Record<string, string | undefined>,
  now: () => number,
) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined) params.set(k, v);
  let res: Response;
  try {
    res = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: params.toString(),
    });
  } catch (e) {
    throw new OAuthError('network', `token endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  let body: Raw = {};
  try {
    body = (await res.json()) as Raw;
  } catch {
    // non-JSON → reported via status below
  }
  return parseTokenResponse(res.status, body, now());
}

export function exchangeCode(
  fetchFn: FetchLike,
  as: AuthServer,
  p: { clientId: string; code: string; redirectUri: string; verifier: string },
  now: () => number = Date.now,
) {
  return postToken(
    fetchFn,
    as.token_endpoint,
    {
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      code_verifier: p.verifier,
      resource: as.resource,
    },
    now,
  );
}

export function refreshTokens(fetchFn: FetchLike, t: TokenSet, now: () => number = Date.now) {
  if (!t.refresh_token) throw new OAuthError('no_refresh_token', 'stored token has no refresh token');
  return postToken(
    fetchFn,
    t.token_endpoint,
    { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id, resource: t.resource },
    now,
  );
}
