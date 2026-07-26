import { describe, expect, test } from 'bun:test';
import { FleetStore, parseUiControls } from './store';

describe('controls-v1 additive density parsing', () => {
  test('keeps every existing field from an older payload and leaves density implicit', () => {
    const controls = parseUiControls(
      JSON.stringify({
        query: 'transcript',
        mode: 'interactive',
        rcOnly: true,
        includeFinished: true,
        dashboardView: 'table',
        sidebarCollapsed: true,
      }),
    );

    expect(controls).toEqual({
      query: 'transcript',
      mode: 'interactive',
      rcOnly: true,
      includeFinished: true,
      dashboardView: 'table',
      density: null,
      // A payload written before `chatWidth` existed degrades to 'full', which IS
      // the previous behaviour — so the field can never change what an older blob
      // meant. That is what makes this addition safe without a version bump.
      chatWidth: 'full',
      projectScope: null,
      sidebarCollapsed: true,
    });
  });

  test('accepts a persisted projectScope and rejects non-strings and empty', () => {
    expect(parseUiControls(JSON.stringify({ projectScope: '/home/kirin/work' })).projectScope).toBe('/home/kirin/work');
    // Empty string is not "scoped to a folder called nothing" — it is no scope.
    expect(parseUiControls(JSON.stringify({ projectScope: '' })).projectScope).toBeNull();
    expect(parseUiControls(JSON.stringify({ projectScope: 42 })).projectScope).toBeNull();
  });

  test('accepts a persisted chatWidth and rejects anything else', () => {
    expect(parseUiControls(JSON.stringify({ chatWidth: 'readable' })).chatWidth).toBe('readable');
    expect(parseUiControls(JSON.stringify({ chatWidth: 'full' })).chatWidth).toBe('full');
    expect(parseUiControls(JSON.stringify({ chatWidth: 'wide' })).chatWidth).toBe('full');
  });

  test('accepts each valid persisted density', () => {
    for (const density of ['full', 'compact', 'minimal'] as const) {
      expect(parseUiControls(JSON.stringify({ density })).density).toBe(density);
    }
  });

  test('falls back field-by-field for invalid additive values', () => {
    const controls = parseUiControls(JSON.stringify({ query: 'keep me', density: 'tiny', sidebarCollapsed: 'yes' }));
    expect(controls.query).toBe('keep me');
    expect(controls.density).toBeNull();
    expect(controls.sidebarCollapsed).toBe(false);
  });

  test('a corrupt whole blob returns all defaults', () => {
    expect(parseUiControls('{')).toEqual({
      query: '',
      mode: 'all',
      rcOnly: false,
      includeFinished: false,
      dashboardView: null,
      density: null,
      chatWidth: 'full',
      projectScope: null,
      sidebarCollapsed: false,
    });
  });
});

describe('ephemeral Settings sheet state', () => {
  test('opens at an optional catalog target and clears fully on close', () => {
    const store = new FleetStore();
    expect(store.getChrome()).toEqual({ settingsOpen: false, settingsTarget: null });
    store.openSettings('density');
    expect(store.getChrome()).toEqual({ settingsOpen: true, settingsTarget: 'density' });
    store.closeSettings();
    expect(store.getChrome()).toEqual({ settingsOpen: false, settingsTarget: null });
  });
});
