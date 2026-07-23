// Theme toggling. Persists to localStorage and falls back to OS preference.

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const KEY = 'kloop-theme';

function initial(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = localStorage.getItem(KEY) as Theme | null;
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initial());
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* private mode etc. */
    }
  }, [theme]);
  // Apply on first mount too (the initial state may not have flushed yet).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [theme, () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))];
}
