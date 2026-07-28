import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskSummary } from '../lib/tasks';
import { TaskAssigneeLink, taskAssigneePresentation } from './TaskAssigneeLink';

const base: Pick<TaskSummary, 'assignee' | 'live'> = {
  assignee: 'ms4v5fu2-f2a89500',
  live: {
    assigneeStatus: 'tool_running',
    assigneeHealth: 'active',
    assigneeDoneMarker: false,
    assigneeLastActivityAt: null,
    staleness: null,
  },
};

describe('task assignee presentation', () => {
  test('shows the human teammate name as a link to the resolved session and keeps liveness', () => {
    const task = {
      ...base,
      live: { ...base.live, assigneeName: 'ottis', assigneeSessionId: 'ms4v5fu2-f2a89500' },
    } as Pick<TaskSummary, 'assignee' | 'live'>;
    const html = renderToStaticMarkup(<TaskAssigneeLink task={task} />);

    expect(html).toContain('href="/session/ms4v5fu2-f2a89500"');
    expect(html).toContain('aria-label="Open ottis&#x27;s session"');
    expect(html).toContain('>ottis</a>');
    expect(html).toContain('tool running');
    expect(html).toContain('bg-ok');
  });

  test('keeps the name visible when stale and leaves unresolved historical names honest', () => {
    const stale = {
      ...base,
      live: {
        ...base.live,
        assigneeName: 'ottis',
        assigneeSessionId: 'ms4v5fu2-f2a89500',
        staleness: 'assignee-dead',
      },
    } as Pick<TaskSummary, 'assignee' | 'live'>;
    expect(taskAssigneePresentation(stale).label).toBe('ottis · Assignee unavailable');

    const unresolved = taskAssigneePresentation({ ...base, assignee: 'legacy-agent' });
    expect(unresolved).toMatchObject({ name: 'legacy-agent', href: null, assigned: true });

    const unresolvedId = taskAssigneePresentation(base);
    expect(unresolvedId).toMatchObject({ name: 'ms4v5fu2-f2a89500', sessionId: null, href: null, assigned: true });
  });

  test('offers a compact dot-and-name form for task rows without nesting links in their open button', () => {
    const task = {
      ...base,
      live: { ...base.live, assigneeName: 'ottis', assigneeSessionId: 'ms4v5fu2-f2a89500' },
    } as Pick<TaskSummary, 'assignee' | 'live'>;
    const html = renderToStaticMarkup(<TaskAssigneeLink task={task} showStatus={false} />);
    expect(html).toContain('>ottis</a>');
    expect(html).not.toContain('<span aria-hidden="true">·</span>');
    expect(html).toContain('title="ottis · tool running');
    expect(html).toContain('bg-ok');
  });
});
