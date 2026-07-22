import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class', '[data-theme="dark"]'],
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
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
      },
      fontFamily: {
        ui: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        md: '8px',
        lg: '10px',
      },
    },
  },
  plugins: [],
};

export default config;
