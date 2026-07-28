import { isHumanAdminActor } from './actor-context';
import type { RuntimeModelCatalog } from './codex-runtime';
import { isSafeSessionId } from './pins-store';
import type { KTeamEvent } from './types';

const RUNTIME_MODELS_PATH = /^\/v1\/sessions\/([^/]+)\/runtime-models\/?$/;

/** Prefix classifier for api-server dispatch and the warden gate. Exact route
 * validation remains in matchRuntimeModelsRoute(). */
export const isRuntimeModelsPath = (pathname: string): boolean =>
  /^\/v1\/sessions\/[^/]+\/runtime-models(?:\/|$)/.test(pathname);

/** Model enumeration and switching can change account cost and session
 * behaviour. Keep the catalog behind the same admin boundary as the runtime
 * mutation; this helper must run before api-server's generic GET allowance. */
export function runtimeModelsWardenDenial(_method: string, pathname: string): string | null {
  return isRuntimeModelsPath(pathname) ? 'enumerate session runtime models' : null;
}

export function matchRuntimeModelsRoute(pathname: string): { sessionId: string } | null {
  const match = pathname.match(RUNTIME_MODELS_PATH);
  if (!match) return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  // Reject encoded slashes, dots, traversal and surprise characters after
  // decoding. The pathname itself is never normalized by this matcher.
  if (!isSafeSessionId(sessionId)) return null;
  return { sessionId };
}

export interface RuntimeModelsService {
  runtimeModels(id: string): Promise<RuntimeModelCatalog>;
}

export interface RuntimeModelsApiRequest {
  method: string;
  url: URL;
  /** Resolved from the authenticated request by api-server. Never accepted in
   * JSON, query parameters, or a client-selected path field. */
  actor?: KTeamEvent['source'];
}

export interface RuntimeModelsApiResponse {
  status: number;
  body: unknown;
}

/** Enumeration is human-only for the same reason the mutation is: the catalog
 * exposes account cost and provider configuration. The predicate itself lives in
 * the committed actor-context module so this surface and POST /runtime cannot
 * drift apart, and so the auth rule does not depend on this newer file. */
function authorizeAdmin(actor: KTeamEvent['source'] | undefined): RuntimeModelsApiResponse | undefined {
  if (isHumanAdminActor(actor)) return undefined;
  return {
    status: 403,
    body: { error: 'runtime model choices require the human admin token', code: 'forbidden' },
  };
}

/** Transport-shaped mount for the session-scoped model catalog. SessionManager
 * owns catalog semantics; this layer owns exact routing and authorization. */
export class RuntimeModelsApi {
  constructor(readonly service: RuntimeModelsService) {}

  async handle(request: RuntimeModelsApiRequest): Promise<RuntimeModelsApiResponse | null> {
    const route = matchRuntimeModelsRoute(request.url.pathname);
    if (!route) return null;
    const denial = authorizeAdmin(request.actor);
    if (denial) return denial;
    if (request.method !== 'GET') {
      return {
        status: 405,
        body: { error: 'runtime model catalog accepts GET', code: 'bad_request' },
      };
    }
    try {
      return { status: 200, body: await this.service.runtimeModels(route.sessionId) };
    } catch (error) {
      // Let api-server retain its established unknown-session 404 mapping.
      if (/unknown kteam session/i.test(String(error))) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 503,
        body: {
          error: message,
          code: /timed out/i.test(message) ? 'catalog_timeout' : 'catalog_unavailable',
        },
      };
    }
  }
}
