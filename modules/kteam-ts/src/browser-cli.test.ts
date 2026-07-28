import { describe, expect, test } from 'bun:test';
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
  });
});

describe('browser CLI rendering', () => {
  test('status states the cap, viewport, viewer count, and provenance', () => {
    const output = renderBrowserCli({ command: 'status' }, status);
    expect(output).toContain('1280x800');
    expect(output).toContain('viewers 1/3');
    expect(output).toContain('last agent: click');
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
