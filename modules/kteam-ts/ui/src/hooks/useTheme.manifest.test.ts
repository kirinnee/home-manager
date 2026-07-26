// MANIFEST HREF REWRITING (plan §4.3, audit M4).
//
// Ten generated manifests per release differ only in theme/background colour.
// The active one is selected by rewriting the href of the ONE
// `<link id="kteam-manifest">` index.html created — never by appending a second
// link, which is what M4 flagged: browsers take the first manifest link, so an
// appended one is both dead weight and a DOM that lies about which manifest is
// in force.
//
// This is the piece that can be wrong with no visible symptom: a bad swap yields
// a 404 that only shows up inside an install prompt nobody is watching. So the
// swap is a pure function and the release-preservation property is asserted
// against the real generated names.

import { describe, expect, test } from 'bun:test';
import { MANIFEST_LINK_ID, manifestHrefFor } from './useTheme';
import { FAMILIES, MODES, manifestName } from '../../scripts/release';

const RELEASE = '93c72ea3f8b3';

describe('manifestHrefFor', () => {
  test('swaps family and mode while preserving the release', () => {
    const from = `/${manifestName('studio', 'light', RELEASE)}`;
    expect(manifestHrefFor(from, 'mission', 'dark')).toBe(`/${manifestName('mission', 'dark', RELEASE)}`);
  });

  // THE RELEASE MUST SURVIVE. It names the generation this bundle belongs to; a
  // swap that clobbered it would point at another release's manifest, or at a
  // file that does not exist.
  test('every family/mode target keeps the same release and matches manifestName', () => {
    const from = `/${manifestName('studio', 'light', RELEASE)}`;
    for (const family of FAMILIES) {
      for (const mode of MODES) {
        const next = manifestHrefFor(from, family, mode);
        expect(next).toBe(`/${manifestName(family, mode, RELEASE)}`);
        expect(next).toContain(RELEASE);
      }
    }
  });

  test('is idempotent — swapping to the current theme changes nothing', () => {
    const href = `/${manifestName('ember', 'dark', RELEASE)}`;
    expect(manifestHrefFor(href, 'ember', 'dark')).toBe(href);
  });

  test('round-trips through every family without accumulating damage', () => {
    let href = `/${manifestName('studio', 'light', RELEASE)}`;
    for (const family of FAMILIES) href = manifestHrefFor(href, family, 'dark');
    for (const family of FAMILIES) href = manifestHrefFor(href, family, 'light');
    expect(href).toBe(`/${manifestName('contrast', 'light', RELEASE)}`);
  });

  // Returns the input rather than fabricating a URL: a dev server has no
  // generated manifest at all, and inventing a plausible name there would point
  // the link at a 404 instead of leaving a harmless one alone.
  test('leaves anything that is not a generated manifest name untouched', () => {
    for (const href of ['/manifest.webmanifest', '', '/icons/favicon.fc09cfb83e.svg', 'data:,']) {
      expect(manifestHrefFor(href, 'neo', 'dark')).toBe(href);
    }
  });

  test('the dev placeholder release is handled like any other', () => {
    const from = '/manifest-studio-light.devdevdevdev.json';
    expect(manifestHrefFor(from, 'neo', 'dark')).toBe('/manifest-neo-dark.devdevdevdev.json');
  });

  test('the link id is the one index.html creates', () => {
    expect(MANIFEST_LINK_ID).toBe('kteam-manifest');
  });
});

describe('index.html and useTheme agree (M4)', () => {
  const html = Bun.file(new URL('../../index.html', import.meta.url).pathname);

  test('exactly ONE manifest link exists, and it carries the id', async () => {
    const text = await html.text();
    const links = [...text.matchAll(/<link[^>]*rel="manifest"[^>]*>/g)];
    expect(links).toHaveLength(1);
    expect(links[0]![0]).toContain(`id="${MANIFEST_LINK_ID}"`);
  });

  test('its href is a generated manifest name the swap function recognises', async () => {
    const text = await html.text();
    const href = /<link[^>]*id="kteam-manifest"[^>]*href="([^"]+)"/.exec(text)?.[1] ?? '';
    // The release is `%VITE_KTEAM_RELEASE%` until Vite substitutes it, so assert
    // the swappable shape rather than a finished name.
    expect(href).toStartWith('/manifest-');
    expect(manifestHrefFor(href, 'neo', 'dark')).toContain('/manifest-neo-dark.');
  });

  // The pre-paint bootstrap applies the same rule so a hard load on a non-default
  // theme does not briefly expose studio-light's colours to an install prompt.
  test('the inline bootstrap repoints the same element', async () => {
    const text = await html.text();
    expect(text).toContain(`getElementById('kteam-manifest')`);
    expect(text).toMatch(/manifest-\[a-z\]\+-\[a-z\]\+\\\./);
  });

  // A static theme-color would be wrong for four of the five families; useTheme
  // sets it from the computed `--bg` once `data-theme` is applied.
  test('index.html ships no static theme-color', async () => {
    const text = await html.text();
    expect(text).not.toContain('name="theme-color"');
  });

  test('iOS add-to-home-screen metadata is present', async () => {
    const text = await html.text();
    for (const needle of [
      'apple-touch-icon',
      'apple-mobile-web-app-capable',
      'apple-mobile-web-app-title',
      'apple-mobile-web-app-status-bar-style',
    ]) {
      expect(text).toContain(needle);
    }
  });
});
