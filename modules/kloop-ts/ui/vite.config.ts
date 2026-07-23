import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Outdir lives OUTSIDE src/ (../ui-dist, the module root) so the CLI's Bun bundler,
// which TS-includes ./src/**, never sees Vite-only assets. `kloop serve` serves that
// directory as the SPA bundle (see src/server/routes.ts). The build output is committed.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../ui-dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5175,
    proxy: {
      // During `vite dev`, talk to a real `kloop serve` on its default port so the UI
      // renders live runs. Forward the JSON API and the SSE streams.
      '/api': {
        target: 'http://127.0.0.1:47316',
        changeOrigin: true,
      },
      '/metrics': { target: 'http://127.0.0.1:47316', changeOrigin: true },
    },
  },
});
