import { afterEach, describe, expect, test } from 'bun:test';
import {
  actOnBrowserLogin,
  browserLoginApi,
  browserLoginSnapshotForTest,
  refreshBrowserLogin,
  resetBrowserLoginStore,
} from './browser-login';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetBrowserLoginStore();
});

describe('browser-login API', () => {
  test('uses the daemon-global route and sends explicit close intent', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ state: 'closed', profilePrimed: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await browserLoginApi.status();
    await browserLoginApi.action('stop', { primed: true });

    expect(calls[0]!.url).toBe('/v1/browser/login');
    expect(calls[0]!.init?.method).toBeUndefined();
    expect(calls[1]!.init?.method).toBe('POST');
    expect(calls[1]!.init?.body).toBe(JSON.stringify({ action: 'stop', primed: true }));
  });

  test('immediately refetches authoritative state after an action', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ state: 'open', profilePrimed: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await actOnBrowserLogin('start');

    expect(calls).toHaveLength(2);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[1]!.init?.method).toBeUndefined();
  });

  test('turns a failed poll into unknown rather than pretending the window closed', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await expect(refreshBrowserLogin()).resolves.toEqual({ state: 'unknown', error: 'offline' });
  });

  test('never lets a stale pre-action poll hide an open login window', async () => {
    let releaseStale!: () => void;
    const stale = new Promise<void>(resolve => {
      releaseStale = resolve;
    });
    let calls = 0;
    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        await stale;
        return new Response(JSON.stringify({ state: 'closed', profilePrimed: false }));
      }
      return new Response(
        JSON.stringify({
          state: 'open',
          profilePrimed: false,
          connection: { host: '127.0.0.1', port: 5951, password: 'secret123', sshTunnel: 'ssh tunnel' },
        }),
      );
    }) as typeof fetch;

    const oldPoll = refreshBrowserLogin();
    await actOnBrowserLogin('start');
    expect(browserLoginSnapshotForTest()).toMatchObject({ state: 'open' });
    releaseStale();
    await oldPoll;
    expect(browserLoginSnapshotForTest()).toMatchObject({ state: 'open' });
  });
});
