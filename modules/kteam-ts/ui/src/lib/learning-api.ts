// Learning API client. Deliberately SEPARATE from ui/src/lib/api.ts (owned by
// another teammate this cycle): it reuses the exported TOKEN/HAS_TOKEN/ApiError
// from that module but has its own tiny request wrapper, so the Learning slice
// adds nothing to the shared api surface.

import { TOKEN, HAS_TOKEN, ApiError } from './api';
import type { LearningStatusView, ProposalState, ProposalView, RunManifest } from './learning-types';

export { HAS_TOKEN };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !headers.has('x-kteam-request-id')) {
    headers.set('x-kteam-request-id', crypto.randomUUID());
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface LearningActionPayload {
  action: 'accept' | 'reject' | 'edit';
  ruleText?: string;
  note?: string;
}

export const learningApi = {
  status: () => req<LearningStatusView>('/v1/learning/status'),
  proposals: (state?: ProposalState) =>
    req<ProposalView[]>(`/v1/learning/proposals${state ? `?state=${encodeURIComponent(state)}` : ''}`),
  act: (id: string, payload: LearningActionPayload) =>
    req<ProposalView>(`/v1/learning/proposals/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  patch: (id: string) =>
    req<{ path: string; contents: string }>(`/v1/learning/proposals/${encodeURIComponent(id)}/patch`, {
      method: 'POST',
      body: '{}',
    }),
  run: (spawn = false) => req<RunManifest>('/v1/learning/run', { method: 'POST', body: JSON.stringify({ spawn }) }),
};
