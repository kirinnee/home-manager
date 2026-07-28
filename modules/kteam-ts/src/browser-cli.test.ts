import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { browserCliRequest, browserScreenshotBytes, parseBrowserCli, renderBrowserCli } from './browser-cli';
import type { BrowserActionResult, BrowserStatusView } from './browser-types';

const SID = 'ms3moxcz-352c6078';
const status: BrowserStatusView = {
  sessionId: SID,
  state: 'running',
  viewport: { width: 1280, height: 800 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 600,
  capacity: { running: 1, maximum: 3 },
  pages: [{ id: 'page_123', url: 'https://example.test/', title: 'Example' }],
  activePageId: 'page_123',
  pageState: 'ready',
  canGoBack: true,
  canGoForward: false,
  agentPage: { kind: 'agent', pageId: 'page_123', action: 'click', at: '2026-07-27T00:00:00.000Z' },
  lastActor: { kind: 'agent', action: 'click', at: '2026-07-27T00:00:00.000Z' },
};

describe('browser CLI parsing', () => {
  test('covers all required agent verbs', () => {
    expect(parseBrowserCli(['open', 'example.com'])).toEqual({ command: 'open', url: 'example.com' });
    expect(parseBrowserCli(['navigate', 'https://example.com'])).toMatchObject({ command: 'navigate' });
    expect(parseBrowserCli(['click', 'button.submit'])).toEqual({ command: 'click', selector: 'button.submit' });
    expect(parseBrowserCli(['type', '#password', 'secret', 'words'])).toEqual({
      command: 'type',
      selector: '#password',
      text: 'secret words',
    });
    expect(parseBrowserCli(['read'])).toEqual({ command: 'read' });
    expect(parseBrowserCli(['screenshot', 'shot.png'])).toEqual({ command: 'screenshot', output: 'shot.png' });
    expect(parseBrowserCli(['back'])).toEqual({ command: 'back' });
    expect(parseBrowserCli(['forward'])).toEqual({ command: 'forward' });
    expect(parseBrowserCli(['reload'])).toEqual({ command: 'reload' });
    expect(parseBrowserCli(['new-page', 'example.com'])).toEqual({ command: 'new-page', url: 'example.com' });
    expect(parseBrowserCli(['new-page'])).toEqual({ command: 'new-page' });
    expect(parseBrowserCli(['activate-page', 'page_123'])).toEqual({ command: 'activate-page', pageId: 'page_123' });
    expect(parseBrowserCli(['close-page', 'page_123'])).toEqual({ command: 'close-page', pageId: 'page_123' });
  });

  test('preserves dash-prefixed typed text after the standard option delimiter', () => {
    expect(parseBrowserCli(['type', '#password', '--', '--secret', 'words'])).toEqual({
      command: 'type',
      selector: '#password',
      text: '--secret words',
    });
  });

  test('self is the default and --session is only a requested target', () => {
    expect(browserCliRequest(parseBrowserCli(['status']), SID).path).toBe(`/v1/sessions/${SID}/browser`);
    expect(parseBrowserCli(['status', '--session', 'zelda'])).toEqual({ command: 'status', session: 'zelda' });
    expect(() => browserCliRequest(parseBrowserCli(['status']), undefined)).toThrow(/no session id/);
  });

  test('builds Playwright and lifecycle action bodies', () => {
    expect(browserCliRequest(parseBrowserCli(['click', '#go']), SID)).toMatchObject({
      method: 'POST',
      body: { action: 'click', selector: '#go' },
    });
    expect(browserCliRequest(parseBrowserCli(['resize', '900', '700']), SID).body).toEqual({
      action: 'resize',
      width: 900,
      height: 700,
    });
    expect(browserCliRequest(parseBrowserCli(['open', 'example.test']), SID).body).toEqual({
      action: 'open',
      url: 'example.test',
    });
    expect(browserCliRequest(parseBrowserCli(['forward']), SID).body).toEqual({ action: 'forward' });
    expect(browserCliRequest(parseBrowserCli(['reload']), SID).body).toEqual({ action: 'reload' });
    expect(browserCliRequest(parseBrowserCli(['new-page', 'example.test']), SID).body).toEqual({
      action: 'new-page',
      url: 'example.test',
    });
    expect(browserCliRequest(parseBrowserCli(['new-page']), SID).body).toEqual({ action: 'new-page' });
    expect(browserCliRequest(parseBrowserCli(['activate-page', 'page_123']), SID).body).toEqual({
      action: 'activate-page',
      pageId: 'page_123',
    });
    expect(browserCliRequest(parseBrowserCli(['close-page', 'page_123']), SID).body).toEqual({
      action: 'close-page',
      pageId: 'page_123',
    });
  });
});

describe('browser CLI rendering', () => {
  test('status states the cap, viewport, viewer count, and provenance', () => {
    const output = renderBrowserCli({ command: 'status' }, status);
    expect(output).toContain('1280x800');
    expect(output).toContain('viewers 1/3');
    expect(output).toContain('last agent: click');
    expect(output).toContain('agent page page_123: click at 2026-07-27T00:00:00.000Z');
    expect(output).toContain('* page_123  Example  https://example.test/');
    expect(output).toContain('page ready · back yes · forward no');
  });

  test('read prints only requested page text', () => {
    const response: BrowserActionResult = { status, result: { text: 'Visible page text' } };
    expect(renderBrowserCli({ command: 'read' }, response)).toBe('Visible page text\n');
  });

  test('screenshot bytes decode only from an explicit response', () => {
    const response: BrowserActionResult = {
      status,
      result: { screenshotBase64: Buffer.from('png').toString('base64') },
    };
    expect(new TextDecoder().decode(browserScreenshotBytes(response))).toBe('png');
  });
});

describe('browser CLI root registration', () => {
  test('root browser help exposes the mounted command and its usage', async () => {
    const child = Bun.spawn([process.execPath, 'src/index.ts', 'browser', '--help'], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { ...process.env, NODE_ENV: 'production', KTEAM_TEST_HERMETIC: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(error);
    expect(code).toBe(0);
    expect(output).toContain('Usage: kteam browser');
    expect(output).toContain('new-page [url]');
  });
});
