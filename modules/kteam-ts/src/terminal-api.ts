import { parseActor } from './actor-context';
import { isSafeSessionId } from './pins-store';
import type { TerminalService } from './terminal-service';
import { TerminalStreamBridge, type TerminalStreamDownstream } from './terminal-stream';
import { isTerminalError, isTerminalId, TerminalError } from './terminal-types';
import type { KTeamEvent } from './types';

const TERMINALS_PATH = /^\/v1\/sessions\/([^/]+)\/terminals\/?$/;
const TERMINAL_PATH = /^\/v1\/sessions\/([^/]+)\/terminals\/([^/]+)\/?$/;
const TERMINAL_STREAM_PATH = /^\/v1\/sessions\/([^/]+)\/terminals\/([^/]+)\/stream\/?$/;

export const isTerminalPath = (pathname: string): boolean => /^\/v1\/sessions\/[^/]+\/terminals(?:\/|$)/.test(pathname);

/** The entire arbitrary-shell surface is admin-only. api-server must call this
 * before its generic warden GET allowance, including for WebSocket upgrades. */
export function terminalWardenDenial(_method: string, pathname: string): string | null {
  return isTerminalPath(pathname) ? 'use interactive shell terminals' : null;
}

export type TerminalRoute =
  | { kind: 'collection'; sessionId: string }
  | { kind: 'terminal'; sessionId: string; terminalId: string }
  | { kind: 'stream'; sessionId: string; terminalId: string };

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function matchTerminalRoute(pathname: string): TerminalRoute | null {
  const stream = pathname.match(TERMINAL_STREAM_PATH);
  const terminal = pathname.match(TERMINAL_PATH);
  const collection = pathname.match(TERMINALS_PATH);
  const match = stream ?? terminal ?? collection;
  if (!match) return null;
  const sessionId = decoded(match[1]!);
  if (!sessionId || !isSafeSessionId(sessionId)) return null;
  if (stream || terminal) {
    const terminalId = decoded(match[2]!);
    if (!terminalId || !isTerminalId(terminalId)) return null;
    return { kind: stream ? 'stream' : 'terminal', sessionId, terminalId };
  }
  return { kind: 'collection', sessionId };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function authorizeAdmin(actor: KTeamEvent['source'] | undefined): void {
  const kind = parseActor(actor ?? '').kind;
  if (kind !== 'admin-ui' && kind !== 'admin-cli') {
    throw new TerminalError('forbidden', 'interactive shell terminals require the human admin token', 403);
  }
}

export interface TerminalApiRequest {
  method: string;
  url: URL;
  body?: unknown;
  /** Resolved from bearer token + headers by api-server, never request JSON. */
  actor?: KTeamEvent['source'];
}

export interface TerminalApiResponse {
  status: number;
  body: unknown;
}

/** Transport-shaped terminal routes; the contended api-server only needs one
 * prefix check, one HTTP call, and one WebSocket hook. */
export class TerminalApi {
  constructor(readonly service: TerminalService) {}

  async handle(request: TerminalApiRequest): Promise<TerminalApiResponse | null> {
    const route = matchTerminalRoute(request.url.pathname);
    if (!route || route.kind === 'stream') return null;
    try {
      authorizeAdmin(request.actor);
      const canonical = await this.service.resolveSession(route.sessionId);
      if (route.kind === 'collection') {
        if (request.method === 'GET') {
          return { status: 200, body: await this.service.list(canonical.id) };
        }
        if (request.method === 'POST') {
          const body = asObject(request.body);
          const terminal = await this.service.create(canonical.id, {
            ...(body['title'] === undefined ? {} : { title: body['title'] }),
            ...(body['cols'] === undefined ? {} : { cols: Number(body['cols']) }),
            ...(body['rows'] === undefined ? {} : { rows: Number(body['rows']) }),
          });
          return { status: 201, body: terminal };
        }
        return { status: 405, body: { error: 'terminal collection accepts GET or POST', code: 'bad_request' } };
      }
      if (request.method === 'GET') {
        return { status: 200, body: await this.service.get(canonical.id, route.terminalId) };
      }
      if (request.method === 'PATCH') {
        const body = asObject(request.body);
        return {
          status: 200,
          body: await this.service.rename(canonical.id, route.terminalId, body['title']),
        };
      }
      if (request.method === 'DELETE') {
        await this.service.closeTerminal(canonical.id, route.terminalId);
        return { status: 200, body: { closed: true, id: route.terminalId } };
      }
      return { status: 405, body: { error: 'terminal route accepts GET, PATCH, or DELETE', code: 'bad_request' } };
    } catch (error) {
      if (!isTerminalError(error)) throw error;
      return { status: error.status, body: { error: error.message, code: error.code } };
    }
  }

  async authorizeStream(
    sessionRef: string,
    terminalId: string,
    actor: KTeamEvent['source'] | undefined,
  ): Promise<{ sessionId: string; terminalId: string }> {
    authorizeAdmin(actor);
    const canonical = await this.service.resolveSession(sessionRef);
    await this.service.get(canonical.id, terminalId);
    return { sessionId: canonical.id, terminalId };
  }

  async openStream(
    sessionId: string,
    terminalId: string,
    actor: KTeamEvent['source'] | undefined,
    downstream: TerminalStreamDownstream,
  ): Promise<TerminalStreamBridge> {
    const canonical = await this.authorizeStream(sessionId, terminalId, actor);
    return await TerminalStreamBridge.connect(this.service, canonical.sessionId, canonical.terminalId, downstream);
  }
}
