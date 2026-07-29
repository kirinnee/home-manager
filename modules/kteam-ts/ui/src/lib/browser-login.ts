// Daemon-global human browser-login window. This deliberately lives outside
// fleet state: the endpoint is separately gated because its open response
// contains a short-lived VNC password.

import { useSyncExternalStore } from 'react';
import { ApiError, TOKEN } from './api';

export type BrowserLoginState = 'closed' | 'opening' | 'open' | 'closing' | 'error';

export interface BrowserLoginStatus {
  state: BrowserLoginState;
  profilePrimed: boolean;
  openedAt?: string;
  expiresAt?: string;
  connection?: {
    host: string;
    port: number;
    password: string;
    sshTunnel: string;
  };
  error?: string;
}

/** A failed poll is intentionally not made to look like a closed window. */
export type BrowserLoginView = BrowserLoginStatus | { state: 'unknown'; error: string };
export type BrowserLoginAction = 'start' | 'stop' | 'confirm';

async function request<T>(init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  if (init?.body) headers.set('content-type', 'application/json');
  if ((init?.method ?? 'GET').toUpperCase() !== 'GET') headers.set('x-kteam-request-id', crypto.randomUUID());
  const response = await fetch('/v1/browser/login', { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(response.status, body.error ?? `HTTP ${response.status}`, body.code);
  }
  return (await response.json()) as T;
}

export const browserLoginApi = {
  status: () => request<BrowserLoginStatus>(),
  action: (action: BrowserLoginAction, options?: { minutes?: number; primed?: boolean }) =>
    request<BrowserLoginStatus>({
      method: 'POST',
      body: JSON.stringify({ action, ...options }),
    }),
};

const CLOSED_POLL_MS = 30_000;
const OPEN_POLL_MS = 2_000;
const listeners = new Set<() => void>();
let snapshot: BrowserLoginView | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let inFlight: { generation: number; promise: Promise<BrowserLoginView> } | null = null;

function publish(next: BrowserLoginView): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function clearPoll(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function schedulePoll(status: BrowserLoginView): void {
  clearPoll();
  if (listeners.size === 0) return;
  const delay = status.state === 'closed' ? CLOSED_POLL_MS : OPEN_POLL_MS;
  timer = setTimeout(() => {
    void refreshBrowserLogin();
  }, delay);
}

/** Re-fetches immediately after every action; credentials remain memory-only. */
export async function refreshBrowserLogin(): Promise<BrowserLoginView> {
  const requestGeneration = generation;
  if (inFlight?.generation === requestGeneration) return inFlight.promise;
  const promise = browserLoginApi
    .status()
    .then(status => {
      if (generation === requestGeneration) {
        publish(status);
        schedulePoll(status);
      }
      return status;
    })
    .catch(caught => {
      const unknown: BrowserLoginView = {
        state: 'unknown',
        error: caught instanceof Error ? caught.message : 'Cannot reach the browser-login window.',
      };
      if (generation === requestGeneration) {
        publish(unknown);
        schedulePoll(unknown);
      }
      return unknown;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { generation: requestGeneration, promise };
  return promise;
}

export async function actOnBrowserLogin(
  action: BrowserLoginAction,
  options?: { minutes?: number; primed?: boolean },
): Promise<BrowserLoginView> {
  // Invalidate any older status request. Its result may still satisfy its own
  // caller, but it must never publish over this action's authoritative state.
  const actionGeneration = ++generation;
  clearPoll();
  try {
    const status = await browserLoginApi.action(action, options);
    if (generation === actionGeneration) publish(status);
    // Even though POST returns status, immediately GET again so the global
    // renderer sees the daemon's authoritative state after teardown/startup.
    return await refreshBrowserLogin();
  } catch (caught) {
    const unknown: BrowserLoginView = {
      state: 'unknown',
      error: caught instanceof Error ? caught.message : 'Browser-login action failed.',
    };
    if (generation === actionGeneration) {
      publish(unknown);
      schedulePoll(unknown);
    }
    return unknown;
  }
}

function subscribe(listener: () => void): () => void {
  const wasEmpty = listeners.size === 0;
  listeners.add(listener);
  if (wasEmpty) void refreshBrowserLogin();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearPoll();
  };
}

const getSnapshot = (): BrowserLoginView | null => snapshot;

export function useBrowserLogin(): {
  status: BrowserLoginView | null;
  start: (minutes?: number) => Promise<BrowserLoginView>;
  stop: (primed?: boolean) => Promise<BrowserLoginView>;
  confirm: () => Promise<BrowserLoginView>;
  refresh: () => Promise<BrowserLoginView>;
} {
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    status,
    start: (minutes?: number) => actOnBrowserLogin('start', minutes === undefined ? undefined : { minutes }),
    stop: (primed?: boolean) => actOnBrowserLogin('stop', primed ? { primed: true } : undefined),
    confirm: () => actOnBrowserLogin('confirm'),
    refresh: refreshBrowserLogin,
  };
}

/** Test-only reset for the module-level polling store. */
export function resetBrowserLoginStore(): void {
  clearPoll();
  generation += 1;
  snapshot = null;
  inFlight = null;
  listeners.clear();
}

/** Test-only observation of the in-memory state; never persists credentials. */
export function browserLoginSnapshotForTest(): BrowserLoginView | null {
  return snapshot;
}
