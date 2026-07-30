import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient } from './api-client';
import type { SessionView } from './service';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const view = {
  directory: '/tmp/kteam/ms-child',
  config: {
    id: 'ms-child',
    name: 'child',
    binary: 'claude-auto-loge',
    harness: 'claude',
    modelHint: 'Fable',
    mode: 'auto',
    parent: 'ms-top',
    boardAccess: 'worker',
    cwd: '/tmp',
    createdAt: new Date().toISOString(),
  },
  state: { id: 'ms-child', status: 'running', turn: 1 },
} as unknown as SessionView;

describe('ApiClient board-access start recovery', () => {
  test('keeps the capability header-only and replays the exact durable grant intent after a lost response', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let failures = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      // Exhaust the normal request's three socket attempts and the explicit
      // recovery POST's three attempts. The by-request lookup then finds the
      // already-persisted child, and the client must repair/replay the grant.
      if (failures < 6) {
        failures += 1;
        throw new TypeError('socket reset after daemon applied request');
      }
      if (String(url).includes('/v1/sessions/by-request/')) {
        return Response.json(view);
      }
      if (String(url).endsWith('/v1/task-board/child-grants/request')) {
        return Response.json({ status: 'approved' });
      }
      throw new Error(`unexpected request ${String(url)}`);
    }) as typeof fetch;

    const client = new (ApiClient as unknown as new (baseUrl: string, token: string) => ApiClient)(
      'http://daemon.test',
      'shared-token',
    );
    const input = {
      prompt: 'work',
      agent: 'claude-auto-loge',
      mode: 'auto' as const,
      parent: 'ms-top',
      boardAccess: 'worker' as const,
    };
    const payloadHash = Bun.hash(JSON.stringify(input)).toString(16);
    const result = await client.start(input, 'start-1', 'top-binding-secret');
    expect(result.config.id).toBe('ms-child');

    const startCalls = calls.filter(call => call.url.endsWith('/v1/sessions'));
    expect(startCalls).toHaveLength(6);
    for (const call of startCalls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get('x-kteam-request-id')).toBe('start-1');
      expect(headers.get('x-kteam-board-capability')).toBe('top-binding-secret');
      expect(String(call.init?.body)).not.toContain('top-binding-secret');
    }
    const grantCall = calls.at(-1)!;
    expect(grantCall.url).toEndWith('/v1/task-board/child-grants/request');
    const grantHeaders = new Headers(grantCall.init?.headers);
    expect(grantHeaders.get('x-kteam-request-id')).toBe(`start-1:board-access:${payloadHash}`);
    expect(grantHeaders.get('x-kteam-board-capability')).toBe('top-binding-secret');
    expect(JSON.parse(String(grantCall.init?.body))).toEqual({ targetSessionId: 'ms-child', role: 'worker' });
  });

  test('refuses a non-none start before transport when its binding secret is absent', async () => {
    const client = new (ApiClient as unknown as new (baseUrl: string, token: string) => ApiClient)(
      'http://daemon.test',
      'shared-token',
    );
    await expect(
      client.start(
        { prompt: 'work', agent: 'claude-auto-loge', mode: 'auto', parent: 'ms-top', boardAccess: 'read' },
        'start-no-secret',
      ),
    ).rejects.toThrow(/requires the calling session board capability/);
  });
});
