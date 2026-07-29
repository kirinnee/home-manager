import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionView } from '../types';
import type { SessionGroup } from '../lib/grouping';
import { buildLineage } from '../lib/lineage';
import {
  BulkStopConfirmation,
  activeSessionAncestorIds,
  bulkStopMenuActions,
  bulkStopReason,
  cancelsRowLongPress,
  drawerFocusPolicy,
  GroupBlock,
  isCurrentBulkRun,
  pinScopedFirst,
  rowMenuActionSpecs,
  suppressesRowClick,
  type BulkStopRequest,
} from './AgentSidebar';

describe('fleet drawer focus policy', () => {
  test('coarse touch focuses the dialog container instead of the search input', () => {
    expect(drawerFocusPolicy(true)).toEqual({
      dialogAutoFocus: true,
      searchAutoFocus: false,
    });
  });

  test('fine pointer and hover retain search-first keyboard navigation', () => {
    expect(drawerFocusPolicy(false)).toEqual({
      dialogAutoFocus: false,
      searchAutoFocus: true,
    });
  });
});

describe('session-row long-press guard', () => {
  test('a scroll-sized movement cancels the 500ms touch/pen opener', () => {
    expect(cancelsRowLongPress({ x: 20, y: 20 }, { x: 30, y: 20 })).toBe(false);
    expect(cancelsRowLongPress({ x: 20, y: 20 }, { x: 31, y: 20 })).toBe(true);
  });

  test('the click following a fired long-press is suppressed, then navigation resumes', () => {
    expect(suppressesRowClick(100, 799)).toBe(true);
    expect(suppressesRowClick(100, 800)).toBe(false);
  });
});

describe('bulk-stop menu gate', () => {
  test('a read-only origin does not render bulk mutation actions', () => {
    expect(bulkStopMenuActions([session('one', '/tmp')], 'one', false)).toEqual([]);
  });

  test('uses all four explicit labels and counts, without the opaque Stop duplicate', () => {
    const root = { ...session('root', '/tmp'), config: { ...session('root', '/tmp').config, label: 'release' } };
    const child = { ...session('child', '/tmp'), config: { ...session('child', '/tmp').config, parent: 'root' } };
    const peer = { ...session('peer', '/tmp'), config: { ...session('peer', '/tmp').config, label: 'release' } };
    const actions = bulkStopMenuActions([root, child, peer], 'root', true);
    expect(actions.map(action => action.label)).toEqual([
      'Stop · orphan this session',
      'Stop · cascade whole tree',
      'Stop · children only (keep this)',
      'Stop label “release”',
    ]);
    expect(
      actions.map(action => `${action.targets.length} ${action.targets.length === 1 ? 'session' : 'sessions'}`),
    ).toEqual(['1 session', '2 sessions', '1 session', '2 sessions']);
    expect(rowMenuActionSpecs(root, true).map(spec => spec.action)).toEqual(['interrupt', 'rename', 'migrate']);
  });

  test('omits the label row when the selected session has no label', () => {
    expect(bulkStopMenuActions([session('one', '/tmp')], 'one', true).map(action => action.scope)).toEqual([
      'orphan',
      'cascade',
      'children',
    ]);
  });
});

describe('global Tasks destination', () => {
  test('is absent from both the rail and drawer', async () => {
    const source = await Bun.file(new URL('./AgentSidebar.tsx', import.meta.url).pathname).text();
    expect(source).not.toContain('to="/tasks"');
    expect(source).not.toContain('aria-label="Open Tasks"');
    expect(source).toContain('grid-cols-2');
  });
});

const group = (name: string, path: string): SessionGroup => ({ name, path, rows: [] });

describe('pinScopedFirst', () => {
  const g = [group('alcohol', '/home/k/alcohol'), group('nitroso', '/home/k/nitroso'), group('diene', '/home/k/diene')];

  test('no scope leaves the order untouched', () => {
    expect(pinScopedFirst(g, null).map(x => x.path)).toEqual(['/home/k/alcohol', '/home/k/nitroso', '/home/k/diene']);
  });

  test('the focused folder is pinned first, the rest keep their relative order', () => {
    expect(pinScopedFirst(g, '/home/k/nitroso').map(x => x.path)).toEqual([
      '/home/k/nitroso',
      '/home/k/alcohol',
      '/home/k/diene',
    ]);
  });

  test('a scope already first, or not present at all, is a no-op', () => {
    expect(pinScopedFirst(g, '/home/k/alcohol').map(x => x.path)).toEqual(g.map(x => x.path));
    expect(pinScopedFirst(g, '/home/k/gone').map(x => x.path)).toEqual(g.map(x => x.path));
  });
});

function session(id: string, cwd: string): SessionView {
  return {
    config: {
      id,
      name: `task ${id}`,
      binary: 'codex',
      harness: 'codex',
      modelHint: 'gpt-5.6',
      mode: 'auto',
      cwd,
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
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
    state: { id, status: 'running', turn: 1, lastActivityAt: '2026-07-25T00:00:00.000Z' },
    directory: cwd,
  };
}

function renderBlock(props: { scoped?: boolean; coarse?: boolean }): string {
  const rows = [session('a', '/home/k/nitroso')];
  const g: SessionGroup = { name: 'nitroso', path: '/home/k/nitroso', rows };
  return renderToStaticMarkup(
    createElement(GroupBlock, {
      group: g,
      lineage: buildLineage(rows),
      byId: new Map(rows.map(r => [r.config.id, r])),
      onFocus: () => undefined,
      ...props,
    }),
  );
}

describe('GroupBlock folder-scope header', () => {
  test('the folder header is a button that names the folder to focus', () => {
    const html = renderBlock({});
    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Focus folder nitroso"');
  });

  test('the scoped group header carries aria-current="true" and the accent', () => {
    const scoped = renderBlock({ scoped: true });
    expect(scoped).toContain('aria-current="true"');
    expect(scoped).toContain('text-accent');
    // Unscoped headers must NOT claim to be current.
    expect(renderBlock({})).not.toContain('aria-current');
  });

  test('the drawer (coarse) header takes the 44px touch floor', () => {
    expect(renderBlock({ coarse: true })).toContain('min-h-[44px]');
    // The desktop expanded column stays compact — no forced 44px.
    expect(renderBlock({ coarse: false })).not.toContain('min-h-[44px]');
  });
});

describe('bulk stop confirmation', () => {
  const targets = [session('caller', '/home/k/nitroso'), session('child', '/home/k/nitroso')];
  const confirmRequest: BulkStopRequest = { token: 1, selectedId: 'caller', scope: 'cascade', targets };

  test('names and counts every confirmed target and flags the current session', () => {
    const html = renderToStaticMarkup(
      createElement(BulkStopConfirmation, {
        request: confirmRequest,
        activeId: 'caller',
        sessions: targets,
        onClose: () => undefined,
        onConfirm: () => undefined,
        onConfirmNew: () => undefined,
      }),
    );
    expect(html).toContain('Stop these 2 sessions?');
    expect(html).toContain('task caller');
    expect(html).toContain('task child');
    expect(html).toContain('Current session is included and will be stopped.');
  });

  test('renders every partial success or failure and offers review for re-scan targets', () => {
    const html = renderToStaticMarkup(
      createElement(BulkStopConfirmation, {
        request: {
          ...confirmRequest,
          outcomes: [
            { id: 'caller', name: 'task caller', ok: true },
            { id: 'child', name: 'task child', ok: false, detail: 'daemon unavailable' },
          ],
          newTargets: [session('late', '/home/k/nitroso')],
        },
        sessions: targets,
        onClose: () => undefined,
        onConfirm: () => undefined,
        onConfirmNew: () => undefined,
      }),
    );
    expect(html).toContain('Stopped');
    expect(html).toContain('Failed');
    expect(html).toContain('daemon unavailable');
    expect(html).toContain('1 newly appeared matching session was not stopped.');
    expect(html).toContain('task late');
    expect(html).toContain('late');
    expect(html).toContain('Review newly appeared sessions');
  });

  test('flags a selected cycle-safe ancestor of the current route session', () => {
    const lead = session('lead', '/home/k/nitroso');
    const current = {
      ...session('current', '/home/k/nitroso'),
      config: { ...session('current', '/home/k/nitroso').config, parent: 'lead' },
    };
    const html = renderToStaticMarkup(
      createElement(BulkStopConfirmation, {
        request: { token: 2, selectedId: 'lead', scope: 'cascade', targets: [lead] },
        activeId: 'current',
        sessions: [lead, current],
        onClose: () => undefined,
        onConfirm: () => undefined,
        onConfirmNew: () => undefined,
      }),
    );
    expect(html).toContain('Current-session ancestor');

    const orphanHtml = renderToStaticMarkup(
      createElement(BulkStopConfirmation, {
        request: { token: 3, selectedId: 'lead', scope: 'orphan', targets: [lead], orphanedDescendants: [] },
        activeId: 'current',
        sessions: [lead, current],
        onClose: () => undefined,
        onConfirm: () => undefined,
        onConfirmNew: () => undefined,
      }),
    );
    expect(orphanHtml).toContain('Current-session ancestor');

    const cyclicLead = { ...lead, config: { ...lead.config, parent: 'current' } };
    expect([...activeSessionAncestorIds('current', [cyclicLead, current])]).toEqual(['lead']);
  });

  test('orphan confirmation leads with exact live descendants that will remain parentless', () => {
    const root = session('root', '/home/k/nitroso');
    const child = {
      ...session('child', '/home/k/nitroso'),
      config: { ...session('child', '/home/k/nitroso').config, parent: 'root' },
    };
    const html = renderToStaticMarkup(
      createElement(BulkStopConfirmation, {
        request: {
          token: 3,
          selectedId: 'root',
          scope: 'orphan',
          targets: [root],
          orphanedDescendants: [child],
        },
        sessions: [root, child],
        onClose: () => undefined,
        onConfirm: () => undefined,
        onConfirmNew: () => undefined,
      }),
    );
    expect(html).toContain('Session to stop:');
    expect(html).toContain('Live descendants left running / parentless (1)');
    expect(html).toContain('task child');
  });

  test('orphan says plainly when no descendants will be left parentless', () => {
    const root = session('root', '/home/k/nitroso');
    const html = renderToStaticMarkup(
      createElement(BulkStopConfirmation, {
        request: { token: 4, selectedId: 'root', scope: 'orphan', targets: [root], orphanedDescendants: [] },
        sessions: [root],
        onClose: () => undefined,
        onConfirm: () => undefined,
        onConfirmNew: () => undefined,
      }),
    );
    expect(html).toContain('No descendants will be orphaned.');
  });

  test('a running sweep disables every dismissal affordance until outcomes are available', () => {
    const html = renderToStaticMarkup(
      createElement(BulkStopConfirmation, {
        request: { ...confirmRequest, running: true },
        sessions: targets,
        onClose: () => undefined,
        onConfirm: () => undefined,
        onConfirmNew: () => undefined,
      }),
    );
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test('a stale sweep token cannot replace a newer confirmation', () => {
    expect(isCurrentBulkRun(confirmRequest, 1)).toBe(true);
    expect(isCurrentBulkRun(confirmRequest, 2)).toBe(false);
  });

  test('a closed nullable confirmation renders nothing so the focus hook observes a close transition', () => {
    const html = renderToStaticMarkup(
      createElement(BulkStopConfirmation, {
        request: null,
        sessions: [],
        onClose: () => undefined,
        onConfirm: () => undefined,
        onConfirmNew: () => undefined,
      }),
    );
    expect(html).toBe('');
  });

  test('a label stop reason preserves the exact label captured by the confirmation', () => {
    expect(bulkStopReason({ scope: 'label', selectedId: 'session-id', labelIdentity: 'release / west' })).toBe(
      'stopped label release / west from browser',
    );
  });
});
