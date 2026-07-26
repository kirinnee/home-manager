// Per-request actor attribution. The api-server runs every authenticated
// request inside `actorContext.run({ actor }, …)`, deriving the actor from the
// token class and self-identification headers (see resolveApiActor).
// SessionManager.emit reads the store at emit time and tags the event's
// `source`, so an event caused by an HTTP action is attributed to whoever
// caused it — the human via the web UI ('admin-ui') or the CLI ('admin-cli'),
// a warden ('warden:<its-session-id>'), or a teammate ('peer:<its-session-id>')
// — instead of the generic 'daemon'. The daemon's OWN reflex actions run
// OUTSIDE any request context, so currentActor() is undefined and they keep
// their genuine 'daemon' source.
//
// EXTENSIBILITY: the actor value is an opaque string as far as consumers are
// concerned. A new kind ("cron:…", "webhook:…") needs no change here or in any
// consumer, and an UNRECOGNISED value must surface AS ITSELF — never collapse to
// 'daemon' (that collapse is the exact defect this module fixes). parseActor
// splits a "kind:id" value without a whitelist, so unknown kinds round-trip.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { KTeamEvent } from './types';

export interface ActorStore {
  actor: KTeamEvent['source'];
}

export const actorContext = new AsyncLocalStorage<ActorStore>();

/** The actor for the current async context, if any. */
export function currentActor(): KTeamEvent['source'] | undefined {
  return actorContext.getStore()?.actor;
}

export const WARDEN_ACTOR_PREFIX = 'warden:';
export const PEER_ACTOR_PREFIX = 'peer:';

/** A warden's action, tagged with the warden's OWN session id. */
export function wardenActor(sessionId: string): `warden:${string}` {
  return `${WARDEN_ACTOR_PREFIX}${sessionId}`;
}

/** A teammate ("peer") acting over the API, tagged with its session id. */
export function peerActor(sessionId: string): `peer:${string}` {
  return `${PEER_ACTOR_PREFIX}${sessionId}`;
}

/** Which bearer token authenticated the request. */
export type TokenClass = 'admin' | 'warden';

export interface ApiActorInput {
  tokenClass: TokenClass;
  /** The acting pane's own kteam session id (x-kteam-session-id header), present
   *  when the request originates from inside a teammate/warden pane. Absent for
   *  the human lead's own shell and the browser UI. */
  sessionId?: string;
  /** Client self-identification (x-kteam-client header), e.g. 'cli'. The browser
   *  SPA sends nothing, so absent + admin token defaults to the UI. */
  client?: string;
}

/** Derive the event actor for an authenticated API request. Never returns
 *  'daemon' — an API request always has a human or an agent behind it, and
 *  attributing those to 'daemon' is the bug being fixed. Precedence: a session
 *  id (an in-pane caller) identifies the specific warden or peer; without one
 *  the admin token is the human, distinguished as CLI vs UI by the client
 *  header. */
export function resolveApiActor(input: ApiActorInput): KTeamEvent['source'] {
  const sessionId = input.sessionId?.trim();
  if (input.tokenClass === 'warden') {
    return sessionId ? wardenActor(sessionId) : 'warden';
  }
  if (sessionId) return peerActor(sessionId);
  return input.client === 'cli' ? 'admin-cli' : 'admin-ui';
}

export interface ParsedActor {
  /** The kind before the first ':' ("warden", "peer", "admin-cli", …), or the
   *  whole value when there is no ':'. Never whitelisted, so unknown kinds pass
   *  through verbatim. */
  kind: string;
  /** The part after the first ':', when present (a session id for warden/peer). */
  id?: string;
  /** The original, unparsed value — what a consumer should display when it does
   *  not specifically understand the kind. */
  raw: string;
}

/** Split a structured actor string into {kind, id} without a whitelist. An
 *  unrecognised value returns {kind: value, raw: value}, so consumers degrade to
 *  showing the raw actor rather than losing it. */
export function parseActor(source: string): ParsedActor {
  const idx = source.indexOf(':');
  if (idx === -1) return { kind: source, raw: source };
  return { kind: source.slice(0, idx), id: source.slice(idx + 1), raw: source };
}
