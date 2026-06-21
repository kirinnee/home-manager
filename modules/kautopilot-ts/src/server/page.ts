// ============================================================================
// The single-page HTML app shell served for every non-/api GET route. It reads
// window.location.pathname, fetches the matching /api endpoint, renders the raw
// markdown (via marked from a CDN) and runs mermaid on fenced mermaid blocks.
// No server-side markdown dependency — rendering is entirely client-side so
// mermaid diagrams work and stable URLs survive a full page reload.
//
// The browser script lives in CLIENT_SCRIPT (a plain string, NOT a template
// literal — so it may freely contain backticks/markup) and is interpolated into
// the shell once. SHELL_HTML is the full document string the server returns.
//
// Design system: a compact, professional engineering tool (Linear / GitHub /
// Vercel density). CSS custom properties drive a neutral zinc palette with a
// single understated indigo accent and muted semantic status colors, hand-tuned
// light + dark themes (via prefers-color-scheme), Inter for UI text and
// JetBrains Mono for code (loaded from a CDN with system fallbacks). Components:
// a slim hairline sticky top bar with breadcrumb + a small static SSE live
// indicator, a dense session list/table, flat semantic phase/status badges, a
// readable prose container (the one comfortable area) with syntax-highlighted
// code (highlight.js), themed mermaid cards, a compact table of contents, and a
// tight red/green diff view. Flat: 1px hairlines + subtle elevation, no
// gradients/glows/pulsing.
// ============================================================================

const STYLE = `
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap");

:root {
	color-scheme: light dark;
	/* spacing scale — tightened */
	--s-1: 4px; --s-2: 6px; --s-3: 10px; --s-4: 12px; --s-5: 16px; --s-6: 24px; --s-7: 36px;
	/* radius — smaller */
	--r-sm: 6px; --r-md: 8px; --r-lg: 10px; --r-full: 999px;
	/* type */
	--font-ui: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	--font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	/* light theme — neutral zinc surfaces + understated indigo accent */
	--bg: #fbfbfc;
	--surface: #ffffff;
	--surface-2: #f5f5f6;
	--raised: #ffffff;
	--fg: #18181b;
	--fg-soft: #3f3f46;
	--muted: #71717a;
	--border: #e4e4e7;
	--border-soft: #ececee;
	--accent: #4f5bd5;
	--accent-fg: #ffffff;
	--accent-soft: #eef0fb;
	--accent-border: #d4d8f4;
	--code-bg: #f5f5f6;
	--code-border: #e4e4e7;
	/* prose emphasis — restrained, distinct hues for scannability */
	--bold: #312e81;            /* indigo ink — heavier than the link accent */
	--italic: #0e7490;          /* muted teal */
	--inline-code: #b03060;     /* rose */
	--inline-code-bg: #fbeef2;
	--inline-code-border: #f1d6df;
	--ring: rgba(79, 91, 213, 0.4);
	/* semantic status — muted, low-saturation */
	--ok: #3f7e52; --ok-bg: #eef4f0; --ok-border: #cfe2d6;
	--warn: #8a6420; --warn-bg: #f7f1e6; --warn-border: #e7dac0;
	--pend: #52525b; --pend-bg: #f4f4f5; --pend-border: #e4e4e7;
	--err: #a14040; --err-bg: #f7eded; --err-border: #e6cfcf;
	--block: #98532f; --block-bg: #f6efe9; --block-border: #e3d3c5;
	/* diff — muted */
	--add: #3f7e52; --add-bg: #eef5f0; --add-gutter: #d3e6d9;
	--del: #a14040; --del-bg: #f6edee; --del-gutter: #e7d0d0;
	/* elevation — flat hairline + very subtle */
	--sh-sm: 0 1px 1px rgba(24,24,27,0.04);
	--sh-md: 0 1px 2px rgba(24,24,27,0.06), 0 2px 6px rgba(24,24,27,0.05);
	--sh-lg: 0 4px 16px rgba(24,24,27,0.1);
	--bar-bg: rgba(251,251,252,0.85);
}
@media (prefers-color-scheme: dark) {
	:root {
		/* deep neutral bg, slightly lighter raised surfaces, soft borders */
		--bg: #0a0a0b;
		--surface: #141416;
		--surface-2: #1b1b1e;
		--raised: #18181b;
		--fg: #f4f4f5;
		--fg-soft: #d4d4d8;
		--muted: #9b9ba3;
		--border: #2a2a2e;
		--border-soft: #222226;
		--accent: #8b93e8;
		--accent-fg: #0b0b0e;
		--accent-soft: #1c1c2c;
		--accent-border: #353560;
		--code-bg: #141416;
		--code-border: #2a2a2e;
		--bold: #c7ccf8;            /* light indigo */
		--italic: #6cc6d4;          /* light teal */
		--inline-code: #f0a2bf;     /* light rose */
		--inline-code-bg: #241820;
		--inline-code-border: #3a2630;
		--ring: rgba(139, 147, 232, 0.5);
		--ok: #6fae82; --ok-bg: #14241a; --ok-border: #234630;
		--warn: #c79a52; --warn-bg: #241d11; --warn-border: #463719;
		--pend: #9b9ba3; --pend-bg: #1b1b1e; --pend-border: #2e2e33;
		--err: #cc7d7d; --err-bg: #251616; --err-border: #482a2a;
		--block: #c08a5e; --block-bg: #241a11; --block-border: #463219;
		--add: #6fae82; --add-bg: #112318; --add-gutter: #1f3d29;
		--del: #cc7d7d; --del-bg: #231516; --del-gutter: #3f2424;
		--sh-sm: 0 1px 1px rgba(0,0,0,0.4);
		--sh-md: 0 1px 2px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.3);
		--sh-lg: 0 6px 24px rgba(0,0,0,0.55);
		--bar-bg: rgba(10,10,11,0.85);
	}
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; scroll-padding-top: 56px; }
body {
	margin: 0;
	background: var(--bg);
	color: var(--fg);
	font-family: var(--font-ui);
	font-size: 13.5px;
	line-height: 1.45;
	-webkit-font-smoothing: antialiased;
	text-rendering: optimizeLegibility;
	overflow-x: hidden;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: var(--r-sm); }
::selection { background: var(--accent-soft); }

/* ── top bar ─────────────────────────────────────────────────────────── */
header.bar {
	position: sticky;
	top: 0;
	z-index: 30;
	background: var(--bar-bg);
	border-bottom: 1px solid var(--border);
	backdrop-filter: saturate(160%) blur(10px);
	-webkit-backdrop-filter: saturate(160%) blur(10px);
}
.bar-inner {
	max-width: 960px;
	margin: 0 auto;
	padding: 0 var(--s-4);
	display: flex;
	align-items: center;
	gap: var(--s-3);
	min-height: 40px;
}
.crumb { font-size: 13px; line-height: 1.35; color: var(--muted); flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 1px; }
.crumb a { color: var(--muted); font-weight: 500; border-radius: 5px; padding: 1px 4px; max-width: 42vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumb a:hover { color: var(--accent); text-decoration: none; background: var(--accent-soft); }
.crumb .cur { color: var(--fg); font-weight: 600; padding: 1px 4px; }
.crumb .sep { margin: 0 1px; opacity: 0.4; }
/* live indicator — small, static, subtle (no pulse/glow) */
.live { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; line-height: 1; color: var(--muted); flex-shrink: 0; user-select: none; }
.live .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--pend); transition: background 0.25s; }
.live.on .dot { background: var(--ok); }
.live.beat .dot { background: var(--accent); }
.live .txt { display: none; }
@media (min-width: 480px) { .live .txt { display: inline; } }

/* slim top progress bar */
#progress {
	position: fixed; top: 0; left: 0; height: 2px; width: 0;
	background: var(--accent);
	z-index: 50; opacity: 0; transition: width 0.2s ease, opacity 0.3s;
}
#progress.go { opacity: 1; }

/* ── layout ──────────────────────────────────────────────────────────── */
main {
	max-width: 960px;
	margin: 0 auto;
	padding: var(--s-5) var(--s-4) var(--s-7);
}
main.prose-page { max-width: 760px; }
.page-head { margin-bottom: var(--s-4); }
h1.page-title { font-size: 1.25rem; font-weight: 650; letter-spacing: -0.01em; line-height: 1.25; margin: 0 0 var(--s-2); }
h1.page-title a { color: inherit; }
h1.page-title a:hover { color: var(--accent); text-decoration: none; }
.meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); color: var(--muted); font-size: 12.5px; line-height: 1.35; }
.meta-row .dotsep { opacity: 0.5; }
.section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin: var(--s-5) 0 var(--s-3); }

/* ── badges ──────────────────────────────────────────────────────────── */
.badge {
	display: inline-flex; align-items: center; gap: 4px;
	font-size: 11px; font-weight: 600; line-height: 1; letter-spacing: 0.01em;
	padding: 3px 7px; border-radius: var(--r-sm);
	border: 1px solid var(--border); background: var(--surface-2); color: var(--fg-soft);
	white-space: nowrap;
}
.badge .pip { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.9; }
.badge.ok { color: var(--ok); background: var(--ok-bg); border-color: var(--ok-border); }
.badge.warn { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-border); }
.badge.pend { color: var(--pend); background: var(--pend-bg); border-color: var(--pend-border); }
.badge.err { color: var(--err); background: var(--err-bg); border-color: var(--err-border); }
.badge.block { color: var(--block); background: var(--block-bg); border-color: var(--block-border); }
.badge.accent { color: var(--accent); background: var(--accent-soft); border-color: var(--accent-border); }

/* repo chips + PR */
.repos { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.repo-chip {
	display: inline-flex; align-items: center; gap: 0;
	border: 1px solid var(--border); border-radius: var(--r-sm);
	background: var(--surface-2); overflow: hidden; font-size: 11.5px; line-height: 1.3;
}
.repo-chip .name { padding: 3px 8px; font-weight: 600; color: var(--fg-soft); display: inline-flex; align-items: center; gap: 5px; }
.repo-chip .name .pip { width: 6px; height: 6px; border-radius: 50%; }
.repo-chip .pr {
	padding: 3px 8px; font-weight: 600; color: var(--accent);
	border-left: 1px solid var(--border); background: var(--accent-soft);
}
.repo-chip .pr:hover { background: var(--accent); color: var(--accent-fg); text-decoration: none; }
.pip.ok { background: var(--ok); } .pip.warn { background: var(--warn); }
.pip.pend { background: var(--pend); } .pip.err { background: var(--err); } .pip.block { background: var(--block); }

/* ── session list (compact rows) ─────────────────────────────────────── */
.rows {
	border: 1px solid var(--border); border-radius: var(--r-md);
	background: var(--surface); overflow: hidden;
}
.row {
	display: flex; align-items: center; gap: var(--s-3);
	padding: 9px var(--s-4); color: var(--fg);
	border-top: 1px solid var(--border-soft);
	transition: background 0.12s;
}
.row:first-child { border-top: none; }
a.row:hover { text-decoration: none; background: var(--surface-2); }
.row .r-id { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 3px; }
.row .r-ticket { font-weight: 600; font-size: 13.5px; color: var(--fg); letter-spacing: -0.01em; }
.row .r-sub { font-size: 11.5px; color: var(--muted); line-height: 1.3; }
.row .r-tags { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); flex: 0 1 auto; justify-content: flex-end; }
.row .r-repos { display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; }
@media (max-width: 560px) {
	.row { flex-wrap: wrap; align-items: flex-start; }
	.row .r-tags { width: 100%; justify-content: flex-start; }
	.row .r-repos { justify-content: flex-start; }
}

/* ── artifact rows ───────────────────────────────────────────────────── */
.art-list {
	border: 1px solid var(--border); border-radius: var(--r-md);
	background: var(--surface); overflow: hidden;
}
.art-row {
	display: flex; align-items: center; gap: var(--s-3);
	padding: 8px var(--s-4); color: var(--fg);
	border-top: 1px solid var(--border-soft);
	transition: background 0.12s;
}
.art-row:first-child { border-top: none; }
.art-row:hover { background: var(--surface-2); }
.art-row .a-name { font-weight: 600; font-size: 13px; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.art-row .a-name a { color: var(--fg); }
.art-row .a-name a:hover { color: var(--accent); text-decoration: none; }
.art-row .a-meta { display: flex; align-items: center; gap: var(--s-2); flex-shrink: 0; color: var(--muted); font-size: 11.5px; }
.art-row .a-meta a { font-weight: 600; }

/* ── version toolbar ─────────────────────────────────────────────────── */
.toolbar {
	display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
	margin: 0 0 var(--s-4); padding: 5px 6px; font-size: 12px;
	background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: var(--r-md);
}
.toolbar .label { color: var(--muted); font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; padding: 0 2px 0 5px; }
.toolbar .vsep { width: 1px; align-self: stretch; background: var(--border); margin: 2px 3px; }
.toolbar .chip {
	border: 1px solid var(--border); border-radius: var(--r-sm);
	padding: 3px 9px; background: var(--surface); color: var(--fg-soft); font-weight: 600;
	transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.toolbar .chip:hover { text-decoration: none; border-color: var(--accent-border); color: var(--accent); }
.toolbar .chip.active { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.toolbar .chip.diff { margin-left: auto; background: var(--accent-soft); color: var(--accent); border-color: var(--accent-border); }
.toolbar .chip.diff:hover { background: var(--accent); color: var(--accent-fg); }

/* ── table of contents ───────────────────────────────────────────────── */
details.toc {
	margin: 0 0 var(--s-4); border: 1px solid var(--border-soft); border-radius: var(--r-md);
	background: var(--surface-2); overflow: hidden;
}
details.toc > summary {
	cursor: pointer; list-style: none; padding: 7px var(--s-4);
	font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
	display: flex; align-items: center; gap: 7px;
}
details.toc > summary::-webkit-details-marker { display: none; }
details.toc > summary::before { content: "▸"; transition: transform 0.15s; font-size: 9px; }
details.toc[open] > summary::before { transform: rotate(90deg); }
details.toc ul { list-style: none; margin: 0; padding: 0 var(--s-4) var(--s-3); }
details.toc li { margin: 0; }
details.toc a { display: block; padding: 3px 0; color: var(--fg-soft); font-size: 12.5px; line-height: 1.35; }
details.toc a:hover { color: var(--accent); text-decoration: none; }
details.toc li.lvl3 a { padding-left: var(--s-4); font-size: 12px; color: var(--muted); }

/* ── prose (the one comfortable-to-read area) ────────────────────────── */
.prose { font-size: 15px; line-height: 1.65; color: var(--fg-soft); overflow-wrap: break-word; }
.prose > :first-child { margin-top: 0; }
.prose h1, .prose h2, .prose h3, .prose h4 {
	color: var(--fg); line-height: 1.3; font-weight: 700; letter-spacing: -0.015em;
	margin-top: 1.6em; margin-bottom: 0.5em; scroll-margin-top: 56px;
}
.prose h1 { font-size: 1.5rem; }
.prose h2 { font-size: 1.25rem; padding-bottom: 0.25em; border-bottom: 1px solid var(--border); }
.prose h3 { font-size: 1.1rem; }
.prose h4 { font-size: 1rem; }
.prose p { margin: 0.85em 0; }
.prose ul, .prose ol { margin: 0.85em 0; padding-left: 1.4em; }
.prose li { margin: 0.3em 0; }
.prose li::marker { color: var(--muted); }
.prose a { font-weight: 500; }
.prose a:hover { text-decoration: underline; }
.prose strong { color: var(--bold); font-weight: 700; }
.prose em { color: var(--italic); font-style: italic; }
/* markdown redline (rendered diff): inline insertions / deletions */
.prose ins.d-ins { text-decoration: none; background: var(--add-bg); color: var(--add); border-radius: 3px; padding: 0 2px; box-shadow: inset 0 -1.5px 0 var(--add-gutter); }
.prose del.d-del { text-decoration: line-through; text-decoration-color: var(--del); background: var(--del-bg); color: var(--del); border-radius: 3px; padding: 0 2px; }
.prose hr { border: none; border-top: 1px solid var(--border); margin: 1.6em 0; }
.prose blockquote {
	margin: 1em 0; padding: 0.4em 1em; color: var(--muted);
	border-left: 3px solid var(--accent); background: var(--accent-soft);
	border-radius: 0 var(--r-sm) var(--r-sm) 0;
}
.prose blockquote p { margin: 0.4em 0; }
.prose code {
	font-family: var(--font-mono); font-size: 0.85em;
	background: var(--inline-code-bg); border: 1px solid var(--inline-code-border);
	padding: 0.1em 0.4em; border-radius: 5px; color: var(--inline-code);
}
.prose pre {
	background: var(--code-bg); border: 1px solid var(--code-border);
	border-radius: var(--r-md); padding: var(--s-4); margin: 1.1em 0;
	overflow-x: auto; font-size: 0.82rem; line-height: 1.55;
	-webkit-overflow-scrolling: touch;
}
.prose pre code { background: none; border: none; padding: 0; font-size: inherit; color: inherit; }
.prose img { max-width: 100%; border-radius: var(--r-sm); }
/* tables */
.table-wrap { margin: 1.1em 0; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--r-md); -webkit-overflow-scrolling: touch; }
.prose table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
.prose th, .prose td { padding: 6px 11px; text-align: left; border-bottom: 1px solid var(--border-soft); }
.prose th { background: var(--surface-2); font-weight: 600; color: var(--fg); white-space: nowrap; }
.prose tbody tr:nth-child(even) { background: var(--surface-2); }
.prose tbody tr:last-child td { border-bottom: none; }
/* mermaid */
.prose .mermaid-card {
	margin: 1.2em 0; padding: var(--s-4); border: 1px solid var(--border);
	border-radius: var(--r-md); background: var(--surface); text-align: center;
	overflow-x: auto; -webkit-overflow-scrolling: touch;
}
.prose .mermaid { display: inline-block; }

/* ── diff ────────────────────────────────────────────────────────────── */
.diff-head { display: flex; align-items: center; gap: var(--s-2); margin: 0 0 var(--s-3); font-size: 0.9rem; }
.diff-head .vlabel { font-family: var(--font-mono); font-weight: 600; }
.diff-controls { display: flex; gap: var(--s-3); margin: 0 0 var(--s-4); flex-wrap: wrap; }
.seg-group { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-sm); overflow: hidden; }
.seg-group .seg { background: var(--surface); color: var(--muted); border: none; border-right: 1px solid var(--border); padding: 4px 11px; font: inherit; font-size: 0.78rem; cursor: pointer; }
.seg-group .seg:last-child { border-right: none; }
.seg-group .seg.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.diff-side { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-4); }
.diff-pane { border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; min-width: 0; }
.diff-pane-h { font-family: var(--font-mono); font-size: 0.76rem; padding: 4px 10px; background: var(--surface-2); border-bottom: 1px solid var(--border); color: var(--muted); }
.diff-pane .prose { font-size: 13.5px; padding: var(--s-4); }
@media (max-width: 720px) { .diff-side { grid-template-columns: 1fr; } }

/* ── kloop run viewer ─────────────────────────────────────────────────── */
.klist { display: flex; flex-direction: column; gap: var(--s-2); }
.krow { display: flex; align-items: center; gap: var(--s-3); padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); }
.krow:hover { background: var(--surface-2); text-decoration: none; }
.krow .kid { font-family: var(--font-mono); font-weight: 600; color: var(--fg); }
.krow .kws { color: var(--fg-soft); }
.krow .kmeta, .kmeta { color: var(--muted); font-size: 0.82rem; margin-left: auto; }
.khero { padding: var(--s-4); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); margin-bottom: var(--s-5); }
.khero .kid { font-family: var(--font-mono); font-weight: 700; }
.khero .kws { font-family: var(--font-mono); font-size: 0.8rem; color: var(--muted); margin-top: 4px; word-break: break-all; }
.khero .kmeta { margin-left: 0; margin-top: 6px; }
.kbanner { margin-top: 10px; padding: 6px 10px; border-radius: var(--r-sm); background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn-border); font-size: 0.85rem; }
.kcard { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); padding: var(--s-3) var(--s-4); margin-bottom: var(--s-3); }
.kcard-h { font-weight: 600; font-size: 0.9rem; margin-bottom: 6px; display: flex; align-items: center; gap: var(--s-2); }
.kline { font-size: 0.85rem; color: var(--fg-soft); padding: 2px 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.kerr { color: var(--err); font-size: 0.82rem; margin-top: 4px; white-space: pre-wrap; }
.kmuted { color: var(--muted); font-size: 0.82rem; }
.hbadge { font-size: 0.7rem; padding: 1px 6px; border-radius: var(--r-full); background: var(--surface-2); border: 1px solid var(--border); color: var(--muted); }
.kbtns { display: flex; gap: var(--s-2); flex-wrap: wrap; margin-top: 4px; }
.klog { background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-sm); padding: var(--s-3); overflow-x: auto; font-size: 0.78rem; line-height: 1.5; max-height: 480px; overflow-y: auto; white-space: pre-wrap; }
.diff-wrap {
	border: 1px solid var(--code-border); border-radius: var(--r-md);
	background: var(--code-bg); overflow-x: auto; -webkit-overflow-scrolling: touch;
	font-family: var(--font-mono); font-size: 0.78rem; line-height: 1.5;
}
.diff-wrap .ln { display: flex; white-space: pre; min-width: max-content; }
.diff-wrap .gutter { flex-shrink: 0; width: 20px; text-align: center; user-select: none; color: var(--muted); opacity: 0.8; border-right: 1px solid var(--border-soft); }
.diff-wrap .code { padding: 0 12px 0 10px; flex: 1; }
.diff-wrap .add { background: var(--add-bg); color: var(--add); }
.diff-wrap .add .gutter { background: var(--add-gutter); color: var(--add); opacity: 1; }
.diff-wrap .del { background: var(--del-bg); color: var(--del); }
.diff-wrap .del .gutter { background: var(--del-gutter); color: var(--del); opacity: 1; }
.diff-wrap .meta { color: var(--muted); }

/* ── states ──────────────────────────────────────────────────────────── */
.muted { color: var(--muted); }
.empty {
	color: var(--muted); padding: var(--s-7) var(--s-4); text-align: center;
	border: 1px dashed var(--border); border-radius: var(--r-md); background: var(--surface-2);
}
.empty h1 { font-size: 1.05rem; color: var(--fg); margin: 0 0 var(--s-2); }
.empty p { margin: var(--s-1) 0; font-size: 12.5px; }
/* skeleton */
.skel { display: grid; gap: var(--s-2); }
.skel-card { height: 44px; border-radius: var(--r-md); border: 1px solid var(--border-soft); background:
	linear-gradient(100deg, var(--surface-2) 30%, var(--surface) 50%, var(--surface-2) 70%);
	background-size: 200% 100%; animation: shimmer 1.3s ease-in-out infinite; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* ── update note (quiet, auto-fading) ────────────────────────────────── */
#toast {
	position: fixed; right: var(--s-4); bottom: var(--s-4); transform: translateY(6px);
	z-index: 40; background: var(--surface); color: var(--fg-soft);
	font-size: 11.5px; font-weight: 500; padding: 5px 10px; border-radius: var(--r-sm);
	border: 1px solid var(--border); box-shadow: var(--sh-md);
	opacity: 0; pointer-events: none;
	transition: opacity 0.25s, transform 0.25s; display: flex; align-items: center; gap: 6px;
}
#toast.show { opacity: 1; transform: translateY(0); }
#toast .d { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }

@media (prefers-reduced-motion: reduce) {
	* { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; scroll-behavior: auto; }
}
`;

// The browser-side module. A plain single-quoted/escaped string so it can hold
// backticks, markup and the mermaid keyword without breaking TypeScript parsing.
const CLIENT_SCRIPT = [
	'import { marked } from "https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js";',
	'import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";',
	'import hljs from "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/es/highlight.min.js";',
	'const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;',
	'mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "loose", fontFamily: "inherit" });',
	"// highlight.js theme: a github-style theme per scheme, loaded as a <link> at runtime (no bundler).",
	'const hlHref = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/" + (dark ? "github-dark" : "github") + ".min.css";',
	'{ const l = document.createElement("link"); l.rel = "stylesheet"; l.href = hlHref; document.head.appendChild(l); }',
	'const app = document.getElementById("app");',
	'const main = document.getElementById("main");',
	'const crumbEl = document.getElementById("crumb");',
	'const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;" }[c]));',
	"// ── tiny helpers ──────────────────────────────────────────────────────",
	"const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };",
	"// Map a repo/phase status word to a semantic tone (badge/pip color class).",
	"function tone(status) {",
	"  const s = String(status || '').toLowerCase();",
	"  if (/(done|ready|approved|merged|success|complete|pass|open)/.test(s)) return 'ok';",
	"  if (/(run|active|progress|exec|working|build)/.test(s)) return 'warn';",
	"  if (/(fail|error|reject)/.test(s)) return 'err';",
	"  if (/(block|conflict|stuck)/.test(s)) return 'block';",
	"  return 'pend';",
	"}",
	"// Phase → tone for the phase badge.",
	"function phaseTone(phase) {",
	"  const p = String(phase || '').toLowerCase();",
	"  if (p.includes('plan')) return 'accent';",
	"  if (p.includes('exec')) return 'warn';",
	"  if (p.includes('polish')) return 'ok';",
	"  if (p.includes('feedback')) return 'block';",
	"  return 'pend';",
	"}",
	"// ── top progress bar ─────────────────────────────────────────────────",
	'const prog = document.getElementById("progress");',
	"let progT;",
	"function progStart() { clearTimeout(progT); prog.classList.add('go'); prog.style.width = '30%'; progT = setTimeout(() => { prog.style.width = '70%'; }, 120); }",
	"function progDone() { clearTimeout(progT); prog.style.width = '100%'; setTimeout(() => { prog.classList.remove('go'); prog.style.width = '0'; }, 250); }",
	"async function api(path) {",
	"  progStart();",
	"  try {",
	'    const r = await fetch("/api" + path);',
	"    if (!r.ok) return null;",
	"    return await r.json();",
	"  } finally { progDone(); }",
	"}",
	"function crumbs(parts) {",
	"  crumbEl.innerHTML = parts",
	"    .map((p, i) => {",
	"      if (p.href) return '<a href=\"' + esc(p.href) + '\">' + esc(p.text) + '</a>';",
	"      return '<span class=\"cur\">' + esc(p.text) + '</span>';",
	"    })",
	"    .join('<span class=\"sep\">/</span>');",
	"}",
	"function showSkeleton(n) {",
	"  main.classList.remove('prose-page');",
	"  let h = '<div class=\"skel\">';",
	"  for (let i = 0; i < (n || 4); i++) h += '<div class=\"skel-card\"></div>';",
	"  h += '</div>';",
	"  app.innerHTML = h;",
	"}",
	"// Render markdown into a polished prose container: wrap tables for horizontal",
	"// scroll, upgrade fenced mermaid blocks to themed cards, syntax-highlight code,",
	"// give headings ids, and build a collapsible table of contents for long docs.",
	"// Pure markdown -> HTML string.",
	"function renderMd(md) { return (md && md.trim()) ? marked.parse(md) : ''; }",
	"// Upgrade an already-rendered .prose container in place: wrap tables, mermaid",
	"// cards, syntax-highlight code, give headings ids, run mermaid. (No TOC/append.)",
	"async function upgradeProse(div) {",
	'  div.querySelectorAll("table").forEach((t) => {',
	"    if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return;",
	'    const w = el("div", "table-wrap");',
	"    t.replaceWith(w); w.appendChild(t);",
	"  });",
	'  div.querySelectorAll("code.language-mermaid").forEach((code) => {',
	'    const card = el("div", "mermaid-card");',
	'    const pre = el("pre", "mermaid");',
	"    pre.textContent = code.textContent;",
	"    card.appendChild(pre);",
	'    const parent = code.closest("pre");',
	"    (parent || code).replaceWith(card);",
	"  });",
	'  div.querySelectorAll("pre code").forEach((code) => {',
	"    if (code.closest('.mermaid-card')) return;",
	"    try { hljs.highlightElement(code); } catch (_e) { /* leave plain */ }",
	"  });",
	"  const used = {};",
	'  for (const h of div.querySelectorAll("h2, h3")) {',
	"    let slug = (h.textContent || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';",
	"    if (used[slug] != null) { used[slug]++; slug = slug + '-' + used[slug]; } else used[slug] = 0;",
	"    h.id = slug;",
	"  }",
	'  const blocks = div.querySelectorAll("pre.mermaid");',
	"  if (blocks.length) { try { await mermaid.run({ nodes: blocks }); } catch (_e) { /* leave source */ } }",
	"}",
	"async function renderMarkdown(md) {",
	"  if (!md || !md.trim()) { app.appendChild(el('div', 'empty', 'No content yet.')); return; }",
	'  const div = el("div", "prose");',
	"  div.innerHTML = renderMd(md);",
	"  await upgradeProse(div);",
	"  // table of contents for long docs",
	'  const heads = [...div.querySelectorAll("h2, h3")];',
	"  if (heads.length >= 4) {",
	'    const toc = el("details", "toc");',
	"    if (window.matchMedia('(min-width: 720px)').matches) toc.open = true;",
	"    let items = '<summary>On this page</summary><ul>';",
	"    for (const h of heads) {",
	"      const cls = h.tagName === 'H3' ? 'lvl3' : 'lvl2';",
	"      items += '<li class=\"' + cls + '\"><a href=\"#' + esc(h.id) + '\">' + esc(h.textContent || '') + '</a></li>';",
	"    }",
	"    items += '</ul>';",
	"    toc.innerHTML = items;",
	"    app.appendChild(toc);",
	"  }",
	"  app.appendChild(div);",
	"}",
	"// --- markdown REDLINE diff ------------------------------------------------",
	"// Word-level diff of two markdown docs, rendered as formatted prose with inline",
	"// <ins>/<del> (track-changes), NOT a code-style line diff. Equal tokens pass",
	"// through verbatim so the markdown structure of unchanged content still renders.",
	"// Word tokens, but keep markdown inline constructs (links/images, code spans,",
	"// HTML tags, bold/italic) ATOMIC so a change never splices an <ins>/<del> inside",
	"// one and corrupts the render. Order matters: constructs before bare words.",
	"function tokenizeMd(s) { return String(s).match(/!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)|`[^`\\n]+`|<[^>\\n]+>|\\*\\*[^*\\n]+\\*\\*|\\*[^*\\n]+\\*|\\n|[^\\S\\n]+|[^\\s]+/g) || []; }",
	"function lcsDiff(a, b) {",
	"  const n = a.length, m = b.length;",
	"  // Guard against an O(n*m) blowup on very large docs: fall back to del-all + ins-all.",
	"  if (n * m > 4000000) return [{ t: 'del', s: a.join('') }, { t: 'ins', s: b.join('') }];",
	"  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));",
	"  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)",
	"    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);",
	"  const out = []; let i = 0, j = 0;",
	"  while (i < n && j < m) {",
	"    if (a[i] === b[j]) { out.push({ t: 'eq', s: a[i] }); i++; j++; }",
	"    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: a[i] }); i++; }",
	"    else { out.push({ t: 'ins', s: b[j] }); j++; }",
	"  }",
	"  while (i < n) out.push({ t: 'del', s: a[i++] });",
	"  while (j < m) out.push({ t: 'ins', s: b[j++] });",
	"  return out;",
	"}",
	"// Tokenize for word-by-word (default) or line-by-line granularity.",
	"function diffTokens(s, gran) {",
	"  return gran === 'line' ? (String(s).match(/[^\\n]*\\n|[^\\n]+/g) || []) : tokenizeMd(s);",
	"}",
	"// Diff two markdown docs → merged runs [{t:'eq'|'ins'|'del', s}].",
	"function diffRuns(fromMd, toMd, gran) {",
	"  const diff = lcsDiff(diffTokens(fromMd, gran), diffTokens(toMd, gran));",
	"  const runs = []; let cur = null;",
	"  for (const seg of diff) { if (!cur || seg.t !== cur.t) { cur = { t: seg.t, s: '' }; runs.push(cur); } cur.s += seg.s; }",
	"  return runs;",
	"}",
	"const insTag = (s) => !s ? '' : '<ins class=\"d-ins\">' + s + '</ins>';",
	"const delTag = (s) => !s ? '' : '<del class=\"d-del\">' + s + '</del>';",
	"// Inline redline: one rendered doc with insertions + deletions woven in.",
	"function redlineInline(runs) {",
	"  return runs.map(r => r.t === 'ins' ? insTag(r.s) : r.t === 'del' ? delTag(r.s) : r.s).join('');",
	"}",
	"// Side-by-side: left = original (deletions marked), right = new (insertions marked).",
	"function redlineSides(runs) {",
	"  let L = '', R = '';",
	"  for (const r of runs) { if (r.t === 'eq') { L += r.s; R += r.s; } else if (r.t === 'del') { L += delTag(r.s); } else { R += insTag(r.s); } }",
	"  return { left: L, right: R };",
	"}",
	"// The version switcher. When revisions carry epochs, chips are grouped +",
	"// labelled by epoch, e.g. `Epoch 1: v1 v2 · Epoch 2: v3`. When the epochs are",
	"// null/absent (epoch-agnostic artifacts like brainstorm), a FLAT chip list is",
	"// rendered with no `Epoch N:` labels. The current version is highlighted, plus",
	"// a `diff vs previous` button pushed to the right.",
	"function versionToolbar(baseHref, current, versions, diffHref) {",
	"  if (!versions.length) return;",
	'  const bar = el("div", "toolbar");',
	"  // Group by epoch only when every revision has a non-null epoch.",
	"  const grouped = versions.every((r) => r.epoch != null);",
	"  let lastEpoch = null;",
	"  for (const r of versions) {",
	"    if (grouped && r.epoch !== lastEpoch) {",
	'      if (lastEpoch !== null) bar.appendChild(el("span", "vsep"));',
	'      bar.appendChild(el("span", "label", "Epoch " + esc(r.epoch)));',
	"      lastEpoch = r.epoch;",
	"    }",
	'    const a = el("a", "chip" + (r.version === current ? " active" : ""));',
	"    a.href = baseHref + '/v' + r.version; a.textContent = 'v' + r.version;",
	"    bar.appendChild(a);",
	"  }",
	"  if (diffHref && versions.length > 1) {",
	'    const d = el("a", "chip diff"); d.href = diffHref; d.textContent = "Diff vs previous"; bar.appendChild(d);',
	"  }",
	"  app.appendChild(bar);",
	"}",
	"// A repo chip: name + status pip, plus a clickable PR badge when a prUrl is set.",
	"function repoChip(r) {",
	"  const t = tone(r.status);",
	"  let html = '<span class=\"name\"><span class=\"pip ' + t + '\"></span>' + esc(r.repo) + '</span>';",
	"  if (r.prUrl) {",
	"    const n = r.prNumber == null ? 'PR' : 'PR #' + esc(r.prNumber);",
	'    html += \'<a class="pr" target="_blank" rel="noopener" href="\' + esc(r.prUrl) + \'">\' + n + \'</a>\';',
	"  }",
	"  return '<span class=\"repo-chip\">' + html + '</span>';",
	"}",
	"async function renderIndex() {",
	'  crumbs([{ text: "Sessions" }]);',
	"  showSkeleton(4);",
	'  const sessions = await api("/sessions");',
	'  app.innerHTML = "";',
	"  main.classList.remove('prose-page');",
	'  const head = el("div", "page-head");',
	'  head.innerHTML = \'<h1 class="page-title">Sessions</h1><div class="meta-row">kautopilot autopilot runs · <a href="/kloop">Kloop runs →</a></div>\';',
	"  app.appendChild(head);",
	"  if (!sessions || sessions.length === 0) {",
	"    app.appendChild(el('div', 'empty', '<h1>No sessions yet</h1><p>Start an autopilot run and it will show up here.</p>'));",
	"    return;",
	"  }",
	'  const rows = el("div", "rows");',
	"  for (const s of sessions) {",
	'    const a = el("a", "row");',
	"    a.href = '/sessions/' + encodeURIComponent(s.id);",
	"    const repos = (s.repos || []).map(repoChip).join('');",
	"    const sys = s.ticketSystem ? esc(s.org) + ' · ' + esc(s.ticketSystem) : esc(s.org);",
	"    const phase = '<span class=\"badge ' + phaseTone(s.phase) + '\"><span class=\"pip\"></span>' + esc(s.phase) + '</span>';",
	"    a.innerHTML =",
	"      '<div class=\"r-id\"><span class=\"r-ticket\">' + esc(s.ticketId) + '</span>' +",
	"        '<span class=\"r-sub\">' + sys + ' · epoch ' + esc(s.epoch) + ' · ' + esc(s.id) + '</span></div>' +",
	"      '<div class=\"r-tags\">' + (repos ? '<span class=\"r-repos\">' + repos + '</span>' : '') + phase + '</div>';",
	"    rows.appendChild(a);",
	"  }",
	"  app.appendChild(rows);",
	"}",
	"async function renderSession(id) {",
	'  crumbs([{ text: "Sessions", href: "/" }, { text: id }]);',
	"  showSkeleton(4);",
	'  const d = await api("/sessions/" + encodeURIComponent(id));',
	'  app.innerHTML = "";',
	"  main.classList.remove('prose-page');",
	"  if (!d) { notFound(id); return; }",
	"  const m = d.meta;",
	"  const ticketText = m.ticketId || id;",
	"  const sys = m.ticketSystem ? esc(m.org) + ' · ' + esc(m.ticketSystem) : esc(m.org);",
	'  const head = el("div", "page-head");',
	"  let metaRow =",
	"    sys +",
	"    '<span class=\"dotsep\">·</span><span class=\"badge ' + phaseTone(d.phase) + '\"><span class=\"pip\"></span>' + esc(d.phase) + ' (' + esc(d.state) + ')</span>' +",
	"    '<span class=\"dotsep\">·</span><span>epoch ' + esc(m.epoch) + '</span>' +",
	"    '<span class=\"dotsep\">·</span><span>base ' + esc(m.baseBranch) + '</span>';",
	"  head.innerHTML =",
	"    '<h1 class=\"page-title\"><a href=\"/sessions/' + esc(id) + '/ticket\">' + esc(ticketText) + '</a></h1>' +",
	"    '<div class=\"meta-row\">' + metaRow + '</div>';",
	"  const repos = (m.repos || []).map(repoChip).join('');",
	"  if (repos) head.innerHTML += '<div class=\"repos\" style=\"margin-top:10px\">' + repos + '</div>';",
	"  app.appendChild(head);",
	"  // ── artifacts ──",
	"  app.appendChild(el('div', 'section-title', 'Artifacts'));",
	'  const list = el("div", "art-list");',
	"  const a = d.artifacts;",
	"  const latestVersion = (revs) => (revs.length ? revs[revs.length - 1].version : null);",
	"  // Highest non-null epoch across revs, or null when every rev is",
	"  // epoch-agnostic (e.g. brainstorm, which precedes any epoch).",
	"  const maxEpoch = (revs) => {",
	"    const es = (revs || []).map((r) => r.epoch).filter((e) => e != null);",
	"    return es.length ? Math.max.apply(null, es) : null;",
	"  };",
	"  const artRow = (href, label, revs, diffHref) => {",
	'    const row = el("div", "art-row");',
	"    let meta = '';",
	"    if (revs) {",
	"      const latest = latestVersion(revs);",
	"      meta += '<span class=\"badge accent\">v' + (latest == null ? '—' : latest) + '</span>';",
	"      if (maxEpoch(revs) != null) meta += '<span>epoch ' + esc(maxEpoch(revs)) + '</span>';",
	"      if (diffHref && revs.length > 1) meta += '<span class=\"dotsep\">·</span><a href=\"' + esc(diffHref) + '\">diff</a>';",
	"    }",
	"    row.innerHTML =",
	"      '<span class=\"a-name\"><a href=\"' + esc(href) + '\">' + esc(label) + '</a></span>' +",
	"      (meta ? '<span class=\"a-meta\">' + meta + '</span>' : '');",
	"    return row;",
	"  };",
	"  if (a.ticket) list.appendChild(artRow('/sessions/' + encodeURIComponent(id) + '/ticket', 'Ticket', null, null));",
	'  for (const kind of ["brainstorm", "triage", "spec", "feedback"]) {',
	"    if (a[kind] && a[kind].length) {",
	"      const base = '/sessions/' + encodeURIComponent(id) + '/' + kind;",
	"      const href = base + '/v' + latestVersion(a[kind]);",
	"      list.appendChild(artRow(href, kind.charAt(0).toUpperCase() + kind.slice(1), a[kind], base + '/diff'));",
	"    }",
	"  }",
	"  for (const repo of Object.keys(a.plans || {})) {",
	"    const revs = a.plans[repo];",
	"    const latest = latestVersion(revs);",
	"    const base = '/sessions/' + encodeURIComponent(id) + '/plans/' + encodeURIComponent(repo);",
	"    const href = base + (latest ? '/v' + latest : '');",
	"    list.appendChild(artRow(href, 'Plans · ' + repo, revs, base + '/diff'));",
	"  }",
	"  if (!list.children.length) app.appendChild(el('div', 'empty', 'No artifacts yet.'));",
	"  else app.appendChild(list);",
	"}",
	"async function renderDoc(id, kind, version, isPlan, repo) {",
	"  const apiPath = isPlan",
	"    ? '/sessions/' + encodeURIComponent(id) + '/plans/' + encodeURIComponent(repo) + (version ? '/v/' + version : '')",
	"    : '/sessions/' + encodeURIComponent(id) + '/doc/' + kind + (version ? '/v/' + version : '');",
	"  showSkeleton(3);",
	"  const d = await api(apiPath);",
	'  app.innerHTML = "";',
	"  main.classList.add('prose-page');",
	"  const label = isPlan ? 'Plans · ' + repo : kind.charAt(0).toUpperCase() + kind.slice(1);",
	'  crumbs([{ text: "Sessions", href: "/" }, { text: id, href: "/sessions/" + encodeURIComponent(id) }, { text: label + (d && d.version ? " v" + d.version : "") }]);',
	"  if (!d) { notFound(id); return; }",
	'  const head = el("div", "page-head");',
	"  head.innerHTML = '<h1 class=\"page-title\">' + esc(label) + (d.version ? ' <span class=\"muted\" style=\"font-weight:500;font-size:0.7em\">v' + esc(d.version) + '</span>' : '') + '</h1>';",
	"  app.appendChild(head);",
	"  const baseHref = isPlan ? '/sessions/' + encodeURIComponent(id) + '/plans/' + encodeURIComponent(repo) : '/sessions/' + encodeURIComponent(id) + '/' + kind;",
	"  const diffHref = baseHref + '/diff';",
	'  versionToolbar(baseHref, d.version, d.versions || [], kind === "ticket" ? null : diffHref);',
	"  await renderMarkdown(d.markdown);",
	"}",
	"async function renderDiffView(id, kind, isPlan, repo) {",
	"  // Forward any ?from=&to= so explicit/shared diff links honor the version pair.",
	"  const apiPath = (isPlan",
	"    ? '/sessions/' + encodeURIComponent(id) + '/diff/plans/' + encodeURIComponent(repo)",
	"    : '/sessions/' + encodeURIComponent(id) + '/diff/' + kind) + window.location.search;",
	"  showSkeleton(1);",
	"  const d = await api(apiPath);",
	'  app.innerHTML = "";',
	"  main.classList.add('prose-page');",
	"  const label = isPlan ? 'Plans · ' + repo : kind;",
	"  const backHref = isPlan ? '/sessions/' + encodeURIComponent(id) + '/plans/' + encodeURIComponent(repo) : '/sessions/' + encodeURIComponent(id) + '/' + kind;",
	'  crumbs([{ text: "Sessions", href: "/" }, { text: id, href: "/sessions/" + encodeURIComponent(id) }, { text: label, href: backHref }, { text: "diff" }]);',
	"  if (!d) { notFound(id); return; }",
	'  const head = el("div", "diff-head");',
	"  const vstr = (d.fromVersion && d.toVersion) ? '<span class=\"vlabel\">v' + esc(d.fromVersion) + ' → v' + esc(d.toVersion) + '</span>' : '';",
	"  head.innerHTML = '<span class=\"badge accent\"><span class=\"pip\"></span>Diff</span> <strong>' + esc(label) + '</strong> ' + vstr;",
	"  app.appendChild(head);",
	"  // Controls: word/line granularity + inline/side-by-side (side-by-side hidden on mobile).",
	"  const mobile = window.matchMedia('(max-width: 720px)').matches;",
	"  let gran = localStorage.getItem('diffGran') || 'word';",
	"  let layout = mobile ? 'inline' : (localStorage.getItem('diffLayout') || 'inline');",
	"  const controls = el('div', 'diff-controls'); app.appendChild(controls);",
	"  const body = el('div', 'diff-body'); app.appendChild(body);",
	"  const seg = (label2, val, cur, set) => { const b = el('button', 'seg' + (val === cur ? ' on' : '')); b.textContent = label2; b.onclick = () => set(val); return b; };",
	"  function paint() {",
	"    controls.innerHTML = '';",
	"    const g = el('div', 'seg-group');",
	"    g.append(seg('Word', 'word', gran, v => { gran = v; localStorage.setItem('diffGran', v); render(); }),",
	"             seg('Line', 'line', gran, v => { gran = v; localStorage.setItem('diffGran', v); render(); }));",
	"    controls.appendChild(g);",
	"    if (!mobile) {",
	"      const l = el('div', 'seg-group');",
	"      l.append(seg('Inline', 'inline', layout, v => { layout = v; localStorage.setItem('diffLayout', v); render(); }),",
	"               seg('Side-by-side', 'side', layout, v => { layout = v; localStorage.setItem('diffLayout', v); render(); }));",
	"      controls.appendChild(l);",
	"    }",
	"  }",
	"  async function render() {",
	"    paint();",
	"    const runs = diffRuns(d.fromMarkdown || '', d.toMarkdown || '', gran);",
	"    body.innerHTML = '';",
	"    if (layout === 'side') {",
	"      const sides = redlineSides(runs);",
	"      const grid = el('div', 'diff-side');",
	"      const lp = el('div', 'diff-pane'); const rp = el('div', 'diff-pane');",
	"      lp.innerHTML = '<div class=\"diff-pane-h\">v' + esc(d.fromVersion || '') + '</div>';",
	"      rp.innerHTML = '<div class=\"diff-pane-h\">v' + esc(d.toVersion || '') + '</div>';",
	"      const lc = el('div', 'prose'); const rc = el('div', 'prose');",
	"      lc.innerHTML = renderMd(sides.left); rc.innerHTML = renderMd(sides.right);",
	"      lp.appendChild(lc); rp.appendChild(rc); grid.append(lp, rp); body.appendChild(grid);",
	"      await upgradeProse(lc); await upgradeProse(rc);",
	"    } else {",
	"      const div = el('div', 'prose'); div.innerHTML = renderMd(redlineInline(runs));",
	"      body.appendChild(div); await upgradeProse(div);",
	"    }",
	"  }",
	"  await render();",
	"}",
	"function notFound(id) {",
	"  main.classList.remove('prose-page');",
	"  app.innerHTML = '<div class=\"empty\"><h1>Not found</h1><p>No session <code>' + esc(id) + '</code>.</p><p><a href=\"/\">← Back to sessions</a></p></div>';",
	"}",
	"// ── Kloop run viewer (adapted from vibe-dash; proxies the kloop CLI) ───",
	"function fmtDur(ms) { if (ms == null) return ''; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm'; }",
	"function kbadge(status) { return '<span class=\"badge ' + tone(status) + '\"><span class=\"pip\"></span>' + esc(status) + '</span>'; }",
	"function kpill(text, t) { return '<span class=\"badge ' + t + '\">' + esc(text) + '</span>'; }",
	"function hbadge(h) { return h ? '<span class=\"hbadge\">' + esc(h) + '</span>' : ''; }",
	"async function renderKloop() {",
	"  crumbs([{ text: 'Sessions', href: '/' }, { text: 'Kloop' }]);",
	"  showSkeleton(4);",
	"  const runs = (await api('/kloop/runs')) || [];",
	"  app.innerHTML = ''; main.classList.remove('prose-page');",
	"  if (!runs.length) { app.appendChild(el('div', 'empty', 'No kloop runs. (Use `kautopilot serve` directly — kloop data is not in the docker dashboard.)')); return; }",
	"  runs.sort((a, b) => { const ar = a.status === 'running' ? 0 : 1, br = b.status === 'running' ? 0 : 1; if (ar !== br) return ar - br; return String(b.startedAt || '').localeCompare(String(a.startedAt || '')); });",
	"  const list = el('div', 'klist');",
	"  for (const r of runs) {",
	"    const a = el('a', 'krow'); a.href = '/kloop/' + encodeURIComponent(r.id);",
	"    const ws = String(r.workspace || '').split('/').pop() || '';",
	"    a.innerHTML = kbadge(r.status) + '<span class=\"kid\">' + esc(r.id) + '</span><span class=\"kws\">' + esc(ws) + '</span><span class=\"kmeta\">loop ' + esc(r.loop != null ? r.loop : '?') + (r.elapsedMs != null ? ' · ' + esc(fmtDur(r.elapsedMs)) : '') + (r.exitReason ? ' · ' + esc(r.exitReason) : '') + '</span>';",
	"    list.appendChild(a);",
	"  }",
	"  app.appendChild(list);",
	"}",
	"async function renderKloopRun(id) {",
	"  crumbs([{ text: 'Sessions', href: '/' }, { text: 'Kloop', href: '/kloop' }, { text: id }]);",
	"  showSkeleton(3);",
	"  const d = await api('/kloop/runs/' + encodeURIComponent(id));",
	"  app.innerHTML = ''; main.classList.remove('prose-page');",
	"  if (!d) { app.appendChild(el('div', 'empty', 'Run not found (or kloop unavailable).')); return; }",
	"  const hero = el('div', 'khero');",
	"  hero.innerHTML = kbadge(d.status) + ' <span class=\"kid\">' + esc(d.id) + '</span>' + '<div class=\"kws\">' + esc(d.workspace || '') + '</div>' + '<div class=\"kmeta\">loop ' + esc(d.loop) + '/' + esc(d.maxIterations != null ? d.maxIterations : '?') + (d.elapsedMs != null ? ' · ' + esc(fmtDur(d.elapsedMs)) : '') + (d.synthesis ? ' · synthesis' : '') + (d.verify ? ' · verify' : '') + '</div>' + (d.exitReason ? '<div class=\"kbanner\">' + esc(d.exitReason) + '</div>' : '');",
	"  app.appendChild(hero);",
	"  const loops = d.loops || [];",
	"  if (!loops.length) { app.appendChild(el('div', 'empty', 'No loops yet.')); return; }",
	"  const chips = el('div', 'toolbar'); app.appendChild(chips);",
	"  const detail = el('div'); app.appendChild(detail);",
	"  const loadFile = async (rel, title) => { const r = await api('/kloop/file?path=' + encodeURIComponent(rel)); const box = el('div', 'kcard'); box.appendChild(el('div', 'kcard-h', esc(title))); const pre = el('pre', 'klog'); pre.textContent = (r && r.content) || '(empty / not found)'; box.appendChild(pre); detail.appendChild(box); };",
	"  const renderLoop = (i) => {",
	"    chips.innerHTML = '';",
	"    loops.forEach((lp, idx) => { const c = el('button', 'chip' + (idx === i ? ' active' : '')); c.textContent = 'Loop ' + (lp.loop != null ? lp.loop : idx + 1); c.onclick = () => { renderLoop(idx); }; chips.appendChild(c); });",
	"    const lp = loops[i]; detail.innerHTML = '';",
	"    if (lp.implementer) { const im = lp.implementer; const card = el('div', 'kcard'); card.innerHTML = '<div class=\"kcard-h\">Implementer ' + kbadge(im.status) + '</div><div class=\"kline\">' + esc(im.binary || '') + ' ' + hbadge(im.harness) + (im.durationMs != null ? ' · ' + esc(fmtDur(im.durationMs)) : '') + (im.inputTokens != null ? ' · ' + esc(im.inputTokens) + '→' + esc(im.outputTokens) + ' tok' : '') + '</div>' + (im.error ? '<div class=\"kerr\">' + esc(im.error) + '</div>' : ''); detail.appendChild(card); }",
	"    for (const ph of (lp.reviewPhases || [])) { const card = el('div', 'kcard'); let h = '<div class=\"kcard-h\">Review phase ' + esc(ph.phase) + (ph.shortCircuited ? ' ' + hbadge('short-circuited') : '') + '</div>'; for (const rv of (ph.reviewers || [])) { h += '<div class=\"kline\">' + esc(rv.binary || '') + ' ' + hbadge(rv.harness) + ' ' + (rv.verdict ? kpill(rv.verdict, tone(rv.verdict)) : '') + (rv.completionEstimate != null ? ' <span class=\"kmuted\">' + esc(rv.completionEstimate) + '%</span>' : '') + (rv.propagated ? ' ' + hbadge('propagated') : '') + (rv.durationMs != null ? ' · ' + esc(fmtDur(rv.durationMs)) : '') + '</div>'; } card.innerHTML = h; detail.appendChild(card); }",
	"    for (const ph of (lp.verifyPhases || [])) { if (!(ph.reviewers || []).length) continue; const card = el('div', 'kcard'); let h = '<div class=\"kcard-h\">Verify phase ' + esc(ph.phase) + '</div>'; for (const rv of (ph.reviewers || [])) { h += '<div class=\"kline\">' + esc(rv.binary || '') + ' ' + hbadge(rv.harness) + ' ' + (rv.verdict ? kpill(rv.verdict, tone(rv.verdict)) : '') + (rv.durationMs != null ? ' · ' + esc(fmtDur(rv.durationMs)) : '') + '</div>'; } card.innerHTML = h; detail.appendChild(card); }",
	"    if (lp.synthesis) { const sy = lp.synthesis; const card = el('div', 'kcard'); card.innerHTML = '<div class=\"kcard-h\">Synthesis ' + kbadge(sy.status) + '</div>' + (sy.error ? '<div class=\"kerr\">' + esc(sy.error) + '</div>' : ''); detail.appendChild(card); }",
	"    const ev = el('div', 'kcard'); ev.innerHTML = '<div class=\"kcard-h\">Evidence & logs</div>'; const btns = el('div', 'kbtns');",
	"    const evb = el('button', 'seg'); evb.textContent = 'Evidence files'; evb.onclick = async () => { const files = (await api('/kloop/dir?path=' + encodeURIComponent(id + '/loop-' + lp.loop + '/evidence'))) || []; if (!files.length) { detail.appendChild(el('div', 'kmuted', '(no evidence files)')); return; } for (const f of files) await loadFile(id + '/loop-' + lp.loop + '/evidence/' + f, 'evidence/' + f); };",
	"    const ib = el('button', 'seg'); ib.textContent = 'Implementer log'; ib.onclick = () => loadFile(id + '/loop-' + lp.loop + '/implementer/log', 'implementer log');",
	"    const rb = el('button', 'seg'); rb.textContent = 'Run log'; rb.onclick = () => loadFile(id + '/run.log', 'run.log');",
	"    btns.append(evb, ib, rb); ev.appendChild(btns); detail.appendChild(ev);",
	"  };",
	"  renderLoop(loops.length - 1);",
	"}",
	"async function route() {",
	"  const path = window.location.pathname;",
	"  const parts = path.split('/').filter(Boolean);",
	"  try {",
	"    if (parts.length === 0) return renderIndex();",
	"    if (parts[0] === 'kloop') return parts[1] ? renderKloopRun(decodeURIComponent(parts[1])) : renderKloop();",
	"    if (parts[0] !== 'sessions') return renderIndex();",
	"    const id = decodeURIComponent(parts[1] || '');",
	"    if (!id) return renderIndex();",
	"    if (parts.length === 2) return renderSession(id);",
	"    if (parts[2] === 'plans') {",
	"      const repo = decodeURIComponent(parts[3] || '');",
	"      if (parts[4] === 'diff') return renderDiffView(id, null, true, repo);",
	"      const v = parts[4] && parts[4].startsWith('v') ? Number(parts[4].slice(1)) : null;",
	"      return renderDoc(id, null, v, true, repo);",
	"    }",
	"    const kind = parts[2];",
	"    if (parts[3] === 'diff') return renderDiffView(id, kind, false, null);",
	"    const v = parts[3] && parts[3].startsWith('v') ? Number(parts[3].slice(1)) : null;",
	"    return renderDoc(id, kind, v, false, null);",
	"  } catch (e) {",
	"    main.classList.remove('prose-page');",
	"    app.innerHTML = '<div class=\"empty\">Error: ' + esc(e && e.message ? e.message : e) + '</div>';",
	"  }",
	"}",
	"route();",
	"// Live reload: the server SSE stream pushes `reload` when the store changes",
	"// on disk (mtime poll). Re-run the current view in place (re-fetch + re-render)",
	"// instead of location.reload(), so scroll position is preserved. The live dot",
	"// is a small, static, subtle indicator: muted when disconnected, a quiet green",
	"// when connected, and briefly turns to the accent color when a reload lands",
	"// (no pulsing, no glow). A small quiet note auto-fades on update. EventSource",
	"// auto-reconnects on transient errors, so onerror just dims the indicator.",
	'const liveEl = document.getElementById("live");',
	"let blipT;",
	"function setLive(on) { if (liveEl) liveEl.classList.toggle('on', on); }",
	"function blipLive() {",
	"  if (!liveEl) return;",
	"  liveEl.classList.add('beat');",
	"  clearTimeout(blipT);",
	"  blipT = setTimeout(() => liveEl.classList.remove('beat'), 700);",
	"}",
	"function toast(msg) {",
	'  let t = document.getElementById("toast");',
	"  if (!t) {",
	'    t = document.createElement("div"); t.id = "toast";',
	"    document.body.appendChild(t);",
	"  }",
	"  t.innerHTML = '<span class=\"d\"></span>' + esc(msg);",
	"  t.classList.add('show');",
	"  clearTimeout(t._t);",
	"  t._t = setTimeout(() => t.classList.remove('show'), 1400);",
	"}",
	"function startLiveReload() {",
	'  if (typeof EventSource === "undefined") return;',
	"  try {",
	'    const es = new EventSource("/api/events");',
	"    es.onopen = () => setLive(true);",
	"    es.onmessage = (e) => {",
	'      if (e.data === "reload") { route(); blipLive(); toast("Updated"); }',
	"    };",
	"    es.onerror = () => { setLive(false); /* EventSource auto-reconnects */ };",
	"  } catch (_e) { /* live reload unavailable; static view still works */ }",
	"}",
	"startLiveReload();",
].join("\n");

export const SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>kautopilot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<style>${STYLE}</style>
</head>
<body>
<div id="progress"></div>
<header class="bar"><div class="bar-inner">
<nav class="crumb" id="crumb"><a href="/">Sessions</a></nav>
<span class="live" id="live"><span class="dot"></span><span class="txt">live</span></span>
</div></header>
<main id="main"><div id="app"><div class="skel"><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div></div></div></main>
<script type="module">
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
