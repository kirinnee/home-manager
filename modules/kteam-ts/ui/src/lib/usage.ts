// Account quota for a session, resolved from the two places the daemon
// publishes it.
//
// There are two sources and they are NOT redundant:
//
//   1. `state.usage*` — stamped onto a session by its own monitor loop, on a
//      60s tick. Authoritative and live, but only exists while that session is
//      being monitored: a session in its first minute, an idle one, and every
//      terminal one carry nothing. This is the gap that made the UI look like
//      quota "was not implemented" even after `kteam ps` grew a QUOTA column.
//
//   2. `GET /v1/usage` — the daemon's cached kfleet feed, keyed by wrapper
//      binary. One snapshot shared by the whole fleet, available immediately,
//      identical for every session on the same wrapper.
//
// (1) wins when present (it is the same feed, already reconciled into that
// session's state), (2) fills in everything else. When NEITHER has a record
// the answer is `null` — the caller must render "no data", never 0%.

import type { SessionState, SessionView, UsageAccountView, UsageFeedView } from '../types';

export interface Quota {
  fiveHourPercent?: number;
  weeklyPercent?: number;
  fiveHourResetAt?: number;
  weeklyResetAt?: number;
  atLimit?: boolean;
  authOk?: boolean;
}

/** Index a feed by wrapper binary for O(1) joins. */
export function usageIndex(feed: UsageFeedView | null): Map<string, UsageAccountView> {
  const map = new Map<string, UsageAccountView>();
  for (const account of feed?.accounts ?? []) map.set(account.binary, account);
  return map;
}

function fromState(state: SessionState): Quota | null {
  const has =
    state.usageAuthOk !== undefined ||
    state.usage5hPercent !== undefined ||
    state.usageWeeklyPercent !== undefined ||
    state.usageAtLimit !== undefined;
  if (!has) return null;
  return {
    fiveHourPercent: state.usage5hPercent,
    weeklyPercent: state.usageWeeklyPercent,
    fiveHourResetAt: state.usage5hResetAt,
    weeklyResetAt: state.usageWeeklyResetAt,
    atLimit: state.usageAtLimit,
    authOk: state.usageAuthOk,
  };
}

/** The quota to display for `view`, or null when nothing is known about its
 *  wrapper. Callers MUST treat null as "no data" rather than as zero. */
export function quotaFor(view: SessionView, index: Map<string, UsageAccountView>): Quota | null {
  return fromState(view.state) ?? index.get(view.config.binary) ?? null;
}

/** Does this quota carry anything worth rendering? An all-undefined record
 *  (a wrapper kfleet knows but reports no usable numbers for) is not. */
export function hasReadout(quota: Quota | null): quota is Quota {
  if (!quota) return false;
  return (
    quota.authOk === false || quota.fiveHourPercent != null || quota.weeklyPercent != null || quota.atLimit === true
  );
}
