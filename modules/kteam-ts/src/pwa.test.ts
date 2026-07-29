import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { loadDaemonConfig } from './daemon-config';
import { createPaths } from './paths';
import {
  PWA_CONFIG_VERSION,
  PWA_SHORT_NAME_LENGTH,
  PwaRuntime,
  brandPwaHtml,
  brandPwaManifest,
  mergePwaConfig,
  parsePwaConfig,
  pwaIconPaths,
  renderPwaIcon,
  resolvePwaIdentity,
  validatePwaConfigPatch,
} from './pwa';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(new TextDecoder().decode(bytes.slice(12, 16))).toBe('IHDR');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint8(25)).toBe(2); // Opaque RGB, not RGBA.
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function maximumWhitePixelRadius(bytes: Uint8Array): number {
  const { width, height } = pngDimensions(bytes);
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 12);
    const length = view.getUint32(0);
    const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    if (type === 'IDAT') idat.push(bytes.slice(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat.map(data => Buffer.from(data))));
  const stride = width * 3;
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  let maximum = 0;
  let whitePixels = 0;
  const rowFilters = new Set<number>();
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    rowFilters.add(raw[row]!);
    for (let x = 0; x < width; x++) {
      const pixel = row + 1 + x * 3;
      if (raw[pixel] !== 255 || raw[pixel + 1] !== 255 || raw[pixel + 2] !== 255) continue;
      whitePixels++;
      maximum = Math.max(maximum, Math.hypot(x - centerX, y - centerY));
    }
  }
  expect([...rowFilters]).toEqual([0]);
  expect(whitePixels).toBeGreaterThan(0);
  return maximum;
}

describe('versioned PWA daemon config', () => {
  test('parses known fields independently and drops unknown keys', () => {
    expect(
      parsePwaConfig({
        version: 1,
        name: '  Home   Lab  ',
        icon: 'h1',
        imagePath: '/tmp/not-owned.png',
      }),
    ).toEqual({ version: 1, name: 'Home Lab', icon: 'H1' });

    // A bad name does not discard a valid icon, and vice versa.
    expect(parsePwaConfig({ version: 1, name: 42, icon: 'w2' })).toEqual({ version: 1, icon: 'W2' });
    expect(parsePwaConfig({ version: 1, name: 'Work', icon: 'three' })).toEqual({ version: 1, name: 'Work' });
  });

  test('migrates an unversioned block additively and ignores unknown future versions', () => {
    expect(parsePwaConfig({ name: 'Atlas', icon: 'at' })).toEqual({ version: 1, name: 'Atlas', icon: 'AT' });
    expect(parsePwaConfig({ version: 2, name: 'Future', icon: 'F2' })).toEqual({ version: 1 });
    expect(parsePwaConfig(null)).toEqual({ version: 1 });
  });

  test('rejects each operator validation rule instead of silently dropping a PATCH field', () => {
    expect(() => validatePwaConfigPatch({ name: 'x'.repeat(65) })).toThrow(/1–64/);
    expect(() => validatePwaConfigPatch({ name: 'bad\u0000name' })).toThrow(/control characters/);
    expect(() => validatePwaConfigPatch({ icon: '' })).toThrow(/1–2 ASCII/);
    expect(() => validatePwaConfigPatch({ icon: 'A!7' })).toThrow(/1–2 ASCII/);
    expect(() => validatePwaConfigPatch({ version: 1 })).toThrow(/unknown field/);
  });

  test('normalizes patches and lets null return individual fields to defaults', () => {
    const initial = { version: 1 as const, name: 'Atlas', icon: 'AT' };
    expect(validatePwaConfigPatch({ name: '  Home   Lab ', icon: 'h1' })).toEqual({ name: 'Home Lab', icon: 'H1' });
    expect(mergePwaConfig(initial, { name: null })).toEqual({ version: 1, icon: 'AT' });
  });

  test('old daemon config gains defaults without rewriting setup requirements', async () => {
    const home = await temporaryDirectory('kteam-pwa-old-config-');
    const paths = createPaths(home);
    await mkdir(paths.daemon, { recursive: true });
    await writeFile(paths.daemonConfig, JSON.stringify({ host: '127.0.0.1', port: 7444 }));

    const config = await loadDaemonConfig(paths);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(7444);
    expect(config.pwa).toEqual({ version: PWA_CONFIG_VERSION });
  });

  test('a new config file persists the version owner and a loaded block is normalized', async () => {
    const freshHome = await temporaryDirectory('kteam-pwa-fresh-config-');
    const freshPaths = createPaths(freshHome);
    await loadDaemonConfig(freshPaths);
    const persisted = JSON.parse(await readFile(freshPaths.daemonConfig, 'utf8')) as Record<string, unknown>;
    expect(persisted['pwa']).toEqual({ version: PWA_CONFIG_VERSION });

    const configuredHome = await temporaryDirectory('kteam-pwa-configured-');
    const configuredPaths = createPaths(configuredHome);
    await mkdir(configuredPaths.daemon, { recursive: true });
    await writeFile(
      configuredPaths.daemonConfig,
      JSON.stringify({ pwa: { version: 1, name: '  Workshop  ', icon: 'ws', ignored: true } }),
    );
    expect((await loadDaemonConfig(configuredPaths)).pwa).toEqual({ version: 1, name: 'Workshop', icon: 'WS' });
  });
});

describe('per-machine PWA identity', () => {
  test('uses the short hostname with a deterministic monogram and colour when unset', () => {
    const first = resolvePwaIdentity({ version: 1 }, 'atlas.example.net');
    const again = resolvePwaIdentity({ version: 1 }, 'atlas.example.net');
    expect(first).toEqual(again);
    expect(first.name).toBe('atlas');
    expect(first.shortName).toBe('atlas');
    expect(first.icon).toBe('AT');
    expect(first.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(first.brandVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  test('uses the configured name and icon and bounds the home-screen label', () => {
    const identity = resolvePwaIdentity({ version: 1, name: 'North Workshop Machine', icon: 'n7' }, 'ignored-host');
    expect(identity.name).toBe('North Workshop Machine');
    expect(identity.icon).toBe('N7');
    expect(identity.shortName).toBe('North Worksh');
    expect(Array.from(identity.shortName)).toHaveLength(PWA_SHORT_NAME_LENGTH);
  });

  test('changes the public icon version whenever configured branding changes', () => {
    const atlas = resolvePwaIdentity({ version: 1, name: 'Atlas', icon: 'AT' }, 'ignored');
    const atlasTwo = resolvePwaIdentity({ version: 1, name: 'Atlas', icon: 'A2' }, 'ignored');
    const borealis = resolvePwaIdentity({ version: 1, name: 'Borealis', icon: 'AT' }, 'ignored');
    expect(atlas.brandVersion).not.toBe(atlasTwo.brandVersion);
    expect(atlas.brandVersion).not.toBe(borealis.brandVersion);
    expect(pwaIconPaths(atlas).any192).not.toBe(pwaIconPaths(atlasTwo).any192);
  });

  test('hot-swaps generated resources after a persisted config update', () => {
    const runtime = new PwaRuntime({ version: 1, name: 'Atlas', icon: 'AT' }, 'ignored');
    const before = runtime.identity.brandVersion;
    runtime.setConfig({ version: 1, name: 'Borealis', icon: 'B2' });
    expect(runtime.identity).toMatchObject({ name: 'Borealis', icon: 'B2' });
    expect(runtime.identity.brandVersion).not.toBe(before);
  });
});

describe('runtime manifest and iOS metadata', () => {
  const identity = resolvePwaIdentity({ version: 1, name: 'Home & <Lab>', icon: 'HL' }, 'ignored');

  test('preserves theme and app identity fields while replacing only machine-facing identity', () => {
    const paths = pwaIconPaths(identity);
    const original = {
      id: '/',
      name: 'Kteam',
      short_name: 'Kteam',
      start_url: '/',
      scope: '/',
      theme_color: '#123456',
      background_color: '#123456',
      icons: [{ src: '/icons/static.png' }],
    };
    const branded = brandPwaManifest(original, identity);
    expect(branded).toMatchObject({
      id: '/',
      name: 'Home & <Lab>',
      short_name: 'Home & <Lab>',
      start_url: '/',
      scope: '/',
      theme_color: '#123456',
      background_color: '#123456',
    });
    expect(branded['icons']).toEqual([
      { src: paths.any192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: paths.any512, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: paths.maskable192, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: paths.maskable512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });

  test('rewrites the one iOS icon/title surface and escapes configured text', async () => {
    const source = await Bun.file(new URL('../ui-dist/index.html', import.meta.url).pathname).text();
    const html = brandPwaHtml(source, identity);
    expect(html).toContain(`<link rel="apple-touch-icon" href="${pwaIconPaths(identity).apple}" />`);
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Home &amp; &lt;Lab&gt;" />');
    expect(html).toContain('<title>Home &amp; &lt;Lab&gt;</title>');
    expect(html.match(/rel="apple-touch-icon"/g)).toHaveLength(1);
    expect(html.match(/name="apple-mobile-web-app-title"/g)).toHaveLength(1);
  });

  test('uses the bounded short label for iOS while retaining the full document title', async () => {
    const source = await Bun.file(new URL('../ui-dist/index.html', import.meta.url).pathname).text();
    const longIdentity = resolvePwaIdentity({ version: 1, name: 'North Workshop Machine', icon: 'NW' }, 'ignored');
    const html = brandPwaHtml(source, longIdentity);
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="North Worksh" />');
    expect(html).toContain('<title>North Workshop Machine</title>');
  });

  test('treats JavaScript replacement tokens in configured names as literal text', async () => {
    const source = await Bun.file(new URL('../ui-dist/index.html', import.meta.url).pathname).text();
    const configuredName = 'A$&$`$1';
    const tokenIdentity = resolvePwaIdentity({ version: 1, name: configuredName, icon: 'AT' }, 'ignored');
    const html = brandPwaHtml(source, tokenIdentity);
    const escapedName = 'A$&amp;$`$1';
    expect(html).toContain(`<meta name="apple-mobile-web-app-title" content="${escapedName}" />`);
    expect(html).toContain(`<title>${escapedName}</title>`);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
  });
});

describe('runtime PWA responses', () => {
  test('brands every real family/mode manifest without changing its theme or app identity', async () => {
    const uiDist = new URL('../ui-dist', import.meta.url).pathname;
    const names = (await readdir(uiDist)).filter(name => /^manifest-.+\.json$/.test(name)).sort();
    expect(names.length).toBeGreaterThan(1);
    const runtime = new PwaRuntime({ version: 1, name: 'Workshop', icon: 'WS' }, 'ignored');
    for (const name of names) {
      const original = JSON.parse(await readFile(path.join(uiDist, name), 'utf8')) as Record<string, unknown>;
      const response = await runtime.response(`/${name}`, uiDist);
      expect(response?.status).toBe(200);
      expect(response?.headers.get('cache-control')).toBe('no-store');
      const branded = (await response!.json()) as Record<string, unknown>;
      expect(branded).toMatchObject({
        id: original['id'],
        start_url: original['start_url'],
        scope: original['scope'],
        display: original['display'],
        orientation: original['orientation'],
        theme_color: original['theme_color'],
        background_color: original['background_color'],
        name: 'Workshop',
        short_name: 'Workshop',
      });
    }
  });

  test('serves each built theme manifest dynamically and never caches daemon identity', async () => {
    const uiDist = await temporaryDirectory('kteam-pwa-ui-dist-');
    const manifestName = 'manifest-studio-light.aaaaaaaaaaaa.json';
    await writeFile(
      path.join(uiDist, manifestName),
      JSON.stringify({ id: '/', name: 'Kteam', short_name: 'Kteam', theme_color: '#fbfbfc', icons: [] }),
    );
    const runtime = new PwaRuntime({ version: 1, name: 'Workshop', icon: 'WS' }, 'ignored');
    const response = await runtime.response(`/${manifestName}`, uiDist);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8');
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.json()).toMatchObject({
      id: '/',
      name: 'Workshop',
      short_name: 'Workshop',
      theme_color: '#fbfbfc',
    });

    const missing = await runtime.response('/manifest-studio-dark.bbbbbbbbbbbb.json', uiDist);
    expect(missing?.status).toBe(404);
    expect(missing?.headers.get('cache-control')).toBe('no-store');
    expect(await runtime.response('/assets/index.aaaaaaaaaaaa.js', uiDist)).toBeUndefined();
  });

  test('serves opaque generated PNGs at install sizes, including iOS', async () => {
    const runtime = new PwaRuntime({ version: 1, name: 'Workshop', icon: 'WS' }, 'ignored');
    const paths = pwaIconPaths(runtime.identity);
    for (const [pathname, expectedSize] of [
      [paths.any192, 192],
      [paths.any512, 512],
      [paths.maskable192, 192],
      [paths.maskable512, 512],
      [paths.apple, 180],
    ] as const) {
      const response = await runtime.response(pathname, '/not-used');
      expect(response?.status).toBe(200);
      expect(response?.headers.get('content-type')).toBe('image/png');
      expect(response?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      const bytes = new Uint8Array(await response!.arrayBuffer());
      expect(pngDimensions(bytes)).toEqual({ width: expectedSize, height: expectedSize });
      if (pathname.includes('/maskable-')) {
        expect(maximumWhitePixelRadius(bytes)).toBeLessThanOrEqual(expectedSize * 0.4);
      }
    }
  });

  test('uses a tighter monogram for the maskable circular safe zone', () => {
    const identity = resolvePwaIdentity({ version: 1, name: 'Proof Atlas', icon: 'PA' }, 'ignored');
    const any = renderPwaIcon(192, identity);
    const maskable = renderPwaIcon(192, identity, 'maskable');
    expect(any).not.toEqual(maskable);
    expect(maximumWhitePixelRadius(maskable)).toBeLessThanOrEqual(192 * 0.4);
  });

  test('different machine identities produce different icon bytes', async () => {
    const atlas = new PwaRuntime({ version: 1, name: 'Atlas', icon: 'AT' }, 'ignored');
    const borealis = new PwaRuntime({ version: 1, name: 'Borealis', icon: 'B7' }, 'ignored');
    const atlasBytes = new Uint8Array(
      await (await atlas.response(pwaIconPaths(atlas.identity).any192, '/not-used'))!.arrayBuffer(),
    );
    const borealisBytes = new Uint8Array(
      await (await borealis.response(pwaIconPaths(borealis.identity).any192, '/not-used'))!.arrayBuffer(),
    );
    expect(atlasBytes).not.toEqual(borealisBytes);
  });
});
