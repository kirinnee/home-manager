import { describe, expect, test } from 'bun:test';
import {
  BrowserRuntime,
  chromeExecutableCandidates,
  chromeLaunchArguments,
  normalizeBrowserUrl,
  resolveChromeExecutable,
} from './browser-runtime';
import type { BrowserAutomation } from './browser-playwright-client';
import {
  BrowserError,
  normalizeBrowserViewport,
  type BrowserPageActionSnapshot,
  type BrowserPageSnapshot,
} from './browser-types';

describe('browser URL policy', () => {
  test('adds useful schemes without blocking loopback dev servers', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeBrowserUrl('127.0.0.1:3000/path')).toBe('http://127.0.0.1:3000/path');
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank');
  });

  test('rejects active and local-file schemes', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings']) {
      expect(() => normalizeBrowserUrl(url)).toThrow(BrowserError);
    }
  });
});

describe('viewport bounds', () => {
  test('rounds and clamps to the CDP screencast contract', () => {
    expect(normalizeBrowserViewport(100.7, 9_000)).toEqual({ width: 320, height: 1_200 });
    expect(normalizeBrowserViewport(801.4, 599.6)).toEqual({ width: 801, height: 600 });
  });

  test('rejects non-finite dimensions', () => {
    expect(() => normalizeBrowserViewport(Number.NaN, 800)).toThrow(/finite/);
  });
});

describe('cross-platform headless Chrome', () => {
  test('knows standard macOS and Linux system-browser locations', () => {
    expect(chromeExecutableCandidates('darwin')[0]).toContain('Google Chrome.app');
    expect(chromeExecutableCandidates('linux')).toContain('/usr/bin/google-chrome');
  });

  test('honours an explicit executable and fails closed when none exists', () => {
    expect(resolveChromeExecutable('darwin', '/custom/chrome', candidate => candidate === '/custom/chrome')).toBe(
      '/custom/chrome',
    );
    expect(() => resolveChromeExecutable('darwin', undefined, () => false)).toThrow(/KTEAM_CHROME_BIN/);
  });

  test('launches the same headless persistent-profile CDP shape on both platforms', () => {
    const argv = chromeLaunchArguments('/Applications/Google Chrome', '/private/profile', 9222, {
      width: 1280,
      height: 800,
    });
    expect(argv).toContain('--headless=new');
    expect(argv).toContain('--user-data-dir=/private/profile');
    expect(argv).toContain('--remote-debugging-address=127.0.0.1');
    expect(argv).toContain('--window-size=1280,800');
    expect(argv.join(' ')).not.toMatch(/Xvfb|x11vnc|DISPLAY/);
  });
});

describe('explicit page lifecycle forwarding', () => {
  test('normalizes new-page URLs and forwards real page ids without treating them as actors', async () => {
    const calls: string[] = [];
    let resolveChromeExit!: (code: number) => void;
    const snapshot = (id: string, url: string): BrowserPageSnapshot => ({
      url,
      title: url === 'about:blank' ? '' : 'page',
      pages: [{ id, url, title: url === 'about:blank' ? '' : 'page' }],
      activePageId: id,
      pageState: 'ready',
      canGoBack: false,
      canGoForward: false,
    });
    const actionSnapshot = (id: string, url: string): BrowserPageActionSnapshot => ({
      ...snapshot(id, url),
      actedPageId: id,
    });
    const automation: BrowserAutomation = {
      navigate: async url => actionSnapshot('pg-1', url),
      click: async () => actionSnapshot('pg-1', 'about:blank'),
      type: async () => actionSnapshot('pg-1', 'about:blank'),
      read: async () => ({ ...actionSnapshot('pg-1', 'about:blank'), text: '' }),
      screenshot: async () => ({ ...actionSnapshot('pg-1', 'about:blank'), screenshotBase64: '' }),
      back: async () => actionSnapshot('pg-1', 'about:blank'),
      forward: async () => actionSnapshot('pg-1', 'about:blank'),
      reload: async () => actionSnapshot('pg-1', 'about:blank'),
      location: async () => snapshot('pg-1', 'about:blank'),
      newPage: async url => {
        calls.push(`newPage:${url ?? 'about:blank'}`);
        return actionSnapshot('pg-2', url ?? 'about:blank');
      },
      activatePage: async pageId => {
        calls.push(`activatePage:${pageId}`);
        return actionSnapshot(pageId, 'about:blank');
      },
      closePage: async pageId => {
        calls.push(`closePage:${pageId}`);
        return actionSnapshot(pageId, 'about:blank');
      },
      resize: async () => actionSnapshot('pg-1', 'about:blank'),
      startScreencast: async () => undefined,
      stopScreencast: async () => undefined,
      dispatchInput: async () => undefined,
      close: async () => {
        resolveChromeExit(0);
      },
    };
    const runtime = Reflect.construct(BrowserRuntime, [
      'runtime-forwarding',
      `/tmp/kteam-runtime-forward-${crypto.randomUUID()}`,
      '/tmp/kteam-runtime-forward-profile',
      { version: 2, cdpPort: 9222, chromePid: 1, startedAt: new Date(0).toISOString() },
      {
        pid: 1,
        exited: new Promise<number>(resolve => {
          resolveChromeExit = resolve;
        }),
        kill: () => resolveChromeExit(0),
      },
      automation,
      { width: 1280, height: 800 },
    ]) as BrowserRuntime;

    expect(await runtime.newPage('localhost:4173')).toMatchObject({ activePageId: 'pg-2', actedPageId: 'pg-2' });
    await runtime.activatePage('pg-2');
    await runtime.closePage('pg-2');
    expect(calls).toEqual(['newPage:http://localhost:4173/', 'activatePage:pg-2', 'closePage:pg-2']);
    await runtime.close();
  });
});
