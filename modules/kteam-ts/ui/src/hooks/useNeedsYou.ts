import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  emptyNeedsYouCache,
  needsYouStore,
  sessionNeedsYou,
  sessionNeedsYouCount,
  type NeedsYouCache,
  type NeedsYouItem,
  type NeedsYouSessionStatus,
  type ResolvedNeedsYouItem,
} from '../lib/needs-you';
import { useSessionEvents } from '../lib/store';

export function useNeedsYouCache(): NeedsYouCache {
  return useSyncExternalStore(needsYouStore.subscribe, needsYouStore.getSnapshot, emptyNeedsYouCache);
}

function useLiveSnapshot(sessionId: string | undefined): void {
  useSessionEvents(sessionId ?? '', event => {
    if (sessionId && event.type === 'needs-you.updated' && event.sessionId === sessionId) {
      needsYouStore.applyServerSnapshot(sessionId, event.data);
    }
  });
}

export function useNeedsYouSession(sessionId: string | undefined): NeedsYouSessionStatus {
  useEffect(() => {
    if (sessionId) void needsYouStore.hydrate(sessionId);
  }, [sessionId]);
  useLiveSnapshot(sessionId);
  return useSyncExternalStore(
    needsYouStore.subscribe,
    () => (sessionId ? needsYouStore.status(sessionId) : 'idle'),
    () => 'idle',
  );
}

export function useNeedsYouItems(sessionId: string | undefined): NeedsYouItem[] {
  const cache = useNeedsYouCache();
  return useMemo(() => (sessionId ? sessionNeedsYou(cache, sessionId) : []), [cache, sessionId]);
}

export function useNeedsYouResolutions(sessionId: string | undefined): ResolvedNeedsYouItem[] {
  const cache = useNeedsYouCache();
  return useMemo(() => (sessionId ? (cache.sessions[sessionId]?.resolved ?? []) : []), [cache, sessionId]);
}

/** Cheap badge path: only fetches `{sessionId,count}` until the full panel is
 * opened. The live whole-snapshot stream replaces it whenever a mutation lands. */
export function useNeedsYouCount(sessionId: string | undefined): number {
  useEffect(() => {
    if (sessionId) void needsYouStore.hydrateCount(sessionId);
  }, [sessionId]);
  useLiveSnapshot(sessionId);
  const cache = useNeedsYouCache();
  return sessionId ? sessionNeedsYouCount(cache, sessionId) : 0;
}
