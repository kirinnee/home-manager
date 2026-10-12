// Shared test fixtures (imported only by *.test.ts).
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FetchLike } from './oauth';
import { type TokenSet, TokenStore } from './store';

export const TOKEN_ENDPOINT = 'https://slack.example/api/oauth.v2.user.access';
export const UPSTREAM = 'https://mcp.slack.example/mcp';

export function tempStore(): TokenStore {
  return new TokenStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'kslack-proxy-test-')), 'state', 'token.json'));
}

export function tokenSet(over: Partial<TokenSet> = {}): TokenSet {
  return {
    access_token: 'xoxe.xoxp-1-OLDACCESS-aaaaaaaaaaaa',
    refresh_token: 'xoxe-1-OLDREFRESH-bbbbbbbbbbbb',
    expires_at: Date.now() + 12 * 3600 * 1000,
    client_id: 'cid',
    token_endpoint: TOKEN_ENDPOINT,
    obtained_at: Date.now() - 1000,
    user_id: 'U123',
    team_name: 'Acme',
    ...over,
  };
}

export interface Call {
  url: string;
  init: RequestInit;
  headers: Headers;
  body: string;
}

/** Fake fetch routed by URL; records every call. */
export function fakeFetch(
  route: (url: string, c: Call) => Response | Promise<Response>,
): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const c: Call = {
      url,
      init,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : '',
    };
    calls.push(c);
    return route(url, c);
  }) as FetchLike & { calls: Call[] };
  f.calls = calls;
  return f;
}

export const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const sseRes = (events: unknown[], headers: Record<string, string> = {}) =>
  new Response(events.map(e => `event: message\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream', ...headers },
  });

let n = 0;
/** A refresh reply with fresh rotated tokens. */
export function refreshReply(): Record<string, unknown> {
  n++;
  return {
    ok: true,
    access_token: `xoxe.xoxp-1-NEWACCESS${n}-cccccccccc`,
    refresh_token: `xoxe-1-NEWREFRESH${n}-dddddddddd`,
    expires_in: 43200,
  };
}
