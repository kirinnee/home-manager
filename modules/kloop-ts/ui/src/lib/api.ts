// Minimal fetch wrapper over the `kloop serve` JSON API (all under /api/kloop/*).
import type { ConfigEditResult, ConfigResponse, RunDetail, RunListItem, RunSessionsResponse } from '../types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const api = {
  listRuns: () => get<RunListItem[]>('/kloop/runs'),
  runDetail: (id: string) => get<RunDetail>(`/kloop/runs/${encodeURIComponent(id)}`),
  runSessions: (id: string) => get<RunSessionsResponse>(`/kloop/runs/${encodeURIComponent(id)}/sessions`),
  readFile: async (rel: string): Promise<string> => {
    const r = await get<{ content: string | null }>(`/kloop/file?path=${encodeURIComponent(rel)}`);
    return r.content ?? '';
  },
  listDir: (rel: string) => get<string[]>(`/kloop/dir?path=${encodeURIComponent(rel)}`),
  getConfig: () => get<ConfigResponse>('/kloop/config'),
  putConfig: async (body: {
    yaml?: string;
    patch?: Record<string, unknown>;
    note?: string;
  }): Promise<ConfigEditResult> => {
    const res = await fetch('/api/kloop/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ConfigEditResult;
  },
};
