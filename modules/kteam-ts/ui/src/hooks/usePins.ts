// React access to the pins store (lib/pins.ts) and the foreground-session
// bridge (lib/pin-bridge.ts). One `useSyncExternalStore` subscription per
// consumer; the store hands back a stable snapshot between mutations, so
// derived lists memoize cleanly and only recompute on an actual write.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { emptyStore, pinsStore, sessionPins, type Pin, type PinStore } from '../lib/pins';
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

/** One session's pins, in display order. */
export function useSessionPins(sessionId: string | undefined): Pin[] {
  const store = usePinStore();
  return useMemo(() => (sessionId ? sessionPins(store, sessionId) : []), [store, sessionId]);
}

/** The count for a session — cheap, for the trigger badge. */
export function usePinCount(sessionId: string | undefined): number {
  return useSessionPins(sessionId).length;
}

/** Is this block pinned right now, in this session? Subscribed, so a pin/unpin
 *  from anywhere reflects here without re-rendering the whole transcript row. */
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
