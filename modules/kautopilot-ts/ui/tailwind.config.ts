import type { Config } from "tailwindcss";

// Color values live as CSS custom properties in src/index.css (hand-tuned light
// + dark zinc palette with a single indigo accent + muted semantic status hues).
// Tailwind tokens just reference those vars so dark mode (data-theme="dark")
// flips everything without duplicate class variants.
export default {
	darkMode: ["class", '[data-theme="dark"]'],
	content: ["./index.html", "./src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				bg: "var(--bg)",
				surface: "var(--surface)",
				"surface-2": "var(--surface-2)",
				raised: "var(--raised)",
				fg: "var(--fg)",
				"fg-soft": "var(--fg-soft)",
				muted: "var(--muted)",
				border: "var(--border)",
				"border-soft": "var(--border-soft)",
				accent: "var(--accent)",
				"accent-fg": "var(--accent-fg)",
				"accent-soft": "var(--accent-soft)",
				"accent-border": "var(--accent-border)",
				"code-bg": "var(--code-bg)",
				"code-border": "var(--code-border)",
				ok: "var(--ok)",
				"ok-bg": "var(--ok-bg)",
				"ok-border": "var(--ok-border)",
				warn: "var(--warn)",
				"warn-bg": "var(--warn-bg)",
				"warn-border": "var(--warn-border)",
				pend: "var(--pend)",
				"pend-bg": "var(--pend-bg)",
				"pend-border": "var(--pend-border)",
				err: "var(--err)",
				"err-bg": "var(--err-bg)",
				"err-border": "var(--err-border)",
				block: "var(--block)",
				"block-bg": "var(--block-bg)",
				"block-border": "var(--block-border)",
			},
			boxShadow: {
				sm: "var(--sh-sm)",
				md: "var(--sh-md)",
				lg: "var(--sh-lg)",
			},
			fontFamily: {
				ui: [
					"Inter",
					"system-ui",
					"-apple-system",
					"Segoe UI",
					"Roboto",
					"sans-serif",
				],
				mono: [
					"JetBrains Mono",
					"ui-monospace",
					"SF Mono",
					"Menlo",
					"Consolas",
					"monospace",
				],
			},
			borderRadius: {
				sm: "6px",
				md: "8px",
				lg: "10px",
			},
			maxWidth: {
				shell: "960px",
				prose: "760px",
			},
		},
	},
	plugins: [],
} satisfies Config;
