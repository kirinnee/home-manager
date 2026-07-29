// Transport-shaped adapter for `/v1/sessions/:id/attention`. It mirrors the
// pins API: resolved actor context is supplied by api-server, writes are
// rate-limited per session, and x-kteam-request-id makes retries at-most-once.

import {
  ATTENTION_SOURCES,
  AttentionError,
  isAttentionError,
  parseAttentionAsk,
  parseAttentionId,
  parseAttentionResponse,
  type AttentionActor,
  type AttentionAsk,
  type AttentionId,
  type AttentionResponse,
  type AttentionSnapshot,
  type AttentionSource,
} from './attention-types';
import { isSafeAttentionSessionId } from './attention-store';
import type { AddAttentionInput } from './attention-service';
import { parseDirectNotificationBody, type DirectNotificationInput } from './attention-notifier';

export interface AttentionApiService {
  list(sessionId: string): Promise<AttentionSnapshot>;
  count(sessionId: string): Promise<number>;
  add(sessionId: string, input: AddAttentionInput, actor: AttentionActor): Promise<AttentionSnapshot>;
  resolve(
    sessionId: string,
    id: string,
    note: string | null | undefined,
    actor: AttentionActor,
    response?: AttentionResponse,
  ): Promise<AttentionSnapshot>;
  dismiss(
    sessionId: string,
    id: string,
    note: string | null | undefined,
    actor: AttentionActor,
  ): Promise<AttentionSnapshot>;
  subscribe?(listener: (event: import('./types').KTeamEvent) => void): () => void;
}

/** Direct notification sink (&F140). A notification is NOT an attention item:
 * nothing durable is written and nothing needs resolution. */
export interface AttentionNotifySink {
  notifyDirect(
    sessionId: string,
    input: DirectNotificationInput,
    actor: AttentionActor,
  ): Promise<{ delivered: number }>;
}

export interface AttentionActorLookup {
  get(sessionRef: string): Promise<{ config: { id: string; teammate?: string; name?: string } } | undefined>;
}

/** Convert api-server's authenticated request source into an attention actor.
 * Reserved/raw identities and unknown sessions are refused instead of being
 * mistaken for the daemon or human. The daemon actor has no HTTP form: source
 * adapters call the service's trusted in-process methods.
 *
 * This does not make provenance cryptographic: the fleet admin bearer is
 * shared, so its holder can still omit or spoof `x-kteam-session-id`. The
 * resulting actor is attribution under that shared capability. */
export async function resolveAttentionApiActor(
  lookup: AttentionActorLookup,
  actorSource: string,
): Promise<AttentionActor> {
  if (actorSource === 'admin-cli' || actorSource === 'admin-ui') return { actor: 'user', actorName: 'user' };
  const match = actorSource.match(/^(?:peer|warden):(.+)$/u);
  const ref = match?.[1]?.trim();
  if (!ref || ref === 'user' || ref === 'daemon' || !isSafeAttentionSessionId(ref)) {
    throw new AttentionError('forbidden', 'attention mutations require a resolved human or session actor');
  }
  const view = await lookup.get(ref).catch(() => undefined);
  if (view === undefined || !isSafeAttentionSessionId(view.config.id)) {
    throw new AttentionError('forbidden', `cannot resolve attention actor ${ref}`);
  }
  const rawName = view.config.teammate ?? view.config.name ?? null;
  const actorName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;
  return { actor: view.config.id, actorName };
}

export type AttentionRoute = { id: string; kind: 'read' | 'write' | 'notify' };

export const isAttentionPath = (pathname: string): boolean => /^\/v1\/sessions\/[^/]+\/attention\/?$/.test(pathname);

/** Direct notification route. Kept beside attention because it shares the
 * actor model and rate limiting, but it is deliberately NOT the attention
 * collection: a POST here presents a push notification and records nothing. */
export const isAttentionNotifyPath = (pathname: string): boolean => /^\/v1\/sessions\/[^/]+\/notify\/?$/.test(pathname);

function sessionIdFromPath(pathname: string, suffix: 'attention' | 'notify'): string | null {
  const match = pathname.match(new RegExp(`^\\/v1\\/sessions\\/([^/]+)\\/${suffix}\\/?$`));
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return isSafeAttentionSessionId(id) ? id : null;
}

export function matchAttentionRoute(method: string, pathname: string): AttentionRoute | null {
  const attentionId = sessionIdFromPath(pathname, 'attention');
  if (attentionId !== null) {
    if (method === 'GET') return { id: attentionId, kind: 'read' };
    if (method === 'POST') return { id: attentionId, kind: 'write' };
    return null;
  }
  const notifyId = sessionIdFromPath(pathname, 'notify');
  if (notifyId !== null && method === 'POST') return { id: notifyId, kind: 'notify' };
  return null;
}

/** Warden capability tokens may inspect the board, but mutations remain on the
 * authenticated admin/agent path exactly like pins. Notifications have no
 * warden form at all. */
export function attentionWardenDenial(method: string, pathname: string): string | null {
  if (isAttentionNotifyPath(pathname)) return 'send notifications';
  if (!isAttentionPath(pathname)) return null;
  return method === 'GET' ? null : 'change attention items';
}

export function attentionErrorStatus(code: AttentionError['code']): number {
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
    case 'full':
    case 'corrupt':
      return 409;
    default:
      return 400;
  }
}

export function attentionErrorBody(error: AttentionError): { error: string; code: AttentionError['code'] } {
  return { error: error.message, code: error.code };
}

export type AttentionAction =
  | { action: 'add'; input: AddAttentionInput }
  | { action: 'resolve'; id: string; note?: string; response?: AttentionResponse }
  | { action: 'dismiss'; id: string; note?: string };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const id = (value: unknown): AttentionId => {
  const parsed = parseAttentionId(value);
  if (parsed === null) throw new AttentionError('invalid', 'an attention id like A3 or !A3 is required');
  return parsed;
};

export function parseAttentionActionBody(value: unknown): AttentionAction {
  const raw = object(value);
  switch (raw['action']) {
    case 'add': {
      const source = raw['source'];
      if (source !== undefined && !(ATTENTION_SOURCES as readonly unknown[]).includes(source)) {
        throw new AttentionError('invalid', `source must be one of ${ATTENTION_SOURCES.join(', ')}`);
      }
      let ask: AttentionAsk | undefined;
      if (raw['ask'] !== undefined) {
        const parsed = parseAttentionAsk(raw['ask']);
        if (parsed === null) {
          throw new AttentionError(
            'invalid',
            'ask must be one of permission, multiple-choice (2+ distinct bounded options), answer-review, open-question',
          );
        }
        ask = parsed;
      }
      return {
        action: 'add',
        input: {
          ...(source === undefined ? {} : { source: source as AttentionSource }),
          ...(raw['sourceRef'] === null
            ? { sourceRef: null }
            : optionalString(raw['sourceRef'])
              ? { sourceRef: optionalString(raw['sourceRef']) }
              : {}),
          subject: optionalString(raw['subject']),
          why: optionalString(raw['why']),
          ...(optionalString(raw['context']) ? { context: optionalString(raw['context']) } : {}),
          howToResolve: optionalString(raw['howToResolve']),
          ...(ask === undefined ? {} : { ask }),
          ...(optionalString(raw['waitingSince']) ? { waitingSince: optionalString(raw['waitingSince']) } : {}),
        },
      };
    }
    case 'resolve':
    case 'done': {
      let response: AttentionResponse | undefined;
      if (raw['response'] !== undefined) {
        const parsed = parseAttentionResponse(raw['response']);
        if (parsed === null) {
          throw new AttentionError('invalid', 'response does not match any of the four attention answer shapes');
        }
        response = parsed;
      }
      return {
        action: 'resolve',
        id: id(raw['id']),
        ...(optionalString(raw['note']) ? { note: optionalString(raw['note']) } : {}),
        ...(response === undefined ? {} : { response }),
      };
    }
    case 'dismiss':
      return {
        action: 'dismiss',
        id: id(raw['id']),
        ...(optionalString(raw['note']) ? { note: optionalString(raw['note']) } : {}),
      };
    default:
      throw new AttentionError('invalid', "body needs action: 'add' | 'resolve' | 'dismiss'");
  }
}

const BUCKET_CAPACITY = 8;
const REFILL_MS = 5_000;

class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  take(key: string, at: number): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: BUCKET_CAPACITY, last: at };
      if (this.buckets.size > 500) this.buckets.delete(this.buckets.keys().next().value!);
    } else {
      const refill = Math.floor((at - bucket.last) / REFILL_MS);
      if (refill > 0) {
        bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + refill);
        bucket.last = at;
      }
    }
    if (bucket.tokens <= 0) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    return true;
  }
}

interface AttentionApiResponse {
  status: number;
  body: unknown;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

class AppliedRequests {
  private readonly entries = new Map<string, AttentionApiResponse>();
  constructor(private readonly capacity = 200) {}
  get(key: string): AttentionApiResponse | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key: string, value: AttentionApiResponse): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
}

export interface AttentionApiRequest {
  method: string;
  url: URL;
  body?: unknown;
  actor?: AttentionActor;
  /** api-server's authenticated actor source. Production supplies this rather
   * than an actor object so reserved/unknown refs are resolved inside the API's
   * error boundary. Tests may pass an already-resolved actor directly. */
  actorSource?: string;
  requestId?: string;
}

export class AttentionApi {
  private readonly limiter = new RateLimiter();
  private readonly applied = new AppliedRequests();
  private readonly inFlight = new Map<string, Promise<AttentionApiResponse>>();

  constructor(
    private readonly service: AttentionApiService,
    private readonly actorLookup?: AttentionActorLookup,
    private readonly notifySink?: AttentionNotifySink,
  ) {}

  subscribe(listener: (event: import('./types').KTeamEvent) => void): () => void {
    return this.service.subscribe?.(listener) ?? ((): void => {});
  }

  async handle(request: AttentionApiRequest, at = Date.now()): Promise<AttentionApiResponse | null> {
    const route = matchAttentionRoute(request.method, request.url.pathname);
    if (route === null) return null;
    try {
      if (route.kind === 'read') {
        if (request.url.searchParams.get('count') === '1') {
          return { status: 200, body: { sessionId: route.id, count: await this.service.count(route.id) } };
        }
        return { status: 200, body: await this.service.list(route.id) };
      }
      let resolvedActor = request.actor ?? {};
      if (request.actor === undefined && request.actorSource !== undefined) {
        if (this.actorLookup === undefined) {
          throw new AttentionError('forbidden', 'attention actor resolution is unavailable');
        }
        resolvedActor = await resolveAttentionApiActor(this.actorLookup, request.actorSource);
      }
      const key = `${route.id}\n${request.requestId ?? ''}\n${Bun.hash(canonicalJson(request.body)).toString(16)}`;
      if (route.kind === 'notify') {
        const input = parseDirectNotificationBody(request.body);
        return await this.once(request.requestId, key, async () => {
          if (this.notifySink === undefined) {
            throw new AttentionError('forbidden', 'direct notifications are unavailable on this daemon');
          }
          if (!this.limiter.take(route.id, at)) {
            throw new AttentionError('rate-limited', 'too many notifications for this session; slow down');
          }
          const result = await this.notifySink.notifyDirect(route.id, input, resolvedActor);
          return { status: 200, body: { sessionId: route.id, delivered: result.delivered } };
        });
      }
      const action = parseAttentionActionBody(request.body);
      return await this.once(request.requestId, key, async () => {
        if (!this.limiter.take(route.id, at)) {
          throw new AttentionError('rate-limited', 'too many attention writes for this session; slow down');
        }
        return {
          status: 200,
          body:
            action.action === 'add'
              ? await this.service.add(route.id, action.input, resolvedActor)
              : action.action === 'dismiss'
                ? await this.service.dismiss(route.id, action.id, action.note, resolvedActor)
                : await this.service.resolve(route.id, action.id, action.note, resolvedActor, action.response),
        };
      });
    } catch (error) {
      if (isAttentionError(error)) {
        return { status: attentionErrorStatus(error.code), body: attentionErrorBody(error) };
      }
      throw error;
    }
  }

  private async once(
    requestId: string | undefined,
    key: string,
    operation: () => Promise<AttentionApiResponse>,
  ): Promise<AttentionApiResponse> {
    if (requestId === undefined) return operation();
    const applied = this.applied.get(key);
    if (applied !== undefined) return applied;
    const inFlight = this.inFlight.get(key);
    if (inFlight !== undefined) return inFlight;
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

export { AttentionError };
