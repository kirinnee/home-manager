import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { BROWSER_LOGIN_MAX_MINUTES } from './browser-api';
import {
  BROWSER_CLI_USAGE,
  BROWSER_LOGIN_CLI_MAX_MINUTES,
  browserCliRequest,
  browserScreenshotBytes,
  parseBrowserCli,
  renderBrowserCli,
} from './browser-cli';
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

describe('browser login CLI', () => {
  test('parses the four actions and their options', () => {
    expect(parseBrowserCli(['login', 'status'])).toEqual({ command: 'login', action: 'status' });
    expect(parseBrowserCli(['login', 'start'])).toEqual({ command: 'login', action: 'start' });
    expect(parseBrowserCli(['login', 'start', '--minutes', '30'])).toEqual({
      command: 'login',
      action: 'start',
      minutes: 30,
    });
    expect(parseBrowserCli(['login', 'start', '--minutes=45'])).toEqual({
      command: 'login',
      action: 'start',
      minutes: 45,
    });
    expect(parseBrowserCli(['login', 'stop'])).toEqual({ command: 'login', action: 'stop' });
    expect(parseBrowserCli(['login', 'stop', '--primed'])).toEqual({
      command: 'login',
      action: 'stop',
      primed: true,
    });
    expect(parseBrowserCli(['login', 'confirm'])).toEqual({ command: 'login', action: 'confirm' });
  });

  test('refuses to guess: no bare action, no misapplied option, no unbounded deadline', () => {
    // "browser login" reads as "show me" to one person and "open it" to
    // another. Guessing either way is a lie about what happened.
    expect(() => parseBrowserCli(['login'])).toThrow(/start, status, stop, or confirm/);
    expect(() => parseBrowserCli(['login', 'reopen'])).toThrow(/unknown browser login action/);
    // Accepting and ignoring an option reports success for something that
    // never happened.
    expect(() => parseBrowserCli(['login', 'stop', '--minutes', '5'])).toThrow(/--minutes applies only/);
    expect(() => parseBrowserCli(['login', 'start', '--primed'])).toThrow(/--primed applies only/);
    expect(() => parseBrowserCli(['status', '--primed'])).toThrow(/apply only to "browser login"/);
    for (const bad of ['0', '61', '1.5', 'soon', '-5']) {
      expect(() => parseBrowserCli(['login', 'start', '--minutes', bad])).toThrow(/between 1 and 60/);
    }
  });

  test('the deadline cap the CLI enforces is the one the daemon enforces', () => {
    // Mirrored rather than imported (browser-api drags in Playwright), so pin
    // them together here instead of letting them drift apart silently.
    expect(BROWSER_LOGIN_CLI_MAX_MINUTES).toBe(BROWSER_LOGIN_MAX_MINUTES);
  });

  test('targets the daemon-global route and needs no session id at all', () => {
    // The window is about the ONE shared profile. Demanding a session id would
    // be a lie about what it targets — and the human runs this from their own
    // shell, where KTEAM_SESSION_ID does not exist.
    expect(browserCliRequest(parseBrowserCli(['login', 'status']), undefined)).toEqual({
      method: 'GET',
      path: '/v1/browser/login',
    });
    expect(browserCliRequest(parseBrowserCli(['login', 'start', '--minutes', '5']), undefined)).toEqual({
      method: 'POST',
      path: '/v1/browser/login',
      body: { action: 'start', minutes: 5 },
    });
    expect(browserCliRequest(parseBrowserCli(['login', 'start']), SID).body).toEqual({ action: 'start' });
    expect(browserCliRequest(parseBrowserCli(['login', 'stop']), SID).body).toEqual({ action: 'stop' });
    expect(browserCliRequest(parseBrowserCli(['login', 'stop', '--primed']), SID).body).toEqual({
      action: 'stop',
      primed: true,
    });
    expect(browserCliRequest(parseBrowserCli(['login', 'confirm']), SID).body).toEqual({ action: 'confirm' });
  });

  test('an open window prints the tunnel, the port, and the one-shot password', () => {
    const output = renderBrowserCli(parseBrowserCli(['login', 'status']), {
      state: 'open',
      profilePrimed: false,
      openedAt: '2026-07-28T23:10:00.000Z',
      expiresAt: '2026-07-28T23:25:00.000Z',
      connection: {
        host: '127.0.0.1',
        port: 5951,
        password: 'Sq7fXk2p',
        sshTunnel: 'ssh -N -L 5951:127.0.0.1:5951 kirin@box',
      },
    });
    expect(output).toContain('browser login window: open');
    expect(output).toContain('closes 2026-07-28T23:25:00.000Z');
    expect(output).toContain('tunnel: ssh -N -L 5951:127.0.0.1:5951 kirin@box');
    expect(output).toContain('point a VNC viewer at 127.0.0.1:5951');
    expect(output).toContain('password: Sq7fXk2p');
    expect(output).toContain('profile primed: no');
  });

  test('a closed window prints no stale port, deadline, or password', () => {
    const output = renderBrowserCli(parseBrowserCli(['login', 'status']), { state: 'closed', profilePrimed: true });
    expect(output).toBe('browser login window: closed\nprofile primed: yes\n');
  });

  test('ABSENCE RENDERS AS UNKNOWN, never as a confident "closed"', () => {
    // A daemon that did not answer has not told us the window shut. Printing
    // "closed" here is the most dangerous lie this feature can tell: the human
    // walks away from a live sign-in window believing it is gone.
    const output = renderBrowserCli(parseBrowserCli(['login', 'status']), {});
    expect(output).toContain('browser login window: unknown');
    expect(output).toContain('profile primed: unknown');
    expect(output).not.toContain('closed');
    expect(renderBrowserCli(parseBrowserCli(['login', 'status']), undefined)).toContain('unknown');
  });

  test('an error state is surfaced, not swallowed', () => {
    const output = renderBrowserCli(parseBrowserCli(['login', 'start']), {
      state: 'error',
      profilePrimed: false,
      error: 'x11vnc did not start',
    });
    expect(output).toContain('browser login window: error');
    expect(output).toContain('error: x11vnc did not start');
  });

  test('the usage text documents the window and how to reach it', () => {
    expect(BROWSER_CLI_USAGE).toContain('login start [--minutes N]');
    expect(BROWSER_CLI_USAGE).toContain('login stop [--primed]');
    expect(BROWSER_CLI_USAGE).toContain('login confirm');
    expect(BROWSER_CLI_USAGE).toContain('human-admin only');
  });
});
