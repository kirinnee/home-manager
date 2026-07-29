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

test('status chips wear their status tone: a dot at rest, the full tone treatment when selected', () => {
  const html = renderToStaticMarkup(
    <TaskStatusFilter
      counts={
        new Map([
          ['todo', 2],
          ['in_progress', 1],
        ])
      }
      selected={new Set(['in_progress'])}
      onSelect={() => undefined}
      onShowAll={() => undefined}
    />,
  );
  // Every status chip previews its rail colour with a tone dot (2 chips —
  // the selected status is already among the counted), and carries its tone.
  expect(html.match(/kt-task-tone-dot/g)).toHaveLength(2);
  expect(html).toContain('data-tone="pend"');
  expect(html).toContain('data-tone="warn"');
  // Only the selected chip takes the full tone treatment; the rest stay quiet.
  expect(html.match(/kt-task-chip-active/g)).toHaveLength(1);
  expect(html).toMatch(/data-tone="warn"[^>]*aria-pressed="true"/u);
  // The All chip keeps the accent vocabulary, not a status tone.
  const allButton = html.match(/<button[^>]*>All /u)?.[0] ?? '';
  expect(allButton).not.toContain('data-tone');
  expect(allButton).not.toContain('kt-task-chip-active');
});
