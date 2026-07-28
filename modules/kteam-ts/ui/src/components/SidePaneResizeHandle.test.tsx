import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SidePaneResizeHandle,
  sidePaneWidthBounds,
  sidePaneWidthFromKey,
  sidePaneWidthFromPointer,
} from './SidePaneResizeHandle';
import { SIDE_PANE_MAX_WIDTH, SIDE_PANE_MIN_WIDTH } from '../lib/side-pane-preferences';

describe('side pane resize policy', () => {
  test('caps the pane so chat retains its minimum column', () => {
    expect(sidePaneWidthBounds(720)).toEqual({ min: SIDE_PANE_MIN_WIDTH, max: 352 });
    expect(sidePaneWidthBounds(2000).max).toBe(SIDE_PANE_MAX_WIDTH);
  });

  test('pointer movement grows leftward and clamps both edges', () => {
    const bounds = { min: 320, max: 680 };
    expect(sidePaneWidthFromPointer(500, 900, 850, bounds)).toBe(550);
    expect(sidePaneWidthFromPointer(500, 900, 200, bounds)).toBe(680);
    expect(sidePaneWidthFromPointer(500, 900, 1200, bounds)).toBe(320);
  });

  test('keyboard arrows, Home and End expose the same bounded control', () => {
    const bounds = { min: 320, max: 680 };
    expect(sidePaneWidthFromKey('ArrowLeft', 500, bounds)).toBe(516);
    expect(sidePaneWidthFromKey('ArrowRight', 500, bounds, true)).toBe(436);
    expect(sidePaneWidthFromKey('Home', 500, bounds)).toBe(320);
    expect(sidePaneWidthFromKey('End', 500, bounds)).toBe(680);
    expect(sidePaneWidthFromKey('Enter', 500, bounds)).toBeNull();
  });

  test('renders a focusable vertical separator with a real 16px hit area', () => {
    const html = renderToStaticMarkup(
      <SidePaneResizeHandle width={520} onPreview={() => undefined} onCommit={() => undefined} />,
    );
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-valuenow="520"');
    expect(html).toContain('w-4');
    expect(html).not.toContain('tabindex="-1"');
  });
});
