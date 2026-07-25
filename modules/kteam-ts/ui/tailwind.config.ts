import type { Config } from 'tailwindcss';

/* TIER 1 — item 3. COMPLETE REPLACEMENT for `ui/tailwind.config.ts`.
   Diff vs the shipped file: adds `fontSize`, `fontWeight`, `lineHeight`,
   `letterSpacing`, `spacing`, `height`/`minHeight`, `borderColor.border-strong`,
   `maxWidth.prose`, plus the `borderRadius` / `boxShadow` / `borderWidth` ROLE
   keys. Nothing is removed.

   Every scale resolves to a CSS variable so utilities and raw CSS agree in EVERY
   theme. This matters more than it looks: `rounded-md` and `--radius-md` used to
   be two different numbers (8px vs 9px), and with a Neo-Brutalist theme in the
   set a hardcoded radius/border/height here means a half-themed UI — square in
   the stylesheet, rounded in the utilities.

   ROLE keys (`rounded-control`, `shadow-panel`, `h-control`) are what components
   should reach for. The t-shirt ramp keys are kept so the existing ~90 call sites
   keep compiling during the Tier-2 migration. */
const config: Config = {
  // The resolved attribute is `<family>-<mode>`, so the old exact-match
  // `[data-theme="dark"]` no longer selects anything. Suffix-match instead.
  darkMode: ['class', '[data-theme$="-dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-3': 'var(--surface-3)',
        fg: 'var(--fg)',
        'fg-soft': 'var(--fg-soft)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        border: 'var(--border)',
        'border-soft': 'var(--border-soft)',
        // Control edges — contrast-constrained (>=3:1, >=7:1 in High Contrast),
        // unlike the decorative `border`/`border-soft`. nero's ask, contract §8.2.
        'border-strong': 'var(--border-strong)',
        accent: 'var(--accent)',
        'accent-fg': 'var(--accent-fg)',
        'accent-soft': 'var(--accent-soft)',
        // DECORATIVE TINT ONLY. Must not carry state — it measures 1.2-2.9:1 in
        // 6 of 10 themes. Selected/active/checked states use `accent`.
        'accent-border': 'var(--accent-border)',
        'accent-strong': 'var(--accent-strong)',
        'user-bg': 'var(--user-bg)',
        'user-border': 'var(--user-border)',
        'user-rail': 'var(--user-rail)',
        'code-bg': 'var(--code-bg)',
        'code-border': 'var(--code-border)',
        'code-fg': 'var(--code-fg)',
        ok: 'var(--ok)',
        'ok-bg': 'var(--ok-bg)',
        'ok-border': 'var(--ok-border)',
        warn: 'var(--warn)',
        'warn-bg': 'var(--warn-bg)',
        'warn-border': 'var(--warn-border)',
        pend: 'var(--pend)',
        'pend-bg': 'var(--pend-bg)',
        'pend-border': 'var(--pend-border)',
        err: 'var(--err)',
        'err-bg': 'var(--err-bg)',
        'err-border': 'var(--err-border)',
        // Modal/drawer scrim — replaces the `bg-black/35|40` literals.
        scrim: 'var(--scrim)',
        focus: 'var(--focus-color)',
        selection: 'var(--selection-bg)',
      },

      /* The type ramp — what kills the `text-[11px]` literals scattered across
         12 components, and what lets Ember run larger/looser while Mission runs
         tighter.

         ADDITIVE BY DESIGN, taking jessica's option: these are ROLE names, and
         Tailwind's own `text-xs`/`text-sm`/`text-base`/`text-lg` are left
         completely untouched. The originally-planned remap of `xs`/`sm` would
         have silently resized ~90 existing call sites app-wide (contract R3, the
         one change lead decision 6 wanted isolated and revertable). Naming the
         roles instead achieves the same contract — a theme-controlled ramp that
         Tier-2 migrates onto — with ZERO fallout and no risky isolated commit.
         R3 is therefore withdrawn, not deferred.

         Role → token, for the Tier-2 migration:
           text-label  10px-ish label caps      (--label-size)
           text-2xs    smallest meta            (--text-2xs)
           text-meta   badges, dim meta         (--text-xs)
           text-cell   table cells, nav rows    (--text-sm)
           text-ui     control labels           (--text-base)
           text-row    primary row text, tasks  (--text-md)
           text-title  session title            (--text-lg)
           text-display  h1                     (--text-display)
           text-chrome   transcript tool chrome (--chrome-font-size)
           text-prose    rendered markdown      (--md-font-size)
           text-code     code blocks            (--code-font-size) */
      fontSize: {
        label: 'var(--label-size)',
        '2xs': 'var(--text-2xs)',
        meta: 'var(--text-xs)',
        cell: 'var(--text-sm)',
        ui: 'var(--text-base)',
        row: 'var(--text-md)',
        title: 'var(--text-lg)',
        display: 'var(--text-display)',
        chrome: 'var(--chrome-font-size)',
        prose: 'var(--md-font-size)',
        code: 'var(--code-font-size)',
      },
      fontWeight: {
        normal: 'var(--weight-normal)',
        medium: 'var(--weight-medium)',
        semibold: 'var(--weight-strong)',
        bold: 'var(--weight-display)',
      },
      lineHeight: {
        base: 'var(--leading-base)',
        tight: 'var(--leading-tight)',
        prose: 'var(--md-leading)',
      },
      letterSpacing: {
        label: 'var(--tracking-label)',
        display: 'var(--tracking-display)',
        body: 'var(--tracking-body)',
      },
      fontFamily: {
        // `ui` now resolves to --font-ui, which Mission points at the mono stack
        // — that one indirection is what puts uppercase Cascadia on every control.
        ui: 'var(--font-ui)',
        body: 'var(--font-body)',
        display: 'var(--font-display)',
        prose: 'var(--font-prose)',
        mono: 'var(--font-mono)',
      },

      /* Density. `h-control` already has the mobile floor composed in (themes.css
         computes it as max(desktop, --target-floor)), so a coarse pointer gets
         44px without any component knowing about pointers. */
      height: {
        control: 'var(--control-h)',
        'control-sm': 'var(--control-h-sm)',
        row: 'var(--row-min-h)',
      },
      minHeight: {
        control: 'var(--control-h)',
        row: 'var(--row-min-h)',
      },
      spacing: {
        xs: 'var(--gap-xs)',
        sm: 'var(--gap-sm)',
        md: 'var(--gap-md)',
        'control-x': 'var(--pad-control-x)',
        'badge-x': 'var(--pad-badge-x)',
        panel: 'var(--pad-panel)',
        'row-y': 'var(--pad-row-y)',
        'cell-x': 'var(--pad-cell-x)',
      },

      boxShadow: {
        // Role keys — what components should use.
        control: 'var(--shadow-control)',
        panel: 'var(--shadow-panel)',
        popover: 'var(--shadow-popover)',
        active: 'var(--shadow-active)',
        rail: 'var(--rail-active)',
        inset: 'var(--rule-inset)',
        // Raw ramp, kept for existing call sites.
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        // Mission Control's cyan bloom; a zero-alpha no-op in other themes.
        glow: 'var(--shadow-glow)',
      },

      borderRadius: {
        // Role keys.
        control: 'var(--radius-control)',
        panel: 'var(--radius-panel)',
        badge: 'var(--radius-badge)',
        tab: 'var(--radius-tab)',
        input: 'var(--radius-input)',
        // Raw ramp. `rounded` (no suffix) keeps its 4px Studio feel while
        // collapsing to 0 under Neo-Brutalism.
        DEFAULT: 'var(--radius-xs)',
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        pill: 'var(--radius-pill)',
        // `rounded-full` intentionally stays a literal 9999px: status dots use
        // shape as a non-colour signal and must stay circular in every theme.
      },
      borderWidth: {
        // Plain `border` follows the theme (1px, 2-3px under Neo/High Contrast).
        DEFAULT: 'var(--border-width)',
        heavy: 'var(--border-width-heavy)',
        control: 'var(--stroke-control)',
        panel: 'var(--stroke-panel)',
      },
      outlineWidth: {
        focus: 'var(--focus-width)',
      },
      outlineOffset: {
        focus: 'var(--focus-offset)',
      },
      ringColor: {
        DEFAULT: 'var(--ring)',
        focus: 'var(--focus-color)',
      },
      maxWidth: {
        prose: 'var(--prose-measure)',
      },
    },
  },
  plugins: [],
};

export default config;
