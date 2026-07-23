import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The built SPA lands in ../ui-dist (a sibling of ui/, OUTSIDE src/) so the
// server's Bun runtime — which TS-includes ./src/** — never sees Vite-only
// assets. `kautopilot serve` serves ui-dist/ as the SPA bundle (with a legacy
// single-file shell fallback). During `vite dev` the /api proxy points at a
// running `kautopilot serve` on the default viewer port.
export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "../ui-dist",
		emptyOutDir: true,
		target: "es2022",
		sourcemap: false,
	},
	server: {
		port: 5174,
		proxy: {
			"/api": {
				target: "http://127.0.0.1:47317",
				changeOrigin: true,
			},
		},
	},
});
