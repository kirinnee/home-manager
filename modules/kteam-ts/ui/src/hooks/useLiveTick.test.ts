// The DECISION behind the live-timer selection freeze (see useLiveTick.ts). This
// package has no DOM implementation, so — following pinBlockedBySelection and the
// other pure-decision tests — the freeze predicate is exported and asserted with
// plain data.
//
// The bug it guards: a per-second timer tick mutates a text node in the
// transcript, and on WebKit/iOS that collapses a held selection. `selectionHeld`
// is what tells the tick to hold off, so it must be true for exactly the
// selections a mutation would destroy and false otherwise.

import { describe, expect, test } from 'bun:test';
import { selectionHeld, type TickSelectionLike } from './useLiveTick';

const sel = (over: Partial<TickSelectionLike>): TickSelectionLike => ({ isCollapsed: false, rangeCount: 1, ...over });

describe('selectionHeld — should the live timer freeze right now?', () => {
  test('no selection object → do not freeze', () => {
    expect(selectionHeld(null)).toBe(false);
  });

  test('a non-collapsed selection with a range → freeze', () => {
    expect(selectionHeld(sel({}))).toBe(true);
  });

  test('a collapsed selection (bare caret) → do not freeze', () => {
    expect(selectionHeld(sel({ isCollapsed: true }))).toBe(false);
  });

  test('an empty selection (rangeCount 0) → do not freeze', () => {
    expect(selectionHeld(sel({ rangeCount: 0 }))).toBe(false);
  });

  test('collapsed AND empty → do not freeze', () => {
    expect(selectionHeld({ isCollapsed: true, rangeCount: 0 })).toBe(false);
  });
});
