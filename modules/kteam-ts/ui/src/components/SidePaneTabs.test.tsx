import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileCode2, FolderGit2, Globe2, ListTodo } from 'lucide-react';
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

/** A synthesized per-instance definition, exactly as `resolveSidePaneTab`
 *  shapes one: full path as the accessible label, basename as the strip name,
 *  the instance riding along. */
const FILE_API: SidePaneTabDefinition = {
  id: 'file:src/api.ts',
  label: 'src/api.ts',
  shortLabel: 'api.ts',
  closeLabel: 'Close api.ts',
  icon: FileCode2,
  order: 1001,
  instance: {
    id: 'file:src/api.ts',
    kind: 'file',
    key: 'src/api.ts',
    label: 'api.ts',
    title: 'src/api.ts',
    order: 1,
    revision: 1,
  },
};
/** The Browser catalogue entry spawns page instances instead of toggling. */
const NEW_PAGE: SidePaneTabDefinition = { ...BROWSER, instanceKind: 'browser' };

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

  test('the strip is one row tall: horizontal overflow only, never a vertical scrollbar', () => {
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('overflow-y-hidden');
  });

  test('an instance tab shows its short label, full-path hover title and a close affordance', () => {
    const withInstance = renderToStaticMarkup(
      <SidePaneTabs
        paneId="pane-a"
        presentation="pane"
        tabs={[...OPEN, FILE_API]}
        all={ALL}
        current="file:src/api.ts"
        onSelect={NOOP}
        onAdd={NOOP}
        onRemove={NOOP}
      />,
    );
    // The accessible name and hover title are the FULL path; the visible
    // strip text is the basename, capped so long names cannot blow up 390px.
    expect(withInstance).toContain('aria-label="src/api.ts"');
    expect(withInstance).toContain('title="src/api.ts"');
    expect(withInstance).toContain('>api.ts</span>');
    expect(withInstance).toContain('max-w-[148px]');
    // Closable independently: pointer ✕ plus the Delete-key shortcut.
    expect(withInstance).toContain('title="Close api.ts"');
    expect(withInstance).toContain('aria-keyshortcuts="Delete"');
    // Singleton tabs stay exactly as they were — no close affordance.
    expect(withInstance).not.toContain('title="Close Browser"');
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

  test('an instance-spawning entry is an action, not a toggle: it always adds a NEW tab', () => {
    const html = renderToStaticMarkup(
      <SidePaneTabPickerList all={[NEW_PAGE, FILES]} openIds={['files']} onAdd={NOOP} onRemove={NOOP} />,
    );
    expect(html).toContain('aria-label="New Browser tab"');
    expect(html).toContain('Opens a new tab');
    // No pressed state: the entry is never "in the strip" — its instances are.
    expect(html).not.toContain('aria-label="Remove Browser tab"');
    expect(html).not.toContain('aria-label="Add Browser tab"');
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

  test('instance tabs list with their label and per-tab close — never a strip', () => {
    const withInstance = renderToStaticMarkup(
      <SidePaneTabSwitcherList
        tabs={[FILES, FILE_API]}
        all={ALL}
        current="file:src/api.ts"
        onSelect={NOOP}
        onAdd={NOOP}
        onRemove={NOOP}
      />,
    );
    expect(withInstance).not.toContain('role="tablist"');
    expect(withInstance).toContain('title="src/api.ts"');
    expect(withInstance).toContain('aria-label="Close api.ts tab"');
    expect(withInstance.match(/aria-current="true"/g)?.length).toBe(1);
    // An instance-spawning catalogue entry stays offered even while its
    // instances are open — it always means "one more".
    const withCatalogue = renderToStaticMarkup(
      <SidePaneTabSwitcherList
        tabs={[FILES]}
        all={[NEW_PAGE, FILES]}
        current="files"
        onSelect={NOOP}
        onAdd={NOOP}
        onRemove={NOOP}
      />,
    );
    expect(withCatalogue).toContain('aria-label="New Browser tab"');
  });
});
