import { describe, expect, test } from 'bun:test';
import type { SessionView } from '../types';
import { buildLineage, lineageIndent, nestByLineage, parentDisplay, shortSessionId } from './lineage';

function session(
  id: string,
  {
    parent,
    teammate,
    name = `task ${id}`,
    activity = '2026-07-25T00:00:00.000Z',
  }: { parent?: string; teammate?: string; name?: string; activity?: string } = {},
): SessionView {
  return {
    config: {
      id,
      name,
      teammate,
      parent,
      binary: 'codex',
      harness: 'codex',
      modelHint: 'gpt-5.6',
      mode: 'auto',
      cwd: '/repo',
      createdAt: activity,
      updatedAt: activity,
      turn: 1,
      harnessSessionId: id,
      tmuxSession: id,
      watcherSession: id,
      intervalSeconds: 60,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 3,
      systemPromptFile: '',
      originalPromptFile: '',
    },
    state: { id, status: 'running', turn: 1, lastActivityAt: activity },
    directory: '/repo',
  };
}

describe('buildLineage', () => {
  test('indexes direct children in daemon order and computes depths', () => {
    const root = session('root');
    const second = session('second', { parent: 'root' });
    const first = session('first', { parent: 'root' });
    const grandchild = session('grandchild', { parent: 'first' });
    const lineage = buildLineage([root, second, first, grandchild]);

    expect(lineage.childrenOf.get('root')?.map(view => view.config.id)).toEqual(['second', 'first']);
    expect(lineage.parentOf.get('grandchild')).toBe('first');
    expect(lineage.depthOf.get('root')).toBe(0);
    expect(lineage.depthOf.get('grandchild')).toBe(2);
  });

  test('drops missing, self and cyclic parent edges without losing their rows', () => {
    const missing = session('missing-child', { parent: 'purged-parent' });
    const self = session('self', { parent: 'self' });
    const a = session('a', { parent: 'b' });
    const b = session('b', { parent: 'a' });
    const lineage = buildLineage([missing, self, a, b]);

    expect([...lineage.parentOf]).toEqual([]);
    expect([...lineage.depthOf.values()]).toEqual([0, 0, 0, 0]);
    expect(nestByLineage([missing, self, a, b], lineage).map(row => row.view.config.id)).toEqual([
      'missing-child',
      'self',
      'a',
      'b',
    ]);
  });

  test('keeps a tail that points at a dropped three-node cycle', () => {
    const d = session('d', { parent: 'a' });
    const a = session('a', { parent: 'b' });
    const b = session('b', { parent: 'c' });
    const c = session('c', { parent: 'a' });
    const lineage = buildLineage([d, a, b, c]);

    expect([...lineage.parentOf]).toEqual([['d', 'a']]);
    expect(lineage.childrenOf.get('a')?.map(view => view.config.id)).toEqual(['d']);
    expect(lineage.depthOf.get('a')).toBe(0);
    expect(lineage.depthOf.get('d')).toBe(1);
  });

  test('fills depths when children arrive before their parents', () => {
    const grandchild = session('grandchild', { parent: 'child' });
    const child = session('child', { parent: 'root' });
    const root = session('root');
    const lineage = buildLineage([grandchild, child, root]);

    expect(lineage.depthOf.get('root')).toBe(0);
    expect(lineage.depthOf.get('child')).toBe(1);
    expect(lineage.depthOf.get('grandchild')).toBe(2);
  });
});

describe('parentDisplay', () => {
  test('uses id resolution, including name and purged-parent fallbacks', () => {
    const named = session('parent-123456', { teammate: 'meghan' });
    const unnamed = session('parent-name', { name: 'old session' });
    const byId = new Map([
      [named.config.id, named],
      [unnamed.config.id, unnamed],
    ]);

    expect(parentDisplay(named.config.id, byId)).toMatchObject({ kind: 'resolved', name: 'meghan' });
    expect(parentDisplay(unnamed.config.id, byId)).toMatchObject({ kind: 'resolved', name: 'old session' });
    expect(parentDisplay('deadbeef0011', byId)).toEqual({ kind: 'missing', shortId: 'deadbeef…' });
    expect(parentDisplay(undefined, byId)).toBeNull();
    expect(shortSessionId('short')).toBe('short');
  });
});

describe('nestByLineage', () => {
  test('nests only below visible same-group parents and marks flattened children', () => {
    const root = session('root');
    const child = session('child', { parent: 'root' });
    const crossGroup = session('cross-group', { parent: 'root' });
    const hiddenParentChild = session('hidden-child', { parent: 'hidden' });
    const lineage = buildLineage([root, child, crossGroup, hiddenParentChild]);
    const nested = nestByLineage([root, child, hiddenParentChild], lineage);
    const flattened = nestByLineage([crossGroup], lineage);

    expect(nested.map(row => row.view.config.id)).toEqual(['root', 'hidden-child']);
    expect(nested[0]?.children.map(row => row.view.config.id)).toEqual(['child']);
    expect(nested[1]?.spawnedBy).toBe('hidden');
    expect(flattened[0]).toMatchObject({ depth: 0, spawnedBy: 'root' });
  });

  test('clamps sidebar indentation through the geometry helper it renders with', () => {
    // This Bun-only harness does not mount the sidebar DOM. Browser gates remain
    // responsible for the native-list and continuous-rail visual assertion.
    const a = session('a');
    const b = session('b', { parent: 'a' });
    const c = session('c', { parent: 'b' });
    const d = session('d', { parent: 'c' });
    const nested = nestByLineage([a, b, c, d], buildLineage([a, b, c, d]));
    const deep = nested[0]!.children[0]!.children[0]!.children[0]!;

    expect(deep.depth).toBe(3);
    expect(lineageIndent(0)).toBe(0);
    expect(lineageIndent(1)).toBe(10);
    expect(lineageIndent(2)).toBe(20);
    expect(lineageIndent(deep.depth)).toBe(20);
    expect(lineageIndent(99)).toBe(20);
  });

  test('sorts roots by newest descendant and each sibling set by its own activity', () => {
    const idleRoot = session('idle-root', { activity: '2026-07-25T01:00:00.000Z' });
    const activeRoot = session('active-root', { activity: '2026-07-25T00:00:00.000Z' });
    const olderChild = session('older-child', { parent: 'active-root', activity: '2026-07-25T02:00:00.000Z' });
    const newerChild = session('newer-child', { parent: 'active-root', activity: '2026-07-25T03:00:00.000Z' });
    const lineage = buildLineage([idleRoot, activeRoot, olderChild, newerChild]);
    const nested = nestByLineage([idleRoot, activeRoot, olderChild, newerChild], lineage);

    expect(nested.map(row => row.view.config.id)).toEqual(['active-root', 'idle-root']);
    expect(nested[0]?.children.map(row => row.view.config.id)).toEqual(['newer-child', 'older-child']);
  });

  test('keeps large direct-child collections intact for consumers that cap their own display', () => {
    const root = session('root');
    const children = Array.from({ length: 55 }, (_, index) => session(`child-${index}`, { parent: 'root' }));
    const lineage = buildLineage([root, ...children]);

    expect(lineage.childrenOf.get('root')).toHaveLength(55);
  });
});
