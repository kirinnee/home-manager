import type { Server, ServerWebSocket } from 'bun';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { KTeamService, SessionView, WardenConfigPatch } from './service';
import { SIGNAL_KINDS } from './types';
import type { KTeamEvent, RuntimeControlRequest, SendRequest, SignalKind, StartSessionRequest } from './types';
import { WARDEN_LABEL } from './warden-detect';
import type { LearningAction, LearningService } from './learning';
import type { ProposalState } from './learning-types';
import { renderShell } from './ui';
import { actorContext, isHumanAdminActor, resolveApiActor, type TokenClass } from './actor-context';
import { KTEAM_VERSION } from './version';
import { FsError } from './fs';
import { GitError } from './git';
import { listSkills } from './skills';
import type { SttService } from './stt-service';
import type { TaskApi } from './tasks-api';
import { resolveTaskActor, taskApiRequestFrom } from './tasks-api';
import type { PinApi } from './pins-api';
import { isPinPath, pinWardenDenial } from './pins-api';
import type { AttentionApi } from './attention-api';
import { isAttentionPath, attentionWardenDenial } from './attention-api';
import type { PushApi } from './push-api';
import { isPushPath, pushWardenDenial } from './push-api';
import { isTaskPath, taskWardenDenial } from './tasks-contract';
import type { AnalyticsQueryService } from './analytics-types';
import { AnalyticsQueryError } from './analytics-query';
import type { TerminalApi } from './terminal-api';
import { isTerminalPath, matchTerminalRoute, terminalWardenDenial } from './terminal-api';
import type { TerminalStreamBridge, TerminalStreamChunk } from './terminal-stream';
import { isTerminalError } from './terminal-types';
import type { BrowserApi } from './browser-api';
import { browserWardenDenial, isBrowserPath, matchBrowserRoute } from './browser-api';
import type { BrowserStreamBridge, BrowserStreamChunk } from './browser-stream';
import { isBrowserError } from './browser-types';

// Built chat UI (Vite output, committed): served when present; the legacy
// single-file shell remains the fallback so the daemon never 404s its own UI.
const UI_DIST = new URL('../ui-dist', import.meta.url).pathname;

interface EventSocketData {
  kind: 'events';
  /** Sessions this socket subscribes to. Empty = the whole fleet.
   *  `?sessionId=` may repeat or carry a comma-separated list, so one socket
   *  can follow N specific teammates without taking the fleet firehose. */
  sessionIds: string[];
  /** Per-session delivery cursor (that session's own `sequence`). Independent
   *  per session by construction: sessions no longer share an ordering domain,
   *  so a busy one cannot delay or renumber another's frames. */
  cursors: Map<string, number>;
  after: number;
  replaying: boolean;
  queued: string[];
}

interface TerminalSocketData {
  kind: 'terminal';
  sessionId: string;
  terminalId: string;
  /** Resolved from the authenticated request before the upgrade. */
  actor: KTeamEvent['source'];
  bridge?: TerminalStreamBridge;
  /** Frames can arrive while the async tmux viewer attachment is opening. */
  pending: TerminalStreamChunk[];
  pendingBytes: number;
  closed: boolean;
}

interface BrowserSocketData {
  kind: 'browser';
  sessionId: string;
  /** Resolved from the authenticated request before the upgrade. */
  actor: KTeamEvent['source'];
  bridge?: BrowserStreamBridge;
  /** Input can arrive while the async screencast attachment is opening. */
  pending: BrowserStreamChunk[];
  pendingBytes: number;
  closed: boolean;
}

type SocketData = EventSocketData | TerminalSocketData | BrowserSocketData;

const MAX_PENDING_TERMINAL_INPUT_BYTES = 1024 * 1024;
const MAX_PENDING_BROWSER_INPUT_BYTES = 1024 * 1024;

/** Parse `?sessionId=a&sessionId=b` and `?sessionId=a,b` into a de-duplicated list. */
function subscribedSessions(url: URL): string[] {
  const raw = url.searchParams.getAll('sessionId').flatMap(value => value.split(','));
  return [...new Set(raw.map(value => value.trim()).filter(value => value.length > 0))];
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
  /** The Learning subsystem (mines terminal sessions into proposed fleet
   *  rules). Optional and additive — an older daemon or a test can omit it and
   *  every /v1/learning/* route answers 404. Kept separate from KTeamService so
   *  the learning surface never widens the warden-scoped token. */
  learning?: LearningService;
  /** Optional batch dictation subsystem. When omitted, STT routes are 404. */
  stt?: SttService;
  /** Optional for older tests; daemon-entry supplies the singleton in production. */
  tasks?: TaskApi;
  /** Daemon-owned per-session pins. Omitted in tests that don't exercise pins. */
  pins?: PinApi;
  /** Admin-only independent shell terminals, including their WebSocket stream. */
  terminals?: TerminalApi;
  /** Per-session remote browser actions and the human-admin screencast. */
  browser?: BrowserApi;
  /** Durable, daemon-owned per-session attention records. */
  attention?: AttentionApi;
  /** Admin-only Web Push enrollment and per-device management. */
  push?: PushApi;
  /** Fleet-wide historical analytics over the daemon-owned SQLite index. */
  analytics?: AnalyticsQueryService;
}

/** The Codex discovery baseline is private launch bookkeeping, not session
 *  state. Returning ~700 UUIDs per Codex session made the 707-session list
 *  response 11.8 MB (10.44 MB was this field alone). */
export function compactFleetSession(view: SessionView): SessionView {
  if (view.config.harnessSessionBaseline === undefined) return view;
  const { harnessSessionBaseline: _baseline, ...config } = view.config;
  return { ...view, config };
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
  // Learning is admin-only (it can accept/reject rules that steer the whole
  // fleet). Deny BEFORE the generic GET allowance below.
  if (pathname.startsWith('/v1/learning')) return forbidden('use the learning routes');
  if (pathname === '/v1/stt' || pathname.startsWith('/v1/stt/')) return forbidden('use the dictation routes');
  // Working-tree bytes are admin-only. A warden oversees session conduct; it
  // does not need repository contents. This must stay before the generic GET
  // allowance or every filesystem route silently becomes warden-readable.
  if (/^\/v1\/sessions\/[^/]+\/fs(?:\/|$)/.test(pathname)) return forbidden('browse session files');
  const taskDenial = taskWardenDenial(method, pathname);
  if (taskDenial) return forbidden(taskDenial);
  const pinDenial = pinWardenDenial(method, pathname);
  if (pinDenial) return forbidden(pinDenial);
  const terminalDenial = terminalWardenDenial(method, pathname);
  if (terminalDenial) return forbidden(terminalDenial);
  const browserDenial = browserWardenDenial(method, pathname);
  if (browserDenial) return forbidden(browserDenial);
  const attentionDenial = attentionWardenDenial(method, pathname);
  if (attentionDenial) return forbidden(attentionDenial);
  const pushDenial = pushWardenDenial(method, pathname);
  if (pushDenial) return forbidden(pushDenial);
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

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'x-kteam-version': KTEAM_VERSION } });

/** Filesystem responses can contain working-tree bytes and must not enter the
 * browser's private HTTP cache (the service worker already passes /v1 through). */
const fsJson = (value: unknown, status = 200): Response => {
  const response = json(value, status);
  response.headers.set('cache-control', 'no-store');
  return response;
};

/**
 * Is this request on the filesystem surface, and therefore no-store?
 *
 * Derived from the PATH rather than from a parsed `action` variable so the catch
 * handler can ask the same question the routes do — including for errors thrown
 * before any parsing happened.
 */
const isFsPath = (pathname: string): boolean => /^\/v1\/sessions\/[^/]+\/fs(\/|$)/.test(pathname);

/** Body for a route the daemon doesn't recognise. The `code` lets the CLI tell
 *  this apart from a "no such session" 404 (which carries a descriptive error),
 *  and method+path let it name the exact route — the classic version-skew
 *  symptom when a new CLI hits an old daemon after a deploy. */
const unknownRoute = (method: string, path: string) => ({
  error: `no route ${method} ${path}`,
  code: 'unknown_route',
  method,
  path,
});

/** Mutating session actions the client may retry on a socket error. A retry
 *  reuses the original x-kteam-request-id, so a duplicate id here means the
 *  first attempt already applied server-side — re-applying would duplicate the
 *  message/turn. */
const DEDUPED_ACTIONS = new Set(['send', 'answer', 'interrupt', 'signal', 'resume', 'migrate', 'rename', 'runtime']);

/** A request id that is safe to PERSIST and to embed in a filename.
 *
 *  `x-kteam-request-id` is chosen by the client, and the send path promotes it to
 *  the durable send id — which the native-file queue path embeds in a path
 *  (`channel/queued-<id>.md`). The charset therefore admits no `/`, `\` or `.` at
 *  all, which makes `..` and absolute paths UNREPRESENTABLE rather than merely
 *  filtered, and the 128 cap keeps the resulting filename bounded. A browser's
 *  `crypto.randomUUID()` satisfies it unchanged.
 *
 *  Dedupe is deliberately NOT gated on this: an id that fails the predicate is
 *  still a perfectly good idempotency token, so it keeps working for `applyOnce`
 *  and only loses its promotion to a durable identity. SessionManager enforces the
 *  same rule independently — it is reachable from the CLI without passing here. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

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

/** Reserved dedup ref for session CREATE (no session id exists yet). */
const CREATE_REF = '#create';

/** Insertion-ordered map with a hard capacity — oldest entry evicted first. */
class BoundedMap<K, V> {
  private readonly entries = new Map<K, V>();
  constructor(private readonly capacity = 200) {}
  get(key: K): V | undefined {
    return this.entries.get(key);
  }
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

/** Body parse for a route whose payload is entirely optional: an absent or
 *  empty body is the no-fields case, not a client error. Malformed JSON is
 *  still a 400 — silently downgrading it would drop a field the caller meant
 *  to send. */
async function optionalBody<T extends object>(request: Request): Promise<T> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
  if (text.trim() === '') return {} as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
  // A nonempty non-object body is not the generic no-fields shape. Treating it
  // as `{}` would silently downgrade a malformed question-bound abandon into a
  // generic interrupt of whatever happens to be running now.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new HttpError(400, 'JSON body must be an object');
  return parsed as T;
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
  /** requestId → the session that request already created (create idempotency). */
  const createdSessions = new BoundedMap<string, string>();
  /** In-flight creates, so a retry that overlaps the first attempt shares it. */
  const createRequests = new Map<string, Promise<SessionView>>();
  /** `${sessionRef}\n${requestId}` → the pending application. A duplicate that
   *  arrives while the first application is still awaited must NOT re-apply —
   *  it shares the original promise (and its error, so a failure stays
   *  retryable for both callers). */
  const inFlightRequests = new Map<string, Promise<unknown>>();
  const broadcast = (event: KTeamEvent): void => {
    const encoded = JSON.stringify(event);
    for (const socket of sockets) {
      if (socket.data.kind !== 'events') continue;
      if (socket.data.sessionIds.length > 0 && !socket.data.sessionIds.includes(event.sessionId)) continue;
      if (socket.data.replaying) socket.data.queued.push(encoded);
      else socket.send(encoded);
    }
  };
  const unsubscribe = options.service.subscribe(broadcast);
  // Per-session task, pin and attention mutations broadcast whole snapshots,
  // so every matching reader converges without polling or cursor replay.
  const unsubscribeTasks = options.tasks?.subscribe(broadcast);
  const unsubscribePins = options.pins?.subscribe(broadcast);
  const unsubscribeAttention = options.attention?.subscribe(broadcast);

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
      // WHATWG URL parsing canonicalizes dot segments (including encoded dot
      // segments) before routing. Keep every browser classifier on this one
      // normalized pathname so the warden gate, upgrade, and HTTP mount cannot
      // disagree about which surface a request targets.
      const pathname = url.pathname;
      if (url.pathname === '/stt-models' || url.pathname.startsWith('/stt-models/')) {
        if (!options.stt) return json(unknownRoute(request.method, url.pathname), 404);
        return await options.stt.handlePublicModel(request, url);
      }
      const wantsWebSocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
      const isEventWebSocket = url.pathname === '/v1/events' && wantsWebSocket;
      // Match the RAW pathname. In particular, never normalize an encoded
      // traversal-shaped session id into a route that TerminalApi rejected.
      const terminalRoute = options.terminals ? matchTerminalRoute(url.pathname) : null;
      const isTerminalWebSocket = terminalRoute?.kind === 'stream' && wantsWebSocket;
      const browserRoute = options.browser ? matchBrowserRoute(pathname) : null;
      const isBrowserWebSocket = browserRoute?.kind === 'stream' && wantsWebSocket;
      const isWebSocket = isEventWebSocket || isTerminalWebSocket || isBrowserWebSocket;
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

      // Attribute events caused by this request to WHOEVER caused it — the human
      // via the CLI ('admin-cli') or web UI ('admin-ui'), a warden
      // ('warden:<id>'), or a teammate ('peer:<id>') — so the journal can answer
      // "who did this" instead of blaming 'daemon'. SessionManager.emit reads
      // this context at emit time. A warden is authenticated by the warden-scoped
      // token or an assigned-warden stop capability; everything else is the admin
      // token, split into peer/CLI/UI by the self-identification headers.
      const tokenClass: TokenClass =
        authedWarden || request.headers.get('x-kteam-stop-capability') != null ? 'warden' : 'admin';
      const actor = resolveApiActor({
        tokenClass,
        sessionId: request.headers.get('x-kteam-session-id') ?? undefined,
        client: request.headers.get('x-kteam-client') ?? undefined,
      });
      const dispatch = async (): Promise<Response | undefined> => {
        try {
          if (isEventWebSocket) {
            const upgraded = serverInstance.upgrade(request, {
              data: {
                kind: 'events',
                sessionIds: subscribedSessions(url),
                cursors: new Map<string, number>(),
                after: Number(url.searchParams.get('after') ?? 0),
                replaying: true,
                queued: [],
              },
            });
            return upgraded ? undefined : json({ error: 'websocket upgrade failed' }, 400);
          }
          if (isTerminalWebSocket && terminalRoute?.kind === 'stream' && options.terminals) {
            // Prove both admin authorization and terminal existence BEFORE the
            // protocol switch. The resolved actor is server-derived and is the
            // same unforgeable identity used by the HTTP mount below.
            const canonical = await options.terminals.authorizeStream(
              terminalRoute.sessionId,
              terminalRoute.terminalId,
              actor,
            );
            const upgraded = serverInstance.upgrade(request, {
              data: {
                kind: 'terminal',
                sessionId: canonical.sessionId,
                terminalId: canonical.terminalId,
                actor,
                pending: [],
                pendingBytes: 0,
                closed: false,
              },
            });
            return upgraded ? undefined : json({ error: 'websocket upgrade failed' }, 400);
          }
          if (isBrowserWebSocket && browserRoute?.kind === 'stream' && options.browser) {
            // BrowserApi proves human-admin authorization and canonical session
            // ownership before the protocol switch, then repeats it while the
            // stream opens. `actor` is derived only by resolveApiActor above.
            const sessionId = await options.browser.authorizeStream(browserRoute.sessionId, actor);
            const upgraded = serverInstance.upgrade(request, {
              data: {
                kind: 'browser',
                sessionId,
                actor,
                pending: [],
                pendingBytes: 0,
                closed: false,
              },
            });
            return upgraded ? undefined : json({ error: 'websocket upgrade failed' }, 400);
          }
          if (url.pathname === '/v1/stt' || url.pathname.startsWith('/v1/stt/')) {
            if (!options.stt) return json(unknownRoute(request.method, url.pathname), 404);
            return await options.stt.handleApi(request, url);
          }
          if (url.pathname === '/v1/health' && request.method === 'GET') return json(await options.service.health());
          if (url.pathname === '/v1/analytics' && request.method === 'GET') {
            if (!options.analytics) return json({ error: 'analytics index is initializing or unavailable' }, 503);
            try {
              return json(options.analytics.query(url.searchParams.get('q') ?? undefined));
            } catch (error) {
              if (error instanceof AnalyticsQueryError) return json({ error: error.message }, 400);
              throw error;
            }
          }
          if (url.pathname === '/v1/search' && request.method === 'GET') {
            const q = url.searchParams.get('q') ?? '';
            const limitRaw = Number(url.searchParams.get('limit') ?? '30');
            return json(await options.service.search(q, Number.isFinite(limitRaw) ? limitRaw : 30));
          }
          // Account quota, per wrapper binary. A FLEET-WIDE route rather than a
          // per-session field: the daemon's usage feed is one cached snapshot
          // shared by every session, and stamping it into each session's state
          // only happens on that session's 60s monitor tick — so a list built
          // from session state alone shows blanks for everything idle, newly
          // started, or terminal. The browser joins this onto `config.binary`.
          if (url.pathname === '/v1/usage' && request.method === 'GET') return json(await options.service.usage());
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
          // Warden failover config: readable and hot-writable. It lives under
          // /v1/warden/, and wardenScopeDenial already 403s the warden token for
          // ANY path under that prefix — so this is admin-only by construction.
          // Do NOT add a warden-token allowance here: a warden that can rewrite
          // its own failover list could promote itself out of a demotion.
          if (url.pathname === '/v1/warden/config' && request.method === 'GET')
            return json(await options.service.wardenConfigView());
          if (url.pathname === '/v1/warden/config' && request.method === 'PATCH') {
            const patch = await body<WardenConfigPatch>(request);
            return json(await options.service.updateWardenConfig(patch));
          }
          if (url.pathname === '/v1/gc' && request.method === 'GET') {
            const raw = Number(url.searchParams.get('limit') ?? '20');
            return json(await options.service.scratchPlan(Number.isFinite(raw) ? raw : 20));
          }
          if (url.pathname === '/v1/gc' && request.method === 'POST') {
            const input = await body<{ force?: boolean }>(request);
            return json(await options.service.scratchSweep(input.force === true));
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
          // --- Learning (admin-only; 404 when the subsystem is not wired) ---
          if (url.pathname.startsWith('/v1/learning')) {
            if (!options.learning) return json(unknownRoute(request.method, url.pathname), 404);
            const learning = options.learning;
            if (url.pathname === '/v1/learning/status' && request.method === 'GET')
              return json(await learning.learningStatus());
            if (url.pathname === '/v1/learning/proposals' && request.method === 'GET') {
              const state = url.searchParams.get('state') ?? undefined;
              return json(await learning.learningProposals(state as ProposalState | undefined));
            }
            if (url.pathname === '/v1/learning/run' && request.method === 'POST') {
              const input = await body<{ spawn?: boolean }>(request);
              return json(await learning.learningRun(input.spawn === true));
            }
            if (url.pathname === '/v1/learning/config' && request.method === 'GET')
              return json(await learning.learningConfig());
            const propMatch = url.pathname.match(/^\/v1\/learning\/proposals\/([^/]+)(?:\/(patch))?$/);
            if (propMatch && request.method === 'POST') {
              const id = decodeURIComponent(propMatch[1]!);
              if (propMatch[2] === 'patch') return json(await learning.learningPatch(id));
              const input = await body<LearningAction>(request);
              const updated = await learning.learningAct(id, input);
              if (!updated) return json({ error: `unknown learning proposal ${id}` }, 404);
              return json(updated);
            }
            return json(unknownRoute(request.method, url.pathname), 404);
          }
          if (url.pathname === '/v1/names' && request.method === 'GET') {
            const raw = Number(url.searchParams.get('count') ?? '1');
            return json(await options.service.suggestNames(Number.isFinite(raw) ? raw : 1));
          }
          // Push mutations and even the public VAPID half stay behind the
          // daemon's admin bearer token. wardenScopeDenial rejects this whole
          // surface before dispatch, including GETs.
          if (options.push && isPushPath(url.pathname)) {
            const pushResponse = await options.push.handle({
              method: request.method,
              url,
              body: request.method === 'POST' ? await body<unknown>(request) : undefined,
            });
            if (pushResponse) return json(pushResponse.body, pushResponse.status);
            return json(unknownRoute(request.method, url.pathname), 404);
          }
          if (url.pathname === '/v1/sessions' && request.method === 'GET')
            return json((await options.service.list()).map(compactFleetSession));
          if (url.pathname === '/v1/sessions' && request.method === 'POST') {
            // CREATE is idempotent per request id. A start whose RESPONSE was
            // lost (socket error, caller timeout, SIGTERM) still created the
            // session, so the client's blind retry used to launch a SECOND
            // teammate for the same task — the duplicate controllers seen on
            // 2026-07-23. Keyed under a reserved ref (no session id exists yet).
            const createId = request.headers.get('x-kteam-request-id') ?? undefined;
            const input = await body<StartSessionRequest>(request);
            if (createId === undefined) return json(await options.service.start(input), 201);
            // The key binds the id to the PAYLOAD. A caller that exports one
            // KTEAM_REQUEST_ID for a whole shell would otherwise have its
            // second and third `kteam start` answered with the first
            // session — different tasks silently never launched, exit 0.
            const key = `${CREATE_REF}\n${createId}\n${Bun.hash(JSON.stringify(input)).toString(16)}`;
            const pending = createRequests.get(key);
            if (pending) return json(await pending, 201);
            const previous = createdSessions.get(key);
            if (previous !== undefined) return json(await options.service.get(previous), 201);
            const attempt = (async () => {
              const view = (await options.service.start(input)) as SessionView;
              createdSessions.set(key, view.config.id);
              return view;
            })();
            createRequests.set(key, attempt);
            try {
              return json(await attempt, 201);
            } finally {
              createRequests.delete(key);
            }
          }

          // Answer "did my start actually create a session?" for a caller whose
          // response was lost. Must be matched BEFORE the /:id route.
          const byRequest = url.pathname.match(/^\/v1\/sessions\/by-request\/([^/]+)$/);
          if (byRequest && request.method === 'GET') {
            // Keyed by request id AND payload hash, exactly like the create
            // itself: a caller that reuses one id across DIFFERENT starts must
            // never be handed the earlier task's session as its own.
            const key = `${CREATE_REF}\n${decodeURIComponent(byRequest[1]!)}\n${url.searchParams.get('payload') ?? ''}`;
            const created = createdSessions.get(key);
            if (created !== undefined) return json(await options.service.get(created));
            // The caller usually asks precisely because its own request is
            // still running (the CLI's deadline is shorter than a queued
            // bootstrap), so wait for the in-flight create rather than
            // answering 404 and inviting a duplicate launch.
            const pending = createRequests.get(key);
            if (pending) return json(await pending);
            return json({ error: 'no session was created for that request id' }, 404);
          }

          if (options.tasks && isTaskPath(url.pathname)) {
            const actorForTask = await resolveTaskActor(options.service, {
              sessionId: request.headers.get('x-kteam-session-id'),
              actorSource: actor,
            });
            const taskResponse = await options.tasks.handle(
              taskApiRequestFrom(
                request,
                url,
                request.method === 'POST' ? await body<unknown>(request) : undefined,
                actorForTask,
              ),
            );
            if (taskResponse) return json(taskResponse.body, taskResponse.status);
            return json(unknownRoute(request.method, url.pathname), 404);
          }

          // MUST precede the generic session match: `terminals` is an API
          // collection, not a session action. TerminalApi performs its own
          // admin-only actor check using this resolved server-side actor.
          if (options.terminals && isTerminalPath(url.pathname)) {
            const terminalResponse = await options.terminals.handle({
              method: request.method,
              url,
              body: request.method === 'POST' || request.method === 'PATCH' ? await body<unknown>(request) : undefined,
              actor,
            });
            if (terminalResponse) return json(terminalResponse.body, terminalResponse.status);
            return json(unknownRoute(request.method, url.pathname), 404);
          }

          // MUST precede the generic session match: `browser` is a daemon API,
          // not a session action. BrowserApi enforces owning-peer/admin access
          // using only the resolved actor supplied here.
          if (options.browser && isBrowserPath(pathname)) {
            const browserResponse = await options.browser.handle({
              method: request.method,
              url,
              body: request.method === 'POST' ? await body<unknown>(request) : undefined,
              actor,
              requestId: request.headers.get('x-kteam-request-id') ?? undefined,
            });
            if (browserResponse) return json(browserResponse.body, browserResponse.status);
            return json(unknownRoute(request.method, pathname), 404);
          }

          // MUST precede the generic session match, or `pins` is parsed as an
          // unknown `:action`. Provenance is resolved server-side here and the
          // request body never gets a say in who the actor is.
          if (options.pins && isPinPath(url.pathname)) {
            const actorForPins = await resolveTaskActor(options.service, {
              sessionId: request.headers.get('x-kteam-session-id'),
              actorSource: actor,
            });
            const pinResponse = await options.pins.handle({
              method: request.method,
              url,
              body: request.method === 'POST' ? await body<unknown>(request) : undefined,
              actor: actorForPins,
              requestId: request.headers.get('x-kteam-request-id') ?? undefined,
            });
            if (pinResponse) return json(pinResponse.body, pinResponse.status);
            return json(unknownRoute(request.method, url.pathname), 404);
          }

          // MUST precede the generic session match, exactly like pins/tasks.
          // Provenance comes from authenticated actor context, never the body.
          if (options.attention && isAttentionPath(url.pathname)) {
            const attentionResponse = await options.attention.handle({
              method: request.method,
              url,
              body: request.method === 'POST' ? await body<unknown>(request) : undefined,
              actorSource: actor,
              requestId: request.headers.get('x-kteam-request-id') ?? undefined,
            });
            if (attentionResponse) return json(attentionResponse.body, attentionResponse.status);
            return json(unknownRoute(request.method, url.pathname), 404);
          }

          const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(.+))?$/);
          if (!match) return json(unknownRoute(request.method, url.pathname), 404);
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
          // The composer's `/` catalog. Reports only FACTS the daemon knows:
          // which harness owns this session's account, and what its SKILL.md
          // manifests actually said. How a skill is INSERTED is presentation
          // and belongs to the client — Claude invokes `/name`, Codex browses
          // with `/skills` and invokes with `$name`, and baking either form
          // into the wire response would make the daemon the authority on a
          // harness convention it does not control.
          if (action === 'skills' && request.method === 'GET') {
            const view = await options.service.get(id);
            return json({
              harness: view.config.harness,
              skills: await listSkills(view.config.harnessHome),
            });
          }
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
            // THE REQUEST ID IS AN IDENTITY, NOT JUST A DEDUPE TOKEN.
            //
            // `x-kteam-request-id` already gates `applyOnce`. Passing it through
            // makes it the send's DURABLE ledger id as well, which is what lets an
            // optimistic browser row join its durable row by IDENTITY instead of
            // falling back to content+time matching — and content matching cannot
            // tell two identical messages apart, which is precisely the ambiguity
            // this change exists to remove.
            //
            // The header is the ONLY accepted source, and it is written
            // UNCONDITIONALLY — including to `undefined`. A body-supplied
            // `requestId` is never merged and never survives: `applyOnce` deduped
            // on the header, so a body value that disagreed would split one logical
            // send across two ids (one for idempotency, another for the ledger),
            // and a caller could otherwise pick an id to collide with an existing
            // record. Overwriting rather than conditionally spreading is what makes
            // that true for every code path, including the absent-header one.
            //
            // VALIDATED FIRST, because this value is client-chosen and the backend
            // uses it as the durable send id — which the native-file path embeds in
            // a filename (`channel/queued-<id>.md`). The charset admits no `/`,
            // `\` or `.` at all, so traversal and absolute paths are
            // unrepresentable rather than merely filtered, and the length cap keeps
            // the filename bounded. The daemon enforces the same rule on its side;
            // this is the outer layer, not the only one.
            //
            // An id that FAILS the predicate still dedupes exactly as before — only
            // the identity propagation is dropped — so an older client with a
            // different id format keeps working and simply falls back to the
            // browser's content+time reconciliation.
            const identity = requestId !== undefined && SAFE_REQUEST_ID.test(requestId) ? requestId : undefined;
            return await applyOnce(() => options.service.send(id, { ...input, requestId: identity }));
          }
          // THE SEND LEDGER — durable existence and fate of every message sent to
          // this session. Read-only.
          //
          // ORDERING. Kept immediately below `'send'` on purpose: the two action
          // names differ by one character, and this dispatcher matches `action` by
          // EXACT string equality, so keeping the pair adjacent is what makes a
          // future `startsWith`/prefix refactor visibly wrong at review time. It
          // also sits well above every generic and catch-all branch further down,
          // so nothing can swallow it.
          //
          // No `applyOnce`: a GET has nothing to apply once, and `'sends'` is
          // deliberately absent from DEDUPED_ACTIONS, so `dedupe` is false here by
          // construction rather than by accident.
          //
          // Bounds live in the service: the default is everything still open plus
          // the newest settled rows, and `all=1` asks for the full ledger under the
          // service's own cap. The route deliberately does no slicing of its own, so
          // there is exactly one place that decides how much history is served.
          if (action === 'sends' && request.method === 'GET') {
            return json({
              sends: await options.service.listSends(id, { all: url.searchParams.get('all') === '1' }),
            });
          }
          if (action === 'runtime' && request.method === 'POST') {
            // Model/effort changes alter cost and behaviour; clear/compact alter
            // live context. Refuse an honestly self-identifying peer before
            // body parsing, dedupe bookkeeping, or any service mutation.
            if (!isHumanAdminActor(actor))
              return json(
                { error: 'in-session runtime control requires the human admin token', code: 'forbidden' },
                403,
              );
            const input = await body<RuntimeControlRequest>(request);
            if (
              input.action !== 'model' &&
              input.action !== 'effort' &&
              input.action !== 'clear' &&
              input.action !== 'compact'
            )
              throw new HttpError(400, 'runtime action must be "model", "effort", "clear", or "compact"');
            return await applyOnce(() => options.service.runtime(id, input));
          }
          if (action === 'answer' && request.method === 'POST') {
            const input = await body<{ toolUseId?: string; labels?: string[]; other?: string; responses?: string[] }>(
              request,
            );
            if (!input.toolUseId) throw new HttpError(400, 'toolUseId is required');
            return await applyOnce(() =>
              options.service.answer(id, input.toolUseId!, input.labels ?? [], input.other, input.responses),
            );
          }
          if (action === 'interrupt' && request.method === 'POST') {
            // Optional binding: a question-specific abandon names the question
            // it rendered, so a retry that lands after that question is gone
            // cannot cancel whatever the session moved on to. A bodyless or
            // empty `{}` POST stays the generic interrupt it has always been.
            const input = await optionalBody<{ toolUseId?: unknown }>(request);
            const expected = input.toolUseId;
            if (expected !== undefined && (typeof expected !== 'string' || expected.trim() === ''))
              throw new HttpError(400, 'toolUseId must be a nonempty string');
            return await applyOnce(() => options.service.interrupt(id, expected as string | undefined));
          }
          if (action === 'stop' && request.method === 'POST') {
            const input = await body<{ reason?: string }>(request);
            return json(await options.service.stop(id, input.reason));
          }
          if (action === 'resume' && request.method === 'POST') {
            const input = await body<{ message?: string }>(request);
            return await applyOnce(() => options.service.resume(id, input.message));
          }
          if (action === 'migrate' && request.method === 'POST') {
            const input = await body<{ agent?: string; model?: string; allowContextDowngrade?: boolean }>(request);
            if (!input.agent) throw new HttpError(400, 'agent is required');
            return await applyOnce(() =>
              options.service.migrate(id, input.agent!, input.model, input.allowContextDowngrade),
            );
          }
          if (action === 'rename' && request.method === 'POST') {
            const input = await body<{ name?: string; teammate?: string; clearParent?: boolean }>(request);
            if (!input.name?.trim() && !input.teammate?.trim() && !input.clearParent)
              throw new HttpError(400, 'name, teammate, and/or clearParent is required');
            return await applyOnce(() => options.service.rename(id, input.name, input.teammate, input.clearParent));
          }
          if (action === 'signal' && request.method === 'POST') {
            const input = await body<{
              kind: SignalKind;
              message?: string;
              until?: string;
              condition?: string;
              peer?: string;
            }>(request);
            if (!SIGNAL_KINDS.includes(input.kind))
              throw new HttpError(400, `kind must be one of ${SIGNAL_KINDS.join(', ')}`);
            return await applyOnce(() =>
              options.service.signal(id, input.kind, input.message, {
                until: input.until,
                condition: input.condition,
                peer: input.peer,
              }),
            );
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
          if (action === 'fs' && request.method === 'GET') {
            return fsJson(await options.service.fsList(id, url.searchParams.get('path') ?? undefined));
          }
          if (action === 'fs/file' && request.method === 'GET') {
            const target = url.searchParams.get('path');
            if (!target) throw new HttpError(400, 'query parameter "path" is required');
            const requestedRev = url.searchParams.get('rev');
            if (requestedRev !== null && requestedRev !== 'head')
              throw new HttpError(400, 'query parameter "rev" must be "head"');
            return fsJson(await options.service.fsFile(id, target, requestedRev === 'head' ? 'head' : undefined));
          }
          if (action === 'fs/changes' && request.method === 'GET') {
            return fsJson(await options.service.fsChanges(id));
          }
          if (action === 'fs/diff' && request.method === 'GET') {
            const target = url.searchParams.get('path');
            if (!target) throw new HttpError(400, 'query parameter "path" is required');
            const result = await options.service.fsDiff(id, target);
            if (result.denied || result.ignored) {
              const code = result.denied ? 'denied' : 'ignored';
              return fsJson({ error: 'diff is not served by the repository secrets policy', code }, 403);
            }
            // A partial diff is actively misleading in a review surface. The
            // core bounds memory at 1 MiB; the route refuses that partial body.
            if (result.truncated)
              return fsJson({ error: 'diff exceeds the 1 MB response limit', code: 'too_large' }, 413);
            return new Response(result.diff, {
              headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
            });
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
          // `fs/…` typos and wrong methods are on the filesystem surface too, so
          // they take the same no-store policy rather than depending on which
          // branch produced them.
          const unknown = unknownRoute(request.method, url.pathname);
          return isFsPath(url.pathname) ? fsJson(unknown, 404) : json(unknown, 404);
        } catch (error) {
          if (isBrowserError(error)) {
            return json({ error: error.message, code: error.code }, error.status);
          }
          if (isTerminalError(error)) {
            return json({ error: error.message, code: error.code }, error.status);
          }
          if (error instanceof FsError) {
            const status =
              error.code === 'not_found'
                ? 404
                : error.code === 'denied' || error.code === 'ignored' || error.code === 'escapes_root'
                  ? 403
                  : 400;
            return fsJson({ error: error.message, code: error.code }, status);
          }
          if (error instanceof GitError) {
            const status =
              error.code === 'git_timeout'
                ? 504
                : error.code === 'not_in_head'
                  ? 404
                  : error.code === 'not_a_repo'
                    ? 400
                    : 500;
            return fsJson({ error: error.message, code: error.code }, status);
          }
          const status =
            error instanceof HttpError ? error.status : /unknown kteam session/i.test(String(error)) ? 404 : 409;
          const body = { error: error instanceof Error ? error.message : String(error) };
          // The no-store boundary is per-ROUTE, not per-error-type. A query
          // validation 400 from /fs/file carries no file bytes today, but making
          // the header depend on which error class was thrown means the next
          // error message added to a filesystem route silently escapes the
          // policy. Every response on `fs` and `fs/*` is no-store.
          return isFsPath(url.pathname) ? fsJson(body, status) : json(body, status);
        }
      };
      const response = await actorContext.run({ actor }, dispatch);
      // Every API response advertises the daemon's version (json() already
      // does; this also covers the text/binary routes — snapshot, logs,
      // attachments — so the CLI detects skew on any command).
      if (response && !response.headers.has('x-kteam-version')) response.headers.set('x-kteam-version', KTEAM_VERSION);
      return response;
    },
    websocket: {
      open(socket) {
        const socketData = socket.data;
        if (socketData.kind === 'browser') {
          const browser = options.browser;
          if (!browser) {
            socket.close(1011, 'browser service unavailable');
            return;
          }
          void browser
            .openStream(socketData.sessionId, socketData.actor, {
              send: chunk => socket.send(chunk),
              close: (code, reason) => socket.close(code, reason),
              getBufferedAmount: () => socket.getBufferedAmount(),
            })
            .then(bridge => {
              if (socketData.closed) {
                bridge.close();
                return;
              }
              socketData.bridge = bridge;
              const pending = socketData.pending.splice(0);
              socketData.pendingBytes = 0;
              for (const chunk of pending) bridge.fromClient(chunk);
            })
            .catch(() => {
              if (!socketData.closed) socket.close(1011, 'browser stream unavailable');
            });
          return;
        }
        if (socketData.kind === 'terminal') {
          const terminals = options.terminals;
          if (!terminals) {
            socket.close(1011, 'terminal service unavailable');
            return;
          }
          void terminals
            .openStream(socketData.sessionId, socketData.terminalId, socketData.actor, {
              send: chunk => socket.send(chunk),
              close: (code, reason) => socket.close(code, reason),
              getBufferedAmount: () => socket.getBufferedAmount(),
            })
            .then(bridge => {
              if (socketData.closed) {
                bridge.close();
                return;
              }
              socketData.bridge = bridge;
              const pending = socketData.pending.splice(0);
              socketData.pendingBytes = 0;
              for (const chunk of pending) bridge.fromClient(chunk);
            })
            .catch(() => {
              if (!socketData.closed) socket.close(1011, 'terminal stream unavailable');
            });
          return;
        }
        sockets.add(socket);
        void (async () => {
          const { sessionIds, cursors } = socketData;
          // Backfill each subscribed session INDEPENDENTLY, from its own
          // sequence. One session's long history no longer delays another's
          // first frame, and there is no shared cursor to renumber.
          const targets: Array<string | undefined> = sessionIds.length > 0 ? sessionIds : [undefined];
          for (const sessionId of targets) {
            let cursor = socketData.after;
            while (true) {
              const events = await options.service.replay(sessionId, cursor, 1_000);
              for (const event of events) {
                socket.send(JSON.stringify(event));
                cursors.set(event.sessionId, Math.max(cursors.get(event.sessionId) ?? 0, event.sequence));
              }
              if (events.length > 0) cursor = events.at(-1)!.sequence;
              // A fleet backfill is a bounded tail, never a paged archive.
              if (events.length < 1_000 || sessionId === undefined) break;
            }
          }
          socketData.replaying = false;
          for (const encoded of socketData.queued) {
            const queued = JSON.parse(encoded) as { sequence?: number; sessionId?: string };
            // Dedupe against THAT session's cursor: sequences are per-session
            // now, so comparing against a single number would drop live frames
            // from every session with a shorter journal than the last one
            // backfilled.
            const delivered = cursors.get(queued.sessionId ?? '') ?? 0;
            // Sequence 0 means LIVE-ONLY — the event carries a whole snapshot
            // and has no journal entry to be backfilled from. Comparing it
            // against the cursor dropped every one of them, which is harmless
            // for frequent terminal frames (another arrives in a moment) but
            // silently loses the ONLY notification a pins.updated or
            // tasks.updated mutation ever sends, leaving a reader on a stale
            // board with no way to know.
            const sequence = queued.sequence ?? 0;
            if (sequence === 0 || sequence > delivered) socket.send(encoded);
          }
          socketData.queued.length = 0;
        })().catch(error => socket.send(JSON.stringify({ type: 'error', error: String(error) })));
      },
      close(socket) {
        sockets.delete(socket);
        if (socket.data.kind === 'terminal' || socket.data.kind === 'browser') {
          socket.data.closed = true;
          socket.data.pending.length = 0;
          socket.data.pendingBytes = 0;
          socket.data.bridge?.close();
        }
      },
      message(socket, message) {
        if (socket.data.kind === 'events' || socket.data.closed) return;
        if (socket.data.bridge) {
          socket.data.bridge.fromClient(message);
          return;
        }
        const size = typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength;
        const maximum =
          socket.data.kind === 'terminal' ? MAX_PENDING_TERMINAL_INPUT_BYTES : MAX_PENDING_BROWSER_INPUT_BYTES;
        if (socket.data.pendingBytes + size > maximum) {
          socket.data.closed = true;
          socket.close(1009, `${socket.data.kind} input queue exceeded`);
          return;
        }
        socket.data.pendingBytes += size;
        socket.data.pending.push(typeof message === 'string' ? message : Uint8Array.from(message));
      },
    },
  });

  const originalStop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    unsubscribe();
    unsubscribeTasks?.();
    unsubscribePins?.();
    unsubscribeAttention?.();
    return originalStop(closeActiveConnections);
  }) as typeof server.stop;
  return server;
}
