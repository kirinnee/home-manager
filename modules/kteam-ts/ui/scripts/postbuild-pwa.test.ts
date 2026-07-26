/* ============================================================================
   THE CLASSIC-WORKER BUNDLE GATE (Stage E blocker).

   `useServiceWorkerUpdate.ts` registers `/sw.<release>.js` with `{ scope: '/' }`
   and no `type: 'module'`, so the browser parses it with the SCRIPT grammar.
   `bun build` defaults to `--format=esm`, and `sw/sw.ts` exports its handlers
   for `sw.test.ts` — so the default output ended with a top-level
   `export { … }` block. Chromium rejected it before install: no installing /
   waiting / active worker, `serviceWorker.ready` never resolving, an empty
   CacheStorage and no offline navigation. Every build step still reported
   success, which is exactly why this gate has to exist in the pipeline.

   ── WHY THIS TEST SPAWNS A REAL BUNDLE ────────────────────────────────────
   The defect lived in the BUNDLER ARGUMENTS, not in any function's logic. A
   test asserting over a hand-written model of the output would have passed
   throughout the regression. So this file imports the production
   `workerBundleArgv()` and runs it, over the real worker source, and inspects
   the bytes that come out. Delete `--format=iife` from `workerBundleArgv` and
   the bundle blocks below go red — that is the whole point.

   The paired `default (pre-fix) bundling` block runs the SAME source through
   the old argv and asserts the gate rejects it. Without that, a checker that
   simply returned `[]` would also make this file green.

   ── CLEAN CHECKOUT, AND WHY NOTHING HERE WRITES INTO `sw/` ────────────────
   `sw/sw.ts` imports the gitignored `sw/precache.gen.ts`, which exists only
   after a build. This file therefore NEVER touches the source tree — writing a
   stub into `sw/` would both mutate a clean checkout and race a concurrent
   build that is rewriting that very file.

   Instead the load-bearing gate bundles an ISOLATED FIXTURE: the real `sw/`
   sources copied into a temp directory, with a generated-shaped
   `precache.gen.ts` supplied there when the tree has none. Real arguments, real
   worker bytes, no tree mutation — so it runs identically, and asserts
   identically, on a clean checkout and on a built one. Nothing about the
   classic-format contract is ever skipped.

   The extra `in-tree worker bundle` block bundles the REAL `sw/sw.ts` at its
   real path, which needs a built tree; it SKIPS VISIBLY when unbuilt, the same
   convention `sw/precache.gen.test.ts` uses. It is a redundancy check on the
   fixture, never the only coverage.
   ============================================================================ */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  PRECACHE_OUT,
  UI_ROOT,
  WORKER_BUNDLE_FORMAT,
  WORKER_ENTRY_REL,
  classicWorkerProblems,
  renderPrecacheModule,
  workerBundleArgv,
} from './postbuild-pwa';

const TMP = mkdtempSync(join(tmpdir(), 'kteam-sw-bundle-'));
/** Fixture root, laid out like UI_ROOT so `sw/sw.ts` resolves the same way. */
const FIXTURE_SW = join(TMP, 'fixture', 'sw');
const FIXTURE_ENTRY_REL = WORKER_ENTRY_REL;
const FIXTURE_ROOT = join(TMP, 'fixture');

/** True when a build has run in this tree. Only the redundancy block needs it. */
const built = existsSync(PRECACHE_OUT);

if (!built) {
  console.log(
    `${basename(PRECACHE_OUT)} absent (no build in this tree) — the classic-worker bundle gate still runs, ` +
      'against an isolated fixture copy of sw/. Only the in-tree-path redundancy check is skipped.',
  );
}

beforeAll(() => {
  // Copy the REAL worker sources; the fixture differs from the tree in exactly
  // one file, and only when the tree has no generated one.
  mkdirSync(FIXTURE_SW, { recursive: true });
  cpSync(join(UI_ROOT, 'sw'), FIXTURE_SW, { recursive: true });
  if (!existsSync(join(FIXTURE_SW, 'precache.gen.ts'))) {
    writeFileSync(
      join(FIXTURE_SW, 'precache.gen.ts'),
      renderPrecacheModule('abcdef012345', ['/offline.abcdef012345.html']),
    );
  }
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** Run an argv the way `postbuild-pwa` runs it (cwd = a UI root) and return the
    emitted bundle. */
function bundle(argv: readonly string[], cwd: string, outfile: string): string {
  const proc = Bun.spawnSync([...argv], { cwd, stdout: 'pipe', stderr: 'pipe' });
  expect(proc.exitCode, `bun build failed: ${proc.stderr.toString()}`).toBe(0);
  return readFileSync(outfile, 'utf8');
}

/** The assertions that define "registrable as a classic worker". Shared so the
    fixture path and the in-tree path cannot drift into checking different
    things. */
function expectClassicWorkerBundle(emitted: string): void {
  // 1. No top-level ESM syntax, and it parses under the script grammar.
  expect(classicWorkerProblems(emitted)).toEqual([]);
  // Parse-only. Bun's `node:vm` Script shim compiles a top-level `export` block
  // without complaint, so it would have passed the broken bundle; a Function
  // body rejects module-only syntax the way a classic worker does.
  expect(() => new Function(emitted)).not.toThrow();

  // 2. Actually WRAPPED, not merely export-free. Guards the weaker "fix" of
  //    deleting the exports from sw.ts, which keeps the ESM format and throws
  //    away the test seam.
  expect(emitted.trimStart().startsWith('(')).toBe(true);
  expect(emitted.trimEnd().endsWith(')();')).toBe(true);

  // 3. Still the worker it is supposed to be — a flag that silently emitted an
  //    empty file would satisfy every syntax assertion above.
  expect(emitted).toContain('registerWorkerEvents');
  expect(emitted).toContain('ServiceWorkerGlobalScope');
  expect(emitted).toContain('SKIP_WAITING');
}

describe('worker bundle argv', () => {
  test('pins an explicit classic (non-ESM) module format', () => {
    // `esm` is bun's default and is what shipped the broken release; asserting
    // the value keeps a "cleanup" that drops the flag from looking harmless.
    expect(WORKER_BUNDLE_FORMAT).toBe('iife');
    expect(workerBundleArgv('sw/sw.ts', '/out/sw.js')).toContain('--format=iife');
  });

  test('bundles the real worker entry to the release-named outfile', () => {
    expect(workerBundleArgv(WORKER_ENTRY_REL, '/out/sw.abcdef012345.js')).toEqual([
      'bun',
      'build',
      'sw/sw.ts',
      '--outfile',
      '/out/sw.abcdef012345.js',
      '--target',
      'browser',
      '--format=iife',
    ]);
  });
});

describe('classicWorkerProblems', () => {
  test('accepts an ordinary classic script', () => {
    expect(classicWorkerProblems('(() => { var a = 1; self.addEventListener("install", () => a); })();')).toEqual([]);
  });

  test('rejects a top-level export block — the exact shape that shipped', () => {
    const problems = classicWorkerProblems('var onInstall = 1;\nexport {\n  onInstall\n};\n');
    expect(problems.some(p => /top-level `export`/.test(p))).toBe(true);
    expect(problems.some(p => /does not parse as a classic script/.test(p))).toBe(true);
  });

  test('rejects top-level imports and import.meta', () => {
    expect(classicWorkerProblems("import { x } from './y';\n").some(p => /top-level `import`/.test(p))).toBe(true);
    expect(classicWorkerProblems('export default 1;\n').some(p => /top-level `export`/.test(p))).toBe(true);
    expect(classicWorkerProblems('var u = import.meta.url;\n').some(p => /import\.meta/.test(p))).toBe(true);
  });

  test('allows dynamic import(), which is legal in a classic worker', () => {
    expect(classicWorkerProblems('(() => { void import("./late.js"); })();')).toEqual([]);
  });
});

/* The gate proper. Runs on EVERY tree, built or clean. */
describe('real worker bundle (isolated fixture)', () => {
  let emitted = '';

  beforeAll(() => {
    const outfile = join(TMP, 'sw.abcdef012345.js');
    emitted = bundle(workerBundleArgv(FIXTURE_ENTRY_REL, outfile), FIXTURE_ROOT, outfile);
  });

  test('is a registrable classic worker script', () => {
    expectClassicWorkerBundle(emitted);
  });

  test('the pre-fix argv still emits an ESM bundle, and the gate rejects it', () => {
    const outfile = join(TMP, 'sw.esm.js');
    const argv = workerBundleArgv(FIXTURE_ENTRY_REL, outfile).filter(a => !a.startsWith('--format='));
    const esm = bundle(argv, FIXTURE_ROOT, outfile);

    // Reproduces the shipped defect from the real source, so this file cannot
    // go green just because someone made `classicWorkerProblems` permissive.
    expect(/^export \{/m.test(esm)).toBe(true);
    expect(classicWorkerProblems(esm).length).toBeGreaterThan(0);
    expect(() => new Function(esm)).toThrow();
  });
});

/* Redundancy only: the same contract at the real path, which needs the
   generated precache list. Skipped VISIBLY on a clean checkout (see the header)
   — never the sole coverage of the format contract. */
describe.skipIf(!built)('in-tree worker bundle (built trees only)', () => {
  test('the real sw/sw.ts bundles to a registrable classic worker', () => {
    const outfile = join(TMP, 'sw.in-tree.js');
    expectClassicWorkerBundle(bundle(workerBundleArgv(WORKER_ENTRY_REL, outfile), UI_ROOT, outfile));
  });
});
