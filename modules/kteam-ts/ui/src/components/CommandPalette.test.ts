import { describe, expect, test } from 'bun:test';
import { paletteFocusPolicy } from './CommandPalette';

describe('CommandPalette focus policy', () => {
  test('lands on the non-text dialog surface for touch-affected input', () => {
    expect(paletteFocusPolicy(true)).toEqual({ dialogAutoFocus: true, inputAutoFocus: false });
  });

  test('keeps search-first keyboard flow for unambiguous desktop input', () => {
    expect(paletteFocusPolicy(false)).toEqual({ dialogAutoFocus: false, inputAutoFocus: true });
  });
});
