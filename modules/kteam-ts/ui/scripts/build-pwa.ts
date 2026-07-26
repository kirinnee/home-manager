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
   The guarded scope is deliberately wide (§4.1 step 1) — anything that can
   change an artifact, including tsconfigs, `.gitignore`, `bun.lock` and
   `brand/`.

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
  outDirFromArgv,
} from './release';

const HERE = dirname(new URL(import.meta.url).pathname);
const UI_ROOT = join(HERE, '..');
/** Repo-relative prefix of this package, for reading `git status --porcelain`. */
const PKG_PREFIX = 'modules/kteam-ts/ui/';

/** Every path whose content can change a build artifact. Directories are
    prefix-matched. Widened per audit C1 — a dirty tsconfig or lockfile changes
    output just as surely as a dirty source file. */
const GUARDED_INPUTS = [
  'index.html',
  'src/',
  'public/',
  'sw/',
  'scripts/',
  'brand/',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'sw/tsconfig.json',
  '.gitignore',
  'bun.lock',
  'package.json',
  'vite.config.ts',
] as const;

function git(args: string[]): string {
  const proc = Bun.spawnSync(['git', ...args], { cwd: UI_ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    console.error(`build-pwa: git ${args.join(' ')} failed: ${proc.stderr.toString().trim()}`);
    process.exit(2);
  }
  return proc.stdout.toString();
}

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
    without a dirty worktree. */
export function dirtyGuardedInputs(
  porcelain: string,
  pkgPrefix: string = PKG_PREFIX,
  guarded: readonly string[] = GUARDED_INPUTS,
): string[] {
  const hits = new Set<string>();
  for (const path of porcelainPaths(porcelain)) {
    if (!path.startsWith(pkgPrefix)) continue;
    const rel = path.slice(pkgPrefix.length);
    for (const input of guarded) {
      const matches = input.endsWith('/') ? rel.startsWith(input) : rel === input;
      if (matches) hits.add(rel);
    }
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
  const dirty = dirtyGuardedInputs(git(['status', '--porcelain']));
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
