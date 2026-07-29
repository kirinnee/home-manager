// THE REGRESSION THIS FILE GUARDS: "the context menu that appears blocks
// everything" — long-pressing transcript prose on a phone opened the app's own
// menu (and its full-screen dismissal surface) over the native selection
// handles, so text could not be selected at all.
//
// This package ships no DOM implementation, so — following Transcript.test.ts
// and AgentSidebar.test.ts — the DECISION is exported as a pure unit and
// asserted here with plain data. `textContextMenuEventAllowed` is the exact
// composition the transcript's `contextmenu` handler calls, so a handler that
// still opened the menu on touch would have to first make this file lie.
//
// `false` in every assertion below means the handler returns WITHOUT
// `preventDefault()` — which is what leaves the native handles and the OS copy
// bar alone.

import { describe, expect, test } from 'bun:test';
import {
  resolvePointerKind,
  textContextMenuAllowed,
  textContextMenuEventAllowed,
  type PointerKind,
} from './context-menu-policy';

describe('resolvePointerKind — which device produced this contextmenu?', () => {
  test('the event names itself and wins', () => {
    expect(resolvePointerKind('touch', 'mouse')).toBe('touch');
    expect(resolvePointerKind('mouse', 'touch')).toBe('mouse');
    expect(resolvePointerKind('pen', null)).toBe('pen');
  });

  test('a bare MouseEvent falls back to the press that started the gesture', () => {
    // WebKit dispatches contextmenu with no pointerType; the touchstart/
    // pointerdown that BEGAN the long press is the only witness left.
    expect(resolvePointerKind(undefined, 'touch')).toBe('touch');
    expect(resolvePointerKind(null, 'mouse')).toBe('mouse');
    expect(resolvePointerKind('', 'touch')).toBe('touch');
  });

  test('an unrecognised or absent answer is unknown, never a guess at mouse', () => {
    expect(resolvePointerKind(undefined, null)).toBe('unknown');
    expect(resolvePointerKind('', '')).toBe('unknown');
    expect(resolvePointerKind('stylus-3000', 'wand')).toBe('unknown');
    // Not a string at all (a hostile or exotic event object).
    expect(resolvePointerKind(42 as unknown as string, undefined)).toBe('unknown');
  });
});

describe('textContextMenuAllowed — may we replace the browser menu?', () => {
  const at = (pointerKind: PointerKind, touchAffected: boolean, hasSelection = true) =>
    textContextMenuAllowed({ pointerKind, touchAffected, hasSelection });

  test('THE BUG: a touch long-press over a selection never opens our menu', () => {
    expect(at('touch', true)).toBe(false);
    // Even on a device we somehow read as non-touch: the pointer said touch.
    expect(at('touch', false)).toBe(false);
  });

  test('a pen long-press is a selection gesture too', () => {
    expect(at('pen', true)).toBe(false);
    expect(at('pen', false)).toBe(false);
  });

  test('a mouse right-click over a selection still opens our menu', () => {
    expect(at('mouse', false)).toBe(true);
    // A touchscreen laptop: the pointer said mouse, so the desktop path stands.
    expect(at('mouse', true)).toBe(true);
  });

  test('unknown provenance resolves AGAINST us on a touch-affected device', () => {
    expect(at('unknown', true)).toBe(false);
    expect(at('unknown', false)).toBe(true);
  });

  test('no selection → never ours, on any device', () => {
    // The browser's own menu for a link or an image is left completely alone.
    expect(at('mouse', false, false)).toBe(false);
    expect(at('touch', true, false)).toBe(false);
    expect(at('unknown', false, false)).toBe(false);
  });
});

describe('textContextMenuEventAllowed — the handler composition, per engine', () => {
  test('Android Chrome: long press selects the word, THEN fires a touch contextmenu', () => {
    // The exact shape that used to open the menu over the handles: a real
    // selection exists by the time the event arrives, which is why "only act
    // when there is a selection" was not a sufficient guard.
    expect(
      textContextMenuEventAllowed(
        { pointerType: 'touch' },
        { lastPointerType: 'touch', touchAffected: true, hasSelection: true },
      ),
    ).toBe(false);
  });

  test('iOS Safari: a bare MouseEvent, attributed by the touch that started it', () => {
    expect(textContextMenuEventAllowed({}, { lastPointerType: 'touch', touchAffected: true, hasSelection: true })).toBe(
      false,
    );
  });

  test('a phone whose press was never observed is still treated as a phone', () => {
    expect(textContextMenuEventAllowed(null, { lastPointerType: null, touchAffected: true, hasSelection: true })).toBe(
      false,
    );
  });

  test('desktop right-click over a selection is unchanged', () => {
    expect(
      textContextMenuEventAllowed(
        { pointerType: 'mouse' },
        { lastPointerType: 'mouse', touchAffected: false, hasSelection: true },
      ),
    ).toBe(true);
    // No pointerType, no touch capability, never pressed: still a desktop.
    expect(textContextMenuEventAllowed({}, { lastPointerType: null, touchAffected: false, hasSelection: true })).toBe(
      true,
    );
  });

  test('desktop right-click with nothing selected leaves the native menu alone', () => {
    expect(
      textContextMenuEventAllowed(
        { pointerType: 'mouse' },
        { lastPointerType: 'mouse', touchAffected: false, hasSelection: false },
      ),
    ).toBe(false);
  });
});
