/* ============================================================================
   THE BUILD ORCHESTRATOR — one process, one release transaction.

       bun run build                       # from modules/kteam-ts/ui
       bun run build -- --out-dir=/tmp/x   # verification build, served dist untouched
       bun run build -- --allow-dirty      # ESCAPE HATCH, see below

   Every path below is relative to `modules/kteam-ts/ui/` (this script's cwd).

   ── WHY ONE ORCHESTRATOR ──────────────────────────────────────────────────
   Five things must agree on one release identity: the worker's filename, the
   generated manifest names, the offline page name, the constant the app
   registers with, and the precache list. If each step ran `git rev-parse`
   itself, a commit landing mid-build would produce a release whose worker
   precaches a different generation's chunk list — a silent, hard-to-see split
   brain. So the ID is computed HERE, exactly once, and handed to every child:
   in-process steps by `--release=`, the Vite child by BOTH `define`
   (`__KTEAM_RELEASE__`, for app code) and the `VITE_KTEAM_RELEASE` environment
   variable (for `%VITE_KTEAM_RELEASE%` in index.html — a shell-local variable
   would never reach Vite's HTML transform, so the export is the contract).
   Children validate what they receive and never re-derive it.

   ── WHY THE CLEAN-SOURCE GUARD ────────────────────────────────────────────
   `RELEASE_ID` is the SOURCE COMMIT (`git rev-parse --short=12 HEAD`). That is
   what makes it pre-build and cycle-free — but it is only truthful if the tree
   matches the commit it names. Building with a dirty input would stamp commit
   X onto artifacts that are not commit X, and the deploy commit's provenance
   would be a lie. Hence: any modification to a build INPUT refuses the build.

   The guarded scope is the WHOLE PACKAGE minus a short, explicit list of
   provably-inert paths (`UNGUARDED_INPUTS`) — a DENYLIST. An audit found the
   earlier allowlist version silently exempted `tailwind.config.ts` and
   `postcss.config.js`, both of which change the emitted CSS: `dirtyGuardedInputs()`
   returned [] for a dirty tailwind config. An allowlist exempts every file
   nobody thought to enumerate, and the set of build-shaping config files grows
   over time. Inverting the polarity makes the failure mode "a harmless file
   refuses a build" (visible, one-line fix) instead of "a build lies about its
   provenance" (invisible).

   `--allow-dirty` exists for local iteration ONLY: it marks the release ID
   `<hash>` → prints a loud banner, and is rejected outright when the output
   directory is the real `../ui-dist`, so it can never produce a deployable
   build. A dirty *deploy* must still fail.

   Order of operations (§4.1): guard → ID → gen-pwa → tsc+vite → postbuild.
   ============================================================================ */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_OUT_DIR,
  OUT_DIR_ENV,
  RELEASE_ENV,
  VITE_RELEASE_ENV,
  assertReleaseId,
  isGeneratedPublicFile,
  outDirFromArgv,
} from './release';

const HERE = dirname(new URL(import.meta.url).pathname);
const UI_ROOT = join(HERE, '..');
/** Repo-relative prefix of this package, for reading `STATUS_ARGV` output. */
const PKG_PREFIX = 'modules/kteam-ts/ui/';

/** The ONLY paths in this package that are not build inputs. Everything else is
    guarded, so a config file nobody enumerated is covered by default rather
    than silently exempt (see "WHY THE CLEAN-SOURCE GUARD" above — an allowlist
    let a dirty `tailwind.config.ts` through).

    Directories are prefix-matched. Only add an entry when a change to it
    PROVABLY cannot alter build output. Docs and editor state qualify;
    `sw/precache.gen.ts` qualifies because this same build overwrites it. A
    "probably fine" config file does not. */
const UNGUARDED_INPUTS = [
  // Prose. Not read by any build step.
  'README.md',
  'CHANGELOG.md',
  // Editor and OS scratch.
  '.idea/',
  '.vscode/',
  '.DS_Store',
  // Written BY this build (postbuild-pwa), so its dirtiness is our own output.
  'sw/precache.gen.ts',
  // Never committed; `bun install` state is pinned by the guarded bun.lock.
  'node_modules/',
] as const;

/** gen-pwa's own release-suffixed output inside `public/`. Gitignored, so it
    should not reach porcelain at all — exempted anyway so a caller passing
    `--porcelain -unormal` cannot make a build refuse its own previous output.
    A LOOKALIKE (`manifest-studio-light.preview.json`) is NOT exempt: it is a
    real, reviewable input. */
function isUnguardedPublicFile(rel: string): boolean {
  const name = rel.slice('public/'.length);
  return isGeneratedPublicFile(name);
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(['git', ...args], { cwd: UI_ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    console.error(`build-pwa: git ${args.join(' ')} failed: ${proc.stderr.toString().trim()}`);
    process.exit(2);
  }
  return proc.stdout.toString();
}

/** The EXACT status invocation the guard uses. Exported so a regression test can
    run this argv itself rather than a hand-copied approximation of it — the
    escape below happened in the command, before `dirtyGuardedInputs()` ever saw
    a string, so a test that only feeds that function cannot catch a recurrence.

    `--untracked-files=all` is load-bearing twice over:

      1. Ambient config wins otherwise. A user or repo `status.showUntrackedFiles
         = no` makes a bare `git status --porcelain` print NOTHING for untracked
         files, so an untracked `future-build-shaping.config.mts` was invisible
         and the build proceeded, stamping the committed release ID onto a tree
         that contained an unreviewed build input. Found by audit after the
         denylist fix — the denylist was correct, but it was being handed an
         empty string.

      2. Even with default config, `-unormal` COLLAPSES an untracked directory to
         `newtool/` instead of listing its files. That still trips the guard (the
         prefix matches), but the operator would be told `newtool/` rather than
         which files, and any exemption logic reasoning about file paths would be
         comparing against a directory name.

    A command-line flag beats every config source, which is the point: the guard
    must not be silenceable by a setting outside this repo. */
export const STATUS_ARGV = ['status', '--porcelain', '--untracked-files=all'] as const;

/** Parse `git status --porcelain` into repo-relative paths, handling renames
    (`R  old -> new`) and quoted paths with spaces. */
export function porcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.trim() === '') continue;
    const body = line.slice(3);
    const arrow = body.indexOf(' -> ');
    const candidates = arrow === -1 ? [body] : [body.slice(0, arrow), body.slice(arrow + 4)];
    for (const c of candidates) paths.push(c.replace(/^"|"$/g, ''));
  }
  return paths;
}

/** Which guarded inputs are dirty. Pure, so the determinism gate can test it
    without a dirty worktree.

    Anything inside this package counts UNLESS it matches `UNGUARDED_INPUTS` or
    is this build's own generated public output. Note `pkgPrefix` keeps its
    trailing slash, so the sibling deploy directory `modules/kteam-ts/ui-dist/`
    is correctly outside the package. */
export function dirtyGuardedInputs(
  porcelain: string,
  pkgPrefix: string = PKG_PREFIX,
  unguarded: readonly string[] = UNGUARDED_INPUTS,
): string[] {
  const hits = new Set<string>();
  for (const path of porcelainPaths(porcelain)) {
    if (!path.startsWith(pkgPrefix)) continue;
    const rel = path.slice(pkgPrefix.length);
    if (rel === '') continue;
    const exempt =
      unguarded.some(entry => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry)) ||
      (rel.startsWith('public/') && isUnguardedPublicFile(rel));
    if (!exempt) hits.add(rel);
  }
  return [...hits].sort();
}

function step(label: string, cmd: string[], env: Record<string, string>): void {
  console.log(`\n▸ ${label}\n  $ ${cmd.join(' ')}`);
  const proc = Bun.spawnSync(cmd, {
    cwd: UI_ROOT,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (proc.exitCode !== 0) {
    console.error(`\nbuild-pwa: step "${label}" failed (exit ${proc.exitCode})`);
    process.exit(proc.exitCode ?? 1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const allowDirty = argv.includes('--allow-dirty');
  const outDirArg = outDirFromArgv(argv);
  const outDir = resolve(UI_ROOT, outDirArg);
  const isServedDist = outDir === resolve(UI_ROOT, DEFAULT_OUT_DIR);

  if (allowDirty && isServedDist) {
    console.error(
      'build-pwa: --allow-dirty is refused for the served output directory. ' +
        'A deployable build must be reproducible from a committed source commit. ' +
        'Pass --out-dir=<scratch path> to iterate locally.',
    );
    process.exit(2);
  }

  /* ---- 1. clean-source guard ------------------------------------------- */
  const dirty = dirtyGuardedInputs(git([...STATUS_ARGV]));
  if (dirty.length > 0) {
    if (!allowDirty) {
      console.error(
        `build-pwa: refusing to build — ${dirty.length} guarded build input(s) are uncommitted:\n` +
          dirty.map(p => `  - ${p}`).join('\n') +
          `\n\nThe release ID is the source commit, so an artifact built from an uncommitted tree would ` +
          `carry a commit hash that does not describe it. Commit the source first (that is the documented ` +
          `order: source commit → build → \`build(kteam-ui): deploy …\` commit).` +
          `\nFor local iteration only: --allow-dirty --out-dir=<scratch path>.`,
      );
      process.exit(1);
    }
    console.warn(
      `\n!! build-pwa: --allow-dirty — ${dirty.length} guarded input(s) uncommitted. ` +
        `Artifacts will be marked with a "-dirty" release and MUST NOT be deployed.\n`,
    );
  }

  /* ---- 2. release ID, computed exactly once ---------------------------- */
  const head = git(['rev-parse', '--short=12', 'HEAD']).trim();
  const release = assertReleaseId(head, 'git rev-parse --short=12 HEAD');
  console.log(`build-pwa: release ${release}${dirty.length > 0 ? ' (DIRTY — not deployable)' : ''}`);
  console.log(`build-pwa: output   ${outDir}${isServedDist ? ' (served dist)' : ' (scratch)'}`);

  // Exported to every child. `KTEAM_RELEASE_ID` is what children cross-check
  // their `--release=` argument against; `VITE_KTEAM_RELEASE` is what reaches
  // `%VITE_KTEAM_RELEASE%` in index.html.
  const childEnv: Record<string, string> = {
    [RELEASE_ENV]: release,
    [VITE_RELEASE_ENV]: release,
    [OUT_DIR_ENV]: outDirArg,
  };

  /* ---- 3. pre-build generation ----------------------------------------- */
  step('gen-pwa (manifests + offline page)', ['bun', 'scripts/gen-pwa.ts', `--release=${release}`], childEnv);

  /* ---- 4. compile + bundle -------------------------------------------- */
  step('tsc -b', ['bunx', 'tsc', '-b'], childEnv);
  step('vite build', ['bunx', 'vite', 'build', '--outDir', outDirArg, '--emptyOutDir'], childEnv);

  /* ---- 5. post-build -------------------------------------------------- */
  step(
    'postbuild-pwa (precache + worker)',
    ['bun', 'scripts/postbuild-pwa.ts', `--release=${release}`, `--out-dir=${outDirArg}`],
    childEnv,
  );

  if (!existsSync(join(outDir, 'index.html'))) {
    console.error(`build-pwa: ${outDir}/index.html missing after build`);
    process.exit(1);
  }

  console.log(`\nbuild-pwa: OK — release ${release} in ${outDir}`);
  if (dirty.length > 0) console.warn('build-pwa: reminder — this was a DIRTY build. Do not deploy it.');
}

// Guarded so the guard/porcelain helpers above can be imported by
// scripts/build-pwa.test.ts without kicking off a build.
if (import.meta.main) await main();
