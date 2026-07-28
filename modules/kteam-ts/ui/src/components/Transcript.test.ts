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
import { pinBlockedBySelection, paneUsableTableWidth, touchQuotePlacement, type SelectionLike } from './Transcript';

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

// The live chat modes now make the content column fill their scroller. Keep the
// general centred-column cases too: the helper remains the safe table ceiling
// for any future/out-of-chat embedding with a narrower column.
describe('paneUsableTableWidth — the pane-safe table ceiling', () => {
  const PAD = 16; // sm:px-4 on .kt-content
  const FALLBACK_COL = 880;

  test('handles a centred fallback column inside a wider pane', () => {
    // column is 880, centred → 280px gutter each side. left-anchored table gives
    // up only the LEFT gutter: 1440 − 16 − 16 − 280 = 1128.
    expect(paneUsableTableWidth(1440, FALLBACK_COL, PAD, PAD)).toBe(1128);
    expect(paneUsableTableWidth(1280, FALLBACK_COL, PAD, PAD)).toBe(1048);
  });

  test('full mode: pane-wide column returns the inner content-box width', () => {
    expect(paneUsableTableWidth(1168, 1168, PAD, PAD)).toBe(1136);
  });

  test('readable and smaller panes return their inner content-box width', () => {
    // In readable mode the scroller IS the surface, so paneWidth==columnWidth and
    // the table ceiling follows that hard frame.
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

// ---------------------------------------------------------------------------
// touchQuotePlacement — where the touch Quote/Pin pair may sit. The reported
// bug: placed above the selection it covered the selected bubble's own
// timestamp row (390x844: buttons at y=177 over the clock at y=203). Policy is
// now below-first, so the pair can only cover text the reader already read.

describe('touchQuotePlacement', () => {
  const PHONE = { width: 390, height: 844 };

  test('sits BELOW the selection when there is room — never over the header row above it', () => {
    // The measured collision case: selection line at y=225–244 in a bubble
    // whose clock row is at y=203–222.
    const pos = touchQuotePlacement({ x: 128, top: 225, bottom: 244 }, PHONE);
    expect(pos.top).toBeGreaterThan(244); // strictly below the selection…
    expect(pos.top).toBe(244 + 10); // …by the handle gap
  });

  test('flips ABOVE only when the selection ends too near the bottom to fit', () => {
    const pos = touchQuotePlacement({ x: 128, top: 800, bottom: 820 }, PHONE);
    expect(pos.top).toBeLessThan(800);
    expect(pos.top).toBe(800 - 10 - 44);
  });

  test('a flipped pair near the very top clamps on screen', () => {
    const pos = touchQuotePlacement({ x: 128, top: 20, bottom: 830 }, PHONE);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });

  test('left edge clamps inside a 360px viewport at both extremes', () => {
    const narrow = { width: 360, height: 780 };
    expect(touchQuotePlacement({ x: 0, top: 100, bottom: 120 }, narrow).left).toBe(8);
    const right = touchQuotePlacement({ x: 360, top: 100, bottom: 120 }, narrow).left;
    expect(right + 148).toBeLessThanOrEqual(360 - 8);
  });

  test('centres on the selection when nothing clamps', () => {
    const pos = touchQuotePlacement({ x: 195, top: 300, bottom: 320 }, PHONE);
    expect(pos.left).toBe(195 - 148 / 2);
  });
});
