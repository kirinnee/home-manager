import { describe, expect, test } from 'bun:test';
import type { FsEntry } from './files-api';
import {
  collapseTreeDir,
  createFileTreeState,
  expandTreeDir,
  invalidateTree,
  isTreeDirExpanded,
  markTreeDirLoading,
  pendingTreeDirs,
  resetTreeDir,
  revealTreeDir,
  setTreeDirError,
  setTreeDirListing,
  toggleTreeDir,
  treeDirNode,
  treeRows,
  type FileTreeState,
} from './file-tree-model';

const file = (name: string, over: Partial<FsEntry> = {}): FsEntry => ({ name, type: 'file', ...over });
const dir = (name: string, over: Partial<FsEntry> = {}): FsEntry => ({ name, type: 'dir', ...over });

/** Built at runtime: a literal backslash in a source file does not survive
 *  editors and formatters reliably, and that byte IS the test. */
const BACKSLASH = String.fromCharCode(92);

function loaded(state: FileTreeState, at: string, entries: FsEntry[], truncated = false): FileTreeState {
  return setTreeDirListing(state, at, { entries, truncated });
}

describe('expansion', () => {
  test('the root starts expanded and refuses to collapse', () => {
    const state = createFileTreeState();
    expect(isTreeDirExpanded(state, '')).toBe(true);
    expect(collapseTreeDir(state, '')).toBe(state);
    expect(isTreeDirExpanded(collapseTreeDir(state, ''), '')).toBe(true);
  });

  test('expand, collapse and toggle flip one directory and normalise its path', () => {
    let state = createFileTreeState();
    state = expandTreeDir(state, 'src/');
    expect(isTreeDirExpanded(state, 'src')).toBe(true);
    state = toggleTreeDir(state, 'src');
    expect(isTreeDirExpanded(state, 'src')).toBe(false);
    state = toggleTreeDir(state, './src');
    expect(isTreeDirExpanded(state, 'src')).toBe(true);
    state = collapseTreeDir(state, 'src');
    expect(isTreeDirExpanded(state, 'src')).toBe(false);
  });

  test('a no-op transition returns the same state object', () => {
    const state = createFileTreeState();
    expect(expandTreeDir(state, '')).toBe(state);
    expect(collapseTreeDir(state, 'never-expanded')).toBe(state);
    expect(revealTreeDir(state, '')).toBe(state);
    const expanded = expandTreeDir(state, 'a/b');
    expect(expandTreeDir(expanded, 'a/b')).toBe(expanded);
  });

  test('reveal expands the full ancestor chain of the current directory', () => {
    let state = createFileTreeState();
    state = expandTreeDir(state, 'other');
    state = revealTreeDir(state, 'a/b/c');
    for (const at of ['a', 'a/b', 'a/b/c', 'other', '']) expect(isTreeDirExpanded(state, at)).toBe(true);
    expect(revealTreeDir(state, 'a/b/c')).toBe(state);
  });
});

describe('per-directory listing state', () => {
  test('an unasked directory is unloaded, never guessed', () => {
    const state = createFileTreeState();
    expect(treeDirNode(state, 'src')).toMatchObject({ status: 'unloaded', entries: [], error: null });
  });

  test('loading → ready carries exactly what the daemon listed', () => {
    let state = createFileTreeState();
    state = markTreeDirLoading(state, '');
    expect(treeDirNode(state, '').status).toBe('loading');
    state = loaded(state, '', [dir('src'), file('a.ts', { size: 12 })], true);
    expect(treeDirNode(state, '')).toMatchObject({
      status: 'ready',
      truncated: true,
      entries: [{ name: 'src' }, { name: 'a.ts' }],
    });
  });

  test('error keeps the reason; reset forgets so the loader can ask again', () => {
    let state = createFileTreeState();
    state = setTreeDirError(state, 'src', 'could not reach the daemon');
    expect(treeDirNode(state, 'src')).toMatchObject({ status: 'error', error: 'could not reach the daemon' });
    state = resetTreeDir(state, 'src');
    expect(treeDirNode(state, 'src').status).toBe('unloaded');
  });

  test('invalidate forgets every answer but keeps the reader’s expansion', () => {
    let state = createFileTreeState();
    state = expandTreeDir(state, 'src');
    state = loaded(state, '', [dir('src')]);
    state = loaded(state, 'src', [file('a.ts')]);
    const fresh = invalidateTree(state);
    expect(treeDirNode(fresh, '').status).toBe('unloaded');
    expect(treeDirNode(fresh, 'src').status).toBe('unloaded');
    expect(isTreeDirExpanded(fresh, 'src')).toBe(true);
    // Nothing to forget → same state object.
    expect(invalidateTree(createFileTreeState())).toEqual(createFileTreeState());
  });
});

describe('pendingTreeDirs', () => {
  test('a fresh tree owes exactly the root', () => {
    expect(pendingTreeDirs(createFileTreeState())).toEqual(['']);
  });

  test('a directory already loading is not asked again', () => {
    const state = markTreeDirLoading(createFileTreeState(), '');
    expect(pendingTreeDirs(state)).toEqual([]);
  });

  test('only VISIBLE expanded directories are owed a listing', () => {
    let state = createFileTreeState();
    state = loaded(state, '', [dir('src'), dir('lib')]);
    state = expandTreeDir(state, 'src');
    // Expanded under a COLLAPSED parent: invisible, so not fetched.
    state = expandTreeDir(state, 'lib/deep');
    expect(pendingTreeDirs(state)).toEqual(['src']);
  });

  test('a refused directory is never fetched even when marked expanded', () => {
    let state = createFileTreeState();
    state = loaded(state, '', [dir('node_modules', { denied: true }), dir('dist', { ignored: true }), dir('src')]);
    state = expandTreeDir(state, 'node_modules');
    state = expandTreeDir(state, 'dist');
    state = expandTreeDir(state, 'src');
    expect(pendingTreeDirs(state)).toEqual(['src']);
  });
});

describe('treeRows', () => {
  test('an unanswered root renders one loading note, never an empty tree', () => {
    expect(treeRows(createFileTreeState())).toEqual([{ kind: 'note', note: 'loading', dir: '', depth: 0 }]);
    expect(treeRows(markTreeDirLoading(createFileTreeState(), ''))).toEqual([
      { kind: 'note', note: 'loading', dir: '', depth: 0 },
    ]);
  });

  test('a failed listing renders the reason where the children would be', () => {
    const state = setTreeDirError(createFileTreeState(), '', 'boom');
    expect(treeRows(state)).toEqual([{ kind: 'note', note: 'error', dir: '', depth: 0, error: 'boom' }]);
  });

  test('directories sort first and an expanded child walks at the next depth', () => {
    let state = createFileTreeState();
    state = loaded(state, '', [file('zz.ts', { size: 5 }), dir('src')]);
    state = expandTreeDir(state, 'src');
    state = loaded(state, 'src', [file('app.ts')]);
    expect(treeRows(state)).toEqual([
      { kind: 'dir', path: 'src', name: 'src', depth: 0, refusal: null, expanded: true, selected: false },
      { kind: 'file', path: 'src/app.ts', name: 'app.ts', depth: 1, refusal: null, expanded: false, selected: false },
      {
        kind: 'file',
        path: 'zz.ts',
        name: 'zz.ts',
        depth: 0,
        refusal: null,
        expanded: false,
        selected: false,
        size: 5,
      },
    ]);
  });

  test('select marks exactly the current directory row', () => {
    let state = createFileTreeState();
    state = loaded(state, '', [dir('src'), dir('lib')]);
    state = expandTreeDir(state, 'src');
    state = loaded(state, 'src', [dir('parts')]);
    const rows = treeRows(state, 'src/parts/');
    const selected = rows.filter(row => row.kind !== 'note' && row.selected);
    expect(selected).toEqual([
      { kind: 'dir', path: 'src/parts', name: 'parts', depth: 1, refusal: null, expanded: false, selected: true },
    ]);
  });

  test('a collapsed directory contributes no child rows', () => {
    let state = createFileTreeState();
    state = loaded(state, '', [dir('src')]);
    state = loaded(state, 'src', [file('app.ts')]);
    expect(treeRows(state)).toHaveLength(1);
    expect(treeRows(expandTreeDir(state, 'src'))).toHaveLength(2);
  });

  test('a refused directory is listed with its reason and never descended', () => {
    let state = createFileTreeState();
    state = loaded(state, '', [
      dir('node_modules', { denied: true }),
      dir('outside', { escapes: true, type: 'symlink' }),
    ]);
    state = expandTreeDir(state, 'node_modules');
    const rows = treeRows(state);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: 'dir',
      name: 'node_modules',
      expanded: false,
      refusal: expect.stringContaining('denylisted'),
    });
    expect(rows[1]).toMatchObject({ refusal: expect.stringContaining('leaves') });
  });

  test('a name outside the daemon grammar keeps its raw bytes as a display key', () => {
    const hostile = `a${BACKSLASH}b`;
    let state = createFileTreeState();
    state = loaded(state, '', [dir('src')]);
    state = expandTreeDir(state, 'src');
    state = loaded(state, 'src', [file(hostile)]);
    const rows = treeRows(state);
    const row = rows.find(candidate => candidate.kind === 'file');
    // Never joined into `src/a/b` — that would be a DIFFERENT file.
    expect(row).toMatchObject({ path: `src/${hostile}`, refusal: expect.stringContaining('cannot be opened') });
  });

  test('empty and truncated expanded directories say so in place', () => {
    let state = createFileTreeState();
    state = loaded(state, '', [dir('empty'), dir('capped')], true);
    state = expandTreeDir(state, 'empty');
    state = expandTreeDir(state, 'capped');
    state = loaded(state, 'empty', []);
    state = loaded(state, 'capped', [file('head.ts')], true);
    expect(treeRows(state)).toEqual([
      { kind: 'dir', path: 'capped', name: 'capped', depth: 0, refusal: null, expanded: true, selected: false },
      {
        kind: 'file',
        path: 'capped/head.ts',
        name: 'head.ts',
        depth: 1,
        refusal: null,
        expanded: false,
        selected: false,
      },
      { kind: 'note', note: 'truncated', dir: 'capped', depth: 1 },
      { kind: 'dir', path: 'empty', name: 'empty', depth: 0, refusal: null, expanded: true, selected: false },
      { kind: 'note', note: 'empty', dir: 'empty', depth: 1 },
      { kind: 'note', note: 'truncated', dir: '', depth: 0 },
    ]);
  });
});
