// Density switch — "compact" hides tool bodies entirely (title + chip only);
// "comfortable" is the default. Persists in localStorage.

import { useEffect, useState } from 'react';

export type Density = 'comfortable' | 'compact';
const KEY = 'kteam-density';

function initial(): Density {
  if (typeof window === 'undefined') return 'comfortable';
  const stored = localStorage.getItem(KEY);
  if (stored === 'compact' || stored === 'comfortable') return stored;
  return 'comfortable';
}

export function useDensity(): [Density, () => void] {
  const [density, setDensity] = useState<Density>(initial());
  useEffect(() => {
    try {
      localStorage.setItem(KEY, density);
    } catch {
      /* private mode etc. */
    }
  }, [density]);
  return [density, () => setDensity(d => (d === 'compact' ? 'comfortable' : 'compact'))];
}
