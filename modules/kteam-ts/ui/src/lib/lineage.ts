// SESSION LINEAGE — defensive, presentation-free helpers shared by the fleet
// surfaces. The daemon records a parent id when one kteam session starts
// another, but old records, purges and future malformed data must never make a
// client-side tree recurse forever.

import type { SessionView } from '../types';
import { displayCallsign } from './callsign';

/** Sidebar indentation stops growing after two 10px steps. */
export const MAX_INDENT_DEPTH = 2;
const INDENT_PER_LEVEL = 10;

/** The one geometry rule used by the nested sidebar: two physical steps at
 * most, even when DOM nesting continues beyond that visual cap. */
export function lineageIndent(depth: number): number {
  const wholeDepth = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  return Math.min(wholeDepth, MAX_INDENT_DEPTH) * INDENT_PER_LEVEL;
}

export interface LineageIndex {
  /** Direct children in the daemon's supplied order. */
  childrenOf: ReadonlyMap<string, SessionView[]>;
  /** A child → parent edge only when both records still exist and are valid. */
  parentOf: ReadonlyMap<string, string>;
  /** Root is zero; malformed cycles are roots rather than an unbounded walk. */
  depthOf: ReadonlyMap<string, number>;
}

export interface NestedRow {
  view: SessionView;
  /** Depth inside this visible project group, not the global lineage depth. */
  depth: number;
  children: NestedRow[];
  /** Raw parent id for a row that could not nest under a visible same-group parent. */
  spawnedBy?: string;
}

export type ParentDisplay =
  | { kind: 'resolved'; view: SessionView; name: string }
  | { kind: 'missing'; shortId: string }
  | null;

/** A concise id remains useful for old records with no human-readable name. */
export function shortSessionId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function displayName(view: SessionView): string {
  return displayCallsign(view.config.teammate) || view.config.name?.trim() || shortSessionId(view.config.id);
}

/** Resolve by id, never by the recyclable teammate callsign. */
export function parentDisplay(parentId: string | undefined, byId: ReadonlyMap<string, SessionView>): ParentDisplay {
  const id = parentId?.trim();
  if (!id) return null;
  const view = byId.get(id);
  return view ? { kind: 'resolved', view, name: displayName(view) } : { kind: 'missing', shortId: shortSessionId(id) };
}

/** Find every member of a parent-pointer cycle so every bad edge can be dropped. */
function cyclicIds(parentOf: ReadonlyMap<string, string>): Set<string> {
  const cyclic = new Set<string>();
  const settled = new Set<string>();
  for (const start of parentOf.keys()) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = start;
    while (current && !settled.has(current)) {
      const seenAt = position.get(current);
      if (seenAt !== undefined) {
        for (const id of path.slice(seenAt)) cyclic.add(id);
        break;
      }
      position.set(current, path.length);
      path.push(current);
      // A parent pointer can only lead through this finite map. This guard is
      // defensive if a caller ever hands us an exotic Map implementation.
      if (path.length > parentOf.size) break;
      current = parentOf.get(current);
    }
    for (const id of path) settled.add(id);
  }
  return cyclic;
}

/** Every edge is walked once after cycle removal, so the whole index remains
 * O(n) even for a historical fleet with one long lineage chain. */
function buildDepths(sessions: readonly SessionView[], parentOf: ReadonlyMap<string, string>): Map<string, number> {
  const depthOf = new Map<string, number>();
  for (const view of sessions) {
    const start = view.config.id;
    if (depthOf.has(start)) continue;

    const path: string[] = [];
    const inPath = new Set<string>();
    let current: string | undefined = start;
    while (current && !depthOf.has(current) && !inPath.has(current)) {
      inPath.add(current);
      path.push(current);
      if (path.length > parentOf.size + 1) break;
      current = parentOf.get(current);
    }

    let parentDepth = current ? (depthOf.get(current) ?? 0) : 0;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const id = path[index]!;
      if (!parentOf.has(id)) parentDepth = 0;
      else parentDepth += 1;
      depthOf.set(id, parentDepth);
    }
  }
  return depthOf;
}

/** Build a safe index once per fleet snapshot. Missing, self and cyclic links
 * are deliberately absent: the UI renders those records as roots instead of
 * trusting bad data to form a navigable tree. */
export function buildLineage(sessions: readonly SessionView[]): LineageIndex {
  const byId = new Map<string, SessionView>();
  for (const view of sessions) byId.set(view.config.id, view);

  const parentOf = new Map<string, string>();
  for (const view of sessions) {
    const id = view.config.id;
    const parent = view.config.parent?.trim();
    if (!parent || parent === id || !byId.has(parent)) continue;
    parentOf.set(id, parent);
  }

  for (const id of cyclicIds(parentOf)) parentOf.delete(id);

  const childrenOf = new Map<string, SessionView[]>();
  for (const view of sessions) {
    const parent = parentOf.get(view.config.id);
    if (!parent) continue;
    const children = childrenOf.get(parent);
    if (children) children.push(view);
    else childrenOf.set(parent, [view]);
  }

  const depthOf = buildDepths(sessions, parentOf);

  return { childrenOf, parentOf, depthOf };
}

function activityAt(view: SessionView): number {
  const value = Date.parse(view.state.lastActivityAt ?? view.config.updatedAt ?? '');
  return Number.isNaN(value) ? 0 : value;
}

/** Newest life-sign first. Equal dates preserve the daemon's supplied order. */
export function byNewestActivity(a: SessionView, b: SessionView): number {
  return activityAt(b) - activityAt(a);
}

function wouldCreateCycle(childId: string, parentId: string, parentOf: ReadonlyMap<string, string>): boolean {
  const seen = new Set<string>([childId]);
  let current: string | undefined = parentId;
  while (current) {
    if (seen.has(current)) return true;
    seen.add(current);
    if (seen.size > parentOf.size + 1) return true;
    current = parentOf.get(current);
  }
  return false;
}

function sortAndDepth(rows: NestedRow[], depth: number): number {
  const subtreeActivity = new Map<NestedRow, number>();
  let newest = 0;
  for (const row of rows) {
    const childActivity = sortAndDepth(row.children, depth + 1);
    const activity = Math.max(activityAt(row.view), childActivity);
    subtreeActivity.set(row, activity);
    newest = Math.max(newest, activity);
  }
  if (depth === 0) rows.sort((a, b) => subtreeActivity.get(b)! - subtreeActivity.get(a)!);
  else rows.sort((a, b) => byNewestActivity(a.view, b.view));
  for (const row of rows) row.depth = depth;
  return newest;
}

/** Nest only under parents visible in this same project group. A filtered,
 * purged or cross-project parent leaves its child flat, retaining the raw
 * parent id so the sidebar can still describe the relationship in its tooltip.
 * The defensive ancestor check makes attachment O(n × depth), plus ordinary
 * sibling sorting; live lineage depth is intentionally shallow. */
export function nestByLineage(rows: readonly SessionView[], lineage: LineageIndex): NestedRow[] {
  const visibleIds = new Set(rows.map(view => view.config.id));
  const nodes = new Map<string, NestedRow>();
  for (const view of rows) nodes.set(view.config.id, { view, depth: 0, children: [] });

  const roots: NestedRow[] = [];
  for (const view of rows) {
    const id = view.config.id;
    const node = nodes.get(id)!;
    const parent = lineage.parentOf.get(id);
    if (parent && visibleIds.has(parent) && !wouldCreateCycle(id, parent, lineage.parentOf)) {
      nodes.get(parent)!.children.push(node);
      continue;
    }
    // The raw config parent intentionally survives a missing/cross-group edge:
    // it lets the row explain why it is flat without resurrecting a ghost row.
    const rawParent = view.config.parent?.trim();
    if (rawParent && rawParent !== id) node.spawnedBy = rawParent;
    roots.push(node);
  }

  sortAndDepth(roots, 0);
  return roots;
}
