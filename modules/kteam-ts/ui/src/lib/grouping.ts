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
// Exported pieces, in the order they are applied:
//   scopeSessions   — folder mode: narrow the fleet to ONE project group (identity
//                     when no scope is active), composed BEFORE the four filters
//   filterSessions  — the instant client-side filter (query + mode + rc + finished)
//   modeCounts      — what each mode segment WOULD show, under the other filters
//   groupByProject  — longest-project-path-prefix grouping, cwd basename fallback
//
// The grouping matcher is factored out into `projectKeyFor` so grouping and
// scoping can NEVER disagree on which folder a session belongs to: the group
// header you tap to focus a folder and the predicate that then narrows the list
// derive the session's group key from the exact same code.

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
    c.parent,
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

/** Strip trailing slashes for prefix comparison, keeping a bare root `/`.
 *
 *  Daemon-registered `ProjectInfo.path` values are NOT guaranteed canonical
 *  (no trailing slash, no symlink variance) — that was flagged as a CANNOT-TELL
 *  in the plan. Routing both grouping and scope equality through this one
 *  normaliser is the mitigation: a `…/repo` and a `…/repo/` registration collapse
 *  to the same key, so a scope set from one still matches sessions filed under
 *  the other. */
export function normalizeProjectPath(p: string): string {
  const trimmed = (p ?? '').replace(/\/+$/, '');
  return trimmed === '' ? (p ?? '') : trimmed;
}

/** The group a session belongs to: `{ key, name }`.
 *
 *  `key` is the STABLE identity used everywhere scope is compared or persisted —
 *  a normalised registered project path, or the session's own (normalised) cwd
 *  when it matches no known project. `name` is only for display. Names can
 *  collide across distinct paths; keys cannot, which is why folder mode scopes
 *  on the key, never the name.
 *
 *  The LONGEST registered path that prefixes the cwd wins, so a worktree nested
 *  inside a repo files under the worktree rather than the parent. */
export interface ProjectKey {
  key: string;
  name: string;
}

export function projectKeyFor(cwd: string, projects: readonly ProjectInfo[]): ProjectKey {
  const c = normalizeProjectPath(cwd ?? '');
  let best: ProjectInfo | undefined;
  let bestLen = -1;
  for (const p of projects) {
    const pp = normalizeProjectPath(p.path);
    if ((c === pp || c.startsWith(pp + '/')) && pp.length > bestLen) {
      best = p;
      bestLen = pp.length;
    }
  }
  if (best) return { key: normalizeProjectPath(best.path), name: best.name };
  return { key: c, name: c ? baseName(c) : 'ungrouped' };
}

/** True when a session falls in the active folder scope. `scope === null` means
 *  "no folder mode" and admits everything (identity). `scope` is a group KEY
 *  (see `projectKeyFor`), never a display name. */
export function sessionInScope(view: SessionView, projects: readonly ProjectInfo[], scope: string | null): boolean {
  if (scope === null) return true;
  return projectKeyFor(view.config.cwd ?? '', projects).key === normalizeProjectPath(scope);
}

/** Folder mode: narrow the fleet to one project group. Applied BEFORE the four
 *  filters and replacing none of them; an identity pass-through when unscoped, so
 *  the whole feature degrades to today's behaviour the instant `scope` is null. */
export function scopeSessions(
  sessions: readonly SessionView[],
  projects: readonly ProjectInfo[],
  scope: string | null,
): SessionView[] {
  if (scope === null) return sessions.slice();
  const s = normalizeProjectPath(scope);
  return sessions.filter(v => projectKeyFor(v.config.cwd ?? '', projects).key === s);
}

/** A scope is RESOLVABLE when it names a real folder: a registered project path,
 *  or the group key of at least one session in the UNFILTERED fleet (which covers
 *  cwd-fallback groups). Computed over the unfiltered list on purpose — a folder
 *  whose sessions are all finished with "include finished" off is *filtered-empty*
 *  (scope preserved), not *missing* (scope recovered). */
export function isScopeResolvable(
  scope: string,
  sessions: readonly SessionView[],
  projects: readonly ProjectInfo[],
): boolean {
  const s = normalizeProjectPath(scope);
  if (projects.some(p => normalizeProjectPath(p.path) === s)) return true;
  return sessions.some(v => projectKeyFor(v.config.cwd ?? '', projects).key === s);
}

/** Group by project: the LONGEST registered project path that prefixes the
 *  session's cwd wins (so a worktree nested inside a repo files under the
 *  worktree, not the parent), and a cwd under no known project falls back to
 *  its own basename so nothing is orphaned. Delegates the per-session decision
 *  to `projectKeyFor` so scoping can never file a session differently.
 *
 *  `sortRows` is opt-in because the dashboard preserves the daemon's order
 *  while the sidebar wants most-recent-first. */
export function groupByProject(
  sessions: readonly SessionView[],
  projects: readonly ProjectInfo[],
  sortRows = false,
): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const v of sessions) {
    const { key, name } = projectKeyFor(v.config.cwd ?? '', projects);
    if (!map.has(key)) map.set(key, { name, path: key, rows: [] });
    map.get(key)!.rows.push(v);
  }
  const groups = [...map.values()];
  if (sortRows) for (const g of groups) g.rows.sort(byActivity);
  return groups.sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
}
