import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { nextSidePaneTab, SidePaneTabs, sidePanePanelId, sidePaneTabId } from './SidePaneTabs';

const ORDER = ['browser', 'files', 'tasks'] as const;

describe('side pane tabs', () => {
  test('wraps arrow navigation and supports Home/End', () => {
    expect(nextSidePaneTab('ArrowRight', 'tasks', ORDER)).toBe('browser');
    expect(nextSidePaneTab('ArrowLeft', 'browser', ORDER)).toBe('tasks');
    expect(nextSidePaneTab('Home', 'tasks', ORDER)).toBe('browser');
    expect(nextSidePaneTab('End', 'browser', ORDER)).toBe('tasks');
    expect(nextSidePaneTab('Escape', 'browser', ORDER)).toBeNull();
  });

  test('renders real labelled tabs controlling stable panels without autofocus', () => {
    const html = renderToStaticMarkup(
      <SidePaneTabs
        paneId="pane-a"
        current="files"
        onSelect={() => undefined}
        tabs={[
          { key: 'browser', label: 'Browser', shortLabel: 'Web', icon: <span>◎</span> },
          { key: 'files', label: 'Files', shortLabel: 'Files', icon: <span>◇</span> },
        ]}
      />,
    );
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)?.length).toBe(2);
    expect(html).toContain('aria-label="Browser"');
    expect(html).toContain(`id="${sidePaneTabId('pane-a', 'files')}"`);
    expect(html).toContain(`aria-controls="${sidePanePanelId('pane-a', 'files')}"`);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('min-h-[44px]');
    expect(html).not.toContain('autofocus');
  });
});
