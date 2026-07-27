// Which section of the details sheet a session was last looking at.
//
// The `⋯` sheet is now tabbed (Identity · Runtime · Progress · Budget). The one
// question this hook answers: when you reopen the sheet for a session, which tab
// do you land on? Answer: the tab you left it on for THAT session. A session you
// have never opened lands on `identity`. The memory is per-session, in-memory
// only, and capped — it does NOT survive a reload (deliberately: a reload is a
// fresh start, and a persisted store would slowly fill with tab picks for
// sessions that no longer exist).
//
// LRU, and the ACCESS EVENT IS THE SHEET OPEN. `SessionDetails` stays mounted
// across close/reopen (SessionHeader always renders it; it returns null while
// closed but its hooks keep running), so a one-shot mount effect would fire once
// and miss every later reopen. The hook therefore takes `open` and refreshes
// recency on every false→true transition (including the first). The only two
// things that touch recency are a sheet open and a `setTab` write — a background
// re-render of a closed sheet never does.

import { useCallback, useEffect, useReducer } from 'react';

export type DetailsTab = 'identity' | 'runtime' | 'progress' | 'budget';

export const DETAILS_TAB_ORDER: readonly DetailsTab[] = ['identity', 'runtime', 'progress', 'budget'];

const CAP = 50;

/** Module-level, in-memory only. Map insertion order IS the recency order:
 *  every write/touch deletes the key first and re-sets it, so the oldest entry
 *  is always `.keys().next()`. */
const LAST_TAB = new Map<string, DetailsTab>();

/** Test seam: clears the shared map so suites cannot leak recency into one
 *  another. Never called by product code. */
export function resetDetailsTabMemory(): void {
  LAST_TAB.clear();
}

/** Test seam: force the remembered tab for an id so a static render can exercise
 *  a non-default panel (the sheet has no DOM to click in that harness). Never
 *  called by product code. */
export function primeDetailsTab(id: string, tab: DetailsTab): void {
  writeTab(LAST_TAB, id, tab);
}

/** Pure read: the remembered tab, or the `identity` default for an id the map
 *  has never seen. Exported so the render path and the tests share one source. */
export function readTab(map: Map<string, DetailsTab>, id: string): DetailsTab {
  return map.get(id) ?? 'identity';
}

/** Refresh recency WITHOUT changing the value — the sheet-open access event.
 *  A no-op for an id that has no entry yet (a fresh session's first open reads
 *  the default; it earns a map entry only once a tab is actually written). */
export function touchTab(map: Map<string, DetailsTab>, id: string): void {
  if (!map.has(id)) return;
  const value = map.get(id)!;
  map.delete(id);
  map.set(id, value);
}

/** Write the chosen tab as the most-recent entry, then evict the oldest entries
 *  until the map is within `cap`. */
export function writeTab(map: Map<string, DetailsTab>, id: string, tab: DetailsTab, cap = CAP): void {
  map.delete(id);
  map.set(id, tab);
  while (map.size > cap) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * `[tab, setTab]` for the session's details sheet. Reads the module map directly
 * every render (a `sessionId` swap therefore reports the new session's tab on
 * the same render — no copied per-mount state to fall out of sync). The reducer
 * bump exists only to force a re-render after `setTab`.
 */
export function useDetailsTab(sessionId: string, open: boolean): [DetailsTab, (tab: DetailsTab) => void] {
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // The access event is the OPEN, not the mount — see the file header.
  useEffect(() => {
    if (open) touchTab(LAST_TAB, sessionId);
  }, [open, sessionId]);

  const setTab = useCallback(
    (tab: DetailsTab) => {
      writeTab(LAST_TAB, sessionId, tab);
      bump();
    },
    [sessionId],
  );

  return [readTab(LAST_TAB, sessionId), setTab];
}
