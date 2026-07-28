import { describe, expect, test } from 'bun:test';
import { matchTerminalRoute, terminalWardenDenial, TerminalApi } from './terminal-api';
import type { TerminalService } from './terminal-service';

const terminalId = '012345abcdef';

function request(path: string, method = 'GET', body?: unknown, actor = 'admin-ui' as const) {
  return { method, url: new URL(`http://daemon${path}`), body, actor };
}

function fixture() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const terminal = {
    id: terminalId,
    sessionId: 'ms-test',
    title: 'Terminal 1',
    state: 'running' as const,
    cols: 80,
    rows: 24,
    viewers: 0,
    createdAt: new Date(0).toISOString(),
    lastActivityAt: new Date(0).toISOString(),
  };
  const service = {
    resolveSession: async (ref: string) => {
      calls.push({ method: 'resolve', args: [ref] });
      return { id: 'ms-test', cwd: '/repo' };
    },
    list: async (...args: unknown[]) => {
      calls.push({ method: 'list', args });
      return {
        sessionId: 'ms-test',
        terminals: [terminal],
        limits: { perSession: 6, global: 24, runningGlobal: 1, idleTimeoutSeconds: 3600, scrollbackLines: 5000 },
      };
    },
    create: async (...args: unknown[]) => {
      calls.push({ method: 'create', args });
      return terminal;
    },
    get: async (...args: unknown[]) => {
      calls.push({ method: 'get', args });
      return terminal;
    },
    rename: async (...args: unknown[]) => {
      calls.push({ method: 'rename', args });
      return { ...terminal, title: String(args[2]) };
    },
    closeTerminal: async (...args: unknown[]) => {
      calls.push({ method: 'close', args });
    },
  } as unknown as TerminalService;
  return { api: new TerminalApi(service), calls };
}

describe('terminal routes and authorization', () => {
  test('matches only safe collection, item, and stream routes', () => {
    expect(matchTerminalRoute('/v1/sessions/ms-test/terminals')).toEqual({ kind: 'collection', sessionId: 'ms-test' });
    expect(matchTerminalRoute(`/v1/sessions/ms-test/terminals/${terminalId}`)).toEqual({
      kind: 'terminal',
      sessionId: 'ms-test',
      terminalId,
    });
    expect(matchTerminalRoute(`/v1/sessions/ms-test/terminals/${terminalId}/stream`)).toEqual({
      kind: 'stream',
      sessionId: 'ms-test',
      terminalId,
    });
    expect(matchTerminalRoute('/v1/sessions/..%2Fsecret/terminals')).toBeNull();
    expect(matchTerminalRoute('/v1/sessions/ms-test/terminals/not-an-id')).toBeNull();
  });

  test('denies the entire prefix to warden-scoped callers before generic GET', () => {
    expect(terminalWardenDenial('GET', '/v1/sessions/ms-test/terminals')).toBeTruthy();
    expect(terminalWardenDenial('GET', `/v1/sessions/ms-test/terminals/${terminalId}/stream`)).toBeTruthy();
    expect(terminalWardenDenial('GET', '/v1/sessions/ms-test')).toBeNull();
  });

  test('admin UI can list/create/rename/close and peer-attributed admin-token requests cannot', async () => {
    const { api, calls } = fixture();
    expect((await api.handle(request('/v1/sessions/ms-test/terminals')))?.status).toBe(200);
    expect(
      (await api.handle(request('/v1/sessions/ms-test/terminals', 'POST', { title: 'Logs', cols: 90, rows: 30 })))
        ?.status,
    ).toBe(201);
    expect(
      (await api.handle(request(`/v1/sessions/ms-test/terminals/${terminalId}`, 'PATCH', { title: 'Build' })))?.status,
    ).toBe(200);
    expect((await api.handle(request(`/v1/sessions/ms-test/terminals/${terminalId}`, 'DELETE')))?.body).toEqual({
      closed: true,
      id: terminalId,
    });
    expect(calls.map(call => call.method)).toContain('create');
    expect(calls.map(call => call.method)).toContain('rename');
    expect(calls.map(call => call.method)).toContain('close');

    const peer = await api.handle({
      method: 'GET',
      url: new URL('http://daemon/v1/sessions/ms-test/terminals'),
      actor: 'peer:ms-test',
    });
    expect(peer).toEqual({
      status: 403,
      body: { error: 'interactive shell terminals require the human admin token', code: 'forbidden' },
    });
  });

  test('proves admin authorization and terminal existence before WebSocket upgrade', async () => {
    const { api, calls } = fixture();
    await expect(api.authorizeStream('ms-test', terminalId, 'admin-ui')).resolves.toEqual({
      sessionId: 'ms-test',
      terminalId,
    });
    expect(calls.map(call => call.method)).toContain('get');
    await expect(api.authorizeStream('ms-test', terminalId, 'warden:ms-warden')).rejects.toThrow('human admin token');
  });
});
