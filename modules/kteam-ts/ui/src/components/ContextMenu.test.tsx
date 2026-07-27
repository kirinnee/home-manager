import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ContextMenu,
  clampMenuPosition,
  firstEnabledIndex,
  nextEnabledIndex,
  type ContextMenuItem,
} from './ContextMenu';

const VP = { width: 390, height: 844 };

describe('clampMenuPosition', () => {
  test('opens at the anchor when it fits', () => {
    expect(clampMenuPosition({ x: 40, y: 60 }, { width: 200, height: 180 }, VP)).toEqual({ left: 40, top: 60 });
  });

  test('flips left when it would overflow the right edge', () => {
    // anchor near the right edge: 360 + 200 > 390, so it opens back to the left.
    expect(clampMenuPosition({ x: 360, y: 60 }, { width: 200, height: 180 }, VP)).toEqual({ left: 160, top: 60 });
  });

  test('flips up when it would overflow the bottom edge', () => {
    expect(clampMenuPosition({ x: 40, y: 800 }, { width: 200, height: 180 }, VP)).toEqual({ left: 40, top: 620 });
  });

  test('never renders past the left/top margin', () => {
    const at = clampMenuPosition({ x: 2, y: 2 }, { width: 200, height: 180 }, VP);
    expect(at.left).toBeGreaterThanOrEqual(8);
    expect(at.top).toBeGreaterThanOrEqual(8);
  });

  test('a menu wider than the viewport is pinned to the left margin, not off-top', () => {
    const at = clampMenuPosition({ x: 380, y: 60 }, { width: 500, height: 180 }, VP);
    expect(at.left).toBe(8);
    expect(at.top).toBe(60);
  });

  test('stays clear of the right and bottom margins after clamping', () => {
    const size = { width: 200, height: 180 };
    const at = clampMenuPosition({ x: 389, y: 843 }, size, VP);
    expect(at.left + size.width).toBeLessThanOrEqual(VP.width - 8);
    expect(at.top + size.height).toBeLessThanOrEqual(VP.height - 8);
  });
});

const items = (disabled: boolean[]): ContextMenuItem[] =>
  disabled.map((d, i) => ({ key: `k${i}`, label: `item ${i}`, onSelect: () => {}, disabled: d }));

describe('roving focus helpers', () => {
  test('firstEnabledIndex skips leading disabled items', () => {
    expect(firstEnabledIndex(items([true, true, false]))).toBe(2);
    expect(firstEnabledIndex(items([false, false]))).toBe(0);
  });

  test('firstEnabledIndex falls back to 0 when all disabled', () => {
    expect(firstEnabledIndex(items([true, true]))).toBe(0);
  });

  test('nextEnabledIndex moves down, wrapping past the end', () => {
    const list = items([false, false, false]);
    expect(nextEnabledIndex(list, 0, 1)).toBe(1);
    expect(nextEnabledIndex(list, 2, 1)).toBe(0);
  });

  test('nextEnabledIndex moves up, wrapping past the start', () => {
    const list = items([false, false, false]);
    expect(nextEnabledIndex(list, 0, -1)).toBe(2);
  });

  test('nextEnabledIndex hops over disabled items', () => {
    const list = items([false, true, false]);
    expect(nextEnabledIndex(list, 0, 1)).toBe(2);
    expect(nextEnabledIndex(list, 2, -1)).toBe(0);
  });

  test('nextEnabledIndex returns the same index when every item is disabled', () => {
    expect(nextEnabledIndex(items([true, true]), 0, 1)).toBe(0);
  });
});

describe('ContextMenu markup', () => {
  test('renders nothing while closed', () => {
    const html = renderToStaticMarkup(
      <ContextMenu open={false} anchor={{ x: 0, y: 0 }} items={items([false])} onClose={() => {}} ariaLabel="Menu" />,
    );
    expect(html).toBe('');
  });

  test('open menu exposes role=menu, its label, and one menuitem per item', () => {
    const html = renderToStaticMarkup(
      <ContextMenu
        open
        anchor={{ x: 10, y: 10 }}
        ariaLabel="Session actions"
        onClose={() => {}}
        items={[
          { key: 'stop', label: 'Stop session', onSelect: () => {}, danger: true },
          { key: 'rename', label: 'Rename…', onSelect: () => {} },
        ]}
      />,
    );
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="Session actions"');
    expect((html.match(/role="menuitem"/g) ?? []).length).toBe(2);
    expect(html).toContain('Stop session');
    expect(html).toContain('Rename…');
  });

  test('touch sizes rows to the 44px floor', () => {
    const html = renderToStaticMarkup(
      <ContextMenu open touch anchor={{ x: 0, y: 0 }} ariaLabel="Menu" onClose={() => {}} items={items([false])} />,
    );
    expect(html).toContain('min-h-[44px]');
  });

  test('a disabled item is rendered disabled', () => {
    const html = renderToStaticMarkup(
      <ContextMenu open anchor={{ x: 0, y: 0 }} ariaLabel="Menu" onClose={() => {}} items={items([true])} />,
    );
    expect(html).toContain('disabled');
  });
});
