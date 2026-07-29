import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FolderGit2, Globe2, ListTodo } from 'lucide-react';
import type { SidePaneTabDefinition } from '../lib/side-pane-tab-model';
import {
  nextSidePaneTab,
  SidePaneTabPickerList,
  SidePaneTabs,
  SidePaneTabSwitcherList,
  sidePanePanelId,
  sidePaneTabId,
} from './SidePaneTabs';

const BROWSER: SidePaneTabDefinition = {
  id: 'browser',
  label: 'Browser',
  shortLabel: 'Web',
  closeLabel: 'Close browser',
  icon: Globe2,
  order: 10,
};
const FILES: SidePaneTabDefinition = {
  id: 'files',
  label: 'Files',
  shortLabel: 'Files',
  closeLabel: 'Close files',
  icon: FolderGit2,
  order: 20,
};
const TASKS: SidePaneTabDefinition = {
  id: 'tasks',
  label: 'Tasks',
  shortLabel: 'Tasks',
  closeLabel: 'Close tasks',
  icon: ListTodo,
  order: 30,
  unavailableReason: 'No task source yet.',
};

const OPEN = [BROWSER, FILES];
const ALL = [BROWSER, FILES, TASKS];
const ORDER = ['browser', 'files', 'tasks'] as const;
const NOOP = () => undefined;

describe('keyboard policy', () => {
  test('wraps arrow navigation and supports Home/End', () => {
    expect(nextSidePaneTab('ArrowRight', 'tasks', ORDER)).toBe('browser');
    expect(nextSidePaneTab('ArrowLeft', 'browser', ORDER)).toBe('tasks');
    expect(nextSidePaneTab('Home', 'tasks', ORDER)).toBe('browser');
    expect(nextSidePaneTab('End', 'browser', ORDER)).toBe('tasks');
    expect(nextSidePaneTab('Escape', 'browser', ORDER)).toBeNull();
  });
});

describe('desktop strip', () => {
  const html = renderToStaticMarkup(
    <SidePaneTabs
      paneId="pane-a"
      presentation="pane"
      tabs={OPEN}
      all={ALL}
      current="files"
      onSelect={NOOP}
      onAdd={NOOP}
      onRemove={NOOP}
    />,
  );

  test('renders real labelled tabs controlling stable panels without autofocus', () => {
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)?.length).toBe(2);
    expect(html).toContain('aria-label="Browser"');
    expect(html).toContain(`id="${sidePaneTabId('pane-a', 'files')}"`);
    expect(html).toContain(`aria-controls="${sidePanePanelId('pane-a', 'files')}"`);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('min-w-[56px]');
    expect(html).not.toContain('autofocus');
  });

  test('the strip shows only OPEN tabs and carries the + picker button', () => {
    // Tasks is registered but not open: no tab for it, only the picker offer.
    expect(html).not.toContain('aria-label="Tasks"');
    expect(html).toContain('aria-label="Add or remove tabs"');
    expect(html).toContain('aria-haspopup="dialog"');
    // The picker popover itself is closed until the + button is pressed.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Choose tabs');
  });
});

describe('tab picker list', () => {
  test('every registered tab is one honest toggle: pressed = in the strip', () => {
    const html = renderToStaticMarkup(
      <SidePaneTabPickerList all={ALL} openIds={['browser', 'files']} onAdd={NOOP} onRemove={NOOP} />,
    );
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(2);
    expect(html.match(/aria-pressed="false"/g)?.length).toBe(1);
    expect(html).toContain('aria-label="Remove Browser tab"');
    expect(html).toContain('aria-label="Add Tasks tab"');
    // Unavailable tabs stay choosable — their BODY is the honest placeholder —
    // but the picker says so up front.
    expect(html).toContain('Unavailable');
  });
});

describe('mobile presentation', () => {
  const html = renderToStaticMarkup(
    <SidePaneTabs
      paneId="pane-a"
      presentation="sheet"
      tabs={OPEN}
      all={ALL}
      current="files"
      onSelect={NOOP}
      onAdd={NOOP}
      onRemove={NOOP}
    />,
  );

  test('never renders a horizontal tab strip', () => {
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain('overflow-x-auto');
    expect(html).not.toContain('kt-sheet-tabs');
  });

  test('one 44px tab control names the active tab and advertises the modal', () => {
    expect(html).toContain('aria-label="Switch tab — Files is showing"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('min-h-[44px]');
    expect(html).not.toContain('autofocus');
  });
});

describe('mobile switcher modal content', () => {
  const html = renderToStaticMarkup(
    <SidePaneTabSwitcherList tabs={OPEN} all={ALL} current="files" onSelect={NOOP} onAdd={NOOP} onRemove={NOOP} />,
  );

  test('lists open tabs with the current one marked and per-tab removal', () => {
    expect(html).toContain('aria-label="Open tabs"');
    expect(html.match(/aria-current="true"/g)?.length).toBe(1);
    expect(html).toContain('aria-label="Remove Browser tab"');
    expect(html).toContain('aria-label="Remove Files tab"');
  });

  test('carries the add-a-tab half of the picker for tabs outside the strip', () => {
    expect(html).toContain('Add a tab');
    expect(html).toContain('aria-label="Add Tasks tab"');
    expect(html).not.toContain('aria-label="Add Browser tab"');
  });
});
