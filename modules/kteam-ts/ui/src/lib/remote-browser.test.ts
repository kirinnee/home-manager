import { afterEach, describe, expect, test } from 'bun:test';
import { remoteBrowserApi, remoteBrowserStreamUrl, remoteViewportForContainer } from './remote-browser';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('remote browser viewport modes', () => {
  test('responsive follows the pane within the daemon/CDP bounds', () => {
    expect(remoteViewportForContainer(679.6, 742.2, 'responsive')).toEqual({ width: 680, height: 742 });
    expect(remoteViewportForContainer(200, 5_000, 'responsive')).toEqual({ width: 320, height: 1_200 });
  });

  test('desktop fit gives a phone a stable desktop viewport for canvas scaling', () => {
    expect(remoteViewportForContainer(390, 700, 'desktop')).toEqual({ width: 1_280, height: 800 });
  });

  test('ignores hidden/zero-sized retained surfaces', () => {
    expect(remoteViewportForContainer(0, 0, 'responsive')).toBeNull();
  });
});

describe('same-origin browser stream URL', () => {
  test('uses the daemon origin and session-scoped authenticated proxy path', () => {
    const location = { protocol: 'https:', host: 'kteam.example.test' } as Location;
    expect(remoteBrowserStreamUrl('session one', location)).toBe(
      'wss://kteam.example.test/v1/sessions/session%20one/browser/stream',
    );
  });
});

describe('shared browser navigation actions', () => {
  test('posts atomic open-with-URL, forward, and reload actions', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: { state: 'running' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await remoteBrowserApi.open('session one', 'https://example.test/login');
    await remoteBrowserApi.forward('session one');
    await remoteBrowserApi.reload('session one');

    expect(bodies).toEqual([
      { action: 'open', url: 'https://example.test/login' },
      { action: 'forward' },
      { action: 'reload' },
    ]);
  });
});
