import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionView } from '../types';
import type { SessionGroup } from '../lib/grouping';
import { buildLineage } from '../lib/lineage';
import { drawerFocusPolicy, GroupBlock, pinScopedFirst } from './AgentSidebar';

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
