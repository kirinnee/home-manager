import type { Server, ServerWebSocket } from 'bun';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { KTeamService } from './service';
import type { SendRequest } from './types';
import { WARDEN_LABEL } from './warden-detect';
import { renderShell } from './ui';
import { actorContext } from './actor-context';

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
 *  safe-recovery actions, self-completion via `signal`, and `stop` on the ONE
 *  session the calling warden is assigned to — authorized by an unguessable
 *  per-assignment capability minted at spawn (see SessionManager.wardenMayStop),
 *  never by a client-chosen identity. */
async function wardenScopeDenial(
  method: string,
  url: URL,
  service: KTeamService,
  stopCapability: string | undefined,
): Promise<Response | undefined> {
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
    if (action === 'stop') {
      // ASSIGNED wardens may stop exactly their assigned session, proven by
      // the per-assignment capability minted at spawn and exported only into
      // that warden's pane. Possession is the authorization — a different
      // warden holding the same shared scoped token has no way to fabricate
      // it. Aliases can't bypass this: the capability is checked against the
      // RAW path segment here, and stop() resolves refs only afterwards, so
      // an alias that resolves to the target would still need the target's
      // own capability recorded under the alias — which never exists.
      const targetId = decodeURIComponent(match[1]!);
      if (stopCapability && service.wardenMayStop(stopCapability, targetId)) return undefined;
      return forbidden('stop that session (only its assigned warden holds the stop capability)');
    }
    return forbidden(`perform the "${action ?? 'stop'}" action`);
  }
  return forbidden('access this route');
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

/** Mutating session actions the client may retry on a socket error. A retry
 *  reuses the original x-kteam-request-id, so a duplicate id here means the
 *  first attempt already applied server-side — re-applying would duplicate the
 *  message/turn. */
const DEDUPED_ACTIONS = new Set(['send', 'answer', 'signal', 'resume', 'migrate']);

/** Per-session LRU of recently APPLIED request ids. Ids are recorded only after
 *  the mutation succeeds: a failed attempt stays retryable, while a retry of a
 *  success (whose response the client never saw) returns the current session
 *  view instead of applying twice. A hit PROMOTES the id (true LRU): an id the
 *  client is actively retrying must outlive colder ids when capacity evicts. */
export class RecentRequestIds {
  /** sessionRef → insertion-ordered id set (Set preserves insertion order). */
  private readonly sessions = new Map<string, Set<string>>();

  constructor(private readonly capacity = 100) {}

  seen(sessionRef: string, requestId: string): boolean {
    const ids = this.sessions.get(sessionRef);
    if (!ids?.has(requestId)) return false;
    ids.delete(requestId);
    ids.add(requestId);
    return true;
  }

  record(sessionRef: string, requestId: string): void {
    let ids = this.sessions.get(sessionRef);
    if (!ids) this.sessions.set(sessionRef, (ids = new Set()));
    ids.delete(requestId);
    ids.add(requestId);
    while (ids.size > this.capacity) ids.delete(ids.values().next().value!);
  }
}

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
  const recentRequests = new RecentRequestIds();
  /** `${sessionRef}\n${requestId}` → the pending application. A duplicate that
   *  arrives while the first application is still awaited must NOT re-apply —
   *  it shares the original promise (and its error, so a failure stays
   *  retryable for both callers). */
  const inFlightRequests = new Map<string, Promise<unknown>>();
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
    // Bun's default HTTP idleTimeout is 10 s and counts while the HANDLER is
    // still working: revive+send, resume, and live snapshots legitimately hold
    // a request open for 30 s+ (tmux relaunch + readiness + injection under the
    // session lock). At the default, Bun closed the socket mid-operation while
    // the daemon kept working — the CLI reported "daemon unavailable" for calls
    // that actually succeeded (and its blind retry then duplicated sends).
    // 255 is Bun's documented maximum; WebSocket connections are unaffected
    // (they use the separate websocket.idleTimeout, default 120 s, reset by
    // every message/ping).
    idleTimeout: 255,
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
        const denial = await wardenScopeDenial(
          request.method,
          url,
          options.service,
          request.headers.get('x-kteam-stop-capability') ?? undefined,
        );
        if (denial) return denial;
      }

      // Attribute events caused by this request to the warden when it is
      // authenticated as one (warden-scoped token, or an assigned-warden stop
      // capability). SessionManager.emit reads this context.
      const wardenActor = authedWarden || request.headers.get('x-kteam-stop-capability') != null;
      const dispatch = async (): Promise<Response | undefined> => {
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
          if (url.pathname === '/v1/wrappers' && request.method === 'GET')
            return json(await options.service.wrappers());
          if (url.pathname === '/v1/projects' && request.method === 'GET')
            return json(await options.service.projects());
          if (url.pathname === '/v1/warden/status' && request.method === 'GET')
            return json(await options.service.wardenStatus());
          if (url.pathname === '/v1/warden/run' && request.method === 'POST') {
            const input = await body<{ spawn?: boolean }>(request);
            return json(await options.service.wardenRun(input.spawn === true));
          }
          if (url.pathname === '/v1/warden/verdicts' && request.method === 'GET')
            return json(await options.service.wardenVerdicts());
          if (url.pathname === '/v1/warden/report' && request.method === 'GET') {
            const rp = url.searchParams.get('path');
            if (!rp) return json({ error: 'path required' }, 400);
            return new Response(await options.service.wardenReport(rp), {
              headers: { 'content-type': 'text/markdown; charset=utf-8' },
            });
          }
          if (url.pathname === '/v1/sessions' && request.method === 'GET') return json(await options.service.list());
          if (url.pathname === '/v1/sessions' && request.method === 'POST')
            return json(await options.service.start(await body(request)), 201);

          const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(.+))?$/);
          if (!match) return json({ error: 'not found' }, 404);
          const id = decodeURIComponent(match[1]!);
          const action = match[2];
          // Idempotency for retried mutations: apply once per request id, and
          // answer a duplicate with the current session view (the first apply
          // already happened — its response was lost on the wire).
          const requestId = request.headers.get('x-kteam-request-id') ?? undefined;
          const dedupe = action !== undefined && DEDUPED_ACTIONS.has(action) && requestId !== undefined;
          const applyOnce = async (operation: () => Promise<unknown>): Promise<Response> => {
            if (!dedupe) return json(await operation());
            if (recentRequests.seen(id, requestId!)) return json(await options.service.get(id));
            const key = `${id}\n${requestId!}`;
            const pending = inFlightRequests.get(key);
            // Concurrent duplicate (retry overlapping the still-awaited first
            // attempt): share the original application and its outcome.
            if (pending) return json(await pending);
            const attempt = (async () => {
              const result = await operation();
              recentRequests.record(id, requestId!);
              return result;
            })();
            inFlightRequests.set(key, attempt);
            try {
              return json(await attempt);
            } finally {
              inFlightRequests.delete(key);
            }
          };

          if (!action && request.method === 'GET') return json(await options.service.get(id));
          if (!action && request.method === 'DELETE') {
            await options.service.remove(
              id,
              url.searchParams.get('purge') === 'true',
              url.searchParams.get('force') === 'true',
            );
            return new Response(null, { status: 204 });
          }
          if (action === 'send' && request.method === 'POST') {
            const input = await body<SendRequest>(request);
            return await applyOnce(() => options.service.send(id, input));
          }
          if (action === 'answer' && request.method === 'POST') {
            const input = await body<{ labels?: string[]; other?: string; responses?: string[] }>(request);
            return await applyOnce(() => options.service.answer(id, input.labels ?? [], input.other, input.responses));
          }
          if (action === 'interrupt' && request.method === 'POST') return json(await options.service.interrupt(id));
          if (action === 'stop' && request.method === 'POST') {
            const input = await body<{ reason?: string }>(request);
            return json(await options.service.stop(id, input.reason));
          }
          if (action === 'resume' && request.method === 'POST') {
            const input = await body<{ message?: string }>(request);
            return await applyOnce(() => options.service.resume(id, input.message));
          }
          if (action === 'migrate' && request.method === 'POST') {
            const input = await body<{ agent?: string; model?: string }>(request);
            if (!input.agent) throw new HttpError(400, 'agent is required');
            return await applyOnce(() => options.service.migrate(id, input.agent!, input.model));
          }
          if (action === 'signal' && request.method === 'POST') {
            const input = await body<{ kind: 'done' | 'help'; message?: string }>(request);
            if (input.kind !== 'done' && input.kind !== 'help') throw new HttpError(400, 'kind must be done or help');
            return await applyOnce(() => options.service.signal(id, input.kind, input.message));
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
      };
      return wardenActor ? actorContext.run({ actor: 'warden' }, dispatch) : dispatch();
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
