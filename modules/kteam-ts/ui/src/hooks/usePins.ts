// React access to the pins store (lib/pins.ts) and the foreground-session
// bridge (lib/pin-bridge.ts).
//
// The store is now DAEMON-BACKED (phase 2): a session's pins are fetched on
// demand and kept live over the events stream. `usePinsSession` is the one hook
// that drives that — it hydrates the session and applies live `pins.updated`
// events — and it is folded into `usePinCount`, which the (always-mounted)
// SessionHeader calls once per session, so the foreground session is always
// hydrated and subscribed. The pure readers (`useSessionPins`, `usePinCount`,
// `useMessagePinned`) then read the in-memory cache with no side effects.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { emptyStore, pinsStore, sessionPins, type Pin, type PinSessionStatus, type PinStore } from '../lib/pins';
import { useSessionEvents } from '../lib/store';
import {
  getForegroundSession,
  setForegroundSession,
  clearForegroundSession,
  subscribeForegroundSession,
} from '../lib/pin-bridge';

/** The whole store. Stable reference between mutations. */
export function usePinStore(): PinStore {
  return useSyncExternalStore(pinsStore.subscribe, pinsStore.getSnapshot, emptyStore);
}

/** Hydrate one session's pins from the daemon and keep them live. Idempotent —
 *  many callers for the same session share one fetch and one subscription is
 *  cheap. Returns the session's degradation status so a consumer can be honest
 *  about a daemon it cannot reach. Safe with an undefined id (no-op). */
export function usePinsSession(sessionId: string | undefined): PinSessionStatus {
  useEffect(() => {
    if (!sessionId) return;
    void pinsStore.hydrate(sessionId);
  }, [sessionId]);
  // Live convergence: an agent pinning (or the reader's other device) broadcasts
  // a `pins.updated` carrying the whole snapshot; apply it so the sheet updates
  // without polling. `useSessionEvents` no-ops on an empty id.
  useSessionEvents(sessionId ?? '', event => {
    if (event.type === 'pins.updated' && event.sessionId === sessionId) {
      pinsStore.applyServerSnapshot(sessionId, event.data);
    }
  });
  return usePinStatus(sessionId);
}

/** One session's degradation status (idle | loading | ready | error). */
export function usePinStatus(sessionId: string | undefined): PinSessionStatus {
  return useSyncExternalStore(
    pinsStore.subscribe,
    () => (sessionId ? pinsStore.status(sessionId) : 'idle'),
    () => 'idle',
  );
}

/** One session's pins, in display order (the daemon's order). */
export function useSessionPins(sessionId: string | undefined): Pin[] {
  const store = usePinStore();
  return useMemo(() => (sessionId ? sessionPins(store, sessionId) : []), [store, sessionId]);
}

/** The count for a session — cheap, for the trigger badge. Also the hydration
 *  driver: SessionHeader calls this once per session, so the foreground session
 *  is always fetched and subscribed. */
export function usePinCount(sessionId: string | undefined): number {
  usePinsSession(sessionId);
  return useSessionPins(sessionId).length;
}

/** Is this block pinned right now, in this session? Subscribed, so a pin/unpin
 *  from anywhere (including an agent) reflects here without re-rendering the
 *  whole transcript row. */
export function useMessagePinned(sessionId: string | undefined, blockId: string): boolean {
  const pins = useSessionPins(sessionId);
  return useMemo(() => pins.some(p => p.kind === 'message' && p.blockId === blockId), [pins, blockId]);
}

/** The foreground session id, as declared by the active SessionHeader. */
export function useForegroundSession(): string | null {
  return useSyncExternalStore(subscribeForegroundSession, getForegroundSession, () => null);
}

/** SessionHeader effect: declare this session as the foreground one while
 *  `active`, and relinquish it on unmount / going inactive. */
export function useDeclareForeground(sessionId: string, active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    setForegroundSession(sessionId);
    return () => clearForegroundSession(sessionId);
  }, [sessionId, active]);
}
