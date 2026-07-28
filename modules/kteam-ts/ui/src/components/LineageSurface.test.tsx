import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionStatus, SessionView } from '../types';
import { RETAINED_SURFACES, SIDE_PANE_SURFACES } from './SidePane';
import { buildLineageSurfaceModel, LineageSurfaceContent } from './LineageSurface';

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
});

describe('lineage surface presentation', () => {
  test('shows this session, its reachable parent and every nested child as touch-sized links', () => {
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
    expect(html).toContain('min-h-[52px]');
    expect(html).not.toContain('autofocus');
  });

  test('distinguishes a purged parent from a genuinely top-level session', () => {
    const orphan = session('orphan', { parent: 'deleted-parent-record' });
    const orphanHtml = renderToStaticMarkup(<LineageSurfaceContent sessionId="orphan" sessions={[orphan]} />);
    const root = session('root');
    const rootHtml = renderToStaticMarkup(<LineageSurfaceContent sessionId="root" sessions={[root]} />);

    expect(orphanHtml).toContain('data-lineage-role="missing-parent"');
    expect(orphanHtml).toContain('Parent gone');
    expect(orphanHtml).toContain('deleted-…');
    expect(orphanHtml).not.toContain('Top-level session');
    expect(rootHtml).toContain('data-lineage-role="top-level"');
    expect(rootHtml).toContain('Top-level session');
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
    expect(html).toContain('Lineage depth 4');
    // Only the first two generations add a 10px rail (rendered as 9px
    // margin + 1px padding); deeper rows share that final 20px footprint.
    expect(html.match(/margin-left:9px/g)).toHaveLength(2);
  });

  test('is registered as a mount-per-open side-pane surface', () => {
    expect(SIDE_PANE_SURFACES.lineage).toMatchObject({ label: 'Lineage', closeLabel: 'Close lineage' });
    expect(RETAINED_SURFACES.has('lineage')).toBe(false);
  });
});
