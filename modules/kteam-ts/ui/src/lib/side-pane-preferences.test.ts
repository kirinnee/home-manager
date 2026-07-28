import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_SIDE_PANE_PREFERENCES,
  getSidePanePreferences,
  loadSidePanePreferences,
  parseSidePanePreferences,
  resetSidePanePreferences,
  saveSidePanePreferences,
  setSidePaneWidth,
  SIDE_PANE_MAX_WIDTH,
  SIDE_PANE_MIN_CHAT_WIDTH,
  SIDE_PANE_MIN_WIDTH,
  SIDE_PANE_PREFERENCES_KEY,
  SIDE_PANE_PREFERENCES_VERSION,
  subscribeSidePanePreferences,
  type SidePanePreferenceStorage,
} from './side-pane-preferences';

afterEach(() => resetSidePanePreferences());

describe('side pane preferences', () => {
  test('allows a wider reading surface while retaining a usable adjacent chat floor', () => {
    expect(SIDE_PANE_MAX_WIDTH).toBe(1024);
    expect(SIDE_PANE_MIN_CHAT_WIDTH).toBe(280);
  });

  test('uses a sane default for absent, malformed, or future payloads', () => {
    expect(parseSidePanePreferences(null)).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
    expect(parseSidePanePreferences('{nope')).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
    expect(parseSidePanePreferences(JSON.stringify({ v: 99, width: 600 }))).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
  });

  test('parses fields defensively and clamps a numeric width to supported bounds', () => {
    expect(parseSidePanePreferences(JSON.stringify({ v: SIDE_PANE_PREFERENCES_VERSION, width: 'wide' }))).toEqual(
      DEFAULT_SIDE_PANE_PREFERENCES,
    );
    expect(parseSidePanePreferences(JSON.stringify({ v: 1, width: 10, ignored: true })).width).toBe(
      SIDE_PANE_MIN_WIDTH,
    );
    expect(parseSidePanePreferences(JSON.stringify({ v: 1, width: 99_999 })).width).toBe(SIDE_PANE_MAX_WIDTH);
    expect(parseSidePanePreferences(JSON.stringify({ v: 1, width: 541.6 })).width).toBe(542);
  });

  test('storage failures degrade to defaults or an in-memory-only write', () => {
    const denied: SidePanePreferenceStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadSidePanePreferences(denied)).toEqual(DEFAULT_SIDE_PANE_PREFERENCES);
    expect(saveSidePanePreferences({ v: 1, width: 600 }, denied)).toBe(false);
  });

  test('writes the sole versioned key once with a normalised payload', () => {
    const writes: Array<[string, string]> = [];
    const storage: SidePanePreferenceStorage = {
      getItem: () => null,
      setItem: (key, value) => writes.push([key, value]),
    };
    expect(saveSidePanePreferences({ v: 1, width: 9999 }, storage)).toBe(true);
    expect(writes).toEqual([[SIDE_PANE_PREFERENCES_KEY, JSON.stringify({ v: 1, width: SIDE_PANE_MAX_WIDTH })]]);
  });

  test('publishes one global width snapshot to every retained session workspace', () => {
    let changes = 0;
    const unsubscribe = subscribeSidePanePreferences(() => {
      changes += 1;
    });
    setSidePaneWidth(612);
    expect(getSidePanePreferences().width).toBe(612);
    expect(changes).toBe(1);
    unsubscribe();
    setSidePaneWidth(640);
    expect(changes).toBe(1);
  });
});
