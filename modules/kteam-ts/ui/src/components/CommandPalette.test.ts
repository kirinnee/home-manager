import { describe, expect, test } from 'bun:test';
import { matchesBrowserLoginCommand, paletteFocusPolicy } from './CommandPalette';

describe('CommandPalette focus policy', () => {
  test('lands on the non-text dialog surface for touch-affected input', () => {
    expect(paletteFocusPolicy(true)).toEqual({ dialogAutoFocus: true, inputAutoFocus: false });
  });

  test('keeps search-first keyboard flow for unambiguous desktop input', () => {
    expect(paletteFocusPolicy(false)).toEqual({ dialogAutoFocus: false, inputAutoFocus: true });
  });
});

describe('CommandPalette browser login command', () => {
  test('is discoverable from every advertised search phrase', () => {
    for (const query of ['', 'browser', 'login', 'sign in', 'shared Chrome']) {
      expect(matchesBrowserLoginCommand(query)).toBe(true);
    }
    expect(matchesBrowserLoginCommand('analytics')).toBe(false);
  });
});
