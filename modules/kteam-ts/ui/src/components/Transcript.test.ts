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
import { pinBlockedBySelection, paneUsableTableWidth, type SelectionLike } from './Transcript';

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

// The reading column is `max-w-[880px] mx-auto px-4` (16px each side) centred in
// the scroller. A full-bleed table is left-anchored to the column and may grow
// rightward to one content-pad short of the pane edge; prose keeps its measure.
describe('paneUsableTableWidth — how wide a table may bleed', () => {
  const PAD = 16; // sm:px-4 on .kt-content
  const COL = 880; // max-w-[880px]

  test('wide pane (1440): table bleeds well past the 848px prose measure', () => {
    // column is 880, centred → 280px gutter each side. left-anchored table gives
    // up only the LEFT gutter: 1440 − 16 − 16 − 280 = 1128.
    expect(paneUsableTableWidth(1440, COL, PAD, PAD)).toBe(1128);
    // and that is far more than prose (the column content box, 848px).
    expect(paneUsableTableWidth(1440, COL, PAD, PAD)).toBeGreaterThan(COL - 2 * PAD);
  });

  test('1280 pane bleeds proportionally', () => {
    // gutter = (1280 − 880)/2 = 200 → 1280 − 32 − 200 = 1048.
    expect(paneUsableTableWidth(1280, COL, PAD, PAD)).toBe(1048);
  });

  test('at the cap (pane == column): usable is exactly the prose measure — inert', () => {
    // No surplus, no gutter: the table can only be as wide as prose. This is the
    // point below which the feature is a no-op (matches the old `max-width:100%`).
    expect(paneUsableTableWidth(880, COL, PAD, PAD)).toBe(848);
  });

  test('narrow pane below the cap (readable 768 / small window): column fills the pane, so usable == its content box, no bleed', () => {
    // In readable mode the scroller IS the surface, so paneWidth==columnWidth and
    // the table fills that measure and no further — a deliberate, consistent
    // choice: the narrow surface is a hard frame, nothing bleeds past it.
    expect(paneUsableTableWidth(768, 768, PAD, PAD)).toBe(768 - 2 * PAD);
    expect(paneUsableTableWidth(700, 700, PAD, PAD)).toBe(700 - 2 * PAD);
  });

  test('never negative, even if padding exceeds a tiny pane', () => {
    expect(paneUsableTableWidth(20, 20, PAD, PAD)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// quotableSelectionText — the text a "Quote" would insert, or '' for nothing.
// Same injected-`contains` shape as pinBlockedBySelection, so the gate is
// checkable without a Selection, a Node, or a DOM.
// ---------------------------------------------------------------------------

import { quotableSelectionText, type QuoteSelectionLike } from './Transcript';

const qsel = (
  text: string,
  anchorNode: Node | null,
  focusNode: Node | null,
  over: Partial<QuoteSelectionLike> = {},
): QuoteSelectionLike => ({
  isCollapsed: false,
  rangeCount: 1,
  anchorNode,
  focusNode,
  toString: () => text,
  ...over,
});

describe('quotableSelectionText', () => {
  test('no selection object → empty', () => {
    expect(quotableSelectionText(null, inViewport)).toBe('');
  });

  test('a collapsed caret → empty (nothing highlighted)', () => {
    expect(quotableSelectionText(qsel('x', INSIDE, INSIDE, { isCollapsed: true }), inViewport)).toBe('');
  });

  test('zero ranges → empty', () => {
    expect(quotableSelectionText(qsel('x', INSIDE, INSIDE, { rangeCount: 0 }), inViewport)).toBe('');
  });

  test('a real selection inside the transcript → its trimmed text', () => {
    expect(quotableSelectionText(qsel('  hello world  ', INSIDE, INSIDE), inViewport)).toBe('hello world');
  });

  test('a selection anchored entirely OUTSIDE the transcript → empty', () => {
    expect(quotableSelectionText(qsel('composer text', OUTSIDE, OUTSIDE), inViewport)).toBe('');
  });

  test('either endpoint inside counts — anchored above the fold, extended in', () => {
    expect(quotableSelectionText(qsel('spanning', OUTSIDE, INSIDE), inViewport)).toBe('spanning');
    expect(quotableSelectionText(qsel('spanning', INSIDE, OUTSIDE), inViewport)).toBe('spanning');
  });

  test('a whitespace-only selection is not quotable', () => {
    expect(quotableSelectionText(qsel('   \n\t ', INSIDE, INSIDE), inViewport)).toBe('');
  });
});
