/* ============================================================================
   POST-BUILD step: precache list, worker typecheck, worker bundle, `.vite`
   cleanup.

   Invoked as an in-process step by `scripts/build-pwa.ts` with the one release
   ID it computed:

       bun scripts/postbuild-pwa.ts --release=<12 hex> [--out-dir=<path>]

   ── THE PRECACHE CLOSURE ──────────────────────────────────────────────────
   Vite's build manifest lists one record per entry/chunk. Precaching only the
   entry's own `file` would leave every lazily-imported chunk uncached, so the
   installed app would still need the network for the chat page — the exact
   failure the worker exists to prevent. So we walk the FULL RECURSIVE CLOSURE:
   each reachable record's `file`, its `css`, its `assets`, and transitively all
   `imports` and `dynamicImports` (audit M6). Cycles are handled by a seen-set.

   `index.html` is deliberately EXCLUDED: it is the token-substituted shell the
   daemon re-reads per request with `no-store`, and caching it would both pin a
   stale shell and risk writing the daemon token into CacheStorage.

   ── WHY THE WORKER GETS ITS OWN TSCONFIG ──────────────────────────────────
   `tsconfig.app.json` includes only `src/` and pulls in DOM libs. A worker
   source outside `src/` would be typechecked by nothing at all, and `lib.dom`
   would happily let `window`/`document` typecheck inside a worker where they do
   not exist. `sw/tsconfig.json` gives it `WebWorker` without `DOM`.

   ── WHY THE WORKER IS BUNDLED AS A CLASSIC SCRIPT ─────────────────────────
   `useServiceWorkerUpdate.ts` registers the worker with `{ scope: '/' }` and NO
   `type: 'module'`, which is the plan's deliberate choice: classic workers are
   the universally supported form, and module workers are still the narrower
   surface. A classic worker script is parsed with the SCRIPT grammar, where a
   top-level `import`/`export` is a syntax error.

   `bun build` defaults to `--format=esm`, and `sw/sw.ts` legitimately exports
   its handlers so `sw.test.ts` can reach them — so the default output ended
   with a real `export { … }` block. Chromium then rejected the bundle BEFORE
   install: the registration got no installing/active/waiting worker,
   `navigator.serviceWorker.ready` never resolved, CacheStorage stayed empty and
   offline navigation failed. Nothing in the pipeline noticed, because every
   step had "succeeded".

   So the format is pinned explicitly (`workerBundleArgv`) and the EMITTED file
   is checked (`classicWorkerProblems`) before the build is allowed to pass. The
   check is on the bundle, not on the source: the source is allowed to export —
   it is the bundler's output that has to be script-grammar-legal.

   ── STAGE BOUNDARY ────────────────────────────────────────────────────────
   The worker SOURCE (`sw/sw.ts`) is Stage D's file; this step is Stage C's. So
   when `sw/sw.ts` is absent the worker typecheck+bundle are SKIPPED with a
   clear log and the rest of the step still runs. That keeps a Stage-C-only tree
   buildable and turns Stage D into "add the source" rather than "also rewire
   the build".
   ============================================================================ */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { outDirFromArgv, releaseIdFromArgv, workerName } from './release';

const HERE = dirname(new URL(import.meta.url).pathname);
export const UI_ROOT = join(HERE, '..');
const SW_DIR = join(UI_ROOT, 'sw');
const SW_ENTRY = join(SW_DIR, 'sw.ts');
export const PRECACHE_OUT = join(SW_DIR, 'precache.gen.ts');
/** The worker entry as `bun build` is given it — every step here runs with
    `cwd: UI_ROOT`. Exported so the bundle regression can pass the real entry. */
export const WORKER_ENTRY_REL = 'sw/sw.ts';

type ViteManifestRecord = {
  file: string;
  src?: string;
  isEntry?: boolean;
  css?: string[];
  assets?: string[];
  imports?: string[];
  dynamicImports?: string[];
};
export type ViteManifest = Record<string, ViteManifestRecord>;

/** Full recursive closure of every entry, as root-absolute URLs. Sorted so the
    generated file is byte-stable for a given input (build determinism gate). */
export function precacheClosure(manifest: ViteManifest): string[] {
  const urls = new Set<string>();
  const visited = new Set<string>();

  const visit = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const record = manifest[key];
    if (!record) return;
    // The HTML shell is never precached (token + staleness safety).
    if (!record.file.endsWith('.html')) urls.add(`/${record.file}`);
    for (const css of record.css ?? []) urls.add(`/${css}`);
    for (const asset of record.assets ?? []) urls.add(`/${asset}`);
    for (const next of [...(record.imports ?? []), ...(record.dynamicImports ?? [])]) visit(next);
  };

  for (const key of Object.keys(manifest)) visit(key);
  return [...urls].sort();
}

type IconEntry = { name: string; file: string };

/** Icon URLs worth precaching. The fingerprinted favicons and app icons are
    small and are what an installed launch paints first. The stable legacy
    `/icons/favicon.ico` is excluded — it is intentionally allowed to go stale
    (§4.2/C3), so caching it would freeze a stale copy twice over. */
export function iconUrls(icons: IconEntry[]): string[] {
  return icons.map(i => `/icons/${i.file}`).sort();
}

export function renderPrecacheModule(release: string, urls: string[]): string {
  return `/* GENERATED by scripts/postbuild-pwa.ts — do not edit, do not commit.
   Regenerated on every build from the Vite manifest's full recursive closure
   plus the offline page and the fingerprinted icons. Gitignored: it names
   content hashes from one specific build, so a committed copy would be a lie
   the moment anything changes.
*/

/** Release this precache list belongs to. The worker derives its cache name
    from this, so a new release never reuses an old generation's cache. */
export const RELEASE_ID = ${JSON.stringify(release)};

/** Root-absolute URLs the worker precaches at install. Every one is content- or
    release-addressed, which is why the api-server's blanket \`immutable\` header
    is correct for them. */
export const PRECACHE_URLS: readonly string[] = ${JSON.stringify(urls, null, 2)} as const;
`;
}

/* ---------- the classic-worker bundling contract --------------------------
   Both halves below are exported and are what the regression test drives, so
   the test runs THE REAL invocation rather than a hand-copied approximation of
   it — the ESM regression happened in the bundler arguments, so a test fed a
   private copy of them could not have caught it.
   -------------------------------------------------------------------------- */

/** Classic script, not ESM — see "WHY THE WORKER IS BUNDLED AS A CLASSIC
    SCRIPT" above. Bun's IIFE format wraps the whole graph in `(() => { … })()`,
    which drops the module record entirely instead of merely renaming it, so
    there is no top-level binding form left to be script-illegal. */
export const WORKER_BUNDLE_FORMAT = 'iife';

/** The EXACT `bun build` argv the worker is produced with, relative to
    `UI_ROOT`. One function so production and the gate cannot drift. */
export function workerBundleArgv(entry: string, outfile: string): string[] {
  return ['bun', 'build', entry, '--outfile', outfile, '--target', 'browser', `--format=${WORKER_BUNDLE_FORMAT}`];
}

/** Top-level module-only syntax. Line-anchored because the bundle is not
    minified, so anything at top level starts its own line; nested occurrences
    inside a string or a comment are not what breaks registration anyway — the
    parse gate below is the authority, these patterns exist to name the problem
    in a way an operator can act on.

    Dynamic `import(...)` is deliberately NOT listed: it is legal in a classic
    script and in a classic worker. `import.meta` is, because it is not. */
const ESM_TOPLEVEL_PATTERNS: readonly { re: RegExp; what: string }[] = [
  { re: /^[ \t]*export[\s{*]/m, what: 'a top-level `export` declaration' },
  { re: /^[ \t]*import[\s{*'"]/m, what: 'a top-level `import` declaration' },
  { re: /\bimport\.meta\b/, what: '`import.meta`' },
];

/** Why this bundle could not be registered as a classic worker; empty = fine.
    Pure, so the same function gates the build and is unit-testable.

    The parse gate is `new Function(source)`, NOT `node:vm`'s `Script`: Bun's
    `node:vm` shim happily compiles a top-level `export { … }` block, so it
    would have passed the very output that Chromium rejected. A Function body is
    parsed with the same script-level grammar for everything that matters here —
    `import`/`export` declarations and `import.meta` are SyntaxErrors in it, and
    it never runs the code. */
export function classicWorkerProblems(source: string): string[] {
  const problems: string[] = [];
  for (const { re, what } of ESM_TOPLEVEL_PATTERNS) {
    const hit = re.exec(source);
    if (hit) problems.push(`contains ${what} (at offset ${hit.index}) — illegal in a classic worker script`);
  }
  try {
    // Parse-only: constructing the function compiles the body; nothing calls it.
    new Function(source);
  } catch (error) {
    problems.push(`does not parse as a classic script: ${(error as Error).message}`);
  }
  return problems;
}

function run(cmd: string[], label: string): void {
  const proc = Bun.spawnSync(cmd, { cwd: UI_ROOT, stdout: 'inherit', stderr: 'inherit' });
  if (proc.exitCode !== 0) {
    console.error(`postbuild-pwa: ${label} failed (exit ${proc.exitCode})`);
    process.exit(proc.exitCode ?? 1);
  }
}

async function main(): Promise<void> {
  const release = releaseIdFromArgv(process.argv.slice(2));
  const outDir = resolve(UI_ROOT, outDirFromArgv(process.argv.slice(2)));

  const viteManifestPath = join(outDir, '.vite', 'manifest.json');
  if (!existsSync(viteManifestPath)) {
    console.error(`postbuild-pwa: missing ${viteManifestPath} — is build.manifest enabled in vite.config.ts?`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(viteManifestPath, 'utf8')) as ViteManifest;

  const icons = (
    JSON.parse(readFileSync(join(UI_ROOT, 'public', 'icons', 'icons.gen.json'), 'utf8')) as { icons: IconEntry[] }
  ).icons;

  const urls = [...precacheClosure(manifest), `/offline.${release}.html`, ...iconUrls(icons)].sort();

  // Sanity: every precache URL must actually exist in the output, or install
  // would fail at runtime on a non-OK response (the worker treats that as fatal).
  const missing = urls.filter(u => !existsSync(join(outDir, u.slice(1))));
  if (missing.length > 0) {
    console.error(`postbuild-pwa: ${missing.length} precache URL(s) absent from ${outDir}:`);
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }

  writeFileSync(PRECACHE_OUT, renderPrecacheModule(release, urls));
  console.log(`postbuild-pwa: precache list = ${urls.length} URL(s) → sw/precache.gen.ts`);

  if (existsSync(SW_ENTRY)) {
    run(['bunx', 'tsc', '-p', 'sw'], 'worker typecheck (tsc -p sw)');
    const outfile = join(outDir, workerName(release));
    run(workerBundleArgv(WORKER_ENTRY_REL, outfile), 'worker bundle');

    // The registration is classic, so an ESM bundle is a deploy-breaking
    // artifact that every other step reports as success. Fail the build here,
    // where the artifact exists and the cause is one flag away.
    const problems = classicWorkerProblems(readFileSync(outfile, 'utf8'));
    if (problems.length > 0) {
      console.error(
        `postbuild-pwa: ${workerName(release)} is not a valid classic worker script ` +
          `(registered with no \`type: 'module'\`, so the browser parses it with the script grammar):`,
      );
      for (const p of problems) console.error(`  - ${p}`);
      console.error(`Expected \`bun build --format=${WORKER_BUNDLE_FORMAT}\` output; see workerBundleArgv().`);
      process.exit(1);
    }
    console.log(`postbuild-pwa: bundled worker → ${workerName(release)} (classic ${WORKER_BUNDLE_FORMAT}, verified)`);
  } else {
    // Stage boundary, not an error — see the header.
    console.log('postbuild-pwa: sw/sw.ts absent (Stage D not landed) — skipping worker typecheck + bundle');
  }

  // The Vite manifest is a build-time artifact. Left in place it would be
  // served as an immutable root static, publishing the build graph for no
  // reason; and it is not part of any release contract.
  const viteDir = join(outDir, '.vite');
  rmSync(viteDir, { recursive: true, force: true });
  if (existsSync(viteDir)) {
    console.error(`postbuild-pwa: could not remove ${viteDir}`);
    process.exit(1);
  }
  console.log('postbuild-pwa: removed .vite/ from the output directory');
}

if (import.meta.main) await main();
