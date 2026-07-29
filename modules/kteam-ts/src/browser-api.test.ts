import { afterEach, describe, expect, test } from 'bun:test';
import {
  BrowserApi,
  BrowserLoginApi,
  browserWardenDenial,
  isBrowserLoginPath,
  isBrowserPath,
  isBrowserStreamPath,
  matchBrowserRoute,
  parseBrowserAction,
  parseBrowserLoginAction,
  type BrowserLoginLifecycle,
  type BrowserLoginStatusView,
} from './browser-api';
import { BrowserService, type ManagedBrowserRuntime } from './browser-service';
import { createPaths } from './paths';
import { BrowserError } from './browser-types';
import type {
  BrowserInputEvent,
  BrowserPageActionSnapshot,
  BrowserPageSnapshot,
  BrowserScreencastFrame,
  BrowserViewport,
} from './browser-types';

const SID = 'ms3moxcz-352c6078';

function pageSnapshot(url: string, title: string): BrowserPageSnapshot {
  return {
    url,
    title,
    pages: [{ id: 'page_1', url, title }],
    activePageId: 'page_1',
    pageState: 'ready',
    canGoBack: false,
    canGoForward: false,
  };
}

function pageActionSnapshot(url: string, title: string): BrowserPageActionSnapshot {
  return { ...pageSnapshot(url, title), actedPageId: 'page_1' };
}

class Runtime implements ManagedBrowserRuntime {
  viewport: BrowserViewport = { width: 1280, height: 800 };
  calls: string[] = [];
  async resize(viewport: BrowserViewport) {
    this.viewport = viewport;
    return pageActionSnapshot('about:blank', '');
  }
  async navigate(url: string) {
    this.calls.push(`navigate:${url}`);
    return pageActionSnapshot(url, 'title');
  }
  async click(selector: string) {
    this.calls.push(`click:${selector}`);
    return pageActionSnapshot('https://example.test/', 'title');
  }
  async type(selector: string, text: string) {
    this.calls.push(`type:${selector}:${text}`);
    return pageActionSnapshot('https://example.test/', 'title');
  }
  async read() {
    return { ...pageActionSnapshot('https://example.test/', 'title'), text: 'page' };
  }
  async screenshot() {
    return { ...pageActionSnapshot('https://example.test/', 'title'), screenshotBase64: 'cG5n' };
  }
  async back() {
    return pageActionSnapshot('https://example.test/old', 'old');
  }
  async forward() {
    this.calls.push('forward');
    return pageActionSnapshot('https://example.test/new', 'new');
  }
  async reload() {
    this.calls.push('reload');
    return pageActionSnapshot('https://example.test/reloaded', 'reloaded');
  }
  async newPage(url?: string) {
    return pageActionSnapshot(url ?? 'about:blank', '');
  }
  async activatePage(_pageId: string) {
    return pageActionSnapshot('https://example.test/', 'title');
  }
  async closePage(_pageId: string) {
    return pageActionSnapshot('https://example.test/', 'title');
  }
  async location() {
    return pageSnapshot('about:blank', '');
  }
  async startScreencast(_listener: (frame: BrowserScreencastFrame) => void) {}
  async stopScreencast() {}
  async dispatchInput(_input: BrowserInputEvent) {}
  async close() {}
}

/** Stands in for browser-login.ts. It implements the seam STRUCTURALLY and
 * imports nothing from it, which is the point of the seam: the route is
 * testable with no Chrome, no x11vnc, and no lease. */
class Lifecycle implements BrowserLoginLifecycle {
  calls: string[] = [];
  view: BrowserLoginStatusView = { state: 'closed', profilePrimed: false };
  async status() {
    this.calls.push('status');
    return this.view;
  }
  async start(options: { minutes?: number }) {
    this.calls.push(`start:${options.minutes ?? 'default'}`);
    return {
      state: 'open' as const,
      profilePrimed: false,
      openedAt: '2026-07-28T23:10:00.000Z',
      expiresAt: '2026-07-28T23:25:00.000Z',
      connection: {
        host: '127.0.0.1',
        port: 5951,
        password: 'Sq7fXk2p',
        sshTunnel: 'ssh -N -L 5951:127.0.0.1:5951 kirin@box',
      },
    };
  }
  async stop(options: { primed?: boolean }) {
    this.calls.push(`stop:${options.primed === undefined ? 'default' : options.primed}`);
    return { state: 'closed' as const, profilePrimed: options.primed === true };
  }
  async confirm() {
    this.calls.push('confirm');
    return { ...this.view, profilePrimed: true };
  }
}

let service: BrowserService | undefined;

function harness() {
  const runtime = new Runtime();
  service = new BrowserService(
    createPaths('/tmp/kteam-browser-api-test'),
    { resolve: async ref => (ref === SID || ref === 'self' ? SID : undefined) },
    { runtimeFactory: async () => runtime },
  );
  return { api: new BrowserApi(service), runtime };
}

afterEach(async () => {
  await service?.close();
  service = undefined;
});

const url = (pathname: string) => new URL(`http://daemon${pathname}`);

describe('browser routing and warden gate', () => {
  test('matches API and screencast routes but nothing adjacent', () => {
    expect(isBrowserPath(`/v1/sessions/${SID}/browser`)).toBe(true);
    expect(isBrowserStreamPath(`/v1/sessions/${SID}/browser/stream`)).toBe(true);
    expect(matchBrowserRoute(`/v1/sessions/${SID}/browser`)).toEqual({ kind: 'api', sessionId: SID });
    expect(matchBrowserRoute(`/v1/sessions/${SID}/browser/stream`)).toEqual({ kind: 'stream', sessionId: SID });
    expect(matchBrowserRoute(`/v1/sessions/${SID}/send`)).toBeNull();
    expect(matchBrowserRoute('/v1/sessions/..%2Fevil/browser')).toBeNull();
  });

  test('warden is denied for reads, writes, and the WebSocket upgrade path', () => {
    expect(browserWardenDenial('GET', `/v1/sessions/${SID}/browser`)).toBe('use the session browser');
    expect(browserWardenDenial('POST', `/v1/sessions/${SID}/browser`)).toBe('use the session browser');
    expect(browserWardenDenial('GET', `/v1/sessions/${SID}/browser/stream`)).toBe('use the session browser');
    expect(browserWardenDenial('GET', '/v1/health')).toBeNull();
  });

  // THE REGRESSION TEST FOR A LIVE GAP. `/v1/browser/login` is a TOP-LEVEL
  // path, so it never matched `isBrowserPath`, and api-server's warden gate
  // ends in a generic "every other GET is fine" allowance. Before this denial
  // existed, a warden-scoped token could GET the window's live VNC port and
  // its password. GET is the whole secret here; POST already fell to the
  // catch-all.
  test('warden is denied the daemon-global login window, GET most of all', () => {
    expect(browserWardenDenial('GET', '/v1/browser/login')).toBe('use the human browser login window');
    expect(browserWardenDenial('POST', '/v1/browser/login')).toBe('use the human browser login window');
    expect(browserWardenDenial('GET', '/v1/browser/login/')).toBe('use the human browser login window');
    expect(isBrowserLoginPath('/v1/browser/login')).toBe(true);
  });

  // ANCHORED, not a prefix land-grab. The denial is a statement about one
  // route; it must not silently swallow neighbours nobody has designed yet.
  test('the login denial does not swallow adjacent paths', () => {
    expect(browserWardenDenial('GET', '/v1/browser')).toBeNull();
    expect(browserWardenDenial('GET', '/v1/browser/loginx')).toBeNull();
    expect(browserWardenDenial('GET', '/v1/browser/login/extra')).toBeNull();
    expect(isBrowserLoginPath('/v1/browser/loginx')).toBe(false);
    // ...and the login path is not mistaken for a session browser route, which
    // would send it to BrowserApi and a session lookup that cannot exist.
    expect(isBrowserPath('/v1/browser/login')).toBe(false);
    expect(matchBrowserRoute('/v1/browser/login')).toBeNull();
  });
});

describe('action parsing', () => {
  test('accepts required lifecycle, Playwright, resize, and provenance actions', () => {
    expect(parseBrowserAction({ action: 'click', selector: '#go' })).toEqual({ action: 'click', selector: '#go' });
    expect(parseBrowserAction({ action: 'type', selector: '#password', text: '' })).toEqual({
      action: 'type',
      selector: '#password',
      text: '',
    });
    expect(parseBrowserAction({ action: 'resize', width: 800, height: 600 })).toEqual({
      action: 'resize',
      width: 800,
      height: 600,
    });
    expect(parseBrowserAction({ action: 'open', url: 'example.test' })).toEqual({
      action: 'open',
      url: 'example.test',
    });
    expect(parseBrowserAction({ action: 'forward' })).toEqual({ action: 'forward' });
    expect(parseBrowserAction({ action: 'reload' })).toEqual({ action: 'reload' });
    expect(parseBrowserAction({ action: 'new-page', url: 'example.test/docs' })).toEqual({
      action: 'new-page',
      url: 'https://example.test/docs',
    });
    expect(parseBrowserAction({ action: 'new-page' })).toEqual({ action: 'new-page' });
    expect(parseBrowserAction({ action: 'activate-page', pageId: 'page_123' })).toEqual({
      action: 'activate-page',
      pageId: 'page_123',
    });
    expect(parseBrowserAction({ action: 'close-page', pageId: 'page_123' })).toEqual({
      action: 'close-page',
      pageId: 'page_123',
    });
  });

  test('rejects malformed actions and oversized selectors', () => {
    expect(() => parseBrowserAction({ action: 'click' })).toThrow(/selector/);
    expect(() => parseBrowserAction({ action: 'click', selector: 'x'.repeat(5_000) })).toThrow(/too long/);
    expect(() => parseBrowserAction({ action: 'human-activity', kind: 'text' })).toThrow(/pointer/);
    expect(() => parseBrowserAction({ action: 'new-page', url: 'file:///tmp/private' })).toThrow(/HTTP\(S\)/);
    expect(() => parseBrowserAction({ action: 'new-page', url: 'x'.repeat(200_001) })).toThrow(/too long/);
    expect(() => parseBrowserAction({ action: 'activate-page', pageId: '' })).toThrow(/pageId/);
    expect(() => parseBrowserAction({ action: 'activate-page', pageId: 123 })).toThrow(/pageId/);
    expect(() => parseBrowserAction({ action: 'close-page', pageId: 'x'.repeat(129) })).toThrow(/too long/);
  });
});

describe('server-resolved ownership and idempotency', () => {
  test('owning peer may act; a different peer and a warden may not', async () => {
    const { api } = harness();
    const own = await api.handle({
      method: 'POST',
      url: url('/v1/sessions/self/browser'),
      body: { action: 'start' },
      actor: `peer:${SID}`,
    });
    expect(own?.status).toBe(200);

    const cross = await api.handle({
      method: 'GET',
      url: url(`/v1/sessions/${SID}/browser`),
      actor: 'peer:someone-else',
    });
    expect(cross).toMatchObject({ status: 403, body: { code: 'forbidden' } });

    const warden = await api.handle({
      method: 'GET',
      url: url(`/v1/sessions/${SID}/browser`),
      actor: `warden:${SID}`,
    });
    expect(warden).toMatchObject({ status: 403, body: { code: 'forbidden' } });
  });

  test('preauthorizes a stream only for a human admin and returns the canonical id', async () => {
    const { api } = harness();
    await expect(api.authorizeStream('self', 'admin-ui')).resolves.toBe(SID);
    await expect(api.authorizeStream(SID, `peer:${SID}`)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(api.authorizeStream(SID, `warden:${SID}`)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  test('same request id and body applies a Playwright mutation once', async () => {
    const { api, runtime } = harness();
    await api.handle({
      method: 'POST',
      url: url(`/v1/sessions/${SID}/browser`),
      body: { action: 'start' },
      actor: 'admin-ui',
    });
    const request = {
      method: 'POST',
      url: url(`/v1/sessions/${SID}/browser`),
      body: { action: 'click', selector: '#once' },
      actor: `peer:${SID}` as const,
      requestId: 'request-1',
    };
    await api.handle(request);
    await api.handle(request);
    expect(runtime.calls.filter(call => call === 'click:#once')).toHaveLength(1);
  });

  test('login route rejects a peer holding the shared admin bearer', async () => {
    // The warden gate never sees this caller: a `peer:<id>` presents the SAME
    // admin token the human does and is separated only by the server-resolved
    // actor. That is what this second layer is for.
    const api = new BrowserLoginApi(new Lifecycle());
    for (const actor of [`peer:${SID}`, `warden:${SID}`, 'warden'] as const) {
      expect(await api.handle({ method: 'GET', actor })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
      expect(await api.handle({ method: 'POST', body: { action: 'start' }, actor })).toMatchObject({
        status: 403,
        body: { code: 'forbidden' },
      });
      expect(await api.handle({ method: 'POST', body: { action: 'stop' }, actor })).toMatchObject({ status: 403 });
    }
    // An unauthenticated/absent actor is refused too, rather than defaulting in.
    expect(await api.handle({ method: 'GET' })).toMatchObject({ status: 403 });
  });

  test('human activity provenance cannot be spoofed by an agent body', async () => {
    const { api } = harness();
    await api.handle({
      method: 'POST',
      url: url(`/v1/sessions/${SID}/browser`),
      body: { action: 'start' },
      actor: 'admin-ui',
    });
    const response = await api.handle({
      method: 'POST',
      url: url(`/v1/sessions/${SID}/browser`),
      body: { action: 'human-activity', kind: 'keyboard' },
      actor: `peer:${SID}`,
    });
    expect(response?.status).toBe(403);
  });
});

describe('human login window route', () => {
  test('parses the three actions and refuses anything else', () => {
    expect(parseBrowserLoginAction({ action: 'start' })).toEqual({ action: 'start' });
    expect(parseBrowserLoginAction({ action: 'start', minutes: 30 })).toEqual({ action: 'start', minutes: 30 });
    expect(parseBrowserLoginAction({ action: 'stop' })).toEqual({ action: 'stop' });
    expect(parseBrowserLoginAction({ action: 'stop', primed: true })).toEqual({ action: 'stop', primed: true });
    expect(parseBrowserLoginAction({ action: 'confirm' })).toEqual({ action: 'confirm' });
    expect(() => parseBrowserLoginAction({ action: 'restart' })).toThrow(/start, stop, or confirm/);
    expect(() => parseBrowserLoginAction({})).toThrow(/start, stop, or confirm/);
  });

  test('bounds the deadline instead of trusting the caller', () => {
    for (const minutes of [0, -5, 61, 1.5, '30', null]) {
      expect(() => parseBrowserLoginAction({ action: 'start', minutes })).toThrow(/between 1 and 60/);
    }
    expect(parseBrowserLoginAction({ action: 'start', minutes: 1 })).toEqual({ action: 'start', minutes: 1 });
    expect(parseBrowserLoginAction({ action: 'start', minutes: 60 })).toEqual({ action: 'start', minutes: 60 });
    expect(() => parseBrowserLoginAction({ action: 'stop', primed: 'yes' })).toThrow(/primed must be a boolean/);
  });

  test('a human admin drives every action, and priming rides on stop', async () => {
    const lifecycle = new Lifecycle();
    const api = new BrowserLoginApi(lifecycle);
    for (const actor of ['admin-ui', 'admin-cli'] as const) {
      expect(await api.handle({ method: 'GET', actor })).toMatchObject({ status: 200 });
    }
    const started = await api.handle({ method: 'POST', body: { action: 'start', minutes: 5 }, actor: 'admin-cli' });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ state: 'open', connection: { port: 5951 } });

    // markPrimed() requires the lease, which only the open window holds — so
    // priming is an argument to stop, never a later call.
    expect(
      await api.handle({ method: 'POST', body: { action: 'stop', primed: true }, actor: 'admin-ui' }),
    ).toMatchObject({ status: 200, body: { profilePrimed: true } });
    expect(await api.handle({ method: 'POST', body: { action: 'confirm' }, actor: 'admin-ui' })).toMatchObject({
      status: 200,
      body: { profilePrimed: true },
    });
    expect(lifecycle.calls).toEqual(['status', 'status', 'start:5', 'stop:true', 'confirm']);
  });

  test('a bare stop leaves priming alone and unknown methods are refused', async () => {
    const lifecycle = new Lifecycle();
    const api = new BrowserLoginApi(lifecycle);
    expect(await api.handle({ method: 'POST', body: { action: 'stop' }, actor: 'admin-cli' })).toMatchObject({
      body: { profilePrimed: false },
    });
    expect(lifecycle.calls).toEqual(['stop:default']);
    expect(await api.handle({ method: 'DELETE', actor: 'admin-cli' })).toMatchObject({ status: 405 });
  });

  test('a closed window reports no connection, no deadline, and no password', async () => {
    const api = new BrowserLoginApi(new Lifecycle());
    const closed = await api.handle({ method: 'GET', actor: 'admin-ui' });
    expect(closed.body).toEqual({ state: 'closed', profilePrimed: false });
    // Assert on the PARSED object: absence must be absence, not a zeroed port
    // or a stale countdown a client would happily render.
    const body = closed.body as Record<string, unknown>;
    expect(body['connection']).toBeUndefined();
    expect(body['expiresAt']).toBeUndefined();
    expect(Object.keys(body)).toEqual(['state', 'profilePrimed']);
  });

  test('a lifecycle failure is surfaced verbatim, never downgraded', async () => {
    const lifecycle = new Lifecycle();
    // profile_busy means a session browser holds the shared lease. Falling back
    // to an ephemeral profile here would silently sign the human into a profile
    // that is then thrown away — the worst outcome in this design.
    lifecycle.start = async () => {
      throw new BrowserError('profile_busy', 'the shared browser profile is in use', 409);
    };
    const api = new BrowserLoginApi(lifecycle);
    expect(await api.handle({ method: 'POST', body: { action: 'start' }, actor: 'admin-cli' })).toEqual({
      status: 409,
      body: { error: 'the shared browser profile is in use', code: 'profile_busy' },
    });
  });

  // Every code browser-login.ts raises must arrive at the client as ITSELF.
  // Flattening these to one generic 500 — or worse, to a cheerful "closed" —
  // is the failure the house rules name: a 503 shown as a stopped browser
  // teaches the human to trust something that is lying.
  test('every lifecycle error code and status reaches the client unflattened', async () => {
    const cases = [
      { code: 'launch_failed', status: 503, message: 'x11vnc did not come up', action: 'start' },
      { code: 'not_running', status: 409, message: 'no login window is open', action: 'confirm' },
      { code: 'bad_request', status: 400, message: 'minutes must be a whole number', action: 'start' },
      { code: 'profile_busy', status: 409, message: 'the shared profile is held', action: 'stop' },
    ] as const;
    for (const { code, status, message, action } of cases) {
      const lifecycle = new Lifecycle();
      const raise = async () => {
        throw new BrowserError(code, message, status);
      };
      lifecycle.start = raise;
      lifecycle.stop = raise;
      lifecycle.confirm = raise;
      const response = await new BrowserLoginApi(lifecycle).handle({
        method: 'POST',
        body: { action },
        actor: 'admin-cli',
      });
      expect(response).toEqual({ status, body: { error: message, code } });
    }
  });
});
