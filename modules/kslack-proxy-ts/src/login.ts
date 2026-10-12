// `kslack-proxy login`: browser OAuth (PKCE) with a one-shot callback server
// on 127.0.0.1:3118 — the redirect Slack has registered for this client id.
import { randomBytes } from 'node:crypto';
import { type AuthServer, type FetchLike, READ_SCOPES, authorizeUrl, discover, exchangeCode, pkcePair } from './oauth';
import { CALLBACK_PORT, SLACK_CLIENT_ID } from './paths';
import { errorMessage } from './redact';
import type { TokenSet, TokenStore } from './store';

export interface LoginOptions {
  store: TokenStore;
  upstream: string;
  clientId?: string;
  port?: number;
  allScopes?: boolean;
  openBrowser?: boolean;
  timeoutMs?: number;
  fetch?: FetchLike;
  print?: (msg: string) => void;
  now?: () => number;
}

export class PortBusyError extends Error {
  constructor(port: number) {
    super(
      `port ${port} is already in use (another Slack login — e.g. a Claude Code session — may hold it).\n` +
        `  find it:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
        '  then wait for that login to finish (or stop it) and retry.',
    );
    this.name = 'PortBusyError';
  }
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3em"><h2>${title}</h2><p>${body}</p></body>`;

function tryOpen(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.env.DISPLAY || process.env.WAYLAND_DISPLAY
        ? ['xdg-open', url]
        : null;
  if (!cmd) return;
  try {
    Bun.spawn({ cmd, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // no browser on this machine — the printed URL is enough
  }
}

export async function login(o: LoginOptions): Promise<TokenSet> {
  const fetchFn = o.fetch ?? fetch;
  const print = o.print ?? (m => console.log(m));
  const now = o.now ?? Date.now;
  const port = o.port ?? CALLBACK_PORT;
  const clientId = o.clientId ?? SLACK_CLIENT_ID;
  const redirectUri = `http://localhost:${port}/callback`;

  const as: AuthServer = await discover(o.upstream, fetchFn);
  const scopes = o.allScopes && as.scopes_supported.length > 0 ? as.scopes_supported : READ_SCOPES;
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('base64url');

  let settle!: { resolve: (code: string) => void; reject: (e: Error) => void };
  const codePromise = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const handler = (req: Request): Response => {
    const u = new URL(req.url);
    if (u.pathname !== '/callback') return new Response('not found', { status: 404 });
    const err = u.searchParams.get('error');
    if (err) {
      settle.reject(new Error(`Slack authorization failed: ${err}`));
      return new Response(PAGE('Slack login failed', `Slack said: ${err.replace(/[<>&]/g, '')}. Check the terminal.`), {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (u.searchParams.get('state') !== state)
      return new Response(PAGE('Login state mismatch', 'Ignored — retry from the terminal.'), {
        status: 400,
        headers: { 'content-type': 'text/html' },
      });
    const code = u.searchParams.get('code');
    if (!code) return new Response('missing code', { status: 400 });
    settle.resolve(code);
    return new Response(PAGE('kslack-proxy is logged in', 'You can close this tab.'), {
      headers: { 'content-type': 'text/html' },
    });
  };

  const servers: ReturnType<typeof Bun.serve>[] = [];
  try {
    servers.push(Bun.serve({ hostname: '127.0.0.1', port, fetch: handler }));
  } catch {
    throw new PortBusyError(port);
  }
  // `localhost` may resolve to ::1 first in some browsers; listen there too when possible.
  try {
    servers.push(Bun.serve({ hostname: '::1', port, fetch: handler }));
  } catch {
    // IPv6 loopback unavailable or busy — 127.0.0.1 still works
  }

  const timer = setTimeout(
    () => settle.reject(new Error('timed out waiting for the Slack login callback')),
    o.timeoutMs ?? 5 * 60 * 1000,
  );
  try {
    const url = authorizeUrl(as, { clientId, redirectUri, scopes, state, challenge });
    print('Open this URL to log in to Slack (read-only scopes unless --all-scopes):\n');
    print(`  ${url}\n`);
    print(`Waiting for the callback on ${redirectUri} …`);
    print('(headless box? run `ssh -L 3118:localhost:3118 <box>` and open the URL on your laptop)');
    if (o.openBrowser !== false) tryOpen(url);

    const code = await codePromise;
    const got = await exchangeCode(fetchFn, as, { clientId, code, redirectUri, verifier }, now);
    const tokens: TokenSet = {
      ...got,
      client_id: clientId,
      token_endpoint: as.token_endpoint,
      resource: as.resource,
      obtained_at: now(),
    };
    o.store.write(tokens);
    return tokens;
  } catch (e) {
    throw new Error(errorMessage(e));
  } finally {
    clearTimeout(timer);
    for (const s of servers) s.stop(true);
  }
}
