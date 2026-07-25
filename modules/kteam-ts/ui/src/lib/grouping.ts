// FLEET FILTERING + PROJECT GROUPING — one implementation, two consumers.
//
// The dashboard and the persistent sidebar answer the same question ("which
// sessions am I looking at, and whose project are they in?") and MUST answer it
// identically: the sidebar renders the controls, the dashboard renders the
// table, and a session that the sidebar shows under `nitroso` cannot be filed
// under something else one column over. Both read the same store controls, so
// the only way they can still disagree is by each carrying its own copy of the
// predicate — which is what this file removes.
//
// Three exported pieces, in the order they are applied:
//   filterSessions  — the instant client-side filter (query + mode + rc + finished)
//   modeCounts      — what each mode segment WOULD show, under the other filters
//   groupByProject  — longest-project-path-prefix grouping, cwd basename fallback

import type { ProjectInfo, SessionView } from '../types';
import { TERMINAL_STATUSES } from './utils';
import type { ModeFilter } from './store';

/** Last path segment: `/home/k/.config/home-manager` → `home-manager`. */
export function baseName(p: string): string {
  const seg = p.replace(/\/+$/, '').split('/').filter(Boolean);
  return seg.length ? seg[seg.length - 1]! : p;
}

/** The four controls that narrow the fleet. Mirrors the store's `UiControls`
 *  subset, as a plain shape so this module does not depend on the store. */
export interface FleetFilter {
  query: string;
  mode: ModeFilter;
  rcOnly: boolean;
  includeFinished: boolean;
}

/** Everything the instant query matches against, lowercased.
 *
 *  `mode` is in the haystack so typing "interactive" filters, and RC sessions
 *  answer to a literal "rc" — both are things the user types expecting a
 *  result, and both also exist as real filters for when they want precision. */
function haystack(v: SessionView): string {
  const c = v.config;
  return [
    c.id,
    c.teammate,
    c.name,
    c.label,
    c.binary,
    c.model,
    c.modelHint,
    c.cwd,
    c.mode,
    v.state.status,
    c.remoteControl ? 'rc remote-control' : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** True when this session survives every filter EXCEPT the mode segment. Used
 *  both by the filter itself and by the counts, so the numbers on the segment
 *  are computed from the same predicate that produced the list. */
function passesNonMode(v: SessionView, f: FleetFilter, needle: string): boolean {
  if (!f.includeFinished && TERMINAL_STATUSES.has(v.state.status)) return false;
  if (f.rcOnly && !v.config.remoteControl) return false;
  if (!needle) return true;
  return haystack(v).includes(needle);
}

export function filterSessions(sessions: readonly SessionView[], f: FleetFilter): SessionView[] {
  const needle = f.query.trim().toLowerCase();
  return sessions.filter(v => {
    if (!passesNonMode(v, f, needle)) return false;
    return f.mode === 'all' || v.config.mode === f.mode;
  });
}

export interface ModeCounts {
  all: number;
  interactive: number;
  auto: number;
}

/** Counts for the mode segment, over everything the OTHER filters admit — so
 *  each number describes what clicking that segment would show rather than an
 *  unrelated fleet-wide total that never matches the list underneath it. */
export function modeCounts(sessions: readonly SessionView[], f: FleetFilter): ModeCounts {
  const needle = f.query.trim().toLowerCase();
  const pool = sessions.filter(v => passesNonMode(v, f, needle));
  return {
    all: pool.length,
    interactive: pool.filter(v => v.config.mode === 'interactive').length,
    auto: pool.filter(v => v.config.mode === 'auto').length,
  };
}

export interface SessionGroup {
  name: string;
  path: string;
  rows: SessionView[];
}

/** Newest life-sign first. The sidebar is a live list: the teammate that just
 *  said something is the one you want at the top of its project, not whichever
 *  one the daemon happened to enumerate first. */
function byActivity(a: SessionView, b: SessionView): number {
  return (
    Date.parse(b.state.lastActivityAt ?? b.config.updatedAt ?? '') -
    Date.parse(a.state.lastActivityAt ?? a.config.updatedAt ?? '')
  );
}

/** Group by project: the LONGEST registered project path that prefixes the
 *  session's cwd wins (so a worktree nested inside a repo files under the
 *  worktree, not the parent), and a cwd under no known project falls back to
 *  its own basename so nothing is orphaned.
 *
 *  `sortRows` is opt-in because the dashboard preserves the daemon's order
 *  while the sidebar wants most-recent-first. */
export function groupByProject(
  sessions: readonly SessionView[],
  projects: readonly ProjectInfo[],
  sortRows = false,
): SessionGroup[] {
  const byPathLen = [...projects].sort((a, b) => b.path.length - a.path.length);
  const map = new Map<string, SessionGroup>();
  for (const v of sessions) {
    const cwd = v.config.cwd ?? '';
    const match = byPathLen.find(p => cwd === p.path || cwd.startsWith(p.path + '/'));
    const key = match?.path ?? cwd ?? 'ungrouped';
    const name = match?.name ?? (cwd ? baseName(cwd) : 'ungrouped');
    if (!map.has(key)) map.set(key, { name, path: match?.path ?? cwd, rows: [] });
    map.get(key)!.rows.push(v);
  }
  const groups = [...map.values()];
  if (sortRows) for (const g of groups) g.rows.sort(byActivity);
  return groups.sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
}
