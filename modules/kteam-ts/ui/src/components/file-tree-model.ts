// Pure state model for the collapsible file tree: which directories are
// expanded, what the daemon has actually said about each of them, and the
// flattened row list a renderer paints.
//
// EVERYTHING HERE IS PURE, like files-model.ts, and the same honesty contract
// applies: a directory the daemon has not answered for renders as loading —
// never as a guessed child list — and a directory it refuses (denylist,
// gitignore, symlink, unaddressable name) is shown but never descended into.
// The tree holds exactly one record per directory, keyed by the daemon's own
// relative-path grammar, so a listing can only ever land under the directory
// that asked for it.

import type { FsEntry, FsListing } from './files-api';
import { entryRefusal, joinRel, normalizeRel, sortFsEntries } from './files-model';

export type TreeDirStatus = 'unloaded' | 'loading' | 'ready' | 'error';

export interface TreeDirNode {
  status: TreeDirStatus;
  /** Entries the daemon actually listed. Empty until `ready`. */
  entries: readonly FsEntry[];
  /** The daemon capped this directory's listing; the children are a prefix. */
  truncated: boolean;
  error: string | null;
}

export interface FileTreeState {
  /** One record per directory the tree has asked about ('' = the root). */
  nodes: ReadonlyMap<string, TreeDirNode>;
  /** Directories whose children are shown. The root is always expanded —
   *  its listing IS the tree's top level. */
  expanded: ReadonlySet<string>;
}

const UNLOADED: TreeDirNode = { status: 'unloaded', entries: [], truncated: false, error: null };

export function createFileTreeState(): FileTreeState {
  return { nodes: new Map(), expanded: new Set(['']) };
}

export function treeDirNode(state: FileTreeState, dir: string): TreeDirNode {
  return state.nodes.get(normalizeRel(dir)) ?? UNLOADED;
}

export function isTreeDirExpanded(state: FileTreeState, dir: string): boolean {
  return state.expanded.has(normalizeRel(dir));
}

function withNode(state: FileTreeState, dir: string, node: TreeDirNode): FileTreeState {
  const nodes = new Map(state.nodes);
  nodes.set(normalizeRel(dir), node);
  return { nodes, expanded: state.expanded };
}

export function expandTreeDir(state: FileTreeState, dir: string): FileTreeState {
  const key = normalizeRel(dir);
  if (state.expanded.has(key)) return state;
  const expanded = new Set(state.expanded);
  expanded.add(key);
  return { nodes: state.nodes, expanded };
}

export function collapseTreeDir(state: FileTreeState, dir: string): FileTreeState {
  const key = normalizeRel(dir);
  // The root cannot collapse: a tree whose only level folded away would render
  // as an empty pane that looks like a failure.
  if (key === '' || !state.expanded.has(key)) return state;
  const expanded = new Set(state.expanded);
  expanded.delete(key);
  return { nodes: state.nodes, expanded };
}

export function toggleTreeDir(state: FileTreeState, dir: string): FileTreeState {
  return isTreeDirExpanded(state, dir) ? collapseTreeDir(state, dir) : expandTreeDir(state, dir);
}

/** Expand every ancestor of `dir` and `dir` itself, so the directory the
 *  reader navigated to (crumbs, flat list, restored session) is visible in the
 *  tree without collapsing anything they opened themselves. */
export function revealTreeDir(state: FileTreeState, dir: string): FileTreeState {
  const key = normalizeRel(dir);
  if (!key) return state;
  let changed = false;
  const expanded = new Set(state.expanded);
  let acc = '';
  for (const seg of key.split('/')) {
    acc = acc ? `${acc}/${seg}` : seg;
    if (!expanded.has(acc)) {
      expanded.add(acc);
      changed = true;
    }
  }
  return changed ? { nodes: state.nodes, expanded } : state;
}

export function markTreeDirLoading(state: FileTreeState, dir: string): FileTreeState {
  const current = treeDirNode(state, dir);
  if (current.status === 'loading') return state;
  return withNode(state, dir, { ...current, status: 'loading', error: null });
}

export function setTreeDirListing(state: FileTreeState, dir: string, listing: FsListing): FileTreeState {
  return withNode(state, dir, {
    status: 'ready',
    entries: listing.entries ?? [],
    truncated: listing.truncated ?? false,
    error: null,
  });
}

export function setTreeDirError(state: FileTreeState, dir: string, error: string): FileTreeState {
  const current = treeDirNode(state, dir);
  return withNode(state, dir, { ...current, status: 'error', error });
}

/** Back to `unloaded`, so the loader asks the daemon again (error retry). */
export function resetTreeDir(state: FileTreeState, dir: string): FileTreeState {
  return withNode(state, dir, UNLOADED);
}

/** Refresh: forget every answer, keep the reader's expansion. Each visible
 *  directory re-renders as loading until the daemon answers again — stale
 *  children are dropped rather than shown as if they were fresh. */
export function invalidateTree(state: FileTreeState): FileTreeState {
  if (!state.nodes.size) return state;
  return { nodes: new Map(), expanded: state.expanded };
}

/** The expanded, VISIBLE directories the loader still owes the daemon a
 *  listing for. Walked from the root so a directory expanded under a collapsed
 *  (or refused) ancestor is not fetched — its rows cannot be seen, and a
 *  refused directory's children would be refused anyway. */
export function pendingTreeDirs(state: FileTreeState): string[] {
  const pending: string[] = [];
  const walk = (dir: string): void => {
    if (!state.expanded.has(dir)) return;
    const node = treeDirNode(state, dir);
    if (node.status === 'unloaded') {
      pending.push(dir);
      return;
    }
    if (node.status !== 'ready') return;
    for (const entry of node.entries) {
      if (entry.type !== 'dir' || entryRefusal(entry)) continue;
      walk(joinRel(dir, entry.name));
    }
  };
  walk('');
  return pending;
}

/* ---- flattened rows ------------------------------------------------------ */

export interface TreeEntryRow {
  kind: 'dir' | 'file';
  /** Daemon-grammar path for an openable entry; for a refused entry this is a
   *  display key only and is never requested. */
  path: string;
  name: string;
  depth: number;
  refusal: string | null;
  /** Dirs only; a refused dir is never expanded. */
  expanded: boolean;
  /** Dirs only: this row is the browse pane's current directory. */
  selected: boolean;
  size?: number;
}

export interface TreeNoteRow {
  kind: 'note';
  note: 'loading' | 'error' | 'empty' | 'truncated';
  /** The directory the note belongs to. */
  dir: string;
  depth: number;
  error?: string;
}

export type TreeRow = TreeEntryRow | TreeNoteRow;

/** Flatten the visible tree, root first. Every expanded directory contributes
 *  either its (sorted) children or one honest note — loading, error, empty or
 *  truncated — so an unanswered directory can never silently render as empty. */
export function treeRows(state: FileTreeState, selectedDir = ''): TreeRow[] {
  const selected = normalizeRel(selectedDir);
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const node = treeDirNode(state, dir);
    if (node.status === 'unloaded' || node.status === 'loading') {
      rows.push({ kind: 'note', note: 'loading', dir, depth });
      return;
    }
    if (node.status === 'error') {
      rows.push({ kind: 'note', note: 'error', dir, depth, error: node.error ?? 'unknown error' });
      return;
    }
    const entries = sortFsEntries(node.entries);
    if (!entries.length) rows.push({ kind: 'note', note: 'empty', dir, depth });
    for (const entry of entries) {
      const refusal = entryRefusal(entry);
      // joinRel would rewrite a name the daemon's grammar refuses (`a\b` →
      // `a/b`), so a refused entry keeps its raw bytes as a display-only key.
      const path = refusal ? (dir ? `${dir}/${entry.name}` : entry.name) : joinRel(dir, entry.name);
      const isDir = entry.type === 'dir';
      const expanded = isDir && !refusal && state.expanded.has(path);
      rows.push({
        kind: isDir ? 'dir' : 'file',
        path,
        name: entry.name,
        depth,
        refusal,
        expanded,
        selected: isDir && !refusal && path === selected,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      });
      if (expanded) walk(path, depth + 1);
    }
    if (node.truncated) rows.push({ kind: 'note', note: 'truncated', dir, depth });
  };
  walk('', 0);
  return rows;
}
