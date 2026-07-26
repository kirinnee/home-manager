import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionView } from '../types';
import { SidebarRow } from '../components/AgentSidebar';
import { LineageName } from '../components/TaskName';
import { buildLineage, lineageIndent, lineageLabel, nestByLineage, parentDisplay, shortSessionId } from './lineage';

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

    expect(parentDisplay(named.config.id, byId)).toMatchObject({
      kind: 'resolved',
      name: 'Meghan · task parent-123456',
    });
    expect(parentDisplay(unnamed.config.id, byId)).toMatchObject({ kind: 'resolved', name: 'old session' });
    expect(parentDisplay('deadbeef0011', byId)).toEqual({ kind: 'missing', shortId: 'deadbeef…' });
    expect(parentDisplay(undefined, byId)).toBeNull();
    expect(shortSessionId('short')).toBe('short');
  });
});

describe('lineageLabel', () => {
  test('joins a title-cased callsign with a plain task while retaining the raw id', () => {
    const view = session('ms0zbxh8-5cce961d', {
      teammate: 'hayden',
      name: '[Hayden] Fix the transcript scroller',
    });
    const label = lineageLabel(view);

    expect(label).toEqual({
      callsign: 'Hayden',
      task: 'Fix the transcript scroller',
      text: 'Hayden · Fix the transcript scroller',
      full: 'Hayden · Fix the transcript scroller · ms0zbxh8-5cce961d',
    });
    expect(label.text).not.toContain('[');
    expect(label.text).not.toContain(']');
  });

  test('suppresses redundant tasks and falls back sensibly when identity data is missing', () => {
    const redundant = lineageLabel(session('redundant-id', { teammate: 'meghan', name: '[Legacy] Meghan' }));
    const taskOnly = lineageLabel(session('task-only-id', { name: '[Legacy] Repair old records' }));
    const idOnly = lineageLabel(session('deadbeef0011', { name: '' }));

    expect(redundant).toMatchObject({ callsign: 'Meghan', task: '', text: 'Meghan', full: 'Meghan · redundant-id' });
    expect(taskOnly).toMatchObject({ callsign: '', task: 'Repair old records', text: 'Repair old records' });
    expect(idOnly).toEqual({ callsign: '', task: '', text: 'deadbeef…', full: 'deadbeef… · deadbeef0011' });
  });

  test('keeps complete long task-bearing labels in the rendered deep-sidebar tooltip and screen-reader context', () => {
    const root = session('root-123456789', {
      teammate: 'mary-jane',
      name: '[Legacy] Repair the unusually long transcript-search cursor regression without dropping context',
    });
    const middle = session('middle-1234567', {
      parent: root.config.id,
      teammate: 'meghan',
      name: '[Meghan] Trace the long-lived sidebar lineage relationship',
    });
    const leaf = session('leaf-123456789', {
      parent: middle.config.id,
      teammate: 'wyatt',
      name: '[Wyatt] Verify a deep lineage tooltip preserves every full parent task',
    });
    const deep = session('deep-123456789', {
      parent: leaf.config.id,
      teammate: 'olivia',
      name: '[Olivia] Surface the complete four-level ancestry in the deep marker',
    });
    const lineage = buildLineage([root, middle, leaf, deep]);
    const trail = [root, middle, leaf].map(lineageLabel);
    const nested = nestByLineage([root, middle, leaf, deep], lineage);
    const deepRow = nested[0]!.children[0]!.children[0]!.children[0]!;
    const deepTrail = trail.map(label => label.full).join(' → ');
    const markup = renderToStaticMarkup(
      createElement(SidebarRow, {
        row: deepRow,
        active: false,
        byId: new Map([root, middle, leaf, deep].map(view => [view.config.id, view])),
      }),
    );

    // SidebarRow activates its deep parent trail only beyond MAX_INDENT_DEPTH (2).
    expect(lineage.depthOf.get(deep.config.id)).toBe(3);
    expect(deepRow.depth).toBe(3);
    expect(trail.map(label => label.text).join(' → ')).toContain(
      'Mary-Jane · Repair the unusually long transcript-search cursor regression',
    );
    expect(trail.map(label => label.text).join(' → ')).toContain(
      'Wyatt · Verify a deep lineage tooltip preserves every full parent task',
    );
    expect(trail.map(label => label.full).join(' → ')).toContain(root.config.id);
    expect(trail.map(label => label.full).join(' → ')).toContain(middle.config.id);
    expect(markup).toContain(`title="${lineageLabel(deep).full}\nactive — running\nspawned by ${deepTrail}"`);
    expect(markup).toContain(
      `<span class="sr-only"> — spawned by ${lineageLabel(leaf).full}; full lineage: ${deepTrail}</span>`,
    );
  });

  test('renders a shrink-safe callsign/task label with complete tooltip and screen-reader text', () => {
    const label = lineageLabel(
      session('lineage-render-id', {
        teammate: 'mary-jane',
        name: '[Legacy] A deliberately long task title that must yield before the callsign does',
      }),
    );
    const markup = renderToStaticMarkup(createElement(LineageName, { label }));

    expect(markup).toContain(`title="${label.full}"`);
    expect(markup).toContain('class="shrink-0">Mary-Jane</span>');
    expect(markup).toContain('class="shrink-0 text-faint"> · </span>');
    expect(markup).toContain(
      'class="min-w-0 truncate">A deliberately long task title that must yield before the callsign does</span>',
    );
    expect(markup).toContain(`<span class="sr-only">${label.full}</span>`);
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
