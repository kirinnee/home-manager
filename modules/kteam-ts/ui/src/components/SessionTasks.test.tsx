// Session tasks surface: the honest copy per degraded state, and the loading
// shell's structure. The live list/detail behaviour needs a DOM runner and the
// daemon's session routes; both are asserted in the browser matrix.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionTaskList, SessionTasksSurface, sessionTasksEmptyCopy } from './SessionTasks';
import { TASK_STATUSES, type TaskStatus, type TaskSummary } from '../lib/tasks';

describe('sessionTasksEmptyCopy', () => {
  test('version skew is named, not shown as an empty board', () => {
    expect(sessionTasksEmptyCopy('absent')).toContain('does not serve per-session tasks');
    expect(sessionTasksEmptyCopy('absent')).not.toContain('fleet-wide Tasks page');
  });
  test('an error carries the daemon message when there is one', () => {
    expect(sessionTasksEmptyCopy('error', 'HTTP 500')).toContain('HTTP 500');
    expect(sessionTasksEmptyCopy('error', null)).toBe("Couldn't load tasks.");
  });
  test('a real empty list tells the reader how records appear', () => {
    expect(sessionTasksEmptyCopy('empty')).toContain('kteam task create');
  });
});

const taskFor = (status: TaskStatus, index: number): TaskSummary => ({
  id: `F${index + 1}`,
  kind: 'feature',
  title: `Visible ${status}`,
  status,
  statusReason: status === 'blocked' || status === 'dropped' ? `${status} reason` : null,
  assignee: 'olivia',
  repo: '/repo',
  links: { prs: [], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: null,
  updatedAt: null,
  live: {
    assigneeStatus: 'running',
    assigneeHealth: 'active',
    assigneeDoneMarker: false,
    assigneeLastActivityAt: null,
    staleness: null,
  },
});

test('the session list shows every declared status once in canonical board order', () => {
  const html = renderToStaticMarkup(
    <SessionTaskList
      tasks={[...TASK_STATUSES].reverse().map((status, index) => taskFor(status, index))}
      onOpen={() => undefined}
    />,
  );
  const positions = TASK_STATUSES.map(status => {
    const marker = `data-task-status="${status}"`;
    expect(html).toContain(marker);
    expect(html).toContain(`Visible ${status}`);
    return html.indexOf(marker);
  });
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(html.match(/data-task-status=/g)).toHaveLength(TASK_STATUSES.length);
});

test('the surface opens in its loading state with a labelled refresh control', () => {
  const html = renderToStaticMarkup(<SessionTasksSurface sessionId="session-a" />);
  expect(html).toContain('Loading tasks…');
  expect(html).toContain('aria-label="Refresh tasks"');
  // No autofocus anywhere in this surface — the host contract forbids it.
  expect(html).not.toContain('autofocus');
});
