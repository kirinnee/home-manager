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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATUS_ARGV, dirtyGuardedInputs, porcelainPaths } from './build-pwa';
import { buildManifest, buildOfflineHtml } from './gen-pwa';
import { iconUrls, precacheClosure, renderPrecacheModule, type ViteManifest } from './postbuild-pwa';
import {
  FAMILIES,
  MODES,
  RELEASE_ENV,
  VITE_RELEASE_ENV,
  assertReleaseId,
  isGeneratedPublicFile,
  manifestName,
  offlineName,
  outDirFromArgv,
  releaseIdFromArgv,
  workerName,
} from './release';
import { defaultCssEntry, readThemeTokens, ThemeTokenError } from './theme-tokens';
import {
  ICONS_MANIFEST,
  PUBLIC_DIR,
  SOURCE_SVG,
  UI_ROOT,
  legacyIcoProblems,
  readIconsManifest,
  sourceProvenanceProblems,
  verifyIconReferences,
  verifyIcons,
} from './verify-icons';
// vite.config.ts exports its release resolution so the BUILD-vs-dev contract is
// testable without spawning vite. Aliased because `releaseId` would collide
// with the release-module helpers above.
import { releaseId as viteReleaseId } from '../vite.config';

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
    const env = { [RELEASE_ENV]: RELEASE };
    expect(() => releaseIdFromArgv([], env)).toThrow(/missing release id/);
    expect(() => releaseIdFromArgv(['--out-dir=/tmp/x'], env)).toThrow(/missing release id/);
  });

  test('a child step fails when the orchestrator env is MISSING, not only when it disagrees', () => {
    // The audited version only compared the two when the env var happened to
    // exist, so a hand-run `bun scripts/gen-pwa.ts --release=<anything>` was
    // accepted and could write half a release. Absence must fail like a
    // mismatch does.
    expect(() => releaseIdFromArgv([`--release=${RELEASE}`], {})).toThrow(/missing release id/);
    expect(() => releaseIdFromArgv([`--release=${RELEASE}`], {})).toThrow(new RegExp(RELEASE_ENV));
    expect(() => releaseIdFromArgv([`--release=${RELEASE}`], { [RELEASE_ENV]: '' })).toThrow(/missing release id/);
    // A present-but-malformed env value is also rejected, and names the env var.
    expect(() => releaseIdFromArgv([`--release=${RELEASE}`], { [RELEASE_ENV]: 'nope' })).toThrow(/malformed/);
  });

  test('a child step fails when its argument disagrees with the orchestrator env (C1)', () => {
    const env = { [RELEASE_ENV]: RELEASE };
    expect(releaseIdFromArgv([`--release=${RELEASE}`], env)).toBe(RELEASE);
    expect(() => releaseIdFromArgv(['--release=0123456789ab'], env)).toThrow(/release id mismatch/);
  });

  test('a vite BUILD needs both orchestrator variables and needs them to agree', () => {
    const both = { [RELEASE_ENV]: RELEASE, [VITE_RELEASE_ENV]: RELEASE };
    expect(viteReleaseId('build', both)).toBe(RELEASE);

    // Either one missing fails, and the message names the one that is missing —
    // `%VITE_KTEAM_RELEASE%` in index.html and the compiled `define` come from
    // different variables, so checking only the canonical one would let the
    // HTML and the bundle name different generations with nothing downstream
    // able to notice.
    expect(() => viteReleaseId('build', {})).toThrow(new RegExp(RELEASE_ENV));
    expect(() => viteReleaseId('build', { [RELEASE_ENV]: RELEASE })).toThrow(new RegExp(VITE_RELEASE_ENV));
    expect(() => viteReleaseId('build', { [VITE_RELEASE_ENV]: RELEASE })).toThrow(new RegExp(RELEASE_ENV));
    expect(() => viteReleaseId('build', { [RELEASE_ENV]: RELEASE, [VITE_RELEASE_ENV]: '' })).toThrow(
      /missing release id/,
    );
    expect(() => viteReleaseId('build', { [RELEASE_ENV]: RELEASE, [VITE_RELEASE_ENV]: '0123456789ab' })).toThrow(
      /release id mismatch/,
    );
    expect(() => viteReleaseId('build', { [RELEASE_ENV]: RELEASE, [VITE_RELEASE_ENV]: 'NOTHEX' })).toThrow(/malformed/);
  });

  test('`vite dev` still starts without any release (it builds no artifact)', () => {
    expect(viteReleaseId('serve', {})).toBe('devdevdevdev');
    expect(viteReleaseId('serve', { [RELEASE_ENV]: RELEASE })).toBe(RELEASE);
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

  test('the build-shaping config files an allowlist forgot are guarded (P1)', () => {
    // The audit's headline finding: the guard was an ALLOWLIST, and neither of
    // these two was on it — so `dirtyGuardedInputs()` returned [] for a dirty
    // tailwind/postcss config even though both change the emitted CSS. They are
    // asserted by name, separately from the loop below, because these exact two
    // regressions are what this test exists to prevent.
    expect(dirtyGuardedInputs(' M modules/kteam-ts/ui/tailwind.config.ts')).toEqual(['tailwind.config.ts']);
    expect(dirtyGuardedInputs(' M modules/kteam-ts/ui/postcss.config.js')).toEqual(['postcss.config.js']);
    expect(dirtyGuardedInputs('?? modules/kteam-ts/ui/tailwind.config.ts')).toEqual(['tailwind.config.ts']);
    expect(dirtyGuardedInputs('?? modules/kteam-ts/ui/postcss.config.js')).toEqual(['postcss.config.js']);
  });

  test('every guarded input trips the guard', () => {
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
      'tailwind.config.ts',
      'postcss.config.js',
      'public/icons/icons.gen.json',
      'public/favicon.ico',
    ]) {
      expect(dirtyGuardedInputs(` M modules/kteam-ts/ui/${input}`)).toEqual([input]);
    }
  });

  test('the guard is a DENYLIST: an unforeseen new config file is guarded by default', () => {
    // The property that makes P1 unrepeatable. Nobody has to remember to add a
    // file for it to be covered; only an explicit UNGUARDED_INPUTS entry exempts
    // one, and adding an entry is a reviewable diff.
    for (const invented of [
      'biome.json',
      'uno.config.ts',
      'lightningcss.config.mjs',
      'src/generated/whatever.ts',
      '.browserslistrc',
      'some-tool-nobody-has-written-yet.config.mts',
    ]) {
      expect(dirtyGuardedInputs(` M modules/kteam-ts/ui/${invented}`)).toEqual([invented]);
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

  test('the deploy output directory is not mistaken for a package input', () => {
    // `modules/kteam-ts/ui-dist/` shares no prefix with `modules/kteam-ts/ui/`
    // once the trailing slash is honoured. A guard that compared without it
    // would refuse every build the moment a build wrote its own output.
    expect(dirtyGuardedInputs(' M modules/kteam-ts/ui-dist/assets/index-AAA.js')).toEqual([]);
    expect(dirtyGuardedInputs('?? modules/kteam-ts/ui-dist/sw.abcdef012345.js')).toEqual([]);
  });

  test("a build's OWN generated public output never trips the next build's guard", () => {
    // These are gitignored, so they should not appear in porcelain at all; the
    // exemption is belt-and-braces for `--porcelain -unormal` style callers.
    const generated = [
      ...FAMILIES.flatMap(f => MODES.map(m => `public/${manifestName(f, m, RELEASE)}`)),
      `public/${offlineName(RELEASE)}`,
      'sw/precache.gen.ts',
    ];
    expect(dirtyGuardedInputs(generated.map(g => ` M modules/kteam-ts/ui/${g}`).join('\n'))).toEqual([]);

    // But a LOOKALIKE in the same directory is a real, reviewable input.
    expect(dirtyGuardedInputs(' M modules/kteam-ts/ui/public/manifest-studio-light.preview.json')).toEqual([
      'public/manifest-studio-light.preview.json',
    ]);
    expect(dirtyGuardedInputs(' M modules/kteam-ts/ui/public/offline.draft.html')).toEqual([
      'public/offline.draft.html',
    ]);
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

/* The guard's INPUT, not its logic. A closure review found the denylist above
   was correct and still let a build through: `git status --porcelain` honours
   `status.showUntrackedFiles`, so a repo or user config of `no` handed
   `dirtyGuardedInputs()` an empty string and an untracked
   `future-build-shaping.config.mts` sailed past. Feeding that function a
   hand-written porcelain string can never catch this — the escape happens
   before it is called. So these tests run real git in a real throwaway repo,
   with the hostile config actually set, using the same STATUS_ARGV the
   orchestrator uses. */
describe('the guard cannot be silenced by ambient git config (P1)', () => {
  /** A minimal repo with one commit and the ui package path present, so
      porcelain output has the same shape the orchestrator parses. */
  function scratchRepo(config: string[][] = []): string {
    const dir = mkdtempSync(join(tmpdir(), 'kteam-guard-config-'));
    const run = (...args: string[]): void => {
      const p = Bun.spawnSync({ cmd: ['git', ...args], cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
    };
    run('init', '-q');
    run('config', 'user.email', 'test@example.invalid');
    run('config', 'user.name', 'test');
    run('config', 'commit.gpgsign', 'false');
    mkdirSync(join(dir, 'modules', 'kteam-ts', 'ui'), { recursive: true });
    writeFileSync(join(dir, 'modules', 'kteam-ts', 'ui', 'tracked.ts'), 'export {};\n');
    run('add', '-A');
    run('commit', '-qm', 'base');
    for (const c of config) run('config', ...c);
    return dir;
  }

  function status(dir: string): string {
    // Deliberately the SAME argv the orchestrator runs, imported from it.
    const p = Bun.spawnSync({ cmd: ['git', ...STATUS_ARGV], cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    return p.stdout.toString();
  }

  function withRepo(config: string[][], fn: (dir: string) => void): void {
    const dir = scratchRepo(config);
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const UNTRACKED = 'modules/kteam-ts/ui/future-build-shaping.config.mts';

  test('EXACT closure repro: status.showUntrackedFiles=no still reports the untracked input', () => {
    withRepo([['status.showUntrackedFiles', 'no']], dir => {
      writeFileSync(join(dir, UNTRACKED), 'export default {};\n');

      // Sanity: without the flag, this config really does hide the file. If git
      // ever changes that, this assertion tells us the test has gone stale
      // rather than silently passing for the wrong reason.
      const bare = Bun.spawnSync({ cmd: ['git', 'status', '--porcelain'], cwd: dir, stdout: 'pipe' }).stdout.toString();
      expect(bare).not.toContain('future-build-shaping');

      // The guard's actual invocation must see it anyway...
      const porcelain = status(dir);
      expect(porcelain).toContain('future-build-shaping.config.mts');
      // ...and must therefore refuse the build.
      expect(dirtyGuardedInputs(porcelain)).toEqual(['future-build-shaping.config.mts']);
    });
  });

  test('the same holds for showUntrackedFiles=off and for a scoped no', () => {
    for (const value of ['off', 'no']) {
      withRepo([['status.showUntrackedFiles', value]], dir => {
        writeFileSync(join(dir, UNTRACKED), 'export default {};\n');
        expect(dirtyGuardedInputs(status(dir))).toEqual(['future-build-shaping.config.mts']);
      });
    }
  });

  test('untracked directories are listed per FILE, not collapsed to the directory', () => {
    // git's own default (-unormal) prints `newtool/` rather than its contents.
    // That still trips the guard, but the operator would be told a directory
    // name, and exemption logic comparing file paths would be matching against
    // something that is not a file path.
    withRepo([], dir => {
      mkdirSync(join(dir, 'modules', 'kteam-ts', 'ui', 'newtool'), { recursive: true });
      writeFileSync(join(dir, 'modules/kteam-ts/ui/newtool/a.config.ts'), 'x\n');
      writeFileSync(join(dir, 'modules/kteam-ts/ui/newtool/b.config.ts'), 'y\n');
      expect(dirtyGuardedInputs(status(dir))).toEqual(['newtool/a.config.ts', 'newtool/b.config.ts']);
    });
  });

  test('a genuinely clean tree still passes under the same invocation', () => {
    // The flag must not make the guard paranoid — a clean worktree has to build,
    // or the whole pipeline is bricked.
    withRepo([], dir => {
      expect(dirtyGuardedInputs(status(dir))).toEqual([]);
    });
    withRepo([['status.showUntrackedFiles', 'no']], dir => {
      expect(dirtyGuardedInputs(status(dir))).toEqual([]);
    });
  });

  test('the orchestrator pins the flag on the command line, where no config can override it', () => {
    // A config-based fix (`-c status.showUntrackedFiles=all`) would work too, but
    // asserting the literal argv keeps the guarantee legible and pins the thing
    // that regressed.
    expect(STATUS_ARGV).toEqual(['status', '--porcelain', '--untracked-files=all']);
    expect(STATUS_ARGV).toContain('--untracked-files=all');
  });
});

describe('generated-file ignore rules (P3)', () => {
  // Asked of real git, not of a re-implementation of its glob semantics —
  // `[0-9a-f]` classes and the `*`-vs-hex distinction are exactly the part a
  // hand-rolled matcher would get subtly wrong.
  const ignored = (rel: string): boolean =>
    Bun.spawnSync({
      cmd: ['git', 'check-ignore', '--no-index', '-q', rel],
      cwd: UI_ROOT,
    }).exitCode === 0;

  test('every name a real build generates is ignored, so a clean build leaves a clean tree', () => {
    // This is what lets the NEXT build's clean-source guard pass.
    for (const family of FAMILIES) {
      for (const mode of MODES) {
        expect(ignored(`public/${manifestName(family, mode, RELEASE)}`)).toBe(true);
      }
    }
    expect(ignored(`public/${offlineName(RELEASE)}`)).toBe(true);
    expect(ignored('sw/precache.gen.ts')).toBe(true);
  });

  test('lookalikes stay VISIBLE, so nothing hand-authored can be copied in unreviewed', () => {
    // The audited patterns were `public/manifest-*.*.json` and
    // `public/offline.*.html`, which swallowed all of these. An ignored file is
    // an unreviewable file: it can be added to the working tree, served by
    // Vite's public copy, and never show up in `git status` or a diff.
    for (const visible of [
      'public/manifest-studio-light.preview.json',
      'public/manifest-studio-light.json',
      'public/manifest.json',
      'public/manifest-studio-light.A6A86445AEC5.json', // uppercase hex
      'public/manifest-studio-light.a6a86445aec.json', // 11 chars
      'public/manifest-studio-light.a6a86445aec5z.json', // 13 chars
      'public/manifest-other-light.a6a86445aec5.json', // unknown family
      'public/manifest-studio-medium.a6a86445aec5.json', // unknown mode
      'public/offline.preview.html',
      'public/offline.html',
      'public/offline.a6a86445aec.html',
      'public/offline.a6a86445aec5z.html',
      'public/favicon.ico',
      'public/icons/icons.gen.json',
      'public/icons/favicon.1e0c791b41.ico',
    ]) {
      expect(ignored(visible)).toBe(false);
    }
  });

  test('the ignore rules and the cleanup matcher agree on exactly the same set', () => {
    // Two independent expressions of "generated": .gitignore (git glob) and
    // GENERATED_PUBLIC_RE (used by gen-pwa's pre-build sweep). If they drift,
    // one of two bad things happens — a generated file is left visible and the
    // next build's guard refuses, or a hand-authored file is swept away. Adding
    // a theme family therefore fails HERE rather than in production.
    const names = [
      ...FAMILIES.flatMap(f => MODES.map(m => manifestName(f, m, RELEASE))),
      offlineName(RELEASE),
      'manifest.json',
      'manifest-studio-light.json',
      'manifest-studio-light.preview.json',
      'manifest-other-light.a6a86445aec5.json',
      'offline.html',
      'offline.preview.html',
      'favicon.ico',
    ];
    for (const name of names) {
      expect({ name, ignored: ignored(`public/${name}`) }).toEqual({
        name,
        ignored: isGeneratedPublicFile(name),
      });
    }
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
    expect(seen.size).toBe(12);
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

  test('the legacy fallback is served from the ROOT, so /favicon.ico resolves (P2)', () => {
    // The audited build wrote it to public/icons/favicon.ico, where a browser
    // probing the well-known root path fell through to the SPA shell and got
    // HTML labelled as an icon. The whole value of this file is its URL.
    const manifest = readIconsManifest();
    expect(manifest.legacyIco.file).toBe('favicon.ico');
    expect(manifest.legacyIco.file).not.toContain('/');
    expect(manifest.legacyIco.url).toBe('/favicon.ico');
    expect(Bun.file(join(PUBLIC_DIR, 'favicon.ico')).size).toBeGreaterThan(0);
  });

  test('the legacy fallback is byte-identical to the fingerprinted ICO', () => {
    const manifest = readIconsManifest();
    const legacy = readFileSync(join(PUBLIC_DIR, 'favicon.ico'));
    const fingerprinted = readFileSync(join(PUBLIC_DIR, 'icons', manifest.legacyIco.identicalTo));
    expect(legacy.equals(fingerprinted)).toBe(true);
  });

  test("index.html's icon references all resolve, and never link the legacy favicon.ico (C3)", () => {
    // index.html is Stage D's file for the *link* edits; this assertion holds
    // either way — before the links land there is nothing to resolve, and after
    // they land they must resolve to fingerprinted files.
    const html = readFileSync(join(UI_ROOT, 'index.html'), 'utf8');
    expect(verifyIconReferences(html, 'index.html')).toEqual([]);
  });

  test('linking the root /favicon.ico is a problem, but the fingerprinted ICO is not', () => {
    expect(verifyIconReferences('<link rel="icon" href="/favicon.ico">', 'probe')).toEqual([
      'probe: links the stable legacy /favicon.ico, which must never be linked (C3)',
    ]);
    const manifest = readIconsManifest();
    expect(verifyIconReferences(`<link rel="icon" href="/icons/${manifest.legacyIco.identicalTo}">`, 'probe')).toEqual(
      [],
    );
  });
});

/* Mutation tests. These are the audit's P2 findings stated as executable
   assertions: BOTH of these checks previously returned zero problems after a
   real byte change, because each compared two fields that the same generation
   run had written. Every case below mutates real bytes in an isolated copy and
   demands a failure. */
describe('icon provenance rejects real byte changes (P2)', () => {
  /** Copy the whole public tree plus the source art into a scratch dir, so a
      mutation cannot touch the committed set. Returns the paths verifyIcons
      needs. */
  function scratchIcons(): { dir: string; iconDir: string; manifest: string; publicDir: string; svg: string } {
    const dir = mkdtempSync(join(tmpdir(), 'kteam-icon-mutation-'));
    const publicDir = join(dir, 'public');
    cpSync(PUBLIC_DIR, publicDir, { recursive: true });
    const svg = join(dir, 'kteam-mark.svg');
    cpSync(SOURCE_SVG, svg);
    return {
      dir,
      iconDir: join(publicDir, 'icons'),
      manifest: join(publicDir, 'icons', 'icons.gen.json'),
      publicDir,
      svg,
    };
  }

  function withScratch(fn: (s: ReturnType<typeof scratchIcons>) => void): void {
    const s = scratchIcons();
    try {
      fn(s);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  }

  test('the unmutated copy passes, so a later failure means the mutation caused it', () => {
    withScratch(s => {
      expect(verifyIcons(s.iconDir, s.manifest, { publicDir: s.publicDir, sourceSvg: s.svg })).toEqual([]);
    });
  });

  test('flipping one byte of the legacy favicon.ico is caught', () => {
    withScratch(s => {
      const path = join(s.publicDir, 'favicon.ico');
      const buf = readFileSync(path);
      buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
      writeFileSync(path, buf);
      const problems = verifyIcons(s.iconDir, s.manifest, { publicDir: s.publicDir, sourceSvg: s.svg });
      // Both the recorded hash AND the byte-identity comparison must object.
      expect(problems.some(p => /favicon\.ico: sha256 does not match/.test(p))).toBe(true);
      expect(problems.some(p => /not byte-identical to the fingerprinted/.test(p))).toBe(true);
    });
  });

  test('deleting the legacy favicon.ico is caught', () => {
    withScratch(s => {
      rmSync(join(s.publicDir, 'favicon.ico'));
      expect(verifyIcons(s.iconDir, s.manifest, { publicDir: s.publicDir, sourceSvg: s.svg })).toEqual([
        'favicon.ico: legacy fallback copy is missing from the public root',
      ]);
    });
  });

  test('a legacyIco.file pointing back inside icons/ is caught', () => {
    withScratch(s => {
      const manifest = JSON.parse(readFileSync(s.manifest, 'utf8'));
      manifest.legacyIco.file = 'icons/favicon.ico';
      manifest.legacyIco.url = '/icons/favicon.ico';
      writeFileSync(s.manifest, JSON.stringify(manifest));
      const problems = verifyIcons(s.iconDir, s.manifest, { publicDir: s.publicDir, sourceSvg: s.svg });
      expect(problems.some(p => /must sit at the public root/.test(p))).toBe(true);
    });
  });

  test('a legacyIco.url that is not the root path is caught', () => {
    withScratch(s => {
      const manifest = JSON.parse(readFileSync(s.manifest, 'utf8'));
      manifest.legacyIco.url = '/icons/favicon.ico';
      writeFileSync(s.manifest, JSON.stringify(manifest));
      const problems = verifyIcons(s.iconDir, s.manifest, { publicDir: s.publicDir, sourceSvg: s.svg });
      expect(problems).toContain('icons.gen.json: legacyIco.url is /icons/favicon.ico, expected /favicon.ico');
    });
  });

  test('editing the source mark without regenerating icons is caught (both hashes)', () => {
    withScratch(s => {
      // A realistic edit: someone nudges the art and commits it, forgetting
      // `bun run gen:icons`. Nothing else in the tree changes, so this check is
      // the only thing standing between that and shipping icons whose recorded
      // provenance is a lie.
      writeFileSync(s.svg, readFileSync(s.svg, 'utf8').replace('<svg', '<svg data-tweaked="1"'));
      const problems = verifyIcons(s.iconDir, s.manifest, { publicDir: s.publicDir, sourceSvg: s.svg });
      expect(problems.some(p => /sha256 .* does not match icons\.gen\.json/.test(p))).toBe(true);
      expect(problems.some(p => /git blob .* does not match icons\.gen\.json/.test(p))).toBe(true);
      expect(problems.every(p => /gen:icons/.test(p))).toBe(true);
    });
  });

  test('a missing source mark is caught rather than skipped', () => {
    withScratch(s => {
      rmSync(s.svg);
      const problems = verifyIcons(s.iconDir, s.manifest, { publicDir: s.publicDir, sourceSvg: s.svg });
      expect(problems).toContain(
        'brand/kteam-mark.svg: icon source art is missing, but icons.gen.json records hashes for it',
      );
    });
  });

  test('a tampered sourceSha256 with an intact sourceBlob is caught (the fields are independent)', () => {
    withScratch(s => {
      const manifest = JSON.parse(readFileSync(s.manifest, 'utf8'));
      manifest.sourceSha256 = 'f'.repeat(64);
      writeFileSync(s.manifest, JSON.stringify(manifest));
      const problems = verifyIcons(s.iconDir, s.manifest, { publicDir: s.publicDir, sourceSvg: s.svg });
      expect(problems.some(p => /sha256 .* does not match/.test(p))).toBe(true);
      expect(problems.some(p => /git blob/.test(p))).toBe(false);
    });
  });

  test('the checks are reachable as pure functions too', () => {
    const manifest = readIconsManifest(ICONS_MANIFEST);
    expect(sourceProvenanceProblems(manifest, SOURCE_SVG)).toEqual([]);
    expect(sourceProvenanceProblems({ ...manifest, sourceSha256: '0'.repeat(64) }, SOURCE_SVG)).toHaveLength(1);
    const fingerprinted = readFileSync(join(PUBLIC_DIR, 'icons', manifest.legacyIco.identicalTo));
    expect(legacyIcoProblems(manifest, fingerprinted, PUBLIC_DIR)).toEqual([]);
    // A wrong "identical" reference: same length, different bytes.
    const wrong = Buffer.alloc(fingerprinted.length, 0x41);
    expect(legacyIcoProblems(manifest, wrong, PUBLIC_DIR)).toHaveLength(1);
  });
});
