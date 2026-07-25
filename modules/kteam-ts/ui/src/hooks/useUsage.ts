// The daemon's cached kfleet usage feed, polled slowly.
//
// kfleet refreshes on its own 300s interval and the daemon caches that, so
// polling faster than the data changes just burns requests. 60s keeps a reset
// countdown honest without pretending the numbers are live.
//
// Visibility-gated, same as the other background polls on this UI: a hidden
// tab has nobody reading the badge.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { usageIndex } from '../lib/usage';
import type { UsageAccountView, UsageFeedView } from '../types';

const REFRESH_MS = 60_000;

export interface UsageState {
  feed: UsageFeedView | null;
  index: Map<string, UsageAccountView>;
}

export function useUsage(): UsageState {
  const [feed, setFeed] = useState<UsageFeedView | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      api
        .usage()
        .then(next => {
          if (!cancelled) setFeed(next);
        })
        // Keep the last good snapshot on a failed refresh — a transient error
        // must not blank a readout that was correct a minute ago.
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Memoized: a fresh Map identity every render would defeat the memo on every
  // row/card that takes it as a prop.
  const index = useMemo(() => usageIndex(feed), [feed]);
  return { feed, index };
}
