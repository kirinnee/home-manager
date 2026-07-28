import { describe, expect, test } from 'bun:test';
import {
  chromeExecutableCandidates,
  chromeLaunchArguments,
  normalizeBrowserUrl,
  resolveChromeExecutable,
} from './browser-runtime';
import { BrowserError, normalizeBrowserViewport } from './browser-types';

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
