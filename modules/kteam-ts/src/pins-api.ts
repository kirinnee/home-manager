// The /v1/sessions/:id/pins route handler, self-contained and transport-shaped
// rather than Bun-shaped: it takes a method + URL + parsed body + resolved actor
// and returns `{ status, body }`, or NULL when the path is not a pins route.
//
// WHY IT LIVES OUTSIDE api-server.ts: that file is one of the most contended in
// the tree. Its whole pins patch becomes a route check + one call:
//
//     if (options.pins && isPinPath(url.pathname)) {
//       const actor = await resolveTaskActor(options.service, {
//         sessionId: request.headers.get('x-kteam-session-id'), actorSource: actor });
//       const answered = await options.pins.handle({
//         method: request.method, url,
//         body: request.method === 'POST' ? await body(request) : undefined,
//         actor, requestId: request.headers.get('x-kteam-request-id') ?? undefined });
//       if (answered) return json(answered.body, answered.status);
//       return json(unknownRoute(...), 404);
//     }
//
// ANTI-SPAM lives here alongside the scope/provenance/cap rules in the service:
//   • a per-session TOKEN BUCKET on writes — a stuck agent pinning every turn gets
//     429ed rather than amplified;
//   • IDEMPOTENCY on `x-kteam-request-id`, so a retried POST whose response was
//     lost replays the first result instead of adding a second pin.

import { PinError, isPinError, type PinActor, type PinSnapshot } from './pins-types';
import { parsePin, isSafeSessionId } from './pins-store';
import type { AddPinInput } from './pins-service';

/** The narrow slice of PinService the routes need. `PinService` satisfies it
 *  structurally, and a test can pass a stub. */
export interface PinApiService {
  list(sessionId: string): Promise<PinSnapshot>;
  add(sessionId: string, input: AddPinInput, actor: PinActor): Promise<PinSnapshot>;
  edit(sessionId: string, id: string, text: string, actor: PinActor): Promise<PinSnapshot>;
  remove(sessionId: string, id: string, actor: PinActor): Promise<PinSnapshot>;
  importPins(sessionId: string, pins: import('./pins-types').Pin[], actor: PinActor): Promise<PinSnapshot>;
  /** Live `pins.updated` stream. OPTIONAL so the many test doubles of this port
   *  stay minimal — only the real PinService emits, and an absent implementation
   *  simply means nothing broadcasts. */
  subscribe?(listener: (event: import('./types').KTeamEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export type PinRoute = { kind: 'list'; id: string } | { kind: 'action'; id: string };

/** True for any pins route — used by the wiring to intercept BEFORE the generic
 *  `/v1/sessions/:id/:action` match (`pins` would otherwise be read as an
 *  unknown action). */
export const isPinPath = (pathname: string): boolean => /^\/v1\/sessions\/[^/]+\/pins\/?$/.test(pathname);

/** Match the pins routes, or null when the path is not ours. The session id is
 *  decoded and validated for path-safety here, before it can be joined onto a
 *  filesystem path. */
export function matchPinRoute(method: string, pathname: string): PinRoute | null {
  const match = pathname.match(/^\/v1\/sessions\/([^/]+)\/pins\/?$/);
  if (!match) return null;
  const id = decodeURIComponent(match[1]!);
  if (!isSafeSessionId(id)) return null;
  if (method === 'GET') return { kind: 'list', id };
  if (method === 'POST') return { kind: 'action', id };
  return null;
}

/** Warden-scoped token policy: pin READS are allowed, pin WRITES are admin-only
 *  (a warden oversees conduct; it does not curate the reader's pins). Returns the
 *  "may not …" phrase for a denial, or null when permitted — shaped to drop into
 *  `wardenScopeDenial`. */
export function pinWardenDenial(method: string, pathname: string): string | null {
  if (!isPinPath(pathname)) return null;
  if (method === 'GET') return null;
  return 'change pins';
}

// ---------------------------------------------------------------------------
// Error → HTTP
// ---------------------------------------------------------------------------

export function pinErrorStatus(code: PinError['code']): number {
  switch (code) {
    case 'invalid':
      return 400;
    case 'too-long':
      return 413;
    case 'not-found':
      return 404;
    case 'forbidden':
    case 'read-only':
      return 403;
    case 'rate-limited':
      return 429;
    default:
      return 400;
  }
}

export function pinErrorBody(error: PinError): { error: string; code: PinError['code'] } {
  return { error: error.message, code: error.code };
}

// ---------------------------------------------------------------------------
// Body parsing (POST /v1/sessions/:id/pins)
// ---------------------------------------------------------------------------

export type PinAction =
  | { action: 'add'; input: AddPinInput }
  | { action: 'edit'; id: string; text: string }
  | { action: 'remove'; id: string }
  | { action: 'import'; pins: import('./pins-types').Pin[] };

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const requireId = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new PinError('invalid', 'a pin id is required');
  return value;
};

/** Parse and validate the POST body into a typed action. Never trusts the body
 *  for provenance — `by`/`createdBy` on an incoming pin are ignored and the
 *  service re-stamps them from the resolved actor. */
export function parsePinActionBody(body: unknown): PinAction {
  const raw = asObject(body);
  const action = raw['action'];
  switch (action) {
    case 'add': {
      const kind = raw['kind'];
      if (kind !== 'note' && kind !== 'message') throw new PinError('invalid', "add needs kind: 'note' | 'message'");
      const input: AddPinInput =
        kind === 'note'
          ? {
              kind: 'note',
              text: typeof raw['text'] === 'string' ? raw['text'] : undefined,
              ...(sourceOf(raw['source']) ? { source: sourceOf(raw['source']) } : {}),
            }
          : {
              kind: 'message',
              blockId: typeof raw['blockId'] === 'string' ? raw['blockId'] : undefined,
              blockKind: raw['blockKind'] as AddPinInput['blockKind'],
              preview: typeof raw['preview'] === 'string' ? raw['preview'] : undefined,
              ...(typeof raw['ts'] === 'string' ? { ts: raw['ts'] } : {}),
            };
      return { action: 'add', input };
    }
    case 'edit':
      return { action: 'edit', id: requireId(raw['id']), text: typeof raw['text'] === 'string' ? raw['text'] : '' };
    case 'remove':
      return { action: 'remove', id: requireId(raw['id']) };
    case 'import': {
      const list = Array.isArray(raw['pins']) ? raw['pins'] : [];
      const pins = list.map(parsePin).filter((p): p is import('./pins-types').Pin => p !== null);
      return { action: 'import', pins };
    }
    default:
      throw new PinError('invalid', "body needs action: 'add' | 'edit' | 'remove' | 'import'");
  }
}

function sourceOf(value: unknown): { blockId: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const blockId = (value as Record<string, unknown>)['blockId'];
  return typeof blockId === 'string' && blockId ? { blockId } : undefined;
}

// ---------------------------------------------------------------------------
// Rate limiting — a per-session token bucket on writes
// ---------------------------------------------------------------------------

/** Burst allowance and steady rate. Eight writes may land back-to-back (an
 *  interactive human editing a few notes never hits it), then the bucket refills
 *  one token every 5s — a stuck agent settles to ~12 writes/minute before it is
 *  throttled, well below "makes the feature useless". */
const BUCKET_CAPACITY = 8;
const REFILL_MS = 5_000;

class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  /** Take one token for `key`, or return false when the bucket is empty. Bounded:
   *  the map is capped so a flood of distinct sessions cannot grow it without
   *  limit. */
  take(key: string, nowMs: number): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: BUCKET_CAPACITY, last: nowMs };
      if (this.buckets.size > 500) this.buckets.delete(this.buckets.keys().next().value!);
    } else {
      const refill = Math.floor((nowMs - bucket.last) / REFILL_MS);
      if (refill > 0) {
        bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + refill);
        bucket.last = nowMs;
      }
    }
    if (bucket.tokens <= 0) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    // Re-insert to keep LRU order for the bound above.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Idempotency — apply at most once per (session, request id, payload)
// ---------------------------------------------------------------------------

interface PinApiResponse {
  status: number;
  body: unknown;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

class AppliedRequests {
  private readonly entries = new Map<string, PinApiResponse>();
  constructor(private readonly capacity = 200) {}
  get(key: string): PinApiResponse | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key: string, value: PinApiResponse): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export interface PinApiRequest {
  method: string;
  url: URL;
  /** Parsed JSON body for a POST. */
  body?: unknown;
  /** Resolved server-side (see resolveTaskActor), NEVER from the body. */
  actor?: PinActor;
  /** `x-kteam-request-id`, the idempotency key. */
  requestId?: string;
}

export class PinApi {
  private readonly limiter = new RateLimiter();
  private readonly applied = new AppliedRequests();
  private readonly inFlight = new Map<string, Promise<PinApiResponse>>();

  constructor(private readonly service: PinApiService) {}

  /** Forward the service's live stream so the api-server has one thing to wire.
   *  Returns a no-op unsubscribe when the service does not emit. */
  subscribe(listener: (event: import('./types').KTeamEvent) => void): () => void {
    return this.service.subscribe?.(listener) ?? ((): void => {});
  }

  /** Handle a pins request, or return null when the path is not ours. Never
   *  throws for a client mistake; a non-PinError is rethrown so the caller's 500
   *  path still applies. `nowMs` is injectable for deterministic rate-limit
   *  tests. */
  async handle(request: PinApiRequest, nowMs: number = Date.now()): Promise<PinApiResponse | null> {
    const route = matchPinRoute(request.method, request.url.pathname);
    if (route === null) return null;
    try {
      if (route.kind === 'list') {
        return { status: 200, body: await this.service.list(route.id) };
      }
      // A write. Rate-limit per session before doing any work.
      if (!this.limiter.take(route.id, nowMs)) {
        throw new PinError('rate-limited', 'too many pin writes for this session; slow down');
      }
      const parsed = parsePinActionBody(request.body);
      const actor = request.actor ?? {};
      const key = `${route.id}\n${request.requestId ?? ''}\n${Bun.hash(canonicalJson(request.body)).toString(16)}`;
      return await this.once(request.requestId, key, async () => ({
        status: 200,
        body: await this.apply(route.id, parsed, actor),
      }));
    } catch (error) {
      if (isPinError(error)) return { status: pinErrorStatus(error.code), body: pinErrorBody(error) };
      throw error;
    }
  }

  private async apply(id: string, action: PinAction, actor: PinActor): Promise<PinSnapshot> {
    switch (action.action) {
      case 'add':
        return this.service.add(id, action.input, actor);
      case 'edit':
        return this.service.edit(id, action.id, action.text, actor);
      case 'remove':
        return this.service.remove(id, action.id, actor);
      case 'import':
        return this.service.importPins(id, action.pins, actor);
    }
  }

  private async once(
    requestId: string | undefined,
    key: string,
    operation: () => Promise<PinApiResponse>,
  ): Promise<PinApiResponse> {
    if (requestId === undefined) return operation();
    const replay = this.applied.get(key);
    if (replay !== undefined) return replay;
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;
    const attempt = (async () => {
      const response = await operation();
      this.applied.set(key, response);
      return response;
    })();
    this.inFlight.set(key, attempt);
    try {
      return await attempt;
    } finally {
      this.inFlight.delete(key);
    }
  }
}

export { PinError };
