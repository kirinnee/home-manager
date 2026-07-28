import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskStatusFilter } from './TaskStatusFilter';

test('task status filter reuses All-first exact multi-select controls with phone-sized targets', () => {
  const html = renderToStaticMarkup(
    <TaskStatusFilter
      counts={
        new Map([
          ['todo', 2],
          ['in_progress', 1],
        ])
      }
      selected={new Set(['in_progress', 'blocked'])}
      onSelect={() => undefined}
      onShowAll={() => undefined}
    />,
  );

  expect(html).toContain('aria-label="Filter tasks by status"');
  expect(html).toContain('>All <span');
  expect(html).toContain('aria-label="To do, 2 tasks"');
  expect(html).toContain('aria-label="In progress, 1 task"');
  expect(html).toContain('aria-label="Blocked, 0 tasks"');
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
  expect(html.match(/min-h-\[44px\]/g)).toHaveLength(4);
  expect(html).toContain('overflow-x-auto');
});
