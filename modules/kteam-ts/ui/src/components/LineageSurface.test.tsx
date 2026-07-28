import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionStatus, SessionView } from '../types';
import { buildLineage, nestByLineage } from '../lib/lineage';
import { RETAINED_SURFACES, SIDE_PANE_SURFACES } from './SidePane';
import {
  buildLineageSurfaceModel,
  filterLineageRows,
  lineageFilterSummary,
  LineageSurfaceContent,
  toggleLineageStatusFilter,
} from './LineageSurface';

function session(
  id: string,
  {
    parent,
    teammate,
    name = `Task ${id}`,
    status = 'running',
    activity = '2026-07-28T00:00:00.000Z',
  }: {
    parent?: string;
    teammate?: string;
    name?: string;
    status?: SessionStatus;
    activity?: string;
  } = {},
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
    state: { id, status, turn: 1, lastActivityAt: activity },
    directory: '/repo',
  };
}

describe('lineage surface model', () => {
  test('selects the whole descendant subtree in shared activity order', () => {
    const parent = session('parent', { teammate: 'zelda', name: '[Zelda] Lead the release' });
    const current = session('current', { parent: 'parent', teammate: 'arthur', name: '[Arthur] Build lineage' });
    const older = session('older', {
      parent: 'current',
      teammate: 'bea',
      activity: '2026-07-28T01:00:00.000Z',
    });
    const newer = session('newer', {
      parent: 'current',
      teammate: 'matt',
      activity: '2026-07-28T03:00:00.000Z',
    });
    const grandchild = session('grandchild', {
      parent: 'older',
      teammate: 'rhonda',
      activity: '2026-07-28T02:00:00.000Z',
    });
    const model = buildLineageSurfaceModel('current', [grandchild, older, parent, current, newer]);

    expect(model.current).toBe(current);
    expect(model.parent).toMatchObject({ kind: 'resolved', view: parent });
    expect(model.descendants.map(row => row.view.config.id)).toEqual(['newer', 'older']);
    expect(model.descendants[1]?.children[0]?.view).toBe(grandchild);
    expect(model.descendantCount).toBe(3);
  });

  test('does not reintroduce self or cyclic parent edges rejected by the shared index', () => {
    const self = session('self', { parent: 'self' });
    expect(buildLineageSurfaceModel('self', [self]).parent).toEqual({ kind: 'invalid', shortId: 'self' });

    const a = session('cycle-a', { parent: 'cycle-b' });
    const b = session('cycle-b', { parent: 'cycle-a' });
    expect(buildLineageSurfaceModel('cycle-a', [a, b]).parent).toEqual({
      kind: 'invalid',
      shortId: 'cycle-b',
    });
  });
});

describe('lineage status filtering', () => {
  test('retains non-matching ancestors as explicit context and prunes unrelated branches', () => {
    const root = session('root', { status: 'running' });
    const path = session('path', { parent: 'root', status: 'waiting' });
    const match = session('match', { parent: 'path', status: 'completed' });
    const unrelated = session('unrelated', { parent: 'root', status: 'failed' });
    const sessions = [root, path, match, unrelated];
    const rows = nestByLineage(sessions, buildLineage(sessions));

    const filtered = filterLineageRows(rows, new Set<SessionStatus>(['completed']));

    expect(filtered.matchCount).toBe(1);
    expect(filtered.contextCount).toBe(2);
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]?.view).toBe(root);
    expect(filtered.rows[0]?.matchesFilter).toBe(false);
    expect(filtered.rows[0]?.children[0]?.view).toBe(path);
    expect(filtered.rows[0]?.children[0]?.matchesFilter).toBe(false);
    expect(filtered.rows[0]?.children[0]?.children[0]?.view).toBe(match);
    expect(filtered.rows[0]?.children[0]?.children[0]?.matchesFilter).toBe(true);
    expect(JSON.stringify(filtered)).not.toContain('unrelated');
  });

  test('supports exact-status multi-select and returns to All after the last removal', () => {
    let selected = toggleLineageStatusFilter(null, 'running');
    expect([...selected!]).toEqual(['running']);

    selected = toggleLineageStatusFilter(selected, 'completed');
    expect([...selected!]).toEqual(['running', 'completed']);

    selected = toggleLineageStatusFilter(selected, 'running');
    expect([...selected!]).toEqual(['completed']);
    expect(toggleLineageStatusFilter(selected, 'completed')).toBeNull();
  });

  test('pluralizes matching and context-path counts', () => {
    expect(lineageFilterSummary(1, 1)).toBe('1 match · 1 path');
    expect(lineageFilterSummary(3, 2)).toBe('3 matches · 2 paths');
  });
});

describe('lineage surface presentation', () => {
  test('shows one connected compact tree with touch-sized rows and a status filter', () => {
    const parent = session('parent/id', { teammate: 'zelda', name: '[Zelda] Lead the release' });
    const current = session('current', { parent: 'parent/id', teammate: 'arthur', name: '[Arthur] Build lineage' });
    const child = session('child', { parent: 'current', teammate: 'matt', name: '[Matt] Build pane tabs' });
    const grandchild = session('grandchild', {
      parent: 'child',
      teammate: 'rhonda',
      name: '[Rhonda] Build skills',
    });
    const html = renderToStaticMarkup(
      <LineageSurfaceContent sessionId="current" sessions={[parent, current, child, grandchild]} />,
    );

    expect(html).toContain('data-lineage-role="current"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Arthur');
    expect(html).toContain('Build lineage');
    expect(html).toContain('href="/session/parent%2Fid"');
    expect(html).toContain('href="/session/child"');
    expect(html).toContain('href="/session/grandchild"');
    expect(html).toContain('2 descendants');
    expect(html).toContain('aria-label="Session lineage tree"');
    expect(html).toContain('aria-label="Filter lineage by status"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('min-h-[44px]');
    expect(html.match(/min-w-\[44px\]/g)).toHaveLength(2);
    expect(html).not.toContain('min-h-[52px]');
    expect(html.match(/style="width:10px"/g)).toHaveLength(2);
    expect(html.indexOf('href="/session/parent%2Fid"')).toBeLessThan(html.indexOf('href="/session/current"'));
    expect(html).not.toContain('autofocus');
  });

  test('distinguishes a purged parent from a genuinely top-level session', () => {
    const orphan = session('orphan', { parent: 'deleted-parent-record' });
    const orphanHtml = renderToStaticMarkup(<LineageSurfaceContent sessionId="orphan" sessions={[orphan]} />);
    const root = session('root');
    const rootHtml = renderToStaticMarkup(<LineageSurfaceContent sessionId="root" sessions={[root]} />);

    expect(orphanHtml).toContain('data-lineage-role="missing-parent"');
    expect(orphanHtml).toContain('Missing parent');
    expect(orphanHtml).toContain('deleted-…');
    expect(orphanHtml).not.toContain('data-lineage-origin="top-level"');
    expect(rootHtml).toContain('data-lineage-origin="top-level"');
    expect(rootHtml).toContain('top-level session; no parent was recorded');
    expect(rootHtml).not.toContain('Missing parent');
  });

  test('renders a malformed self-parent once with an honest invalid-edge marker', () => {
    const self = session('self', { parent: 'self' });
    const html = renderToStaticMarkup(<LineageSurfaceContent sessionId="self" sessions={[self]} />);

    expect(html).toContain('data-lineage-role="invalid-parent"');
    expect(html).toContain('Invalid parent link');
    expect(html.match(/href="\/session\/self"/g)).toHaveLength(1);
    expect(html).not.toContain('data-lineage-role="parent"');
    expect(html).not.toContain('data-lineage-origin="top-level"');
  });

  test('makes live and dead child states visibly different without colour alone', () => {
    const current = session('current');
    const live = session('live', { parent: 'current', status: 'tool_running' });
    const dead = session('dead', { parent: 'current', status: 'stopped' });
    const html = renderToStaticMarkup(<LineageSurfaceContent sessionId="current" sessions={[current, live, dead]} />);

    expect(html).toContain('data-session-status="tool_running"');
    expect(html).toContain('active — tool_running');
    expect(html).toContain('kt-pulse');
    expect(html).toContain('data-session-status="stopped"');
    expect(html).toContain('finished — stopped');
    expect(html).toContain('>stopped</span>');
    expect(html).toContain('aria-label="tool running, 1 session"');
    expect(html).toContain('aria-label="stopped, 1 session"');
  });

  test('keeps a deep tree complete while capping its phone-width indentation', () => {
    const root = session('root');
    const child = session('child', { parent: 'root' });
    const grandchild = session('grandchild', { parent: 'child' });
    const greatGrandchild = session('great-grandchild', { parent: 'grandchild' });
    const deep = session('deep', { parent: 'great-grandchild' });
    const html = renderToStaticMarkup(
      <LineageSurfaceContent sessionId="root" sessions={[root, child, grandchild, greatGrandchild, deep]} />,
    );

    expect(html).toContain('4 descendants');
    expect(html).toContain('href="/session/deep"');
    expect(html).toContain('data-lineage-depth="3"');
    expect(html).toContain('data-lineage-tree-depth="4"');
    expect(html).toContain('Tree level 4');
    expect(html).toContain('Tree level 5');
    // Only the first two generations add a 10px step. Deeper rows keep the
    // connector but share the final 20px footprint and print their true level.
    expect(html.match(/margin-left:10px/g)).toHaveLength(2);
  });

  test('is registered as a mount-per-open side-pane surface', () => {
    expect(SIDE_PANE_SURFACES.lineage).toMatchObject({ label: 'Lineage', closeLabel: 'Close lineage' });
    expect(RETAINED_SURFACES.has('lineage')).toBe(false);
  });
});
