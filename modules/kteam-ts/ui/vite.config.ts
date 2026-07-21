import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Outdir lives OUTSIDE src/ so the daemon's Bun bundler (which TS-includes
// ./src/**) never sees or tries to resolve Vite-only assets. The daemon serves
// this directory as the SPA bundle.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../ui-dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
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
});
