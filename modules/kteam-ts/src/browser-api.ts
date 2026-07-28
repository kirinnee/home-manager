import { parseActor } from './actor-context';
import { isSafeSessionId } from './pins-store';
import type { KTeamEvent } from './types';
import { BrowserStreamBridge, type BrowserStreamDownstream } from './browser-stream';
import type { BrowserService } from './browser-service';
import { normalizeBrowserUrl } from './browser-runtime';
import {
  BROWSER_MAX_PAGE_ID_LENGTH,
  BrowserError,
  isBrowserError,
  type BrowserAction,
  type BrowserActionResult,
} from './browser-types';

const BROWSER_PATH = /^\/v1\/sessions\/([^/]+)\/browser\/?$/;
const BROWSER_STREAM_PATH = /^\/v1\/sessions\/([^/]+)\/browser\/stream\/?$/;
const MAX_SELECTOR_CHARS = 4_096;
const MAX_TEXT_CHARS = 200_000;

export const isBrowserPath = (pathname: string): boolean => /^\/v1\/sessions\/[^/]+\/browser(?:\/|$)/.test(pathname);

export const isBrowserStreamPath = (pathname: string): boolean => BROWSER_STREAM_PATH.test(pathname);

/** The entire surface is admin-only. This helper must run in api-server's
 * warden gate before its generic GET allowance; covering GET also covers the
 * screencast WebSocket upgrade. */
export function browserWardenDenial(_method: string, pathname: string): string | null {
  return isBrowserPath(pathname) ? 'use the session browser' : null;
}

export type BrowserRoute = { kind: 'api' | 'stream'; sessionId: string };

export function matchBrowserRoute(pathname: string): BrowserRoute | null {
  const api = pathname.match(BROWSER_PATH);
  const stream = pathname.match(BROWSER_STREAM_PATH);
  const encoded = api?.[1] ?? stream?.[1];
  if (!encoded) return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!isSafeSessionId(sessionId)) return null;
  return { kind: stream ? 'stream' : 'api', sessionId };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requiredString(raw: Record<string, unknown>, key: string, maximum = MAX_TEXT_CHARS): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BrowserError('bad_request', `${key} is required`, 400);
  }
  if (value.length > maximum) throw new BrowserError('bad_request', `${key} is too long`, 400);
  return value;
}

function optionalBrowserUrl(raw: Record<string, unknown>): string | undefined {
  if (raw['url'] === undefined) return undefined;
  return normalizeBrowserUrl(requiredString(raw, 'url'));
}

export function parseBrowserAction(value: unknown): BrowserAction {
  const raw = asObject(value);
  switch (raw['action']) {
    case 'start':
      return { action: 'start' };
    case 'open':
      return {
        action: 'open',
        ...(typeof raw['url'] === 'string' && raw['url'].trim() ? { url: raw['url'] } : {}),
      };
    case 'new-page': {
      const url = optionalBrowserUrl(raw);
      return { action: 'new-page', ...(url ? { url } : {}) };
    }
    case 'activate-page':
      return { action: 'activate-page', pageId: requiredString(raw, 'pageId', BROWSER_MAX_PAGE_ID_LENGTH) };
    case 'close-page':
      return { action: 'close-page', pageId: requiredString(raw, 'pageId', BROWSER_MAX_PAGE_ID_LENGTH) };
    case 'stop':
      return { action: 'stop' };
    case 'navigate':
      return { action: 'navigate', url: requiredString(raw, 'url') };
    case 'click':
      return { action: 'click', selector: requiredString(raw, 'selector', MAX_SELECTOR_CHARS) };
    case 'type':
      return {
        action: 'type',
        selector: requiredString(raw, 'selector', MAX_SELECTOR_CHARS),
        text:
          typeof raw['text'] === 'string' && raw['text'].length <= MAX_TEXT_CHARS
            ? raw['text']
            : (() => {
                throw new BrowserError('bad_request', 'text must be a string no longer than 200000 characters', 400);
              })(),
      };
    case 'read':
      return {
        action: 'read',
        ...(typeof raw['selector'] === 'string' && raw['selector'].trim()
          ? { selector: requiredString(raw, 'selector', MAX_SELECTOR_CHARS) }
          : {}),
      };
    case 'screenshot':
      return { action: 'screenshot' };
    case 'back':
      return { action: 'back' };
    case 'forward':
      return { action: 'forward' };
    case 'reload':
      return { action: 'reload' };
    case 'resize':
      return { action: 'resize', width: Number(raw['width']), height: Number(raw['height']) };
    case 'human-activity': {
      const kind = raw['kind'];
      if (kind !== 'pointer' && kind !== 'keyboard' && kind !== 'paste') {
        throw new BrowserError('bad_request', 'human activity kind must be pointer, keyboard, or paste', 400);
      }
      return { action: 'human-activity', kind };
    }
    default:
      throw new BrowserError(
        'bad_request',
        'browser action must be start, open, stop, new-page, activate-page, close-page, navigate, click, type, read, screenshot, back, forward, reload, resize, or human-activity',
        400,
      );
  }
}

function actorKind(actor: KTeamEvent['source'] | undefined): 'agent' | 'human' {
  const parsed = parseActor(actor ?? '');
  if (parsed.kind === 'peer') return 'agent';
  if (parsed.kind === 'admin-ui' || parsed.kind === 'admin-cli') return 'human';
  throw new BrowserError('forbidden', 'the session browser requires the admin token', 403);
}

function authorize(
  actor: KTeamEvent['source'] | undefined,
  targetSessionId: string,
  stream = false,
): 'agent' | 'human' {
  const kind = actorKind(actor);
  const parsed = parseActor(actor ?? '');
  if (kind === 'agent' && parsed.id !== targetSessionId) {
    throw new BrowserError('forbidden', 'an agent may drive only its own session browser', 403);
  }
  if (stream && kind !== 'human') {
    throw new BrowserError('forbidden', 'the browser stream is human-admin only', 403);
  }
  return kind;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function dedupeEligible(action: BrowserAction): boolean {
  return action.action !== 'read' && action.action !== 'screenshot' && action.action !== 'human-activity';
}

export interface BrowserApiRequest {
  method: string;
  url: URL;
  body?: unknown;
  /** Resolved from token + headers by api-server; never accepted in the body. */
  actor?: KTeamEvent['source'];
  requestId?: string;
}

export interface BrowserApiResponse {
  status: number;
  body: unknown;
}

/** Transport-shaped browser routes; api-server needs only a route check + one
 * call, keeping its contended body small. */
export class BrowserApi {
  private readonly applied = new Map<string, BrowserApiResponse>();
  private readonly inFlight = new Map<string, Promise<BrowserApiResponse>>();

  constructor(readonly service: BrowserService) {}

  async handle(request: BrowserApiRequest): Promise<BrowserApiResponse | null> {
    const route = matchBrowserRoute(request.url.pathname);
    if (!route || route.kind !== 'api') return null;
    try {
      const sessionId = await this.service.resolveSession(route.sessionId);
      const kind = authorize(request.actor, sessionId);
      if (request.method === 'GET') return { status: 200, body: await this.service.status(sessionId) };
      if (request.method !== 'POST') {
        return { status: 405, body: { error: 'browser route accepts GET or POST', code: 'bad_request' } };
      }
      const action = parseBrowserAction(request.body);
      if (action.action === 'human-activity' && kind !== 'human') {
        throw new BrowserError('forbidden', 'only the human viewer may report human browser activity', 403);
      }
      const apply = async (): Promise<BrowserApiResponse> => ({
        status: 200,
        body: await this.service.act(sessionId, action, kind),
      });
      if (!request.requestId || !dedupeEligible(action)) return await apply();
      const key = `${sessionId}\n${request.requestId}\n${Bun.hash(canonicalJson(action))}`;
      const replay = this.applied.get(key);
      if (replay) return replay;
      const pending = this.inFlight.get(key);
      if (pending) return await pending;
      const promise = apply();
      this.inFlight.set(key, promise);
      try {
        const response = await promise;
        this.applied.delete(key);
        this.applied.set(key, response);
        while (this.applied.size > 200) this.applied.delete(this.applied.keys().next().value!);
        return response;
      } finally {
        this.inFlight.delete(key);
      }
    } catch (error) {
      if (!isBrowserError(error)) throw error;
      return { status: error.status, body: { error: error.message, code: error.code } };
    }
  }

  async openStream(
    sessionId: string,
    actor: KTeamEvent['source'] | undefined,
    downstream: BrowserStreamDownstream,
  ): Promise<BrowserStreamBridge> {
    const canonical = await this.authorizeStream(sessionId, actor);
    return await BrowserStreamBridge.connect(this.service, canonical, downstream);
  }

  /** Resolve ownership and prove human-admin authorization before api-server
   * commits a WebSocket upgrade. `openStream` repeats this cheap check when the
   * socket opens so authorization cannot be accidentally bypassed by another
   * caller. */
  async authorizeStream(sessionId: string, actor: KTeamEvent['source'] | undefined): Promise<string> {
    const canonical = await this.service.resolveSession(sessionId);
    authorize(actor, canonical, true);
    return canonical;
  }
}

export function browserResult(value: unknown): BrowserActionResult {
  return value as BrowserActionResult;
}
