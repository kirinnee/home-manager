import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SheetTabs, nextDetailsTab, sheetPanelId, sheetTabId, type SheetTabSpec } from './SheetTabs';
import { DETAILS_TAB_ORDER, type DetailsTab } from '../hooks/useDetailsTab';

const TABS: SheetTabSpec<DetailsTab>[] = [
  { key: 'identity', label: 'Identity' },
  { key: 'runtime', label: 'Runtime' },
  { key: 'progress', label: 'Progress' },
  { key: 'budget', label: 'Budget' },
];

describe('nextDetailsTab keyboard policy', () => {
  test('ArrowRight/Down and ArrowLeft/Up step with wrap', () => {
    expect(nextDetailsTab('ArrowRight', 'identity', DETAILS_TAB_ORDER)).toBe('runtime');
    expect(nextDetailsTab('ArrowDown', 'identity', DETAILS_TAB_ORDER)).toBe('runtime');
    expect(nextDetailsTab('ArrowRight', 'budget', DETAILS_TAB_ORDER)).toBe('identity');
    expect(nextDetailsTab('ArrowLeft', 'identity', DETAILS_TAB_ORDER)).toBe('budget');
    expect(nextDetailsTab('ArrowUp', 'runtime', DETAILS_TAB_ORDER)).toBe('identity');
  });

  test('Home/End jump to the ends and unknown keys yield null', () => {
    expect(nextDetailsTab('Home', 'budget', DETAILS_TAB_ORDER)).toBe('identity');
    expect(nextDetailsTab('End', 'identity', DETAILS_TAB_ORDER)).toBe('budget');
    expect(nextDetailsTab('Enter', 'identity', DETAILS_TAB_ORDER)).toBeNull();
    expect(nextDetailsTab('a', 'identity', DETAILS_TAB_ORDER)).toBeNull();
    expect(nextDetailsTab('ArrowRight', 'unknown', DETAILS_TAB_ORDER)).toBeNull();
  });
});

describe('SheetTabs markup', () => {
  test('renders roving-tabindex tabs with instance-scoped ids', () => {
    const html = renderToStaticMarkup(
      <SheetTabs sheetId="sheetX" tabs={TABS} current="runtime" order={DETAILS_TAB_ORDER} onChange={() => {}} />,
    );
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)?.length).toBe(4);

    // Exactly one tab is in the Tab cycle (tabIndex 0), the selected one.
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    const inCycle = buttons.filter(button => button.includes('tabindex="0"'));
    expect(inCycle.length).toBe(1);
    expect(inCycle[0]).toContain('aria-selected="true"');
    expect(inCycle[0]).toContain(`id="${sheetTabId('sheetX', 'runtime')}"`);
    expect(inCycle[0]).toContain(`aria-controls="${sheetPanelId('sheetX', 'runtime')}"`);

    // Every other tab is removed from the cycle.
    expect(buttons.filter(button => button.includes('tabindex="-1"')).length).toBe(3);
  });
});
