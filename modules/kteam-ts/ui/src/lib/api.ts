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
  SearchResponse,
  UsageFeedView,
} from '../types';
import { attachmentApiPath, type AttachmentView } from './attachments';

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
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface RenameSessionPatch {
  name?: string;
  teammate?: string;
  clearParent?: boolean;
}

export interface MigrateSessionTarget {
  agent: string;
  model?: string;
  allowContextDowngrade?: boolean;
}

/** Dedicated native-harness command. It is intentionally separate from send:
 * runtime commands must never queue, revive a terminal session, or become a
 * user-chat record. */
export interface RuntimeSessionAction {
  action: 'model';
  /** Claude's account-validated value. Omit for Codex so its native picker
   * opens and combines the model with supported reasoning effort. */
  model?: string;
}

// NO FULL DOCUMENT LOADS. A 401 used to force a one-shot document reload on
// the theory that a stale embedded token is fixed by re-serving index.html. It
// also threw away the entire client — draft,
// scroll, loaded transcript, socket — for what is an ordinary failed request,
// and it fired on a genuine authorization failure too (the guard only stopped
// the SECOND reload, never the first). Authorization failure is now surfaced
// like any other error: an ApiError the caller renders while the SPA keeps its
// draft, scroll position, transcript, and reconnect loop intact.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  // The browser must own a FormData boundary. Supplying application/json here
  // makes multipart uploads unreadable even though the bytes are present.
  if (init?.body && !(init.body instanceof FormData) && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  // Idempotency: every mutation carries an x-kteam-request-id so the daemon
  // dedupes retries/double-fires of the SAME logical call (see api-server
  // DEDUPED_ACTIONS). Callers reuse one id across a logical action by setting
  // the header in `init`; otherwise a fresh id is minted per call.
  //
  // A per-call mint is a LAST RESORT, not the design. It makes the server's
  // dedupe unreachable for the case it exists for: measured 2026-07-25, a send
  // whose response was lost and which the reader then re-sent arrived twice with
  // two different ids, and the message was delivered to the agent twice (06:09:32
  // and 06:09:38). Any mutation a person can repeat MUST pass its own id — see
  // `api.send`/`api.answer` and SessionChatPage's per-message requestId.
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !headers.has('x-kteam-request-id')) {
    headers.set('x-kteam-request-id', crypto.randomUUID());
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    const fallback =
      res.status === 401
        ? HAS_TOKEN
          ? 'unauthorized — the daemon rejected this page’s credentials'
          : 'unauthorized — this origin was served without a daemon token (read-only)'
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, body.error ?? fallback, body.code);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  if (ct.startsWith('image/')) return (await res.blob()) as T;
  return (await res.text()) as unknown as T;
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
  // `requestId` identifies the LOGICAL message, not this attempt: pass the same
  // one for every delivery of the same message (first try, retry after an error,
  // the interrupt-then-send path) and the daemon applies it exactly once.
  send: (id: string, message: string, now = false, requestId?: string, attachmentIds?: string[]) =>
    request<SessionView & { disposition?: 'delivered' | 'queued' | 'revived' }>(
      `/v1/sessions/${encodeURIComponent(id)}/send`,
      {
        method: 'POST',
        body: JSON.stringify({ message, now, ...(attachmentIds?.length ? { attachmentIds } : {}) }),
        ...(requestId ? { headers: { 'x-kteam-request-id': requestId } } : {}),
      },
    ),
  upload: (id: string, file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<AttachmentView>(`/v1/sessions/${encodeURIComponent(id)}/attachments`, {
      method: 'POST',
      body: form,
    });
  },
  attachment: (id: string, attachmentId: string) => request<Blob>(attachmentApiPath(id, attachmentId)),
  answer: (
    id: string,
    payload: { toolUseId: string; labels?: string[]; other?: string; responses?: string[] },
    requestId?: string,
  ) =>
    request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: JSON.stringify(payload),
      ...(requestId ? { headers: { 'x-kteam-request-id': requestId } } : {}),
    }),
  // An interrupt can be retried after its response is lost. Callers that own
  // that logical action pass one stable id so the daemon applies it once.
  // `toolUseId` binds the interrupt to the structured question the caller has
  // on screen; omit it for the generic "stop what you're doing" interrupt.
  interrupt: (id: string, requestId?: string, toolUseId?: string) =>
    request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}/interrupt`, {
      method: 'POST',
      body: JSON.stringify(toolUseId ? { toolUseId } : {}),
      ...(requestId ? { headers: { 'x-kteam-request-id': requestId } } : {}),
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
  // Both actions are daemon-deduped. The caller must mint one id for the
  // logical gesture and retain it across a retry whose body is unchanged.
  rename: (id: string, patch: RenameSessionPatch, requestId: string) =>
    request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}/rename`, {
      method: 'POST',
      body: JSON.stringify(patch),
      headers: { 'x-kteam-request-id': requestId },
    }),
  migrate: (id: string, target: MigrateSessionTarget, requestId: string) =>
    request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}/migrate`, {
      method: 'POST',
      body: JSON.stringify(target),
      headers: { 'x-kteam-request-id': requestId },
    }),
  // Runtime actions are destructive enough to need caller-owned request ids,
  // but they are NOT chat sends: the daemon refuses a busy pane instead of
  // queueing or reviving it. One fresh id belongs to each user gesture.
  runtime: (id: string, action: RuntimeSessionAction, requestId: string) =>
    request<SessionView>(`/v1/sessions/${encodeURIComponent(id)}/runtime`, {
      method: 'POST',
      body: JSON.stringify(action),
      headers: { 'x-kteam-request-id': requestId },
    }),
  wardenStatus: () => request<WardenStatusView>('/v1/warden/status'),
  wardenVerdicts: () => request<WardenVerdict[]>('/v1/warden/verdicts'),
  wardenReport: (path: string) => request<string>(`/v1/warden/report?path=${encodeURIComponent(path)}`),
  search: (q: string, limit = 30) => request<SearchResponse>(`/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  usage: () => request<UsageFeedView>('/v1/usage'),
  wrappers: () => request<WrapperInfo[]>('/v1/wrappers'),
  projects: () => request<ProjectInfo[]>('/v1/projects'),
  createSession: (payload: StartSessionPayload) =>
    request<SessionView>('/v1/sessions', { method: 'POST', body: JSON.stringify(payload) }),
  replay: (id: string, after: number, limit = 200) => {
    const qs = `after=${after}&limit=${limit}`;
    return request<KTeamEvent[]>(`/v1/sessions/${encodeURIComponent(id)}/events?${qs}`);
  },
};
