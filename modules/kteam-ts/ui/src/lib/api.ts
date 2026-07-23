// Minimal fetch wrapper around the daemon's /v1 API. Token is pulled from
// window.__KTEAM_TOKEN__ once at boot (the daemon substitutes the real value
// for loopback clients and an empty string otherwise — we surface the empty
// case as a read-only banner and gate every mutating call on token presence).

import type {
  SessionView,
  ChatHistoryPage,
  KTeamEvent,
  WardenStatusView,
  WrapperInfo,
  ProjectInfo,
  StartSessionPayload,
  WardenVerdict,
} from '../types';

declare global {
  interface Window {
    __KTEAM_TOKEN__: string;
  }
}

// `?? ''` also covers a page served BEFORE the daemon's substitution fix
// (where the global itself was renamed) — undefined must read as no-token,
// never as the string "undefined".
export const TOKEN = typeof window !== 'undefined' ? (window.__KTEAM_TOKEN__ ?? '') : '';
export const HAS_TOKEN = TOKEN.length > 0;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// A 401 while we HOLD a token means the token is stale (page served across a
// daemon token change or the old substitution bug) — a fresh page load embeds
// the current one. Reload ONCE per tab session; the guard prevents loops when
// the daemon genuinely rejects us.
function recoverFromStaleToken(): void {
  if (typeof window === 'undefined' || !HAS_TOKEN) return;
  if (sessionStorage.getItem('kteam-token-reload') === '1') return;
  sessionStorage.setItem('kteam-token-reload', '1');
  window.location.reload();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  // Idempotency: every mutation carries an x-kteam-request-id so the daemon
  // dedupes retries/double-fires of the SAME logical call (see api-server
  // DEDUPED_ACTIONS). Callers reuse one id across a logical action by setting
  // the header in `init`; otherwise a fresh id is minted per call.
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !headers.has('x-kteam-request-id')) {
    headers.set('x-kteam-request-id', crypto.randomUUID());
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) recoverFromStaleToken();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  // Any success re-arms the one-shot stale-token recovery.
  if (typeof window !== 'undefined') sessionStorage.removeItem('kteam-token-reload');
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
  wardenStatus: () => request<WardenStatusView>('/v1/warden/status'),
  wardenVerdicts: () => request<WardenVerdict[]>('/v1/warden/verdicts'),
  wardenReport: (path: string) => request<string>(`/v1/warden/report?path=${encodeURIComponent(path)}`),
  wrappers: () => request<WrapperInfo[]>('/v1/wrappers'),
  projects: () => request<ProjectInfo[]>('/v1/projects'),
  createSession: (payload: StartSessionPayload) =>
    request<SessionView>('/v1/sessions', { method: 'POST', body: JSON.stringify(payload) }),
  replay: (id: string, after: number, limit = 200) => {
    const qs = `after=${after}&limit=${limit}`;
    return request<{ events: KTeamEvent[]; latest: number }>(
      `/v1/sessions/${encodeURIComponent(id)}/events?${qs}`,
    ).then(r => r.events ?? []);
  },
};
