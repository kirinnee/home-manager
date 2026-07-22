import type { Server, ServerWebSocket } from 'bun';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { KTeamService } from './service';
import { WARDEN_LABEL } from './warden-detect';
import { renderShell } from './ui';

// Built chat UI (Vite output, committed): served when present; the legacy
// single-file shell remains the fallback so the daemon never 404s its own UI.
const UI_DIST = new URL('../ui-dist', import.meta.url).pathname;

interface SocketData {
  sessionId?: string;
  after: number;
  replaying: boolean;
  queued: string[];
}

export interface ApiServerOptions {
  host: string;
  port: number;
  token: string;
  /** Capability-scoped token the warden pane runs under. When set, requests
   *  bearing it are restricted to a read + safe-recovery allowlist (GET routes
   *  except warden oversight, plus send/answer/resume/migrate, plus signalling
   *  ONLY a warden-labelled session so the warden can complete itself). Every
   *  other route — start/stop/remove/interrupt and the warden/* routes — is
   *  rejected 403. Omitted in tests that only exercise the admin path. */
  wardenToken?: string;
  service: KTeamService;
}

/** Actions the warden-scoped token may POST to /v1/sessions/:id. `signal` is
 *  gated further (self-completion only) in the gate below. */
const WARDEN_ALLOWED_ACTIONS = new Set(['send', 'answer', 'resume', 'migrate']);

/** Decide whether the warden-scoped token may perform this request. Returns a
 *  403 Response when denied, or undefined when allowed. Reads (GET) are allowed
 *  except the warden oversight routes; the only permitted writes are the
 *  safe-recovery actions plus self-completion via `signal`. */
async function wardenScopeDenial(method: string, url: URL, service: KTeamService): Promise<Response | undefined> {
  const forbidden = (what: string) => json({ error: `the warden-scoped token may not ${what}` }, 403);
  const pathname = url.pathname;
  if (pathname.startsWith('/v1/warden/')) return forbidden('use the warden oversight routes');
  if (method === 'GET') return undefined; // every other read is fine
  if (pathname === '/v1/sessions' && method === 'POST') return forbidden('start sessions');
  if (method === 'DELETE') return forbidden('remove sessions');
  const match = pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(.+))?$/);
  if (match && method === 'POST') {
    const action = match[2];
    if (action && WARDEN_ALLOWED_ACTIONS.has(action)) return undefined;
    if (action === 'signal') {
      // A warden completes its own turn with `kteam signal done`; permit signal
      // ONLY when the target resolves to a warden-labelled session, so it can
      // never mark another teammate's work done or ask for help on its behalf.
      const id = decodeURIComponent(match[1]!);
      const target = await service.get(id).catch(() => undefined);
      if (target?.config.label === WARDEN_LABEL) return undefined;
      return forbidden('signal a non-warden session');
    }
    return forbidden(`perform the "${action ?? 'stop'}" action`);
  }
  return forbidden('access this route');
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function startApiServer(options: ApiServerOptions): Server<SocketData> {
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const unsubscribe = options.service.subscribe(event => {
    const encoded = JSON.stringify(event);
    for (const socket of sockets) {
      if (!socket.data.sessionId || socket.data.sessionId === event.sessionId) {
        if (socket.data.replaying) socket.data.queued.push(encoded);
        else socket.send(encoded);
      }
    }
  });

  const server = Bun.serve<SocketData>({
    hostname: options.host,
    port: options.port,
    async fetch(request, serverInstance) {
      const url = new URL(request.url);
      const isWebSocket =
        url.pathname === '/v1/events' && request.headers.get('upgrade')?.toLowerCase() === 'websocket';
      const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
      // Loopback requesters may already read the token file, so serving them
      // the token grants nothing new. NON-loopback requesters (KTEAM_HOST set,
      // reverse proxy, forwarded port) must never receive it — they get a
      // token-less shell (the SPA surfaces the 401s) and their WS query-param
      // token is ignored so the token never travels in a loggable URL.
      const remoteAddress = serverInstance.requestIP(request)?.address ?? '';
      const loopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
      // Browser WebSocket constructors cannot set Authorization headers. The UI
      // embeds the daemon token (loopback only) and passes it as a query
      // parameter; ordinary HTTP API calls remain bearer-authenticated.
      const websocketToken = isWebSocket && loopback ? url.searchParams.get('token') : undefined;
      if (request.method === 'GET' && !url.pathname.startsWith('/v1/')) {
        const distIndex = join(UI_DIST, 'index.html');
        if (existsSync(distIndex)) {
          // Static assets (hashed filenames → cacheable). Path is confined to
          // the dist dir; anything escaping it falls through to index.html.
          const assetPath = normalize(join(UI_DIST, url.pathname));
          // index.html must NEVER take the raw-static path — it would leak the
          // unsubstituted placeholder to the browser.
          if (
            url.pathname !== '/' &&
            !assetPath.endsWith('/index.html') &&
            assetPath.startsWith(`${UI_DIST}/`) &&
            existsSync(assetPath)
          ) {
            return new Response(Bun.file(assetPath), {
              headers: { 'cache-control': 'public, max-age=31536000, immutable' },
            });
          }
          // SPA shell for every client-side route; token only for loopback.
          // Replace ONLY the quoted placeholder VALUE (either quote style —
          // prettier rewrites the inline script to single quotes): a bare
          // replaceAll also rewrites the `window.__KTEAM_TOKEN__` property
          // NAME, silently renaming the global the SPA reads.
          const tokenJson = JSON.stringify(loopback ? options.token : '');
          const html = (await Bun.file(distIndex).text())
            .replaceAll('"__KTEAM_TOKEN__"', tokenJson)
            .replaceAll("'__KTEAM_TOKEN__'", tokenJson);
          return new Response(html, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
        }
        return new Response(renderShell(loopback ? options.token : ''), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      const authedAdmin = bearer === options.token || websocketToken === options.token;
      const authedWarden = options.wardenToken !== undefined && bearer === options.wardenToken;
      if (!authedAdmin && !authedWarden) return json({ error: 'unauthorized' }, 401);
      // Warden-scoped token: enforce the capability allowlist before routing.
      // (An admin token that also happens to match is never scoped.)
      if (authedWarden && !authedAdmin) {
        const denial = await wardenScopeDenial(request.method, url, options.service);
        if (denial) return denial;
      }

      try {
        if (isWebSocket) {
          const upgraded = serverInstance.upgrade(request, {
            data: {
              sessionId: url.searchParams.get('sessionId') ?? undefined,
              after: Number(url.searchParams.get('after') ?? 0),
              replaying: true,
              queued: [],
            },
          });
          return upgraded ? undefined : json({ error: 'websocket upgrade failed' }, 400);
        }
        if (url.pathname === '/v1/health' && request.method === 'GET') return json(await options.service.health());
        if (url.pathname === '/v1/warden/status' && request.method === 'GET')
          return json(await options.service.wardenStatus());
        if (url.pathname === '/v1/warden/run' && request.method === 'POST') {
          const input = await body<{ spawn?: boolean }>(request);
          return json(await options.service.wardenRun(input.spawn === true));
        }
        if (url.pathname === '/v1/sessions' && request.method === 'GET') return json(await options.service.list());
        if (url.pathname === '/v1/sessions' && request.method === 'POST')
          return json(await options.service.start(await body(request)), 201);

        const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(.+))?$/);
        if (!match) return json({ error: 'not found' }, 404);
        const id = decodeURIComponent(match[1]!);
        const action = match[2];

        if (!action && request.method === 'GET') return json(await options.service.get(id));
        if (!action && request.method === 'DELETE') {
          await options.service.remove(
            id,
            url.searchParams.get('purge') === 'true',
            url.searchParams.get('force') === 'true',
          );
          return new Response(null, { status: 204 });
        }
        if (action === 'send' && request.method === 'POST')
          return json(await options.service.send(id, await body(request)));
        if (action === 'answer' && request.method === 'POST') {
          const input = await body<{ labels?: string[]; other?: string; responses?: string[] }>(request);
          return json(await options.service.answer(id, input.labels ?? [], input.other, input.responses));
        }
        if (action === 'interrupt' && request.method === 'POST') return json(await options.service.interrupt(id));
        if (action === 'stop' && request.method === 'POST') {
          const input = await body<{ reason?: string }>(request);
          return json(await options.service.stop(id, input.reason));
        }
        if (action === 'resume' && request.method === 'POST') {
          const input = await body<{ message?: string }>(request);
          return json(await options.service.resume(id, input.message));
        }
        if (action === 'migrate' && request.method === 'POST') {
          const input = await body<{ agent?: string; model?: string }>(request);
          if (!input.agent) throw new HttpError(400, 'agent is required');
          return json(await options.service.migrate(id, input.agent, input.model));
        }
        if (action === 'signal' && request.method === 'POST') {
          const input = await body<{ kind: 'done' | 'help'; message?: string }>(request);
          if (input.kind !== 'done' && input.kind !== 'help') throw new HttpError(400, 'kind must be done or help');
          return json(await options.service.signal(id, input.kind, input.message));
        }
        if (action === 'snapshot' && request.method === 'GET') {
          // Default = the monitor's on-disk frame (fast, lock-free). ?live=true
          // forces a fresh tmux capture under the session lock (CLI behavior) —
          // that path can block for seconds on a busy session.
          const live = url.searchParams.get('live') === 'true';
          return new Response(await (live ? options.service.snapshot(id) : options.service.lastSnapshot(id)), {
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
        if (action === 'chat' && request.method === 'GET') {
          const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
          return json(await options.service.chatHistory(id, before, limit));
        }
        if (action === 'logs' && request.method === 'GET') {
          const turn = url.searchParams.has('turn') ? Number(url.searchParams.get('turn')) : undefined;
          return new Response(await options.service.logs(id, turn), {
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
        if (action === 'events' && request.method === 'GET') {
          return json(
            await options.service.replay(
              id,
              Number(url.searchParams.get('after') ?? 0),
              Number(url.searchParams.get('limit') ?? 1000),
            ),
          );
        }
        if (action === 'attachments' && request.method === 'POST') {
          const form = await request.formData();
          const file = form.get('file');
          if (!(file instanceof File)) throw new HttpError(400, 'multipart field "file" is required');
          return json(
            await options.service.addAttachment(id, file.name, file.type, new Uint8Array(await file.arrayBuffer())),
            201,
          );
        }
        const attachment = action?.match(/^attachments\/([^/]+)$/);
        if (attachment && request.method === 'GET') {
          const result = await options.service.getAttachment(id, decodeURIComponent(attachment[1]!));
          return new Response(Uint8Array.from(result.bytes).buffer, {
            headers: {
              'content-type': result.attachment.mime,
              'content-length': String(result.attachment.size),
              'content-disposition': `inline; filename="${result.attachment.filename.replace(/["\\]/g, '_')}"`,
            },
          });
        }
        return json({ error: 'not found' }, 404);
      } catch (error) {
        const status =
          error instanceof HttpError ? error.status : /unknown kteam session/i.test(String(error)) ? 404 : 409;
        return json({ error: error instanceof Error ? error.message : String(error) }, status);
      }
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        void (async () => {
          let cursor = socket.data.after;
          while (true) {
            const events = await options.service.replay(socket.data.sessionId, cursor, 1_000);
            for (const event of events) socket.send(JSON.stringify(event));
            if (events.length > 0) cursor = events.at(-1)!.sequence;
            if (events.length < 1_000) break;
          }
          socket.data.replaying = false;
          for (const encoded of socket.data.queued) {
            const queued = JSON.parse(encoded) as { sequence?: number };
            if ((queued.sequence ?? 0) > cursor) socket.send(encoded);
          }
          socket.data.queued.length = 0;
        })().catch(error => socket.send(JSON.stringify({ type: 'error', error: String(error) })));
      },
      close(socket) {
        sockets.delete(socket);
      },
      message() {},
    },
  });

  const originalStop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    unsubscribe();
    return originalStop(closeActiveConnections);
  }) as typeof server.stop;
  return server;
}
