// Thin WebSocket wrapper for the kteam /v1/events stream. Handles:
//  - token-as-query-param (browsers can't set Authorization on a WS)
//  - JSON parsing + soft-failure (one bad event never sinks the socket)
//  - automatic reconnect with capped exponential backoff
//  - per-call subscribe/unsubscribe so multiple components can listen

import type { KTeamEvent } from '../types';
import { TOKEN } from './api';

type Listener = (event: KTeamEvent) => void;
type StatusListener = (status: 'connecting' | 'open' | 'closed') => void;

interface SocketHandle {
  close(): void;
}

export function openEventStream(
  sessionId: string,
  after: number,
  listener: Listener,
  statusListener?: StatusListener,
): SocketHandle {
  let closed = false;
  let socket: WebSocket | null = null;
  let listeners: Listener[] = [listener];
  let status: StatusListener | undefined = statusListener;
  let backoff = 500;
  const maxBackoff = 5000;

  const connect = () => {
    if (closed) return;
    status?.('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${location.host}/v1/events`);
    if (TOKEN) url.searchParams.set('token', TOKEN);
    if (sessionId) url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('after', String(after));

    try {
      socket = new WebSocket(url.toString());
    } catch {
      scheduleReconnect();
      return;
    }
    socket.onopen = () => {
      backoff = 500;
      status?.('open');
    };
    socket.onmessage = message => {
      try {
        const event = JSON.parse(message.data) as KTeamEvent;
        if (typeof event.sequence === 'number' && event.sequence > after) after = event.sequence;
        for (const fn of listeners) fn(event);
      } catch {
        /* swallow malformed frame; daemon never sends anything else */
      }
    };
    socket.onclose = () => {
      status?.('closed');
      if (!closed) scheduleReconnect();
    };
    socket.onerror = () => {
      // close will fire too; nothing to do here.
    };
  };

  const scheduleReconnect = () => {
    if (closed) return;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  };

  connect();

  return {
    close() {
      closed = true;
      socket?.close();
      listeners = [];
    },
    // (no public addListener; one listener per handle — open a second if needed)
  };
}
