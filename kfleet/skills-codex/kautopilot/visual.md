# kautopilot visual brief — one HTML infographic per artifact version

This is the full design brief for the sub-agent that renders an artifact version
(`vN.md`) into a standalone `vN.html`. The controller passes the sub-agent: the
`path` that `kautopilot revise` returned, and the Read URL (`revise`'s returned
`url`) to use verbatim as the source link. On Codex, delegate this renderer to a
**Sonnet 5** subagent when model selection is available; if it is not, use the
strongest available visual/code-writing subagent. Tell the sub-agent to **use the
`frontend-design` skill if available** — and if that skill isn't installed, to apply
the same accessible visual-design principles directly (don't fail).

The audience is **ADHD + dyslexic**, so the HTML must be scannable and visual,
NOT a wall of text. For **v1** the sub-agent has free rein on the _layout_ —
clarity beats fidelity; jarring-but-clear is OK — but the **bright-mode + Claude
design style** and **completeness** rules below always apply. For **v2+** it
should instead **keep the previous version's design** and edit it (see "Reuse
the prior design" below), so versions look like siblings.

## The brief

- **Cover every segment (completeness).** **Every** section/segment of the source markdown
  must be reflected in the visual — do not drop, merge-away, or silently summarize content
  out. Reshaping a wall of text into scannable cards/callouts is the goal, but the
  information from each original section must still be present.
- **Bright mode + Claude design style.** Always render in **bright (light) mode** using the
  **Claude design style** — warm off-white/cream background, dark high-contrast text, Claude's
  coral/terracotta accent for highlights, generous whitespace, rounded cards. Never dark mode.
- **Reuse the prior design (v2+ — do this FIRST).** When a previous HTML exists
  (`v{N-1}.html`, the **same path** the new file goes — for single-file that's next to the
  `.md`; for plans it's that plan's own `<plan>/v{N-1}.html`), **start by copying it to
  `vN.html`**, then **edit only the parts the markdown changed** — keep the
  same CSS, colors, layout, and components so the look-and-feel stays consistent and the diff
  is cheap (you edit snippets, not regenerate the whole page). Refresh the **"What changed"**
  callout each time. **Before reusing, sanity-check** the copied file still meets the
  Output-format and Mobile constraints below (no JS, no remote resources, responsive); if it
  doesn't (e.g. an old file predating these rules), fix those bits or regenerate. **Escape
  hatch:** if the markdown changed shape so drastically that editing the old layout is more
  work than starting over, regenerate from scratch instead. (For **v1**, or when no prior
  HTML exists, generate from scratch.)
- **Input & output location** depends on the artifact:
  - **Single-file** (brainstorm, triage, spec, master_plan, feedback) — `path` is a `vN.md`. Write a
    sibling **`vN.html`** in the **same directory, same basename** (just `.md` → `.html`).
    For **v2+**, also read the previous version (`v{N-1}.md` in the same dir) and, at the
    **TOP**, show a short **"What changed"** callout summarizing the diff (key changes only).
  - **Plans** — `path` is the repo's **plans dir**, which contains one subfolder per plan,
    each with a `vN.md`. Treat each plan exactly like a single-file artifact: **spawn one
    sub-agent per plan**, and each writes a sibling **`<plan>/vN.html`** next to that plan's
    `<plan>/vN.md`. **Do NOT merge** plans into one file — one infographic per plan. Pass each
    sub-agent only its own plan's `vN.md` path. For **v2+**, each compares against its own
    `<plan>/v{N-1}.md` and adds the "What changed" callout at the top of that plan's page.
    The dashboard shows a **"View visual"** link on each plan's tab.
  - For the **master plan**, render the DAG as a mermaid/diagram-style visual so the
    PR/branch layout and gate-level dependencies are visible at a glance.
- **Output format** — a **standalone** HTML file: fully self-contained inline CSS, no build
  step, **no JavaScript** (it is served with a script-blocking CSP — any JS is silently
  dropped, so the page must work with zero scripts). **No remote resources** either: the CSP
  blocks all external hosts, so use a **system font stack** (no Google Fonts / CDN `<link>` /
  `@import`) and embed any images as inline SVG or `data:` URIs. Design for dyslexia:
  generous spacing, high contrast, sans-serif, left-aligned (never justified), short lines,
  icons/cards/callouts, strong visual hierarchy.
- **Mobile-friendly / responsive** — it WILL be viewed on phones. Include
  `<meta name="viewport" content="width=device-width, initial-scale=1">`; use a fluid,
  single-column-on-narrow layout (e.g. CSS flex/grid that wraps, `max-width` containers,
  relative units, `@media` breakpoints); never rely on fixed pixel widths or horizontal
  scrolling; tap targets and text must stay comfortably readable on a small screen.
- **Cross-link back to source** — put a clear **"← View source (markdown)"** link near the
  top of the HTML. Use the **Read URL you were handed** (`revise`'s `url`) verbatim as the
  `href` (add `target="_top"` — harmless full-page navigation). Do NOT hand-construct this
  URL — use the one passed in. The dashboard's "View visual" link is the reverse direction.
- Do this for **every** version of **every** artifact before you present that version. The
  dashboard auto-detects each HTML sibling and shows a **"View visual"** link that opens the
  full-page infographic — on the Read page for single-file artifacts, and on each plan's tab
  for plans.
