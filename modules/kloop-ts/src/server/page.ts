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
// light + dark themes (via data-theme — toggle or OS default), Inter for UI text and
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
/* dark theme — applied via data-theme (set by JS from saved pref or OS) */
:root[data-theme="dark"] {
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
		--add: #6fae82; --add-bg: #15391f; --add-gutter: #1f3d29;
		--del: #cc7d7d; --del-bg: #3d1a1d; --del-gutter: #3f2424;
		--sh-sm: 0 1px 1px rgba(0,0,0,0.4);
		--sh-md: 0 1px 2px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.3);
		--sh-lg: 0 6px 24px rgba(0,0,0,0.55);
		--bar-bg: rgba(10,10,11,0.85);
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
/* theme toggle */
.themebtn { background: transparent; border: none; color: var(--muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 3px 6px; border-radius: var(--r-sm); flex-shrink: 0; }
.themebtn:hover { color: var(--accent); background: var(--accent-soft); }
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
h1.page-title { font-size: 1.25rem; font-weight: 650; letter-spacing: -0.01em; line-height: 1.25; margin: 0 0 var(--s-2); }
h1.page-title a { color: inherit; }
h1.page-title a:hover { color: var(--accent); text-decoration: none; }
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
/* harness + verdict chips */
.kharness { font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; padding: 1px 6px; border-radius: var(--r-full); background: var(--surface-2); border: 1px solid var(--border); color: var(--muted); }
.kharness.claude { background: var(--accent-soft); border-color: var(--accent-border); color: var(--accent); }
.kharness.gemini { background: var(--block-bg); border-color: var(--block-border); color: var(--block); }
.kharness.codex { background: var(--ok-bg); border-color: var(--ok-border); color: var(--ok); }
.kverdict { font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; padding: 1px 7px; border-radius: var(--r-full); border: 1px solid transparent; }
.kverdict.ok { background: var(--ok-bg); border-color: var(--ok-border); color: var(--ok); }
.kverdict.err { background: var(--err-bg); border-color: var(--err-border); color: var(--err); }
.kverdict.warn { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn); }
.kverdict.pend { background: var(--pend-bg); border-color: var(--pend-border); color: var(--pend); }
/* run-detail sub-tabs + pane */
.ksubtabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: var(--s-4); overflow-x: auto; }
.ksubtab { background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--muted); font: inherit; font-size: 0.86rem; font-weight: 600; padding: 7px 12px; cursor: pointer; white-space: nowrap; }
.ksubtab:hover { color: var(--fg); }
.ksubtab.active { color: var(--accent); border-bottom-color: var(--accent); }
.kpane { min-height: 120px; }
.kloop-chips { margin-bottom: var(--s-4); }
/* overview metric cards */
.kmetrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: var(--s-3); margin-bottom: var(--s-4); }
.kmetric { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); padding: var(--s-3) var(--s-4); }
.kmetric-ic { font-size: 1rem; opacity: 0.8; }
.kmetric-l { font-size: 0.66rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-top: 4px; }
.kmetric-v { font-family: var(--font-mono); font-size: 1.15rem; font-weight: 600; color: var(--fg); margin-top: 2px; }
.kbartrack { height: 5px; border-radius: var(--r-full); background: var(--surface-2); border: 1px solid var(--border-soft); margin-top: 8px; overflow: hidden; }
.kbarfill { height: 100%; background: var(--accent); }
/* agent log viewer */
.klog-bar { display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; margin-bottom: var(--s-3); }
.klog-pills { display: flex; gap: 4px; flex-wrap: wrap; }
.klog-pill { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-full); color: var(--fg-soft); font: inherit; font-size: 0.74rem; padding: 3px 10px; cursor: pointer; }
.klog-pill:hover { border-color: var(--accent-border); color: var(--accent); }
.klog-pill.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.klog-content { max-height: 72vh; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); padding: var(--s-3); }
.klog-raw, .klog-rc, .klog-sc { font-family: var(--font-mono); font-size: 0.76rem; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.klog-line, .klog-rl, .klog-sl { min-height: 1.2em; }
.klog-chat { display: flex; flex-direction: column; gap: var(--s-3); }
.klog-session { font-family: var(--font-mono); font-size: 0.72rem; color: var(--muted); background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: var(--r-sm); padding: 4px 8px; display: flex; gap: 6px; align-items: center; }
.klog-cwd { color: var(--accent); } .klog-sep { opacity: 0.5; }
.klog-think { border: 1px dashed var(--border); border-radius: var(--r-sm); background: var(--surface-2); }
.klog-think > summary { cursor: pointer; padding: 4px 10px; font-size: 0.74rem; color: var(--muted); font-style: italic; }
.klog-think-b { padding: 0 12px 8px; color: var(--fg-soft); font-size: 0.84rem; }
.klog-msg { align-self: flex-end; max-width: 88%; }
.klog-msg-h { display: flex; align-items: center; gap: 6px; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent); justify-content: flex-end; margin-bottom: 3px; }
.klog-ava { width: 17px; height: 17px; border-radius: 50%; background: var(--accent); color: var(--accent-fg); font-size: 0.62rem; display: inline-flex; align-items: center; justify-content: center; }
.klog-msg-c { background: var(--accent-soft); border: 1px solid var(--accent-border); border-radius: 12px 12px 4px 12px; padding: 8px 13px; font-size: 0.86rem; }
.klog-msg-c > :first-child { margin-top: 0; } .klog-msg-c > :last-child { margin-bottom: 0; }
.klog-tool { border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface); padding: 7px 11px; }
.klog-th { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.klog-tbadge { display: inline-flex; align-items: center; gap: 4px; font-size: 0.72rem; font-weight: 600; padding: 2px 8px; border-radius: var(--r-full); }
.klog-tic { font-size: 0.8rem; }
.klog-ttar { font-family: var(--font-mono); font-size: 0.76rem; color: var(--fg-soft); word-break: break-all; }
.kt-read { background: var(--accent-soft); color: var(--accent); } .kt-write { background: var(--block-bg); color: var(--block); }
.kt-edit { background: var(--warn-bg); color: var(--warn); } .kt-bash { background: var(--ok-bg); color: var(--ok); }
.kt-glob { background: var(--pend-bg); color: var(--pend); } .kt-grep { background: var(--accent-soft); color: var(--accent); }
.kt-def { background: var(--surface-2); color: var(--muted); }
.klog-tbody > summary { cursor: pointer; font-size: 0.7rem; color: var(--muted); margin-top: 6px; }
.klog-tbody pre { background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-sm); padding: 8px; margin: 6px 0 0; overflow-x: auto; font-size: 0.74rem; }
.klog-res { border: 1px solid var(--ok-border); border-radius: var(--r-sm); background: var(--ok-bg); margin-left: 16px; }
.klog-res.bad { border-color: var(--err-border); background: var(--err-bg); }
.klog-sys { border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); }
.klog-res > summary, .klog-sys > summary { cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 5px 11px; }
.klog-rico { color: var(--ok); font-size: 0.7rem; } .klog-res.bad .klog-rico { color: var(--err); }
.klog-rlab { font-size: 0.64rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ok); }
.klog-sys .klog-rlab { color: var(--muted); } .klog-res.bad .klog-rlab { color: var(--err); }
.klog-rprev { flex: 1; min-width: 0; font-size: 0.74rem; color: var(--muted); font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.klog-rc, .klog-sc { padding: 6px 11px; border-top: 1px solid var(--border-soft); color: var(--fg-soft); max-height: 360px; overflow-y: auto; }
.kconfig { background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--r-md); padding: var(--s-4); overflow-x: auto; font-size: 0.8rem; line-height: 1.55; }
.kconfig code { font-family: var(--font-mono); }
/* overview → configuration breakdown */
.kcfg { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); margin-bottom: var(--s-4); }
.kcfg > summary { cursor: pointer; padding: 8px 12px; font-weight: 600; font-size: 0.86rem; }
.kcfg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--s-3); padding: 0 12px 12px; }
.kcfg-card { border: 1px solid var(--border-soft); border-radius: var(--r-sm); background: var(--bg); padding: 8px 10px; }
.kcfg-ch { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 6px; }
.kcfg-row { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; padding: 2px 0; font-size: 0.8rem; }
.kcfg-l { color: var(--fg-soft); flex-shrink: 0; }
.kcfg-v { text-align: right; color: var(--fg); display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.kcfg-bin { font-family: var(--font-mono); font-size: 0.74rem; }
.kcfg-pri { color: var(--muted); } .kcfg-star { color: var(--warn); margin-left: 2px; }
.kcfg-w { font-family: var(--font-mono); font-size: 0.74rem; color: var(--muted); }
/* reviews / evidence / learnings collapsibles */
.kreview, .kev { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); margin-bottom: var(--s-3); }
.kreview > summary, .kev > summary { cursor: pointer; padding: 8px 12px; font-size: 0.86rem; display: flex; align-items: center; gap: 8px; }
.kreview > .prose, .kev > .prose { padding: 0 14px 10px; }
.kev > .kconfig { margin: 0 12px 12px; }
/* logs live tag */
.klog-livetag { font-size: 0.72rem; font-weight: 600; color: var(--muted); }
.klog-livetag.on { color: var(--ok); }
/* shared loop selector bar (per-loop tabs only) */
.kloopbar { margin-bottom: var(--s-4); }
/* overview loop history */
.kloophist { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); margin-bottom: var(--s-3); }
.kloophist > summary { cursor: pointer; padding: 8px 12px; font-weight: 600; font-size: 0.88rem; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kloophist-b { padding: 4px 12px 10px; }
/* agent log header (binary · harness · model) */
.klog-agenthead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 11px; margin-bottom: var(--s-3); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); }
.klog-ah-bin { font-family: var(--font-mono); font-weight: 600; font-size: 0.84rem; color: var(--fg); }
.klog-ah-model { font-family: var(--font-mono); font-size: 0.74rem; color: var(--muted); }
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
// Kloop viewer client code — authored as readable JS (no backticks / no ${) so it
// can live in a String.raw template and be spliced into CLIENT_SCRIPT as one entry.
const KLOOP_CLIENT = String.raw`
// ── Kloop run viewer (adapted from vibe-dash; reads ~/.kloop via the server) ──
// Fetch a JSON endpoint under /api. Returns parsed JSON, or null on any error/non-2xx
// so callers can use (await api(...)) || fallback. (Function decl so it hoists for route.)
function api(path) { return fetch('/api' + path).then((r) => r.ok ? r.json() : null).catch(() => null); }
function enc(s) { return encodeURIComponent(s); }
function fmtDur(ms) { if (ms == null) return ''; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm'; }
function klBadge(status) { return '<span class="badge ' + tone(status) + '"><span class="pip"></span>' + esc(status) + '</span>'; }
function klPill(text, t) { return '<span class="badge ' + t + '">' + esc(text) + '</span>'; }
function klHarness(h) { if (!h) return ''; const k = String(h).toLowerCase(); return '<span class="kharness ' + esc(k) + '">' + esc(h) + '</span>'; }
function klVerdict(v) { if (!v) return ''; return '<span class="kverdict ' + tone(v) + '">' + esc(v) + '</span>'; }
function klOnOff(v) { return v ? '<span class="kverdict ok">on</span>' : '<span class="kverdict pend">off</span>'; }
function klStopPoll() { if (window.__klTimer) { clearInterval(window.__klTimer); window.__klTimer = null; } if (window.__klES) { try { window.__klES.close(); } catch (_e) { /* already closed */ } window.__klES = null; } }
// ── ANSI → styled spans (16-colour palette, github-ish) ──
function klAnsi(text) {
  const fg = { 30: '#5c6370', 31: '#d65c5c', 32: '#4a8a4a', 33: '#b8860b', 34: '#4078c0', 35: '#a050b0', 36: '#2a9d9d', 37: '#abb2bf', 90: '#7a818e', 91: '#e06c75', 92: '#69a955', 93: '#d19a66', 94: '#61afef', 95: '#c678dd', 96: '#56b6c2', 97: '#e6e6e6' };
  const re = /\x1b\[([0-9;]*)m/g;
  let res = '', idx = 0, color = null, bold = false, m;
  function emit(s) { if (!s) return; let st = ''; if (color) st += 'color:' + color + ';'; if (bold) st += 'font-weight:600;'; res += st ? '<span style="' + st + '">' + esc(s) + '</span>' : esc(s); }
  while ((m = re.exec(text))) { emit(text.slice(idx, m.index)); idx = m.index + m[0].length; const codes = (m[1] || '0').split(';'); for (const cs of codes) { const c = parseInt(cs || '0', 10); if (c === 0) { color = null; bold = false; } else if (c === 1) bold = true; else if (c === 22) bold = false; else if (c === 39) color = null; else if (fg[c]) color = fg[c]; } }
  emit(text.slice(idx));
  return res;
}
// ── agent JSONL parser: supports claude / gemini / codex harness logs ──
function klToolTarget(input) { if (!input || typeof input !== 'object') return ''; const keys = ['file_path', 'path', 'directory', 'url', 'command', 'pattern', 'query', 'notebook_path']; for (const k of keys) { if (input[k] != null && input[k] !== '') return String(input[k]); } return ''; }
function klBody(input) { if (input == null) return ''; try { return JSON.stringify(input, null, 2); } catch (_e) { return String(input); } }
function klResultText(c) { if (c == null) return ''; if (typeof c === 'string') return c; if (Array.isArray(c)) return c.map((x) => (x && x.text) ? x.text : (typeof x === 'string' ? x : JSON.stringify(x))).join('\n'); if (c.text) return c.text; try { return JSON.stringify(c, null, 2); } catch (_e) { return String(c); } }
// Pull the model id out of a parsed JSONL line (claude/gemini init, codex turn), if present.
function klLineModel(p) { if (!p || typeof p !== 'object') return ''; if (p.model) return String(p.model); if (p.message && p.message.model) return String(p.message.model); return ''; }
function klRoute(p, segs, names) {
  if (!p || typeof p !== 'object') { segs.push({ type: 'system', content: String(p) }); return; }
  const ty = p.type;
  if (ty === 'system') {
    // The init event is the only real "session" banner — it carries cwd + session id.
    // Every other system event also carries session_id, so keying the banner off session_id
    // alone floods the log with one (cwd)·sid row per event (e.g. thinking_tokens fires once
    // every few tokens — thousands per run).
    if (p.subtype === 'init' || p.cwd) { segs.push({ type: 'session', cwd: p.cwd || '', sid: p.session_id || '' }); return; }
    // Streaming token-estimate pings are pure noise — drop them.
    if (p.subtype === 'thinking_tokens') return;
    segs.push({ type: 'system', content: JSON.stringify(p) });
    return;
  }
  if (ty === 'assistant' && p.message && Array.isArray(p.message.content)) { for (const b of p.message.content) { if (b.type === 'thinking' && b.thinking) segs.push({ type: 'thinking', content: b.thinking }); else if (b.type === 'text' && b.text) segs.push({ type: 'msg', content: b.text }); else if (b.type === 'tool_use') { const n = b.name || 'tool'; if (b.id) names[b.id] = n; segs.push({ type: 'tool', name: n, target: klToolTarget(b.input), body: klBody(b.input) }); } } return; }
  if (ty === 'user' && p.message && Array.isArray(p.message.content)) { for (const b of p.message.content) { if (b.type === 'tool_result') segs.push({ type: 'result', name: names[b.tool_use_id] || 'tool', content: klResultText(b.content), ok: !b.is_error }); else if (b.type === 'text' && b.text) segs.push({ type: 'system', content: b.text }); } return; }
  if (ty === 'init') { segs.push({ type: 'session', cwd: p.cwd || '', sid: p.session_id || '' }); return; }
  if (ty === 'message') { if (p.role === 'assistant') segs.push({ type: 'msg', content: String(p.content || '') }); else segs.push({ type: 'system', content: String(p.content || '') }); return; }
  if (ty === 'tool_use') { const n = p.tool_name || 'tool'; if (p.tool_id) names[p.tool_id] = n; segs.push({ type: 'tool', name: n, target: klToolTarget(p.parameters), body: klBody(p.parameters) }); return; }
  if (ty === 'tool_result') { const ok = p.status !== 'error'; const txt = ok ? (p.output || '') : ((p.error && p.error.message) || p.output || 'error'); segs.push({ type: 'result', name: names[p.tool_id] || 'tool', content: String(txt), ok: ok }); return; }
  if (ty === 'thread.started') { segs.push({ type: 'session', cwd: '', sid: p.thread_id || '' }); return; }
  if (ty === 'item.completed' && p.item) { const it = p.item, k = it.type; if (k === 'agent_message') segs.push({ type: 'msg', content: String(it.text || '') }); else if (k === 'command_execution') { segs.push({ type: 'tool', name: 'command', target: String(it.command || ''), body: '' }); segs.push({ type: 'result', name: 'command', content: String(it.aggregated_output || ''), ok: it.exit_code === 0 }); } else if (k === 'web_search') segs.push({ type: 'tool', name: 'search', target: String(it.query || ''), body: '' }); else if (k === 'error') segs.push({ type: 'system', content: String(it.message || 'error') }); return; }
  segs.push({ type: 'system', content: JSON.stringify(p) });
}
function klToolIcon(n) { n = String(n || '').toLowerCase(); if (/read|view|cat/.test(n)) return '\u{1F441}'; if (/write|create/.test(n)) return '✏'; if (/edit|replace|update|multiedit/.test(n)) return '\u{1F4DD}'; if (/bash|shell|command|exec|run/.test(n)) return '\u{1F4BB}'; if (/glob|find|ls|list/.test(n)) return '\u{1F4C1}'; if (/grep|search/.test(n)) return '\u{1F50D}'; if (/web|fetch|http/.test(n)) return '\u{1F310}'; if (/task|agent/.test(n)) return '\u{1F916}'; return '\u{1F527}'; }
function klToolTone(n) { n = String(n || '').toLowerCase(); if (/read|view/.test(n)) return 'kt-read'; if (/write|create/.test(n)) return 'kt-write'; if (/edit|replace|multiedit/.test(n)) return 'kt-edit'; if (/bash|shell|command|exec|run/.test(n)) return 'kt-bash'; if (/glob|find|ls/.test(n)) return 'kt-glob'; if (/grep|search/.test(n)) return 'kt-grep'; return 'kt-def'; }
function klSegEl(seg) {
  if (seg.type === 'session') { const e = el('div', 'klog-session'); e.innerHTML = '<span class="klog-cwd">' + esc(seg.cwd || '(cwd)') + '</span>' + (seg.sid ? '<span class="klog-sep">·</span><span class="klog-sid">' + esc(seg.sid) + '</span>' : ''); return e; }
  if (seg.type === 'thinking') { const d = el('details', 'klog-think'); const s = el('summary', null, 'Thinking'); const b = el('div', 'klog-think-b'); b.innerHTML = renderMd(seg.content); d.append(s, b); return d; }
  if (seg.type === 'msg') { const e = el('div', 'klog-msg'); e.innerHTML = '<div class="klog-msg-h"><span class="klog-ava">C</span>Assistant</div>'; const c = el('div', 'klog-msg-c'); c.innerHTML = renderMd(seg.content); e.appendChild(c); return e; }
  if (seg.type === 'tool') { const e = el('div', 'klog-tool'); e.innerHTML = '<div class="klog-th"><span class="klog-tbadge ' + klToolTone(seg.name) + '"><span class="klog-tic">' + klToolIcon(seg.name) + '</span>' + esc(seg.name) + '</span>' + (seg.target ? '<span class="klog-ttar">' + esc(seg.target) + '</span>' : '') + '</div>'; if (seg.body) { const d = el('details', 'klog-tbody'); d.innerHTML = '<summary>parameters</summary><pre>' + esc(seg.body) + '</pre>'; e.appendChild(d); } return e; }
  if (seg.type === 'result') { const d = el('details', 'klog-res' + (seg.ok ? '' : ' bad')); const first = (String(seg.content).split('\n')[0] || '').slice(0, 200); d.innerHTML = '<summary><span class="klog-rico">' + (seg.ok ? '✓' : '✗') + '</span><span class="klog-rlab">Result</span><span class="klog-rprev">' + esc(first) + '</span></summary>'; const c = el('div', 'klog-rc'); c.innerHTML = String(seg.content).split('\n').map((l) => '<div class="klog-rl">' + (klAnsi(l) || '&nbsp;') + '</div>').join(''); d.appendChild(c); return d; }
  const d = el('details', 'klog-sys'); const first = (String(seg.content).split('\n')[0] || '').slice(0, 200); d.innerHTML = '<summary><span class="klog-rlab">System</span><span class="klog-rprev">' + esc(first) + '</span></summary>'; const c = el('div', 'klog-sc'); c.innerHTML = String(seg.content).split('\n').map((l) => '<div class="klog-sl">' + esc(l || ' ') + '</div>').join(''); d.appendChild(c); return d;
}
// ── config breakdown (rendered in the Overview) ──
function klBin(s) { s = String(s); let important = false; for (;;) { if (s.endsWith('*')) { important = true; s = s.slice(0, -1); } else if (s.endsWith('!')) { s = s.slice(0, -1); } else break; } const dd = s.split('::'); const flags = dd.slice(1).join(''); if (/i/.test(flags)) important = true; const seg = dd[0].split(':'); return { name: seg[0], priority: seg[1] != null ? seg[1] : null, important: important }; }
function klReviewerHtml(s) { if (s && typeof s === 'object') { return '<span class="kcfg-bin">' + Object.keys(s).map(function(k){ return esc(k) + '<span class="kcfg-pri">:' + esc(s[k]) + '</span>'; }).join(' <span class="kmuted">+</span> ') + '</span>'; } const b = klBin(s); return '<span class="kcfg-bin">' + esc(b.name) + (b.priority != null ? '<span class="kcfg-pri">:' + esc(b.priority) + '</span>' : '') + (b.important ? '<span class="kcfg-star" title="important">★</span>' : '') + '</span>'; }
function klCfgCard(title, rows) { return rows ? '<div class="kcfg-card"><div class="kcfg-ch">' + esc(title) + '</div>' + rows + '</div>' : ''; }
function klCfgRow(label, value) { return '<div class="kcfg-row"><span class="kcfg-l">' + esc(label) + '</span><span class="kcfg-v">' + value + '</span></div>'; }
function klOverviewConfig(cfg) {
  if (!cfg) return null;
  let cards = '';
  if (cfg.implementers && typeof cfg.implementers === 'object') { let rows = ''; for (const k of Object.keys(cfg.implementers)) { const b = klBin(k); rows += klCfgRow(b.name + (b.important ? ' ★' : ''), '<span class="kcfg-w">weight ' + esc(cfg.implementers[k]) + '</span>'); } if (cfg.firstIterationWeightMultiplier != null) rows += klCfgRow('first-iter weight ×', esc(cfg.firstIterationWeightMultiplier)); cards += klCfgCard('Implementers', rows); }
  if (Array.isArray(cfg.reviewPhases) && cfg.reviewPhases.length) { let rows = ''; cfg.reviewPhases.forEach((ph, i) => { rows += klCfgRow('Phase ' + i + ' types', (ph || []).map(klReviewerHtml).join(' ')); }); const lenses = (cfg.reviewLenses && cfg.reviewLenses.length) ? cfg.reviewLenses : ['general']; rows += klCfgRow('lenses', lenses.map(function(l){ return klPill(l, 'accent'); }).join(' ')); if (cfg.previousReviewPropagation != null) rows += klCfgRow('propagation', esc(Math.round(cfg.previousReviewPropagation * 100)) + '%'); if (cfg.firstLoopFullReview != null) rows += klCfgRow('first-loop full review', klOnOff(cfg.firstLoopFullReview)); cards += klCfgCard('Review matrix (lens × type)', rows); }
  if (cfg.poolProfiles && typeof cfg.poolProfiles === 'object' && Object.keys(cfg.poolProfiles).length) { let rows = ''; for (const name of Object.keys(cfg.poolProfiles)) { rows += klCfgRow(name, klReviewerHtml(cfg.poolProfiles[name])); } cards += klCfgCard('Pool profiles', rows); }
  if (Array.isArray(cfg.verifyPhases) && cfg.verifyPhases.length) { let rows = ''; cfg.verifyPhases.forEach((ph, i) => { rows += klCfgRow('Phase ' + i, (ph || []).map(klReviewerHtml).join(' ')); }); cards += klCfgCard('Verify phases', rows); }
  let cp = '';
  if (cfg.conflictChecker) cp += klCfgRow('conflict checker', klReviewerHtml(cfg.conflictChecker));
  if (cfg.synthesizer) cp += klCfgRow('synthesizer', klReviewerHtml(cfg.synthesizer));
  if (cfg.conflictCheckThreshold != null) cp += klCfgRow('conflict threshold', esc(cfg.conflictCheckThreshold));
  if (cfg.compressSpec != null) cp += klCfgRow('compress spec', klOnOff(cfg.compressSpec));
  if (cfg.rerankAfterCheckpoint != null) cp += klCfgRow('rerank after checkpoint', klOnOff(cfg.rerankAfterCheckpoint));
  cards += klCfgCard('Checkpointer', cp);
  let to = ''; const tk = [['implementerTimeout', 'implementer'], ['reviewerTimeout', 'reviewer'], ['synthesisTimeout', 'synthesis'], ['verifyTimeout', 'verify']]; for (const t of tk) { if (cfg[t[0]] != null) to += klCfgRow(t[1], esc(cfg[t[0]]) + 'm'); } cards += klCfgCard('Timeouts', to);
  let ft = '';
  if (cfg.maxIterations != null) ft += klCfgRow('max iterations', esc(cfg.maxIterations));
  if (cfg.synthesis != null) ft += klCfgRow('synthesis', klOnOff(cfg.synthesis));
  if (cfg.verify != null) ft += klCfgRow('verify', klOnOff(cfg.verify));
  if (cfg.implementerRetry && typeof cfg.implementerRetry === 'object') ft += klCfgRow('implementer retry', esc(cfg.implementerRetry.maxRetries) + '× / ' + esc(cfg.implementerRetry.backoffBaseMs) + 'ms');
  cards += klCfgCard('Limits & features', ft);
  if (!cards) return null;
  const wrap = el('details', 'kcfg'); wrap.open = true; wrap.innerHTML = '<summary>Configuration</summary><div class="kcfg-grid">' + cards + '</div>'; return wrap;
}
// ── per-loop card builders (shared by Overview history) ──
function klFlatReviewers(phases) { const out = []; for (const ph of (phases || [])) for (const rv of (ph.reviewers || [])) out.push(rv); return out; }
function klAppendLoopCards(host, lp) {
  if (lp.implementer) { const im = lp.implementer; const card = el('div', 'kcard'); card.innerHTML = '<div class="kcard-h">Implementer ' + klBadge(im.status) + '</div><div class="kline">' + esc(im.binary || '') + ' ' + klHarness(im.harness) + (im.durationMs != null ? ' · ' + fmtDur(im.durationMs) : '') + (im.inputTokens != null ? ' · ' + esc(im.inputTokens) + '→' + esc(im.outputTokens) + ' tok' : '') + (im.retryAttempt ? ' · retry ' + esc(im.retryAttempt) : '') + '</div>' + (im.error ? '<div class="kerr">' + esc(im.error) + '</div>' : ''); host.appendChild(card); }
  for (const ph of (lp.reviewPhases || [])) { const card = el('div', 'kcard'); let h = '<div class="kcard-h">Review phase ' + esc(ph.phase) + (ph.shortCircuited ? ' ' + klPill('short-circuited', 'warn') : '') + '</div>'; for (const rv of (ph.reviewers || [])) { h += '<div class="kline">' + (rv.lens ? klPill(rv.lens, 'accent') + ' ' : '') + esc(rv.binary || '') + (rv.reviewType && rv.reviewType !== rv.binary ? ' <span class="kmuted">[' + esc(rv.reviewType) + ']</span>' : '') + ' ' + klHarness(rv.harness) + ' ' + klVerdict(rv.verdict) + (rv.completionEstimate != null ? ' <span class="kmuted">' + esc(rv.completionEstimate) + '%</span>' : '') + (rv.propagated ? ' ' + klPill('propagated', 'accent') : '') + (rv.durationMs != null ? ' · ' + fmtDur(rv.durationMs) : '') + (rv.inputTokens != null ? ' · ' + esc(rv.inputTokens) + '→' + esc(rv.outputTokens) + ' tok' : '') + '</div>' + (rv.error ? '<div class="kerr">' + esc(rv.error) + '</div>' : ''); } card.innerHTML = h; host.appendChild(card); }
  for (const ph of (lp.verifyPhases || [])) { if (!(ph.reviewers || []).length) continue; const card = el('div', 'kcard'); let h = '<div class="kcard-h">Verify phase ' + esc(ph.phase) + '</div>'; for (const rv of (ph.reviewers || [])) { h += '<div class="kline">' + esc(rv.binary || '') + ' ' + klHarness(rv.harness) + ' ' + klVerdict(rv.verdict) + (rv.durationMs != null ? ' · ' + fmtDur(rv.durationMs) : '') + '</div>'; } card.innerHTML = h; host.appendChild(card); }
  if (lp.synthesis) { const sy = lp.synthesis; const card = el('div', 'kcard'); card.innerHTML = '<div class="kcard-h">Synthesis ' + klBadge(sy.status) + '</div>' + (sy.binary ? '<div class="kline">' + esc(sy.binary) + ' ' + klHarness(sy.harness) + (sy.durationMs != null ? ' · ' + fmtDur(sy.durationMs) : '') + '</div>' : '') + (sy.error ? '<div class="kerr">' + esc(sy.error) + '</div>' : ''); host.appendChild(card); }
  if (lp.checkpoint) { const cp = lp.checkpoint; const card = el('div', 'kcard'); card.innerHTML = '<div class="kcard-h">Checkpoint ' + klBadge(cp.status || cp.outcome || '') + '</div>' + (cp.summary ? '<div class="kline">' + esc(cp.summary) + '</div>' : ''); host.appendChild(card); }
}
function klLoopSummary(lp) {
  let parts = '';
  if (lp.implementer) parts += klBadge(lp.implementer.status);
  const rvs = klFlatReviewers(lp.reviewPhases);
  if (rvs.length) { const ok = rvs.filter((r) => tone(r.verdict) === 'ok').length; parts += ' <span class="kmuted">reviews ' + ok + '/' + rvs.length + '</span>'; }
  return parts;
}
// ── Overview tab (loop-independent: summary + config + full loop history) ──
function klMetric(icon, label, value, sub) { return '<div class="kmetric"><div class="kmetric-ic">' + icon + '</div><div class="kmetric-l">' + esc(label) + '</div><div class="kmetric-v">' + esc(value) + '</div>' + (sub ? '<div class="kmetric-s">' + sub + '</div>' : '') + '</div>'; }
function klOvSig(d) { try { return JSON.stringify([d.status, d.loop, d.loops]); } catch (_e) { return ''; } }
function klOvDraw(pane, d, id) {
  pane.innerHTML = '';
  const loops = d.loops || [];
  const lpCur = d.loop != null ? d.loop : loops.length;
  const bar = d.maxIterations ? '<div class="kbartrack"><div class="kbarfill" style="width:' + Math.min(100, Math.round(100 * lpCur / d.maxIterations)) + '%"></div></div>' : '';
  const mode = ((d.synthesis ? 'synthesis ' : '') + (d.verify ? 'verify' : '')).trim() || 'plain';
  const grid = el('div', 'kmetrics');
  grid.innerHTML = klMetric('\u{1F501}', 'Loop', lpCur + (d.maxIterations ? ' / ' + d.maxIterations : ''), bar) + klMetric('⏱', 'Elapsed', fmtDur(d.elapsedMs) || '—', '') + klMetric('⚙', 'Mode', mode, '') + klMetric('⚠', 'Failures', (d.failures != null ? d.failures : 0) + (d.failureThreshold ? ' / ' + d.failureThreshold : ''), '');
  pane.appendChild(grid);
  if (d.exitReason) pane.appendChild(el('div', 'kbanner', esc(d.exitReason)));
  const cfgEl = klOverviewConfig(d.config); if (cfgEl) pane.appendChild(cfgEl);
  if (!loops.length) { pane.appendChild(el('div', 'empty', 'No loops yet.')); return; }
  pane.appendChild(el('div', 'section-title', 'Loop history'));
  for (let i = loops.length - 1; i >= 0; i--) { const lp = loops[i]; const ln = lp.loop != null ? lp.loop : i + 1; const det = el('details', 'kloophist'); if (i === loops.length - 1) det.open = true; det.innerHTML = '<summary>Loop ' + esc(ln) + ' ' + klLoopSummary(lp) + '</summary>'; const body = el('div', 'kloophist-b'); klAppendLoopCards(body, lp); det.appendChild(body); pane.appendChild(det); }
}
function klOverview(pane, d, id) {
  klStopPoll(); klOvDraw(pane, d, id);
  if (d.status === 'running') { let sig = klOvSig(d); const t = window.__klTimer = setInterval(async () => { const nd = await api('/kloop/runs/' + enc(id)); if (window.__klTimer !== t || !nd) return; const ns = klOvSig(nd); if (ns !== sig) { sig = ns; for (const k of Object.keys(nd)) d[k] = nd[k]; klOvDraw(pane, d, id); } }, 4000); }
}
// ── streaming log renderer: SSE tail appends nodes (no re-render / flicker) ──
function klLogStream(content, agent, live, onModel) {
  const isRaw = agent.kind === 'raw';
  content.innerHTML = '';
  const host = el('div', isRaw ? 'klog-raw' : 'klog-chat'); content.appendChild(host);
  const st = { pending: '', names: {} };
  function near() { return content.scrollHeight - content.scrollTop - content.clientHeight < 90; }
  function feed(text, reset) {
    if (reset) { host.innerHTML = ''; st.pending = ''; st.names = {}; }
    const stick = near();
    const all = st.pending + text; const parts = all.split('\n'); st.pending = parts.pop();
    for (const line of parts) { if (isRaw) { const dv = el('div', 'klog-line'); dv.innerHTML = klAnsi(line) || '&nbsp;'; host.appendChild(dv); } else { const t = line.trim(); if (!t) continue; let p; try { p = JSON.parse(t); } catch (_e) { host.appendChild(klSegEl({ type: 'system', content: line })); continue; } if (onModel) { const md = klLineModel(p); if (md) onModel(md); } const segs = []; klRoute(p, segs, st.names); for (const s of segs) host.appendChild(klSegEl(s)); } }
    if (stick) content.scrollTop = content.scrollHeight;
  }
  if (live) { const es = new EventSource('/api/kloop/stream?path=' + enc(agent.path)); window.__klES = es; es.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_e) { return; } if (m.full != null) feed(m.full, true); else if (m.append != null) feed(m.append, false); }; es.onerror = () => { /* EventSource auto-reconnects */ }; }
  else { api('/kloop/file?path=' + enc(agent.path)).then((r) => { const raw = (r && r.content) || ''; if (!raw.trim()) { content.innerHTML = ''; content.appendChild(el('div', 'empty', '(empty / not written yet)')); return; } feed(raw + '\n', true); }); }
}
// ── Logs tab (per loop: agents only; header shows binary + harness + model) ──
async function klLogs(pane, d, id, state) {
  klStopPoll(); pane.innerHTML = '';
  const loops = d.loops || [];
  if (!loops.length) { pane.appendChild(el('div', 'empty', 'No loops yet.')); return; }
  const lp = loops[state.loop] || loops[loops.length - 1];
  const ln = lp.loop != null ? lp.loop : state.loop + 1;
  const reviewers = klFlatReviewers(lp.reviewPhases);
  const verifiers = klFlatReviewers(lp.verifyPhases);
  const agents = [{ key: 'impl', label: 'implementer', path: id + '/loop-' + ln + '/implementer/log', binary: lp.implementer && lp.implementer.binary, harness: lp.implementer && lp.implementer.harness }];
  const revDirs = ((await api('/kloop/dir?path=' + enc(id + '/loop-' + ln + '/reviews'))) || []).filter((x) => /^reviewer-\d+$/.test(x)).sort();
  revDirs.forEach((r) => { const k = parseInt((r.match(/(\d+)/) || [])[1], 10); const rv = reviewers[k] || {}; agents.push({ key: r, label: rv.lens ? r + ' · ' + rv.lens : r, path: id + '/loop-' + ln + '/reviews/' + r + '/log', binary: rv.binary, harness: rv.harness }); });
  const loopDir = (await api('/kloop/dir?path=' + enc(id + '/loop-' + ln))) || [];
  if (loopDir.indexOf('synthesis') >= 0) agents.push({ key: 'syn', label: 'synthesis', path: id + '/loop-' + ln + '/synthesis/log', binary: lp.synthesis && lp.synthesis.binary, harness: lp.synthesis && lp.synthesis.harness });
  if (loopDir.indexOf('verify') >= 0) { const vd = ((await api('/kloop/dir?path=' + enc(id + '/loop-' + ln + '/verify'))) || []).filter((x) => /^verifier-\d+$/.test(x)).sort(); vd.forEach((v) => { const k = parseInt((v.match(/(\d+)/) || [])[1], 10); const rv = verifiers[k] || {}; agents.push({ key: v, label: v, path: id + '/loop-' + ln + '/verify/' + v + '/log', binary: rv.binary, harness: rv.harness }); }); }
  let active = (state.agent && agents.find((a) => a.key === state.agent)) ? state.agent : 'impl';
  const isLive = d.status === 'running';
  const head = el('div', 'klog-agenthead');
  const bar = el('div', 'klog-bar'); const pills = el('div', 'klog-pills'); bar.appendChild(pills);
  const livetag = el('span', 'klog-livetag' + (isLive ? ' on' : '')); livetag.textContent = isLive ? '● live' : ''; bar.appendChild(livetag);
  const content = el('div', 'klog-content');
  let curModel = '';
  function paintHead(a) { head.innerHTML = '<span class="klog-ah-bin">' + esc(a.binary || a.label) + '</span>' + klHarness(a.harness) + (curModel ? '<span class="klog-ah-model">model: ' + esc(curModel) + '</span>' : ''); }
  function open(a) { active = a.key; state.agent = a.key; for (const x of pills.children) x.classList.toggle('active', x.__key === a.key); klStopPoll(); curModel = ''; paintHead(a); klLogStream(content, a, isLive, (md) => { if (md && md !== curModel) { curModel = md; paintHead(a); } }); }
  agents.forEach((a) => { const b = el('button', 'klog-pill'); b.__key = a.key; b.textContent = a.label; b.onclick = () => open(a); pills.appendChild(b); });
  pane.appendChild(head); pane.appendChild(bar); pane.appendChild(content);
  open(agents.find((a) => a.key === active) || agents[0]);
}
// ── Run log tab (loop-independent: the run-level run.log, streamed) ──
function klRunLog(pane, d, id) {
  klStopPoll(); pane.innerHTML = '';
  const isLive = d.status === 'running';
  const bar = el('div', 'klog-bar'); bar.appendChild(el('span', 'kmuted', 'run.log')); const livetag = el('span', 'klog-livetag' + (isLive ? ' on' : '')); livetag.textContent = isLive ? '● live' : ''; bar.appendChild(livetag);
  const content = el('div', 'klog-content');
  pane.appendChild(bar); pane.appendChild(content);
  klLogStream(content, { kind: 'raw', path: id + '/run.log' }, isLive, null);
}
// ── Reviews tab (per loop: reviewer markdown + verdicts + synthesis summary) ──
async function klReviews(pane, d, id, state) {
  klStopPoll(); pane.innerHTML = '';
  const loops = d.loops || [];
  if (!loops.length) { pane.appendChild(el('div', 'empty', 'No loops yet.')); return; }
  const lp = loops[state.loop] || loops[loops.length - 1];
  const ln = lp.loop != null ? lp.loop : state.loop + 1;
  const files = ((await api('/kloop/dir?path=' + enc(id + '/loop-' + ln + '/reviews'))) || []).filter((x) => /^reviewer-\d+\.md$/.test(x)).sort();
  const synDir = (await api('/kloop/dir?path=' + enc(id + '/loop-' + ln + '/synthesis'))) || [];
  const hasSyn = synDir.indexOf('review-summary.md') >= 0;
  if (!files.length && !hasSyn) { pane.appendChild(el('div', 'empty', 'No reviews for this loop yet.')); return; }
  const rvs = klFlatReviewers(lp.reviewPhases); // matrix reviewers (carry lens/reviewType), indexed by global reviewer index
  for (const f of files) { const idx = (f.match(/(\d+)/) || [])[1]; const rv = rvs[parseInt(idx, 10)] || {}; let verdict = ''; const vr = await api('/kloop/file?path=' + enc(id + '/loop-' + ln + '/verdicts/reviewer-' + idx + '.json')); if (vr && vr.content) { try { const j = JSON.parse(vr.content); verdict = j.verdict || j.decision || (j.approved === true ? 'approved' : j.approved === false ? 'rejected' : ''); } catch (_e) { /* ignore */ } } const det = el('details', 'kreview'); det.innerHTML = '<summary><b>' + esc(f) + '</b> ' + (rv.lens ? klPill(rv.lens, 'accent') + ' ' : '') + (rv.reviewType && rv.reviewType !== rv.binary ? '<span class="kmuted">[' + esc(rv.reviewType) + ']</span> ' : '') + klVerdict(verdict) + '</summary>'; const body = el('div', 'prose'); const r = await api('/kloop/file?path=' + enc(id + '/loop-' + ln + '/reviews/' + f)); body.innerHTML = renderMd((r && r.content) || ''); det.appendChild(body); pane.appendChild(det); await upgradeProse(body); }
  if (hasSyn) { const det = el('details', 'kreview'); det.open = true; det.innerHTML = '<summary><b>synthesis · review-summary.md</b></summary>'; const body = el('div', 'prose'); const r = await api('/kloop/file?path=' + enc(id + '/loop-' + ln + '/synthesis/review-summary.md')); body.innerHTML = renderMd((r && r.content) || ''); det.appendChild(body); pane.appendChild(det); await upgradeProse(body); }
}
// ── Evidence tab (per loop: diff.patch, files.json, self-review.md, …) ──
async function klEvidence(pane, d, id, state) {
  klStopPoll(); pane.innerHTML = '';
  const loops = d.loops || [];
  if (!loops.length) { pane.appendChild(el('div', 'empty', 'No loops yet.')); return; }
  const lp = loops[state.loop] || loops[loops.length - 1];
  const ln = lp.loop != null ? lp.loop : state.loop + 1;
  const files = ((await api('/kloop/dir?path=' + enc(id + '/loop-' + ln + '/evidence'))) || []).sort();
  if (!files.length) { pane.appendChild(el('div', 'empty', 'No evidence for this loop.')); return; }
  let first = true;
  for (const f of files) { const det = el('details', 'kev'); if (first) { det.open = true; first = false; } det.innerHTML = '<summary><b>' + esc(f) + '</b></summary>'; const r = await api('/kloop/file?path=' + enc(id + '/loop-' + ln + '/evidence/' + f)); const txt = (r && r.content) || ''; if (/\.md$/.test(f)) { const body = el('div', 'prose'); body.innerHTML = renderMd(txt); det.appendChild(body); pane.appendChild(det); await upgradeProse(body); } else { const lang = /\.(patch|diff)$/.test(f) ? 'language-diff' : (/\.json$/.test(f) ? 'language-json' : ''); const pre = el('pre', 'kconfig'); const code = el('code', lang); code.textContent = txt; pre.appendChild(code); det.appendChild(pre); pane.appendChild(det); if (lang) { try { hljs.highlightElement(code); } catch (_e) { /* leave plain */ } } } }
}
// ── Learnings tab (run-level learnings.md header + per-loop learning.md) ──
async function klLearnings(pane, d, id, state) {
  klStopPoll(); pane.innerHTML = '<div class="kmuted">Loading…</div>';
  const rr = await api('/kloop/file?path=' + enc(id + '/learnings.md')); const runmd = (rr && rr.content) || '';
  const loops = d.loops || [];
  const lp = loops[state.loop] || loops[loops.length - 1];
  const ln = lp ? (lp.loop != null ? lp.loop : state.loop + 1) : 1;
  let loopmd = '';
  if (lp) { const lr = await api('/kloop/file?path=' + enc(id + '/loop-' + ln + '/learning.md')); loopmd = (lr && lr.content) || ''; }
  pane.innerHTML = '';
  let any = false;
  if (runmd.trim()) { any = true; pane.appendChild(el('div', 'section-title', 'Run learnings')); const div = el('div', 'prose'); div.innerHTML = renderMd(runmd); pane.appendChild(div); await upgradeProse(div); }
  if (loopmd.trim()) { any = true; pane.appendChild(el('div', 'section-title', 'Loop ' + esc(ln) + ' learning')); const div = el('div', 'prose'); div.innerHTML = renderMd(loopmd); pane.appendChild(div); await upgradeProse(div); }
  if (!any) pane.appendChild(el('div', 'empty', 'No learnings recorded.'));
}
// ── Spec tab (loop-independent) ──
async function klSpec(pane, id) {
  klStopPoll(); pane.innerHTML = '<div class="kmuted">Loading…</div>';
  const r = await api('/kloop/file?path=' + enc(id + '/spec.md'));
  const md = (r && r.content) || '';
  pane.innerHTML = '';
  if (!md.trim()) { pane.appendChild(el('div', 'empty', 'No spec.md for this run.')); return; }
  const div = el('div', 'prose'); div.innerHTML = renderMd(md); pane.appendChild(div); await upgradeProse(div);
}
// ── Config tab (loop-independent: full config.yaml, syntax-highlighted) ──
async function klConfig(pane, id) {
  klStopPoll(); pane.innerHTML = '<div class="kmuted">Loading…</div>';
  const r = await api('/kloop/file?path=' + enc(id + '/config.yaml'));
  const txt = (r && r.content) || '';
  pane.innerHTML = '';
  if (!txt.trim()) { pane.appendChild(el('div', 'empty', 'No config.yaml for this run.')); return; }
  const pre = el('pre', 'kconfig'); const code = el('code', 'language-yaml'); code.textContent = txt; pre.appendChild(code); pane.appendChild(pre); try { hljs.highlightElement(code); } catch (_e) { /* leave plain */ }
}
// ── Kloop runs list ──
async function renderKloop() {
  crumbs([{ text: 'Kloop' }]);
  showSkeleton(4);
  const runs = (await api('/kloop/runs')) || [];
  app.innerHTML = ''; main.classList.remove('prose-page');
  if (!runs.length) { app.appendChild(el('div', 'empty', 'No kloop runs yet.')); return; }
  runs.sort((a, b) => { const ar = a.status === 'running' ? 0 : 1, br = b.status === 'running' ? 0 : 1; if (ar !== br) return ar - br; return String(b.startedAt || '').localeCompare(String(a.startedAt || '')); });
  const list = el('div', 'klist');
  for (const r of runs) { const a = el('a', 'krow'); a.href = '/kloop/' + enc(r.id); const ws = String(r.workspace || '').split('/').pop() || ''; a.innerHTML = klBadge(r.status) + '<span class="kid">' + esc(r.id) + '</span><span class="kws">' + esc(ws) + '</span><span class="kmeta">loop ' + esc(r.loop != null ? r.loop : '?') + (r.elapsedMs != null ? ' · ' + esc(fmtDur(r.elapsedMs)) : '') + (r.phase ? ' · ' + esc(r.phase) : '') + (r.exitReason ? ' · ' + esc(r.exitReason) : '') + '</span>'; list.appendChild(a); }
  app.appendChild(list);
}
// ── Kloop run detail (tabbed; one shared loop selector for per-loop tabs) ──
async function renderKloopRun(id) {
  crumbs([{ text: 'Kloop', href: '/kloop' }, { text: id }]);
  showSkeleton(3);
  const d = await api('/kloop/runs/' + enc(id));
  app.innerHTML = ''; main.classList.remove('prose-page');
  if (!d) { app.appendChild(el('div', 'empty', 'Run not found (or kloop unavailable).')); return; }
  const hero = el('div', 'khero');
  hero.innerHTML = klBadge(d.status) + ' <span class="kid">' + esc(d.id) + '</span>' + '<div class="kws">' + esc(d.workspace || '') + '</div>';
  app.appendChild(hero);
  const loops = d.loops || [];
  const tabs = el('div', 'ksubtabs');
  const loopBar = el('div', 'toolbar kloopbar');
  const pane = el('div', 'kpane');
  const state = { tab: 'overview', loop: Math.max(0, loops.length - 1), agent: null };
  const perLoop = { logs: 1, reviews: 1, evidence: 1, learnings: 1 };
  const defs = [['overview', 'Overview'], ['logs', 'Logs'], ['reviews', 'Reviews'], ['evidence', 'Evidence'], ['learnings', 'Learnings'], ['runlog', 'Run log'], ['spec', 'Spec'], ['config', 'Config']];
  function drawPane() { klStopPoll(); const t = state.tab; if (t === 'overview') klOverview(pane, d, id); else if (t === 'logs') klLogs(pane, d, id, state); else if (t === 'reviews') klReviews(pane, d, id, state); else if (t === 'evidence') klEvidence(pane, d, id, state); else if (t === 'learnings') klLearnings(pane, d, id, state); else if (t === 'runlog') klRunLog(pane, d, id); else if (t === 'spec') klSpec(pane, id); else klConfig(pane, id); }
  function buildLoopBar() { loopBar.innerHTML = ''; if (!perLoop[state.tab] || loops.length <= 1) { loopBar.style.display = 'none'; return; } loopBar.style.display = ''; loopBar.appendChild(el('span', 'label', 'Loop')); loops.forEach((lp, idx) => { const c = el('button', 'chip' + (idx === state.loop ? ' active' : '')); c.textContent = (lp.loop != null ? lp.loop : idx + 1); c.onclick = () => { state.loop = idx; for (const x of loopBar.querySelectorAll('button')) x.classList.remove('active'); c.classList.add('active'); drawPane(); }; loopBar.appendChild(c); }); }
  function draw() { buildLoopBar(); drawPane(); }
  for (const def of defs) { const b = el('button', 'ksubtab' + (def[0] === 'overview' ? ' active' : '')); b.textContent = def[1]; b.onclick = () => { state.tab = def[0]; for (const x of tabs.children) x.classList.toggle('active', x === b); draw(); }; tabs.appendChild(b); }
  app.appendChild(tabs); app.appendChild(loopBar); app.appendChild(pane);
  draw();
}
`;

const CLIENT_SCRIPT =
  [
    'import { marked } from "https://cdn.jsdelivr.net/npm/marked@15.0.6/lib/marked.esm.js";',
    'import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.es.mjs";',
    'import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";',
    'import hljs from "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/es/highlight.min.js";',
    'const dark = document.documentElement.dataset.theme === "dark";',
    'mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict", fontFamily: "inherit" });',
    '// highlight.js theme: a github-style theme per scheme, loaded as a <link> at runtime (no bundler).',
    'const hlHref = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/" + (dark ? "github-dark" : "github") + ".min.css";',
    '{ const l = document.createElement("link"); l.rel = "stylesheet"; l.href = hlHref; document.head.appendChild(l); }',
    'const app = document.getElementById("app");',
    'const main = document.getElementById("main");',
    'const crumbEl = document.getElementById("crumb");',
    'const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;" }[c]));',
    '// ── tiny helpers ──────────────────────────────────────────────────────',
    'const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };',
    '// Map a repo/phase status word to a semantic tone (badge/pip color class).',
    'function tone(status) {',
    "  const s = String(status || '').toLowerCase();",
    "  if (/(done|ready|approved|merged|success|complete|pass|open)/.test(s)) return 'ok';",
    "  if (/(run|active|progress|exec|working|build)/.test(s)) return 'warn';",
    "  if (/(fail|error|reject)/.test(s)) return 'err';",
    "  if (/(block|conflict|stuck)/.test(s)) return 'block';",
    "  return 'pend';",
    '}',
    '// Phase → tone for the phase badge.',
    'function crumbs(parts) {',
    '  crumbEl.innerHTML = parts',
    '    .map((p, i) => {',
    "      if (p.href) return '<a href=\"' + esc(p.href) + '\">' + esc(p.text) + '</a>';",
    "      return '<span class=\"cur\">' + esc(p.text) + '</span>';",
    '    })',
    '    .join(\'<span class="sep">/</span>\');',
    '}',
    'function showSkeleton(n) {',
    "  main.classList.remove('prose-page');",
    '  let h = \'<div class="skel">\';',
    '  for (let i = 0; i < (n || 4); i++) h += \'<div class="skel-card"></div>\';',
    "  h += '</div>';",
    '  app.innerHTML = h;',
    '}',
    '// Render markdown into a polished prose container: wrap tables for horizontal',
    '// scroll, upgrade fenced mermaid blocks to themed cards, syntax-highlight code,',
    '// give headings ids, and build a collapsible table of contents for long docs.',
    '// Pure markdown -> HTML string.',
    "function renderMd(md) { return (md && md.trim()) ? DOMPurify.sanitize(marked.parse(md)) : ''; }",
    '// Upgrade an already-rendered .prose container in place: wrap tables, mermaid',
    '// cards, syntax-highlight code, give headings ids, run mermaid. (No TOC/append.)',
    'async function upgradeProse(div) {',
    '  div.querySelectorAll("table").forEach((t) => {',
    "    if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return;",
    '    const w = el("div", "table-wrap");',
    '    t.replaceWith(w); w.appendChild(t);',
    '  });',
    '  div.querySelectorAll("code.language-mermaid").forEach((code) => {',
    '    const card = el("div", "mermaid-card");',
    '    const pre = el("pre", "mermaid");',
    '    pre.textContent = code.textContent;',
    '    card.appendChild(pre);',
    '    const parent = code.closest("pre");',
    '    (parent || code).replaceWith(card);',
    '  });',
    '  div.querySelectorAll("pre code").forEach((code) => {',
    "    if (code.closest('.mermaid-card')) return;",
    '    try { hljs.highlightElement(code); } catch (_e) { /* leave plain */ }',
    '  });',
    '  const used = {};',
    '  for (const h of div.querySelectorAll("h2, h3")) {',
    "    let slug = (h.textContent || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';",
    "    if (used[slug] != null) { used[slug]++; slug = slug + '-' + used[slug]; } else used[slug] = 0;",
    '    h.id = slug;',
    '  }',
    '  const blocks = div.querySelectorAll("pre.mermaid");',
    '  if (blocks.length) { try { await mermaid.run({ nodes: blocks }); } catch (_e) { /* leave source */ } }',
    '}',
    'async function route() {',
    '  const path = window.location.pathname;',
    "  const parts = path.split('/').filter(Boolean);",
    '  klStopPoll();',
    '  try {',
    "    if (parts[0] === 'kloop' && parts[1]) return renderKloopRun(decodeURIComponent(parts[1]));",
    '    return renderKloop();',
    '  } catch (e) {',
    "    main.classList.remove('prose-page');",
    "    app.innerHTML = '<div class=\"empty\">Error: ' + esc(e && e.message ? e.message : e) + '</div>';",
    '  }',
    '}',
    'route();',
    '// Live reload: the server SSE stream pushes `reload` when the store changes',
    '// on disk (mtime poll). Re-run the current view in place (re-fetch + re-render)',
    '// instead of location.reload(), so scroll position is preserved. The live dot',
    '// is a small, static, subtle indicator: muted when disconnected, a quiet green',
    '// when connected, and briefly turns to the accent color when a reload lands',
    '// (no pulsing, no glow). A small quiet note auto-fades on update. EventSource',
    '// auto-reconnects on transient errors, so onerror just dims the indicator.',
    'const liveEl = document.getElementById("live");',
    'let blipT;',
    "function setLive(on) { if (liveEl) liveEl.classList.toggle('on', on); }",
    'function blipLive() {',
    '  if (!liveEl) return;',
    "  liveEl.classList.add('beat');",
    '  clearTimeout(blipT);',
    "  blipT = setTimeout(() => liveEl.classList.remove('beat'), 700);",
    '}',
    'function toast(msg) {',
    '  let t = document.getElementById("toast");',
    '  if (!t) {',
    '    t = document.createElement("div"); t.id = "toast";',
    '    document.body.appendChild(t);',
    '  }',
    '  t.innerHTML = \'<span class="d"></span>\' + esc(msg);',
    "  t.classList.add('show');",
    '  clearTimeout(t._t);',
    "  t._t = setTimeout(() => t.classList.remove('show'), 1400);",
    '}',
    'function startLiveReload() {',
    '  if (typeof EventSource === "undefined") return;',
    '  try {',
    '    const es = new EventSource("/api/events");',
    '    es.onopen = () => setLive(true);',
    '    es.onmessage = (e) => {',
    '      if (e.data === "reload") { route(); blipLive(); toast("Updated"); }',
    '    };',
    '    es.onerror = () => { setLive(false); /* EventSource auto-reconnects */ };',
    '  } catch (_e) { /* live reload unavailable; static view still works */ }',
    '}',
    '// Theme toggle — persist the choice and reload so the boot script + hljs/mermaid pick it up.',
    "function applyTheme(t) { try { localStorage.setItem('theme', t); } catch (e) {} location.reload(); }",
    "{ const tb = document.getElementById('themebtn'); if (tb) { const d = document.documentElement.dataset.theme === 'dark'; tb.textContent = d ? '\\u2600' : '\\u263E'; tb.onclick = () => applyTheme(d ? 'light' : 'dark'); } }",
    'startLiveReload();',
    // KLOOP_CLIENT (the run-viewer renderers) is appended here — its function
    // declarations hoist, so route() above can call renderKloop/renderKloopRun.
  ].join('\n') +
  '\n' +
  KLOOP_CLIENT;

export const SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script>try{document.documentElement.dataset.theme=localStorage.getItem('theme')||(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch(e){}</script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>kloop</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<style>${STYLE}</style>
</head>
<body>
<div id="progress"></div>
<header class="bar"><div class="bar-inner">
<nav class="crumb" id="crumb"><a href="/">Kloop</a></nav>
<button class="themebtn" id="themebtn" type="button" aria-label="Toggle light/dark" title="Toggle light/dark"></button>
<span class="live" id="live"><span class="dot"></span><span class="txt">live</span></span>
</div></header>
<main id="main"><div id="app"><div class="skel"><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div></div></div></main>
<script type="module">
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
