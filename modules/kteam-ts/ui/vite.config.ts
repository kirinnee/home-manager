import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { RELEASE_ENV, VITE_RELEASE_ENV, ReleaseIdError, assertReleaseId } from './scripts/release';

// Outdir lives OUTSIDE src/ so the daemon's Bun bundler (which TS-includes
// ./src/**) never sees or tries to resolve Vite-only assets. The daemon serves
// this directory as the SPA bundle.
//
// This config is a CHILD of scripts/build-pwa.ts, which computes the release ID
// once and exports it. Vite is never invoked directly for a real build: `bun run
// build` goes through the orchestrator, and the two release-derived values here
// (the `define` the app reads, and `%VITE_KTEAM_RELEASE%` in index.html) must
// come from that single value or the artifacts of one build would disagree about
// which release they belong to.
//
// `vite dev` has no release at all — no build, no worker, no fingerprinted
// manifest to point at — so the ID degrades to the literal 'devdevdevdev'
// rather than failing: a dev server that refuses to start because git is
// mid-rebase would be a bad trade. A BUILD without the env var fails loudly.
const DEV_RELEASE = 'devdevdevdev';

/** Resolve the release for this Vite invocation.

    A BUILD requires BOTH orchestrator variables, and requires them to agree.
    `KTEAM_RELEASE_ID` is the canonical value; `VITE_KTEAM_RELEASE` is the copy
    Vite exposes to `%VITE_KTEAM_RELEASE%` in index.html. Checking only the
    first would let a stale or hand-set `VITE_KTEAM_RELEASE` name a different
    generation in the HTML than the `define` compiled into the bundle — the
    manifest link and the app's own release constant would disagree, which is
    precisely the split brain the single-orchestrator rule exists to prevent.
    Nothing downstream can detect that, so it is checked here.

    Exported so scripts/build-pwa.test.ts can assert the missing/mismatch cases
    without spawning vite.

    `vite dev` has no release at all, so it degrades to a literal rather than
    failing (see the note above). */
export function releaseId(command: string, env: Record<string, string | undefined> = process.env): string {
  if (command === 'serve') return env[RELEASE_ENV] ?? DEV_RELEASE;
  const canonical = assertReleaseId(
    env[RELEASE_ENV],
    `${RELEASE_ENV} (set by scripts/build-pwa.ts — run \`bun run build\`, not \`vite build\`)`,
  );
  const viteCopy = assertReleaseId(
    env[VITE_RELEASE_ENV],
    `${VITE_RELEASE_ENV} (set by scripts/build-pwa.ts — index.html's %${VITE_RELEASE_ENV}% needs it)`,
  );
  if (viteCopy !== canonical) {
    throw new ReleaseIdError(
      `release id mismatch: ${RELEASE_ENV}=${canonical} but ${VITE_RELEASE_ENV}=${viteCopy}. ` +
        `index.html and the compiled bundle would name different releases.`,
    );
  }
  return canonical;
}

export default defineConfig(({ command }) => {
  const release = releaseId(command);
  return {
    plugins: [react()],
    define: {
      // Read by the app (Stage D's registration hook). A literal, so an
      // unreplaced identifier is a build-time error rather than a runtime
      // `undefined` inside a worker URL.
      __KTEAM_RELEASE__: JSON.stringify(release),
    },
    build: {
      outDir: '../ui-dist',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      // The worker's precache list is the FULL recursive closure of this
      // manifest (scripts/postbuild-pwa.ts). Without it there is no way to know
      // the lazily-imported chunk names, and the installed app would still need
      // the network for the chat page. postbuild deletes `.vite/` afterwards so
      // the manifest is never served as an immutable root static.
      manifest: true,
    },
    server: {
      port: 5173,
      proxy: {
        // Browser-local dictation prepares its explicitly chosen model from the
        // box too. Unlike /v1 this endpoint is public because model loaders do
        // plain fetches without the daemon bearer token.
        '/stt-models': {
          target: 'http://127.0.0.1:7337',
          changeOrigin: true,
        },
        // During `vite dev`, the UI talks to the real kteam daemon on loopback
        // so it can render live sessions; forward /v1 + WebSocket upgrades.
        '/v1': {
          target: 'http://127.0.0.1:7337',
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
