// Per-request actor attribution. The api-server runs warden-authenticated
// requests (warden-scoped bearer token, or an assigned-warden stop capability)
// inside `actorContext.run({ actor: 'warden' }, …)`. SessionManager.emit reads
// the store at emit time and tags the event's `source` accordingly, so events
// caused by a warden HTTP action are attributed to 'warden' rather than the
// generic 'client'/'daemon'. The daemon's OWN reflex actions run outside any
// request context, so they keep their original source.

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
