import { afterEach, describe, expect, test } from 'bun:test';
import { Cable } from 'lucide-react';
import {
  activateSidePaneTab,
  deactivateSidePane,
  getSidePaneInstanceBody,
  getSidePaneTabDefinition,
  getSidePaneTabDefinitions,
  openSidePaneBrowserTab,
  openSidePaneFileTab,
  openSidePaneTab,
  openSidePaneTerminalTab,
  parseSidePaneInstanceTabId,
  readSidePaneTabInstance,
  readSidePaneTabsState,
  registerSidePaneInstanceBody,
  registerSidePaneTab,
  removeSidePaneTab,
  resetSidePaneTabsStates,
  resolveSidePaneTab,
  setSidePaneBrowserDestination,
  setSidePaneInstanceLabel,
  SIDE_PANE_BUILT_IN_TABS,
  sortSidePaneTabs,
  subscribeSidePaneInstanceClose,
  subscribeSidePaneTabsState,
  type SidePaneTabDefinition,
} from './side-pane-tab-model';

const destination = (href: string) => ({ href, origin: new URL(href).origin }) as never;

afterEach(() => {
  resetSidePaneTabsStates();
});

/** The human's default strip, in the order they named it. */
const DEFAULT_STRIP = ['pins', 'tasks', 'skills', 'lineage', 'mcp', 'attention', 'analytics'];

function wave2Definition(overrides: Partial<SidePaneTabDefinition> = {}): SidePaneTabDefinition {
  return {
    id: 'wave2-probe',
    label: 'Probe',
    shortLabel: 'Probe',
    closeLabel: 'Close probe',
    icon: Cable,
    order: 5,
    ...overrides,
  };
}

describe('defaults', () => {
  test('a fresh session opens the seven default tabs, closed, in strip order', () => {
    const state = readSidePaneTabsState('fresh');
    expect(state.open).toEqual(DEFAULT_STRIP);
    expect(state.active).toBeNull();
    expect(state.browser).toBeNull();
  });

  test('web, files and terminals are registered but not default', () => {
    for (const id of ['browser', 'files', 'terminals']) {
      expect(getSidePaneTabDefinition(id)).toBeDefined();
      expect(getSidePaneTabDefinition(id)?.defaultOpen).not.toBe(true);
    }
  });

  test('only browser and terminals retain', () => {
    const retained = SIDE_PANE_BUILT_IN_TABS.filter(def => def.retain).map(def => def.id);
    expect(retained.sort()).toEqual(['browser', 'terminals']);
  });
});

describe('open / activate / close', () => {
  test('opening a non-default tab adds it to the strip in registry order and activates it', () => {
    openSidePaneTab('s', 'files');
    const state = readSidePaneTabsState('s');
    expect(state.open).toEqual([...DEFAULT_STRIP, 'files']);
    expect(state.active).toBe('files');
  });

  test('opening an already-open tab only activates it', () => {
    openSidePaneTab('s', 'skills');
    openSidePaneTab('s', 'pins');
    expect(readSidePaneTabsState('s').open).toEqual(DEFAULT_STRIP);
    expect(readSidePaneTabsState('s').active).toBe('pins');
  });

  test('activate is a no-op for a tab outside the strip', () => {
    openSidePaneTab('s', 'pins');
    activateSidePaneTab('s', 'terminals');
    expect(readSidePaneTabsState('s').active).toBe('pins');
    expect(readSidePaneTabsState('s').open).not.toContain('terminals');
  });

  test('deactivate closes the pane but the strip survives', () => {
    openSidePaneTab('s', 'files');
    deactivateSidePane('s');
    const state = readSidePaneTabsState('s');
    expect(state.active).toBeNull();
    expect(state.open).toContain('files');
  });

  test('state is per session and never leaks across ids', () => {
    openSidePaneTab('a', 'files');
    expect(readSidePaneTabsState('b').open).toEqual(DEFAULT_STRIP);
    expect(readSidePaneTabsState('b').active).toBeNull();
  });
});

describe('removal', () => {
  test('removing the active tab activates the following neighbour', () => {
    openSidePaneTab('s', 'tasks');
    removeSidePaneTab('s', 'tasks');
    const state = readSidePaneTabsState('s');
    expect(state.open).not.toContain('tasks');
    expect(state.active).toBe('skills');
  });

  test('removing the LAST active tab falls back to the preceding neighbour', () => {
    openSidePaneTab('s', 'analytics');
    removeSidePaneTab('s', 'analytics');
    expect(readSidePaneTabsState('s').active).toBe('attention');
  });

  test('removing an inactive tab never changes the active one', () => {
    openSidePaneTab('s', 'pins');
    removeSidePaneTab('s', 'mcp');
    expect(readSidePaneTabsState('s').active).toBe('pins');
  });

  test('removing the only tab closes the pane', () => {
    for (const id of DEFAULT_STRIP.slice(1)) removeSidePaneTab('s', id);
    openSidePaneTab('s', 'pins');
    removeSidePaneTab('s', 'pins');
    const state = readSidePaneTabsState('s');
    expect(state.open).toEqual([]);
    expect(state.active).toBeNull();
  });

  test('removing a tab outside the strip is a no-op', () => {
    openSidePaneTab('s', 'pins');
    removeSidePaneTab('s', 'terminals');
    expect(readSidePaneTabsState('s').open).toEqual(DEFAULT_STRIP);
  });
});

describe('instance tabs — one per file, one per page, one per terminal', () => {
  test('two files are two tabs, after the utility tabs, in opening order', () => {
    openSidePaneFileTab('s', 'src/api.ts');
    openSidePaneFileTab('s', 'README.md');
    const state = readSidePaneTabsState('s');
    expect(state.open).toEqual([...DEFAULT_STRIP, 'file:src/api.ts', 'file:README.md']);
    expect(state.active).toBe('file:README.md');
  });

  test('opening the same file twice focuses the existing tab, never duplicates', () => {
    openSidePaneFileTab('s', 'src/api.ts');
    openSidePaneFileTab('s', 'README.md');
    openSidePaneFileTab('s', 'src/api.ts', { line: 12, endLine: 20 });
    const state = readSidePaneTabsState('s');
    expect(state.open.filter(id => id === 'file:src/api.ts')).toHaveLength(1);
    expect(state.active).toBe('file:src/api.ts');
    expect(state.instances['file:src/api.ts']?.selection).toEqual({ line: 12, endLine: 20 });
  });

  test('a re-delivery to an open tab bumps its revision (observable scroll cue)', () => {
    openSidePaneFileTab('s', 'a.ts', { line: 1 });
    const first = readSidePaneTabInstance('s', 'file:a.ts')?.revision;
    openSidePaneFileTab('s', 'a.ts', { line: 9 });
    expect(readSidePaneTabInstance('s', 'file:a.ts')?.revision).toBe((first ?? 0) + 1);
  });

  test('file labels are the basename; the full path is the title', () => {
    openSidePaneFileTab('s', 'src/lib/deep/thing.ts');
    const instance = readSidePaneTabInstance('s', 'file:src/lib/deep/thing.ts');
    expect(instance?.label).toBe('thing.ts');
    expect(instance?.title).toBe('src/lib/deep/thing.ts');
  });

  test('two pages are two tabs; re-opening a destination focuses its page', () => {
    const a = openSidePaneBrowserTab('s', destination('https://a.test/'));
    const b = openSidePaneBrowserTab('s', destination('https://b.test/'));
    expect(a).not.toBe(b);
    expect(openSidePaneBrowserTab('s', destination('https://a.test/'))).toBe(a);
    const state = readSidePaneTabsState('s');
    expect(Object.keys(state.instances)).toHaveLength(2);
    expect(state.active).toBe(a);
  });

  test('forceNew (the + picker) always creates a fresh page', () => {
    const a = openSidePaneBrowserTab('s', null, { forceNew: true });
    const b = openSidePaneBrowserTab('s', null, { forceNew: true });
    expect(a).not.toBe(b);
    expect(Object.keys(readSidePaneTabsState('s').instances)).toHaveLength(2);
  });

  test('the legacy browser singleton redirects to a page instance — its id never enters the strip', () => {
    openSidePaneTab('s', 'browser');
    const state = readSidePaneTabsState('s');
    expect(state.open).not.toContain('browser');
    expect(state.active?.startsWith('browser:')).toBe(true);
    // Re-opening focuses the existing page instead of stacking blank pages.
    openSidePaneTab('s', 'browser');
    expect(Object.keys(readSidePaneTabsState('s').instances)).toHaveLength(1);
  });

  test('page labels show the host with the URL as title; a blank page says so', () => {
    const id = openSidePaneBrowserTab('s', destination('https://example.com/docs'));
    expect(readSidePaneTabInstance('s', id)?.label).toBe('example.com');
    expect(readSidePaneTabInstance('s', id)?.title).toBe('https://example.com/docs');
    const blank = openSidePaneBrowserTab('s2', null);
    expect(readSidePaneTabInstance('s2', blank)?.label).toBe('New page');
  });

  test('terminals are one tab per terminal id; re-opening focuses', () => {
    openSidePaneTerminalTab('s', 't1', 'term 1');
    openSidePaneTerminalTab('s', 't2', 'term 2');
    openSidePaneTerminalTab('s', 't1');
    const state = readSidePaneTabsState('s');
    expect(state.open.filter(id => id.startsWith('terminal:'))).toEqual(['terminal:t1', 'terminal:t2']);
    expect(state.active).toBe('terminal:t1');
    expect(state.instances['terminal:t1']?.label).toBe('term 1');
  });

  test('instances group files → pages → terminals after the utility tabs, insertion order within kind', () => {
    openSidePaneTerminalTab('s', 't1', 'term 1');
    openSidePaneBrowserTab('s', destination('https://example.com/'));
    openSidePaneFileTab('s', 'z.ts');
    openSidePaneFileTab('s', 'a.ts');
    const tail = readSidePaneTabsState('s').open.slice(DEFAULT_STRIP.length);
    expect(tail[0]).toBe('file:z.ts');
    expect(tail[1]).toBe('file:a.ts');
    expect(tail[2]?.startsWith('browser:')).toBe(true);
    expect(tail[3]).toBe('terminal:t1');
  });

  test('closing an instance disposes exactly it and notifies close listeners', () => {
    const closed: string[] = [];
    const unsubscribe = subscribeSidePaneInstanceClose((_sessionId, instance) => closed.push(instance.id));
    try {
      openSidePaneFileTab('s', 'a.ts');
      openSidePaneFileTab('s', 'b.ts');
      removeSidePaneTab('s', 'file:a.ts');
      const state = readSidePaneTabsState('s');
      expect(state.open).not.toContain('file:a.ts');
      expect(state.instances['file:a.ts']).toBeUndefined();
      expect(state.instances['file:b.ts']).toBeDefined();
      expect(closed).toEqual(['file:a.ts']);
    } finally {
      unsubscribe();
    }
  });

  test('closing the last instance leaves no phantom Files/Browser tab behind', () => {
    openSidePaneFileTab('s', 'a.ts');
    removeSidePaneTab('s', 'file:a.ts');
    const state = readSidePaneTabsState('s');
    expect(state.open).toEqual(DEFAULT_STRIP);
    expect(state.instances).toEqual({});
    // Singleton removal (picker toggle-off) still never fires disposal —
    // covered by the removal suite above; instance close is a real close.
  });

  test('resolveSidePaneTab synthesizes a definition for an open instance and nothing for a closed one', () => {
    openSidePaneFileTab('s', 'src/x.ts');
    const def = resolveSidePaneTab('s', 'file:src/x.ts');
    expect(def?.shortLabel).toBe('x.ts');
    expect(def?.label).toBe('src/x.ts');
    expect(def?.retain).not.toBe(true);
    const page = openSidePaneBrowserTab('s', null);
    expect(resolveSidePaneTab('s', page)?.retain).toBe(true);
    expect(resolveSidePaneTab('s', 'file:never-opened.ts')).toBeUndefined();
  });

  test('setSidePaneInstanceLabel retitles without touching focus or membership', () => {
    const id = openSidePaneBrowserTab('s', null, { forceNew: true });
    openSidePaneFileTab('s', 'a.ts');
    setSidePaneInstanceLabel('s', id, { label: 'example.com', title: 'https://example.com/' });
    const state = readSidePaneTabsState('s');
    expect(state.instances[id]?.label).toBe('example.com');
    expect(state.active).toBe('file:a.ts');
    expect(state.open).toContain(id);
  });

  test('parse recognises only the three instance kinds', () => {
    expect(parseSidePaneInstanceTabId('file:src/a.ts')).toEqual({ kind: 'file', key: 'src/a.ts' });
    expect(parseSidePaneInstanceTabId('browser:page-3')).toEqual({ kind: 'browser', key: 'page-3' });
    expect(parseSidePaneInstanceTabId('terminal:t1')).toEqual({ kind: 'terminal', key: 't1' });
    expect(parseSidePaneInstanceTabId('tasks')).toBeNull();
    expect(parseSidePaneInstanceTabId('wave2:probe')).toBeNull();
  });

  test('registerSidePaneInstanceBody claims a kind; a stale unregister cannot tear down a replacement', () => {
    const first = () => null;
    const second = () => null;
    const unregisterFirst = registerSidePaneInstanceBody('terminal', first);
    const unregisterSecond = registerSidePaneInstanceBody('terminal', second);
    try {
      expect(getSidePaneInstanceBody('terminal')).toBe(second);
      unregisterFirst();
      expect(getSidePaneInstanceBody('terminal')).toBe(second);
    } finally {
      unregisterSecond();
    }
    expect(getSidePaneInstanceBody('terminal')).toBeUndefined();
  });
});

describe('browser payload', () => {
  test('rides with the session state', () => {
    const destination = { href: 'https://example.com/', origin: 'https://example.com' };
    setSidePaneBrowserDestination('s', destination as never);
    expect(readSidePaneTabsState('s').browser).toBe(destination as never);
  });
});

describe('registry (the wave-2 seam)', () => {
  test('register adds a live definition; unregister removes exactly it', () => {
    const unregister = registerSidePaneTab(wave2Definition());
    try {
      expect(getSidePaneTabDefinition('wave2-probe')?.label).toBe('Probe');
      expect(getSidePaneTabDefinitions().some(def => def.id === 'wave2-probe')).toBe(true);
    } finally {
      unregister();
    }
    expect(getSidePaneTabDefinition('wave2-probe')).toBeUndefined();
  });

  test('a defaultOpen registration seeds sessions whose strip was never touched', () => {
    const unregister = registerSidePaneTab(wave2Definition({ defaultOpen: true }));
    try {
      // order 5 sorts ahead of pins (10).
      expect(readSidePaneTabsState('untouched').open[0]).toBe('wave2-probe');
    } finally {
      unregister();
      resetSidePaneTabsStates();
    }
  });

  test('re-registering an id replaces it (hot reload cannot dupe)', () => {
    const first = registerSidePaneTab(wave2Definition());
    const second = registerSidePaneTab(wave2Definition({ label: 'Probe v2' }));
    try {
      expect(getSidePaneTabDefinition('wave2-probe')?.label).toBe('Probe v2');
      expect(getSidePaneTabDefinitions().filter(def => def.id === 'wave2-probe').length).toBe(1);
      // The stale unregister must not tear down the replacement.
      first();
      expect(getSidePaneTabDefinition('wave2-probe')?.label).toBe('Probe v2');
    } finally {
      second();
    }
  });

  test('sortSidePaneTabs puts unknown ids last instead of inventing a position', () => {
    expect(sortSidePaneTabs(['zzz-unknown', 'tasks', 'pins'])).toEqual(['pins', 'tasks', 'zzz-unknown']);
  });

  test('writes notify subscribers', () => {
    let notified = 0;
    const unsubscribe = subscribeSidePaneTabsState(() => {
      notified += 1;
    });
    try {
      openSidePaneTab('s', 'pins');
      removeSidePaneTab('s', 'pins');
    } finally {
      unsubscribe();
    }
    expect(notified).toBe(2);
  });
});
