// WHEN FOLLOW IS ALLOWED TO WRITE scrollTop.
//
// The selection bug (transcript-selection-diagnosis.md) was proven in the
// browser: a `scrollTop` write while the reader holds a text selection collapses
// it, 3/3, and the transcript re-pins on every streaming delta — so a live convo
// was unhighlightable. The fix gates every pin on `pinBlockedBySelection`.
//
// This package has no DOM implementation, so — following the pattern of
// TranscriptRow.test.ts (ASSISTANT_LAYOUT) and AgentSidebar.test.ts
// (drawerFocusPolicy) — the DECISION is exported as a pure unit and asserted
// here with plain data. The `contains` predicate is injected, so the five cases
// the guard must get right are checkable without a Selection or a Node.

import { describe, expect, test } from 'bun:test';
import { pinBlockedBySelection, type SelectionLike } from './Transcript';

// Two sentinel "nodes". `contains` decides which is "inside" the viewport; the
// guard never inspects a node itself, only asks the predicate.
const INSIDE = { tag: 'inside' } as unknown as Node;
const OUTSIDE = { tag: 'outside' } as unknown as Node;
const inViewport = (n: Node | null) => n === INSIDE;

/** A live drag-selection spanning two nodes. */
const sel = (anchorNode: Node | null, focusNode: Node | null): SelectionLike => ({
  isCollapsed: false,
  rangeCount: 1,
  anchorNode,
  focusNode,
});

describe('pinBlockedBySelection — may follow pin the viewport right now?', () => {
  test('no selection object → pin allowed', () => {
    expect(pinBlockedBySelection(null, inViewport)).toBe(false);
  });

  test('a collapsed selection (bare caret) → pin allowed', () => {
    const caret: SelectionLike = { isCollapsed: true, rangeCount: 1, anchorNode: INSIDE, focusNode: INSIDE };
    expect(pinBlockedBySelection(caret, inViewport)).toBe(false);
  });

  test('an empty selection (rangeCount 0) → pin allowed', () => {
    const empty: SelectionLike = { isCollapsed: false, rangeCount: 0, anchorNode: INSIDE, focusNode: INSIDE };
    expect(pinBlockedBySelection(empty, inViewport)).toBe(false);
  });

  test('a non-collapsed selection anchored INSIDE the viewport → pin refused', () => {
    expect(pinBlockedBySelection(sel(INSIDE, INSIDE), inViewport)).toBe(true);
  });

  test('a selection entirely OUTSIDE the viewport (composer, another pane) → pin allowed', () => {
    expect(pinBlockedBySelection(sel(OUTSIDE, OUTSIDE), inViewport)).toBe(false);
  });

  test('either endpoint inside blocks: anchor above the fold, focus dragged in → refused', () => {
    expect(pinBlockedBySelection(sel(OUTSIDE, INSIDE), inViewport)).toBe(true);
    expect(pinBlockedBySelection(sel(INSIDE, OUTSIDE), inViewport)).toBe(true);
  });

  test('null element (contains never true) → pin allowed even with a live selection', () => {
    // Models hasSelectionIn(null): the predicate can never match, so nothing is
    // "inside" and follow is never blocked by a missing viewport.
    const never = () => false;
    expect(pinBlockedBySelection(sel(INSIDE, INSIDE), never)).toBe(false);
  });

  test('null endpoints are not treated as inside', () => {
    expect(pinBlockedBySelection(sel(null, null), inViewport)).toBe(false);
  });
});
