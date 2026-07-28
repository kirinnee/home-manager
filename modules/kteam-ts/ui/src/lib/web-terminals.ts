import { ApiError, TOKEN } from './api';

export interface WebTerminal {
  id: string;
  sessionId: string;
  title: string;
  state: 'running';
  cols: number;
  rows: number;
  viewers: number;
  createdAt: string;
  lastActivityAt: string;
  idleDeadline?: string;
}

export interface WebTerminalList {
  sessionId: string;
  terminals: WebTerminal[];
  limits: {
    perSession: number;
    global: number;
    runningGlobal: number;
    idleTimeoutSeconds: number;
    scrollbackLines: number;
  };
}

async function terminalRequest<T>(sessionId: string, suffix = '', init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  if (init?.body) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase())) {
    headers.set('x-kteam-request-id', crypto.randomUUID());
  }
  const response = await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/terminals${suffix}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(response.status, body.error ?? `HTTP ${response.status}`, body.code);
  }
  return (await response.json()) as T;
}

export const webTerminalApi = {
  list: (sessionId: string) => terminalRequest<WebTerminalList>(sessionId),
  create: (sessionId: string, size?: { cols: number; rows: number }) =>
    terminalRequest<WebTerminal>(sessionId, '', {
      method: 'POST',
      body: JSON.stringify(size ?? {}),
    }),
  rename: (sessionId: string, terminalId: string, title: string) =>
    terminalRequest<WebTerminal>(sessionId, `/${encodeURIComponent(terminalId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  close: (sessionId: string, terminalId: string) =>
    terminalRequest<{ closed: true; id: string }>(sessionId, `/${encodeURIComponent(terminalId)}`, {
      method: 'DELETE',
    }),
};

export function webTerminalStreamUrl(
  sessionId: string,
  terminalId: string,
  locationValue: Location = window.location,
): string {
  const protocol = locationValue.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(
    `${protocol}//${locationValue.host}/v1/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/stream`,
  );
  if (TOKEN) url.searchParams.set('token', TOKEN);
  return url.toString();
}

export function terminalLimitLabel(list: WebTerminalList): string {
  const count = list.terminals.length;
  return `${count}/${list.limits.perSession} in this session · ${list.limits.runningGlobal}/${list.limits.global} on this box`;
}
