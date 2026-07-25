// The daemon's cached kfleet usage feed.
//
// THE POLL LIVES IN THE STORE NOW (lib/store.tsx). This hook used to own a 60s
// interval, which meant one interval PER MOUNTED CONSUMER: with the dashboard
// kept mounted behind a session and two retained chat panes, three components
// asked the daemon the same fleet-wide question every minute, forever. The
// store runs one visibility-gated 60s poll and publishes a stable indexed
// snapshot; this is now a thin read of that slice, with the same API and the
// same guarantees (last-good on failure, absent record = unknown, never 0%).

import { useUsageSnapshot, type UsageSnapshot } from '../lib/store';

export type UsageState = UsageSnapshot;

export function useUsage(): UsageState {
  return useUsageSnapshot();
}
