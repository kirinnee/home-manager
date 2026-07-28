import { afterEach, describe, expect, test } from 'bun:test';
import {
  BrowserApi,
  browserWardenDenial,
  isBrowserPath,
  isBrowserStreamPath,
  matchBrowserRoute,
  parseBrowserAction,
} from './browser-api';
import { BrowserService, type ManagedBrowserRuntime } from './browser-service';
import { createPaths } from './paths';
import type { BrowserInputEvent, BrowserScreencastFrame, BrowserViewport } from './browser-types';

const SID = 'ms3moxcz-352c6078';

class Runtime implements ManagedBrowserRuntime {
  viewport: BrowserViewport = { width: 1280, height: 800 };
  calls: string[] = [];
  async resize(viewport: BrowserViewport) {
    this.viewport = viewport;
  }
  async navigate(url: string) {
    this.calls.push(`navigate:${url}`);
    return { url, title: 'title' };
  }
  async click(selector: string) {
    this.calls.push(`click:${selector}`);
    return { url: 'https://example.test/', title: 'title' };
  }
  async type(selector: string, text: string) {
    this.calls.push(`type:${selector}:${text}`);
    return { url: 'https://example.test/', title: 'title' };
  }
  async read() {
    return { url: 'https://example.test/', title: 'title', text: 'page' };
  }
  async screenshot() {
    return { url: 'https://example.test/', title: 'title', screenshotBase64: 'cG5n' };
  }
  async back() {
    return { url: 'https://example.test/old', title: 'old' };
  }
  async forward() {
    this.calls.push('forward');
    return { url: 'https://example.test/new', title: 'new' };
  }
  async reload() {
    this.calls.push('reload');
    return { url: 'https://example.test/reloaded', title: 'reloaded' };
  }
  async location() {
    return { url: 'about:blank', title: '' };
  }
  async startScreencast(_listener: (frame: BrowserScreencastFrame) => void) {}
  async stopScreencast() {}
  async dispatchInput(_input: BrowserInputEvent) {}
  async close() {}
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
  });

  test('rejects malformed actions and oversized selectors', () => {
    expect(() => parseBrowserAction({ action: 'click' })).toThrow(/selector/);
    expect(() => parseBrowserAction({ action: 'click', selector: 'x'.repeat(5_000) })).toThrow(/too long/);
    expect(() => parseBrowserAction({ action: 'human-activity', kind: 'text' })).toThrow(/pointer/);
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
