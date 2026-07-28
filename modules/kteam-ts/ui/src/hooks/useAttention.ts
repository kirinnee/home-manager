import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  emptyAttentionCache,
  attentionStore,
  sessionAttention,
  sessionAttentionCount,
  type AttentionCache,
  type AttentionItem,
  type AttentionSessionStatus,
  type ResolvedAttentionItem,
} from '../lib/attention';
import { useSessionEvents } from '../lib/store';

export function useAttentionCache(): AttentionCache {
  return useSyncExternalStore(attentionStore.subscribe, attentionStore.getSnapshot, emptyAttentionCache);
}

function useLiveSnapshot(sessionId: string | undefined): void {
  useSessionEvents(sessionId ?? '', event => {
    if (sessionId && event.type === 'attention.updated' && event.sessionId === sessionId) {
      attentionStore.applyServerSnapshot(sessionId, event.data);
    }
  });
}

export function useAttentionSession(sessionId: string | undefined): AttentionSessionStatus {
  useEffect(() => {
    if (sessionId) void attentionStore.hydrate(sessionId);
  }, [sessionId]);
  useLiveSnapshot(sessionId);
  return useSyncExternalStore(
    attentionStore.subscribe,
    () => (sessionId ? attentionStore.status(sessionId) : 'idle'),
    () => 'idle',
  );
}

export function useAttentionItems(sessionId: string | undefined): AttentionItem[] {
  const cache = useAttentionCache();
  return useMemo(() => (sessionId ? sessionAttention(cache, sessionId) : []), [cache, sessionId]);
}

export function useAttentionResolutions(sessionId: string | undefined): ResolvedAttentionItem[] {
  const cache = useAttentionCache();
  return useMemo(() => (sessionId ? (cache.sessions[sessionId]?.resolved ?? []) : []), [cache, sessionId]);
}

/** Cheap badge path: only fetches `{sessionId,count}` until the full panel is
 * opened. The live whole-snapshot stream replaces it whenever a mutation lands. */
export function useAttentionCount(sessionId: string | undefined): number {
  useEffect(() => {
    if (sessionId) void attentionStore.hydrateCount(sessionId);
  }, [sessionId]);
  useLiveSnapshot(sessionId);
  const cache = useAttentionCache();
  return sessionId ? sessionAttentionCount(cache, sessionId) : 0;
}
