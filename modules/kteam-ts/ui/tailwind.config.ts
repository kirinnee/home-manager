import type { Config } from 'tailwindcss';

/* Every scale below resolves to a CSS variable so that utilities and raw CSS
   agree in EVERY theme. This matters more than it looks: `rounded-md` and
   `--radius-md` used to be two different numbers (8px vs 9px), and with a
   Neo-Brutalist theme in the set a hardcoded radius/border here would mean a
   half-themed UI — square in the stylesheet, rounded in the utilities. */
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
        accent: 'var(--accent)',
        'accent-fg': 'var(--accent-fg)',
        'accent-soft': 'var(--accent-soft)',
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
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        // Mission Control's cyan bloom; a zero-alpha no-op in other themes.
        glow: 'var(--shadow-glow)',
      },
      fontFamily: {
        ui: 'var(--font-body)',
        body: 'var(--font-body)',
        display: 'var(--font-display)',
        mono: 'var(--font-mono)',
      },
      borderRadius: {
        // `rounded` (no suffix) keeps its current 4px feel in Studio while
        // collapsing to 0 under Neo-Brutalism.
        DEFAULT: 'var(--radius-xs)',
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        // `rounded-full` stays a literal pill: status dots use shape as a
        // non-colour signal and must remain circular in every theme.
        pill: 'var(--radius-pill)',
      },
      borderWidth: {
        // Plain `border` follows the theme (1px, 2px under Neo/High Contrast).
        DEFAULT: 'var(--border-width)',
        heavy: 'var(--border-width-heavy)',
      },
      outlineWidth: {
        focus: 'var(--focus-width)',
      },
      ringColor: {
        DEFAULT: 'var(--ring)',
        focus: 'var(--focus-color)',
      },
    },
  },
  plugins: [],
};

export default config;
