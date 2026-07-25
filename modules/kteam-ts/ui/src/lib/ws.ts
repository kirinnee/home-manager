// Thin WebSocket wrapper for the kteam /v1/events stream. Handles:
//  - token-as-query-param (browsers can't set Authorization on a WS)
//  - JSON parsing + soft-failure (one bad event never sinks the socket)
//  - automatic reconnect with capped exponential backoff AND jitter
//  - catch-up on every (re)connect via the daemon's bounded tail
//
// ONE SOCKET PER APP. The store (lib/store.tsx) opens exactly one fleet-scoped
// stream and fans events out to the pages; nothing else in the UI opens a
// socket. The daemon broadcasts EVERY event — including the sequence-0
// live-only classes (`terminal.frame` and all harness chat/tool frames) — to a
// socket that named no `sessionId`, so a fleet subscription is a superset of a
// per-session one (api-server.ts: the broadcast loop filters only when
// `sessionIds.length > 0`).

import type { KTeamEvent } from '../types';
import { TOKEN } from './api';

export type StreamStatus = 'connecting' | 'open' | 'closed';

export interface EventStreamHandle {
  close(): void;
}

export interface EventStreamOptions {
  /** Empty (the default) subscribes to the whole fleet. */
  sessionId?: string;
  /** NEGATIVE = tail semantics: "the last |after| events, then live".
   *
   *  A fleet stream must use a tail. Sequences are PER SESSION (the daemon
   *  dropped its global counter), so there is no single cursor to resume from —
   *  the client dedupes journalled events by (session, sequence) instead. */
  after?: number;
  onEvent: (event: KTeamEvent) => void;
  onStatus?: (status: StreamStatus) => void;
}

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
/** 2^10 * 500ms already exceeds the cap; stop growing the exponent there. */
const MAX_ATTEMPT = 10;

export function openEventStream({
  sessionId = '',
  after = -200,
  onEvent,
  onStatus,
}: EventStreamOptions): EventStreamHandle {
  let closed = false;
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: number | null = null;

  const connect = () => {
    if (closed) return;
    onStatus?.('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${location.host}/v1/events`);
    if (TOKEN) url.searchParams.set('token', TOKEN);
    if (sessionId) url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('after', String(after));

    let next: WebSocket;
    try {
      next = new WebSocket(url.toString());
    } catch {
      scheduleReconnect();
      return;
    }
    socket = next;
    next.onopen = () => {
      if (closed) return;
      attempt = 0;
      onStatus?.('open');
    };
    next.onmessage = message => {
      try {
        onEvent(JSON.parse(message.data as string) as KTeamEvent);
      } catch {
        /* swallow malformed frame; daemon never sends anything else */
      }
    };
    next.onclose = () => {
      if (socket === next) socket = null;
      if (closed) return;
      onStatus?.('closed');
      scheduleReconnect();
    };
    next.onerror = () => {
      // close fires too; nothing to do here.
    };
  };

  // Capped exponential backoff with jitter. Without jitter every tab (and every
  // client of a restarted daemon) retries on the same schedule and hammers the
  // socket in lockstep the moment it comes back.
  const scheduleReconnect = () => {
    if (closed || timer != null) return;
    const capped = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    attempt = Math.min(attempt + 1, MAX_ATTEMPT);
    const delay = capped / 2 + Math.random() * (capped / 2);
    timer = window.setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  };

  /** A tab coming back to the foreground (or a machine coming back online) is
   *  the one moment a long backoff is pure latency: retry at once. */
  const wake = () => {
    if (closed) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
    attempt = 0;
    connect();
  };

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
  if (typeof window !== 'undefined') window.addEventListener('online', wake);

  connect();

  return {
    close() {
      closed = true;
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
      if (typeof window !== 'undefined') window.removeEventListener('online', wake);
      socket?.close();
      socket = null;
    },
  };
}
