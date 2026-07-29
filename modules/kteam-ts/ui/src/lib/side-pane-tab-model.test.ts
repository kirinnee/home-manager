import { afterEach, describe, expect, test } from 'bun:test';
import { Cable } from 'lucide-react';
import {
  activateSidePaneTab,
  deactivateSidePane,
  getSidePaneTabDefinition,
  getSidePaneTabDefinitions,
  openSidePaneTab,
  readSidePaneTabsState,
  registerSidePaneTab,
  removeSidePaneTab,
  resetSidePaneTabsStates,
  setSidePaneBrowserDestination,
  SIDE_PANE_BUILT_IN_TABS,
  sortSidePaneTabs,
  subscribeSidePaneTabsState,
  type SidePaneTabDefinition,
} from './side-pane-tab-model';

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
