import { ApiError, TOKEN } from './api';

export type RemoteBrowserState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type RemoteBrowserActivity =
  | 'start'
  | 'stop'
  | 'navigate'
  | 'click'
  | 'type'
  | 'read'
  | 'screenshot'
  | 'back'
  | 'forward'
  | 'reload'
  | 'resize'
  | 'pointer'
  | 'keyboard'
  | 'paste';

export interface RemoteBrowserStatus {
  sessionId: string;
  state: RemoteBrowserState;
  viewport: { width: number; height: number };
  viewers: number;
  persistentProfile: true;
  idleTimeoutSeconds: number;
  idleDeadline?: string;
  startedAt?: string;
  url?: string;
  title?: string;
  lastActor?: { kind: 'agent' | 'human'; at: string; action: RemoteBrowserActivity };
  capacity: { running: number; maximum: number };
  error?: string;
}

export interface RemoteBrowserActionResult {
  status: RemoteBrowserStatus;
  result?: { url?: string; title?: string; text?: string; screenshotBase64?: string };
}

async function browserRequest<T>(sessionId: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  if (init?.body) headers.set('content-type', 'application/json');
  if ((init?.method ?? 'GET').toUpperCase() !== 'GET') headers.set('x-kteam-request-id', crypto.randomUUID());
  const response = await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/browser`, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(response.status, body.error ?? `HTTP ${response.status}`, body.code);
  }
  return (await response.json()) as T;
}

const action = (sessionId: string, body: unknown) =>
  browserRequest<RemoteBrowserActionResult>(sessionId, { method: 'POST', body: JSON.stringify(body) });

export const remoteBrowserApi = {
  status: (sessionId: string) => browserRequest<RemoteBrowserStatus>(sessionId),
  start: (sessionId: string) => action(sessionId, { action: 'start' }),
  /** Start or reuse the persistent browser, then navigate in the same request when a URL is supplied. */
  open: (sessionId: string, url?: string) => action(sessionId, { action: 'open', ...(url ? { url } : {}) }),
  stop: (sessionId: string) => action(sessionId, { action: 'stop' }),
  navigate: (sessionId: string, url: string) => action(sessionId, { action: 'navigate', url }),
  back: (sessionId: string) => action(sessionId, { action: 'back' }),
  forward: (sessionId: string) => action(sessionId, { action: 'forward' }),
  reload: (sessionId: string) => action(sessionId, { action: 'reload' }),
  resize: (sessionId: string, width: number, height: number) => action(sessionId, { action: 'resize', width, height }),
  activity: (sessionId: string, kind: 'pointer' | 'keyboard' | 'paste') =>
    action(sessionId, { action: 'human-activity', kind }),
};

export function remoteBrowserStreamUrl(sessionId: string, locationValue: Location = window.location): string {
  const protocol = locationValue.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${locationValue.host}/v1/sessions/${encodeURIComponent(sessionId)}/browser/stream`);
  if (TOKEN) url.searchParams.set('token', TOKEN);
  return url.toString();
}

export type RemoteViewportMode = 'responsive' | 'desktop';

export function remoteViewportForContainer(
  width: number,
  height: number,
  mode: RemoteViewportMode,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  if (mode === 'desktop') return { width: 1_280, height: 800 };
  return {
    width: Math.max(320, Math.min(1_920, Math.round(width))),
    height: Math.max(240, Math.min(1_200, Math.round(height))),
  };
}
