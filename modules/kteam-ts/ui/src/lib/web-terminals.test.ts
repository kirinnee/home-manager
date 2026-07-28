import { afterEach, describe, expect, test } from 'bun:test';
import { terminalLimitLabel, webTerminalApi, webTerminalStreamUrl, type WebTerminalList } from './web-terminals';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const list: WebTerminalList = {
  sessionId: 'ms-test',
  terminals: [],
  limits: { perSession: 6, global: 24, runningGlobal: 3, idleTimeoutSeconds: 3600, scrollbackLines: 5000 },
};

describe('web terminal client', () => {
  test('builds the same-origin authenticated WebSocket route', () => {
    const location = { protocol: 'https:', host: 'kteam.example.test' } as Location;
    expect(webTerminalStreamUrl('ms/a', '012345abcdef', location)).toBe(
      'wss://kteam.example.test/v1/sessions/ms%2Fa/terminals/012345abcdef/stream',
    );
  });

  test('reports both lifecycle caps without hiding the fleet cost', () => {
    expect(terminalLimitLabel(list)).toBe('0/6 in this session · 3/24 on this box');
  });

  test('uses collection and item routes with mutation request ids', async () => {
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push(new Request(new URL(String(input), 'http://daemon'), init));
      return new Response(JSON.stringify(requests.length === 1 ? list : { closed: true, id: '012345abcdef' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await webTerminalApi.list('ms-test');
    await webTerminalApi.close('ms-test', '012345abcdef');
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/sessions/ms-test/terminals');
    expect(requests[0]!.method).toBe('GET');
    expect(new URL(requests[1]!.url).pathname).toBe('/v1/sessions/ms-test/terminals/012345abcdef');
    expect(requests[1]!.method).toBe('DELETE');
    expect(requests[1]!.headers.get('x-kteam-request-id')).toBeTruthy();
  });
});
