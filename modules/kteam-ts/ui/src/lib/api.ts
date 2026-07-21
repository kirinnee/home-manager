// Minimal fetch wrapper around the daemon's /v1 API. Token is pulled from
// window.__KTEAM_TOKEN__ once at boot (the daemon substitutes the real value
// for loopback clients and an empty string otherwise — we surface the empty
// case as a read-only banner and gate every mutating call on token presence).

import type { SessionView, ChatHistoryPage, KTeamEvent } from '../types';

declare global {
  interface Window {
    __KTEAM_TOKEN__: string;
  }
}

export const TOKEN = typeof window !== 'undefined' ? (window.__KTEAM_TOKEN__ ?? '') : '';
export const HAS_TOKEN = TOKEN.length > 0;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? ((await res.json()) as T) : ((await res.text()) as unknown as T);
}

export const api = {
  listSessions: () => request<SessionView[]>('/v1/sessions'),
  getSession: (id: string) => request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}`),
  chatHistory: (id: string, before?: number, limit = 200) => {
    const qs = new URLSearchParams();
    if (before != null) qs.set('before', String(before));
    qs.set('limit', String(limit));
    return request<ChatHistoryPage>(`/v1/sessions/${encodeURIComponent(id)}/chat?${qs}`);
  },
  snapshot: (id: string, live = false) =>
    request<string>(`/v1/sessions/${encodeURIComponent(id)}/snapshot${live ? '?live=true' : ''}`),
  send: (id: string, message: string, now = false) =>
    request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      body: JSON.stringify({ message, now }),
    }),
  answer: (id: string, payload: { labels?: string[]; other?: string; responses?: string[] }) =>
    request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  interrupt: (id: string) =>
    request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}/interrupt`, {
      method: 'POST',
      body: '{}',
    }),
  stop: (id: string, reason: string) =>
    request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  resume: (id: string, message?: string) =>
    request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      body: JSON.stringify(message ? { message } : {}),
    }),
  replay: (id: string, after: number, limit = 200) => {
    const qs = `after=${after}&limit=${limit}`;
    return request<{ events: KTeamEvent[]; latest: number }>(
      `/v1/sessions/${encodeURIComponent(id)}/events?${qs}`,
    ).then(r => r.events ?? []);
  },
};
