// Streamable-HTTP MCP pass-through: localhost /mcp → https://mcp.slack.com/mcp.
// Injects the proxy-owned bearer token, enforces the read-only policy, and
// streams SSE straight through (never buffered).
import type { FetchLike } from './oauth';
import { blockedCalls, blockedError, filterMessage, sseFilter } from './policy';
import { type Logger, errorMessage } from './redact';
import { LOGIN_HINT, NotLoggedInError, type TokenManager } from './tokens';

export interface ProxyOptions {
  tokens: TokenManager;
  upstream: string;
  allowWrites: boolean;
  fetch?: FetchLike;
  log?: Logger;
}

// Never forwarded upstream: hop-by-hop, client auth (we inject our own), and
// accept-encoding (fetch decodes for us; the SSE/JSON filters need plain text).
const DROP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'authorization',
  'proxy-authorization',
  'cookie',
  'accept-encoding',
  'origin',
  'referer',
]);
// Never forwarded back: hop-by-hop + encoding/length (the body may be rewritten
// or was already decoded) + upstream auth challenges (the client has no auth to give).
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'www-authenticate',
  'set-cookie',
]);

export const NOT_LOGGED_IN_CODE = -32001;

function upstreamHeaders(h: Headers, token: string): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (!DROP_REQUEST.has(k.toLowerCase())) out.set(k, v);
  });
  out.set('authorization', `Bearer ${token}`);
  return out;
}

function responseHeaders(h: Headers): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (!DROP_RESPONSE.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

function rpcError(id: unknown, code: number, message: string, status: number): Response {
  return json(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { 'x-kslack-proxy-error': 'true' });
}

const firstId = (body: unknown): unknown => {
  const m = Array.isArray(body) ? body[0] : body;
  return typeof m === 'object' && m !== null ? (m as Record<string, unknown>).id : undefined;
};

export function createProxy(o: ProxyOptions): (req: Request) => Promise<Response> {
  const fetchFn = o.fetch ?? fetch;
  const log = o.log ?? (() => {});

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') {
      let loggedIn = false;
      try {
        loggedIn = o.tokens.current() !== null;
      } catch {
        // corrupt token file → report not logged in
      }
      return json(200, { ok: true, service: 'kslack-proxy', loggedIn, readOnly: !o.allowWrites });
    }
    if (url.pathname !== '/mcp') return json(404, { error: 'not found — the MCP endpoint is /mcp' });
    if (!['POST', 'GET', 'DELETE'].includes(req.method))
      return json(405, { error: 'method not allowed' }, { allow: 'GET, POST, DELETE' });

    const started = Date.now();
    const bodyText = req.method === 'POST' ? await req.text() : undefined;
    let parsed: unknown;
    if (bodyText) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = undefined;
      }
    }
    const describe = (() => {
      const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      return items
        .map(m => {
          const r = m as Record<string, unknown>;
          const tool =
            r.method === 'tools/call' ? `:${String((r.params as Record<string, unknown> | undefined)?.name)}` : '';
          return `${String(r.method ?? 'response')}${tool}`;
        })
        .join(',');
    })();

    if (!o.allowWrites && parsed !== undefined) {
      const blocked = blockedCalls(parsed);
      if (blocked.length > 0) {
        log(`${req.method} /mcp ${describe} → blocked by read-only policy`);
        const errors = blocked.map(blockedError);
        return json(200, Array.isArray(parsed) ? errors : errors[0]);
      }
    }

    let token: string;
    try {
      token = await o.tokens.accessToken();
    } catch (e) {
      log(`${req.method} /mcp ${describe} → ${errorMessage(e)}`);
      if (e instanceof NotLoggedInError) return rpcError(firstId(parsed), NOT_LOGGED_IN_CODE, e.message, 503);
      return rpcError(
        firstId(parsed),
        NOT_LOGGED_IN_CODE,
        `kslack-proxy could not obtain a Slack token: ${errorMessage(e)}`,
        503,
      );
    }

    const send = (t: string) =>
      fetchFn(o.upstream, {
        method: req.method,
        headers: upstreamHeaders(req.headers, t),
        body: bodyText,
        signal: req.signal,
      });

    let res: Response;
    try {
      res = await send(token);
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        const fresh = await o.tokens.refresh(token);
        res = await send(fresh.access_token);
        if (res.status === 401) {
          await res.body?.cancel().catch(() => {});
          log(`${req.method} /mcp ${describe} → upstream 401 after refresh`);
          return rpcError(
            firstId(parsed),
            NOT_LOGGED_IN_CODE,
            `Slack rejected the proxy's token even after a refresh — ${LOGIN_HINT}`,
            503,
          );
        }
      }
    } catch (e) {
      if (e instanceof NotLoggedInError) {
        log(`${req.method} /mcp ${describe} → ${e.message}`);
        return rpcError(firstId(parsed), NOT_LOGGED_IN_CODE, e.message, 503);
      }
      if (req.signal.aborted) return new Response(null, { status: 499 });
      log(`${req.method} /mcp ${describe} → upstream error: ${errorMessage(e)}`);
      return rpcError(firstId(parsed), -32002, `kslack-proxy could not reach Slack MCP: ${errorMessage(e)}`, 502);
    }

    log(`${req.method} /mcp ${describe || '-'} → ${res.status} (${Date.now() - started}ms)`);
    const headers = responseHeaders(res.headers);
    const type = res.headers.get('content-type') ?? '';
    if (o.allowWrites || !res.body) return new Response(res.body, { status: res.status, headers });
    if (type.includes('text/event-stream'))
      return new Response(res.body.pipeThrough(sseFilter()), { status: res.status, headers });
    if (type.includes('json')) {
      const text = await res.text();
      try {
        const r = filterMessage(JSON.parse(text));
        return new Response(r.changed ? JSON.stringify(r.msg) : text, { status: res.status, headers });
      } catch {
        return new Response(text, { status: res.status, headers });
      }
    }
    return new Response(res.body, { status: res.status, headers });
  };
}
