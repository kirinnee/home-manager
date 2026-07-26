/* ============================================================================
   Release identity + artifact naming — the single contract every PWA build step
   shares.

   ONE process computes the release ID: `scripts/build-pwa.ts`. It runs
   `git rev-parse --short=12 HEAD` exactly once and hands the validated value to
   every child step (in-process steps by argument, the Vite child by env). No
   other file may call git for it. That is what makes the worker URL, the
   generated manifest/offline names, the app's registration constant and the
   precache list one atomic release instead of four independent guesses that
   drift if a commit lands mid-build.

   Children therefore *receive* the ID and validate it:
     * missing            → fail
     * malformed          → fail
     * != KTEAM_RELEASE_ID (when the orchestrator exported it) → fail
   so a hand-run `bun scripts/gen-pwa.ts` can never silently stamp a different
   generation into half the artifacts.
   ============================================================================ */

/** 12 hex chars — `git rev-parse --short=12`. Fixed width keeps every
    generated filename's shape predictable, which is what lets the cleanup
    globs in gen-pwa be scoped to *only* generated names. */
export const RELEASE_ID_RE = /^[0-9a-f]{12}$/;

/** Env var the orchestrator exports so children can cross-check the argument
    they were given. Also the `%VITE_KTEAM_RELEASE%`/`define` source of truth
    for the Vite child (see vite.config.ts). */
export const RELEASE_ENV = 'KTEAM_RELEASE_ID';

/** Vite-visible alias of the same value. Vite only exposes `VITE_*` vars to
    `%…%` HTML substitution, and index.html needs the release to name the
    manifest link — a shell-local variable would never reach the transform, so
    the orchestrator exports this one too. */
export const VITE_RELEASE_ENV = 'VITE_KTEAM_RELEASE';

/** Env var carrying the build output directory, so a verification build can be
    pointed at a scratch path and never touch the served `ui-dist`. */
export const OUT_DIR_ENV = 'KTEAM_OUT_DIR';

export const DEFAULT_OUT_DIR = '../ui-dist';

export const FAMILIES = ['studio', 'mission', 'neo', 'ember', 'contrast'] as const;
export const MODES = ['light', 'dark'] as const;
export type Family = (typeof FAMILIES)[number];
export type Mode = (typeof MODES)[number];

export class ReleaseIdError extends Error {}

/** Validate a release ID from any source. Throws with the source named, because
    "invalid release id" without a source is unactionable in a 5-step build. */
export function assertReleaseId(value: string | undefined, source: string): string {
  if (!value) {
    throw new ReleaseIdError(
      `missing release id (${source}). Every PWA build step must be invoked by scripts/build-pwa.ts, ` +
        `which computes it once from the committed source commit.`,
    );
  }
  if (!RELEASE_ID_RE.test(value)) {
    throw new ReleaseIdError(
      `malformed release id ${JSON.stringify(value)} (${source}); expected 12 lowercase hex chars`,
    );
  }
  return value;
}

/** Read `--release=<id>` from a child step's argv and cross-check it against the
    orchestrator's exported value. Never falls back to git. */
export function releaseIdFromArgv(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string {
  const flag = argv.find(a => a.startsWith('--release='));
  const fromArg = assertReleaseId(flag?.slice('--release='.length), '--release=<id>');
  const fromEnv = env[RELEASE_ENV];
  if (fromEnv !== undefined && fromEnv !== fromArg) {
    throw new ReleaseIdError(
      `release id mismatch: --release=${fromArg} but ${RELEASE_ENV}=${fromEnv}. ` +
        `A single build must stamp one generation into every artifact.`,
    );
  }
  return fromArg;
}

/** Read `--out-dir=<path>` (or the env fallback) for a child step. */
export function outDirFromArgv(argv: readonly string[], env: Record<string, string | undefined> = process.env): string {
  const flag = argv.find(a => a.startsWith('--out-dir='));
  return flag?.slice('--out-dir='.length) || env[OUT_DIR_ENV] || DEFAULT_OUT_DIR;
}

/* ---------- artifact names ------------------------------------------------
   Every PWA artifact is release- or content-addressed, so the api-server's
   unconditional `public, max-age=31536000, immutable` header on existing
   `ui-dist` files is *correct* for all of them: a new release means a new URL.
   The only uncached document is the SPA shell itself (`no-store`, re-read per
   request), and it always references the current names — so a client can never
   be pinned to a stale artifact by a header. This is why Stage C needs no
   api-server change and no daemon restart.
   -------------------------------------------------------------------------- */

export function manifestName(family: Family, mode: Mode, release: string): string {
  return `manifest-${family}-${mode}.${release}.json`;
}

export function offlineName(release: string): string {
  return `offline.${release}.html`;
}

export function workerName(release: string): string {
  return `sw.${release}.js`;
}

/** Matches ONLY gen-pwa's own output naming schemes (release-suffixed). Used to
    sweep stale generations out of `public/` before a build, without ever
    touching hand-authored public assets or the committed icons. */
export const GENERATED_PUBLIC_RE = [
  new RegExp(`^manifest-(${FAMILIES.join('|')})-(${MODES.join('|')})\\.[0-9a-f]{12}\\.json$`),
  /^offline\.[0-9a-f]{12}\.html$/,
];

export function isGeneratedPublicFile(name: string): boolean {
  return GENERATED_PUBLIC_RE.some(re => re.test(name));
}
