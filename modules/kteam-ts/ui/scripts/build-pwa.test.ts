/* ============================================================================
   Stage C unit gates: the parts of the build graph whose failure modes are
   silent.

   These cover the contracts the gate list (§6, "Build determinism (B2 + C1)")
   names, at the level a unit test can reach without running a full build:
   release-ID discipline, the clean-source guard's scope, the precache closure,
   the generated-file naming schemes, and the manifest/offline generators. The
   two-consecutive-builds byte-identity check and the MIME gate are recorded as
   build evidence in the Stage-C exit note — they need a real build and a live
   daemon, not a unit test.
   ============================================================================ */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirtyGuardedInputs, porcelainPaths } from './build-pwa';
import { buildManifest, buildOfflineHtml } from './gen-pwa';
import { iconUrls, precacheClosure, renderPrecacheModule, type ViteManifest } from './postbuild-pwa';
import {
  FAMILIES,
  MODES,
  RELEASE_ENV,
  assertReleaseId,
  isGeneratedPublicFile,
  manifestName,
  offlineName,
  outDirFromArgv,
  releaseIdFromArgv,
  workerName,
} from './release';
import { defaultCssEntry, readThemeTokens, ThemeTokenError } from './theme-tokens';
import { UI_ROOT, verifyIconReferences, verifyIcons } from './verify-icons';

const RELEASE = 'abcdef012345';

describe('release id discipline', () => {
  test('accepts a 12-hex short hash and rejects anything else', () => {
    expect(assertReleaseId(RELEASE, 'test')).toBe(RELEASE);
    expect(() => assertReleaseId(undefined, 'test')).toThrow(/missing release id/);
    expect(() => assertReleaseId('', 'test')).toThrow(/missing release id/);
    expect(() => assertReleaseId('abc', 'test')).toThrow(/malformed/);
    expect(() => assertReleaseId('ABCDEF012345', 'test')).toThrow(/malformed/); // uppercase
    expect(() => assertReleaseId('abcdef0123456', 'test')).toThrow(/malformed/); // 13 chars
    expect(() => assertReleaseId('abcdefg12345', 'test')).toThrow(/malformed/); // non-hex
  });

  test('a child step fails when it is given no release id (never re-derives one)', () => {
    expect(() => releaseIdFromArgv([])).toThrow(/missing release id/);
    expect(() => releaseIdFromArgv(['--out-dir=/tmp/x'])).toThrow(/missing release id/);
  });

  test('a child step fails when its argument disagrees with the orchestrator env (C1)', () => {
    const env = { [RELEASE_ENV]: RELEASE };
    expect(releaseIdFromArgv([`--release=${RELEASE}`], env)).toBe(RELEASE);
    expect(() => releaseIdFromArgv(['--release=0123456789ab'], env)).toThrow(/release id mismatch/);
  });

  test('out-dir comes from argv, then env, then the served dist default', () => {
    expect(outDirFromArgv(['--out-dir=/tmp/scratch'])).toBe('/tmp/scratch');
    expect(outDirFromArgv([], { KTEAM_OUT_DIR: '/tmp/env' })).toBe('/tmp/env');
    expect(outDirFromArgv([], {})).toBe('../ui-dist');
  });
});

describe('artifact naming', () => {
  test('every artifact name carries the release', () => {
    expect(manifestName('studio', 'light', RELEASE)).toBe(`manifest-studio-light.${RELEASE}.json`);
    expect(offlineName(RELEASE)).toBe(`offline.${RELEASE}.html`);
    expect(workerName(RELEASE)).toBe(`sw.${RELEASE}.js`);
  });

  test('the generated-file matcher covers exactly gen-pwa output, and nothing else', () => {
    for (const family of FAMILIES) {
      for (const mode of MODES) {
        expect(isGeneratedPublicFile(manifestName(family, mode, RELEASE))).toBe(true);
      }
    }
    expect(isGeneratedPublicFile(offlineName(RELEASE))).toBe(true);

    // Hand-authored and committed-provenance files must never be swept.
    for (const safe of [
      'icons.gen.json',
      'favicon.ico',
      'icon-192.486032358f.png',
      'robots.txt',
      'manifest.json',
      'manifest-studio-light.json', // no release suffix
      'offline.html', // no release suffix
      'manifest-studio-light.xyz.json', // non-hex suffix
      'manifest-other-light.abcdef012345.json', // unknown family
    ]) {
      expect(isGeneratedPublicFile(safe)).toBe(false);
    }
  });
});

describe('clean-source guard (C1)', () => {
  test('parses porcelain output including renames and quoted paths', () => {
    const porcelain = [
      ' M modules/kteam-ts/ui/src/App.tsx',
      '?? modules/kteam-ts/ui/scripts/new.ts',
      'R  modules/kteam-ts/ui/brand/old.svg -> modules/kteam-ts/ui/brand/new.svg',
      ' M "modules/kteam-ts/ui/src/a file.ts"',
      '',
    ].join('\n');
    expect(porcelainPaths(porcelain)).toEqual([
      'modules/kteam-ts/ui/src/App.tsx',
      'modules/kteam-ts/ui/scripts/new.ts',
      'modules/kteam-ts/ui/brand/old.svg',
      'modules/kteam-ts/ui/brand/new.svg',
      'modules/kteam-ts/ui/src/a file.ts',
    ]);
  });

  test('every widened guarded input trips the guard', () => {
    // Each of these can change an artifact, so each must refuse a build.
    for (const input of [
      'index.html',
      'src/App.tsx',
      'public/robots.txt',
      'sw/sw.ts',
      'scripts/gen-pwa.ts',
      'brand/kteam-mark.svg',
      'tsconfig.json',
      'tsconfig.app.json',
      'tsconfig.node.json',
      'sw/tsconfig.json',
      '.gitignore',
      'bun.lock',
      'package.json',
      'vite.config.ts',
    ]) {
      expect(dirtyGuardedInputs(` M modules/kteam-ts/ui/${input}`)).toEqual([input]);
    }
  });

  test('ignores changes outside this package and outside the guarded scope', () => {
    const porcelain = [
      ' M flake.lock',
      ' M kteam-prob.md',
      ' M modules/kteam-ts/src/api-server.ts',
      ' M modules/kteam-ts/ui/README.md',
      ' M modules/kteam-ts/ui-dist/index.html',
    ].join('\n');
    expect(dirtyGuardedInputs(porcelain)).toEqual([]);
  });

  test('reports every dirty input, deduplicated and sorted', () => {
    const porcelain = [
      ' M modules/kteam-ts/ui/src/App.tsx',
      ' M modules/kteam-ts/ui/index.html',
      '?? modules/kteam-ts/ui/src/App.tsx',
    ].join('\n');
    expect(dirtyGuardedInputs(porcelain)).toEqual(['index.html', 'src/App.tsx']);
  });

  test('a clean tree passes', () => {
    expect(dirtyGuardedInputs('')).toEqual([]);
  });
});

describe('precache closure (M6)', () => {
  const manifest: ViteManifest = {
    'index.html': {
      file: 'assets/index-AAA.js',
      isEntry: true,
      css: ['assets/index-CSS.css'],
      assets: ['assets/font-FFF.woff2'],
      imports: ['_shared-SSS.js'],
      dynamicImports: ['src/pages/SessionChatPage.tsx'],
    },
    '_shared-SSS.js': { file: 'assets/shared-SSS.js', imports: ['_deep-DDD.js'] },
    '_deep-DDD.js': { file: 'assets/deep-DDD.js' },
    'src/pages/SessionChatPage.tsx': {
      file: 'assets/SessionChatPage-CCC.js',
      css: ['assets/SessionChatPage-CCC.css'],
      dynamicImports: ['src/components/Markdown.tsx'],
    },
    'src/components/Markdown.tsx': { file: 'assets/Markdown-MMM.js' },
  };

  test('walks imports AND dynamicImports transitively', () => {
    const urls = precacheClosure(manifest);
    // The lazily-imported chat page and ITS lazy import must both be present —
    // this is the whole reason the closure is recursive.
    expect(urls).toContain('/assets/SessionChatPage-CCC.js');
    expect(urls).toContain('/assets/Markdown-MMM.js');
    expect(urls).toContain('/assets/deep-DDD.js');
    expect(urls).toContain('/assets/shared-SSS.js');
    expect(urls).toContain('/assets/index-CSS.css');
    expect(urls).toContain('/assets/SessionChatPage-CCC.css');
    expect(urls).toContain('/assets/font-FFF.woff2');
  });

  test('never precaches an HTML shell (token + staleness safety)', () => {
    const withHtml: ViteManifest = { ...manifest, 'extra.html': { file: 'index.html' } };
    expect(precacheClosure(withHtml).some(u => u.endsWith('.html'))).toBe(false);
  });

  test('terminates on an import cycle', () => {
    const cyclic: ViteManifest = {
      a: { file: 'a.js', imports: ['b'] },
      b: { file: 'b.js', imports: ['a'] },
    };
    expect(precacheClosure(cyclic)).toEqual(['/a.js', '/b.js']);
  });

  test('tolerates a dangling import key rather than crashing the build', () => {
    expect(precacheClosure({ a: { file: 'a.js', imports: ['nope'] } })).toEqual(['/a.js']);
  });

  test('output is sorted and deduplicated, so the generated module is byte-stable', () => {
    const urls = precacheClosure(manifest);
    expect([...urls].sort()).toEqual(urls);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test('icon URLs are included but the stale-by-design legacy favicon.ico is not', () => {
    const urls = iconUrls([
      { name: 'icon-192', file: 'icon-192.abc1234567.png' },
      { name: 'favicon-ico', file: 'favicon.def1234567.ico' },
    ]);
    expect(urls).toEqual(['/icons/favicon.def1234567.ico', '/icons/icon-192.abc1234567.png']);
    expect(urls).not.toContain('/icons/favicon.ico');
  });

  test('the generated precache module carries the release and is deterministic', () => {
    const a = renderPrecacheModule(RELEASE, ['/assets/x.js']);
    expect(a).toContain(`export const RELEASE_ID = "${RELEASE}"`);
    expect(a).toContain('/assets/x.js');
    expect(a).toBe(renderPrecacheModule(RELEASE, ['/assets/x.js']));
  });
});

describe('theme token reading (M4)', () => {
  const themes = readThemeTokens(defaultCssEntry(UI_ROOT));

  test('resolves --bg for all ten themes to a literal colour', () => {
    const seen = new Set<string>();
    for (const family of FAMILIES) {
      for (const mode of MODES) {
        const bg = themes.token(family, mode, 'bg');
        expect(bg).toMatch(/^#[0-9a-fA-F]{3,8}$/);
        seen.add(`${family}-${mode}`);
      }
    }
    expect(seen.size).toBe(10);
  });

  test('light and dark differ within every family (no silent fallback to the base block)', () => {
    for (const family of FAMILIES) {
      expect(themes.token(family, 'light', 'bg')).not.toBe(themes.token(family, 'dark', 'bg'));
    }
  });

  test('the offline page also needs --fg/--accent/--border in every theme', () => {
    for (const family of FAMILIES) {
      for (const mode of MODES) {
        for (const token of ['fg', 'accent', 'border']) {
          expect(themes.token(family, mode, token).length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('a missing token or theme block FAILS rather than defaulting', () => {
    expect(() => themes.token('studio', 'light', 'no-such-token')).toThrow(ThemeTokenError);
    // @ts-expect-error — deliberately outside the Family union
    expect(() => themes.token('nosuchfamily', 'light', 'bg')).toThrow(ThemeTokenError);
  });
});

describe('generated manifests', () => {
  const icons = (
    JSON.parse(readFileSync(join(UI_ROOT, 'public', 'icons', 'icons.gen.json'), 'utf8')) as {
      icons: { name: string; file: string; width?: number; height?: number; mime: string }[];
    }
  ).icons;

  test('identity fields are constant across every theme; only the colours vary', () => {
    const a = buildManifest('#fbfbfc', icons);
    const b = buildManifest('#000000', icons);
    for (const key of ['id', 'start_url', 'scope', 'name', 'short_name', 'display']) {
      expect(a[key]).toEqual(b[key]);
    }
    expect(a.id).toBe('/');
    expect(a.start_url).toBe('/');
    expect(a.scope).toBe('/');
    expect(a.display).toBe('standalone');
    expect(a.theme_color).toBe('#fbfbfc');
    expect(a.background_color).toBe('#fbfbfc');
    expect(b.theme_color).toBe('#000000');
  });

  test('carries the full any+maskable icon set at both sizes', () => {
    const entries = buildManifest('#fff', icons).icons as { src: string; sizes: string; purpose: string }[];
    expect(entries).toHaveLength(4);
    expect(
      entries
        .filter(e => e.purpose === 'any')
        .map(e => e.sizes)
        .sort(),
    ).toEqual(['192x192', '512x512']);
    expect(
      entries
        .filter(e => e.purpose === 'maskable')
        .map(e => e.sizes)
        .sort(),
    ).toEqual(['192x192', '512x512']);
    for (const e of entries) expect(e.src).toMatch(/^\/icons\/[a-z0-9-]+\.[0-9a-f]{10}\.png$/);
  });

  test('every manifest icon reference resolves to a file in icons.gen.json', () => {
    const json = JSON.stringify(buildManifest('#fff', icons));
    expect(verifyIconReferences(json, 'generated manifest')).toEqual([]);
  });

  test('fails loudly when the icon provenance file lacks a required icon', () => {
    expect(() =>
      buildManifest(
        '#fff',
        icons.filter(i => i.name !== 'maskable-512'),
      ),
    ).toThrow(/maskable-512/);
  });
});

describe('offline page', () => {
  const themes = readThemeTokens(defaultCssEntry(UI_ROOT));
  const colors = new Map(
    FAMILIES.flatMap(family =>
      MODES.map(
        mode =>
          [
            `${family}-${mode}`,
            {
              bg: themes.token(family, mode, 'bg'),
              fg: themes.token(family, mode, 'fg'),
              accent: themes.token(family, mode, 'accent'),
              border: themes.token(family, mode, 'border'),
            },
          ] as const,
      ),
    ),
  );
  const html = buildOfflineHtml(colors);

  test('states the honest reason and offers a retry', () => {
    expect(html).toContain('Kteam is not connected');
    expect(html).toContain('kteamd');
    expect(html).toContain('unreachable');
    expect(html).toContain('location.reload()');
  });

  test('carries no daemon token placeholder and no API references', () => {
    // The daemon only substitutes index.html; a token placeholder here would
    // ship the literal string to every offline visitor.
    expect(html).not.toContain('__KTEAM_TOKEN__');
    expect(html).not.toContain('/v1/');
  });

  test('resolves a theme before first paint for all ten themes', () => {
    expect(html).toContain("localStorage.getItem('kteam-theme')");
    expect(html).toContain("setAttribute('data-theme'");
    for (const family of FAMILIES) {
      for (const mode of MODES) {
        expect(html).toContain(`[data-theme='${family}-${mode}']`);
      }
    }
  });

  test('pays the safe-area insets and keeps a 44px retry target', () => {
    expect(html).toContain('env(safe-area-inset-top)');
    expect(html).toContain('env(safe-area-inset-bottom)');
    expect(html).toContain('min-height: 44px');
  });

  test('references no external resource (it must render with zero network)', () => {
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });
});

describe('committed icon set', () => {
  test('verify-icons finds no problem in the committed set', () => {
    expect(verifyIcons()).toEqual([]);
  });

  test("index.html's icon references all resolve, and never link the legacy favicon.ico (C3)", () => {
    // index.html is Stage D's file for the *link* edits; this assertion holds
    // either way — before the links land there is nothing to resolve, and after
    // they land they must resolve to fingerprinted files.
    const html = readFileSync(join(UI_ROOT, 'index.html'), 'utf8');
    expect(verifyIconReferences(html, 'index.html')).toEqual([]);
  });
});
