import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { RELEASE_ENV, assertReleaseId } from './scripts/release';

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

function releaseId(command: string): string {
  const fromEnv = process.env[RELEASE_ENV];
  if (command === 'serve') return fromEnv ?? DEV_RELEASE;
  // A build MUST have come through the orchestrator.
  return assertReleaseId(
    fromEnv,
    `${RELEASE_ENV} (set by scripts/build-pwa.ts — run \`bun run build\`, not \`vite build\`)`,
  );
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
