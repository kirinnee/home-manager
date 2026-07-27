import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskDetail, TaskRow, TasksPage } from './TasksPage';
import type { TaskSummary } from '../lib/tasks';

const task: TaskSummary = {
  id: 'B7',
  kind: 'bug',
  title: 'Questions reach UI',
  status: 'in_progress',
  statusReason: null,
  assignee: 'sasha',
  repo: '/repo',
  links: { prs: ['https://github.com/acme/kteam/pull/42'], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: null,
  updatedAt: null,
  live: {
    assigneeStatus: 'failed',
    assigneeHealth: 'dead',
    assigneeDoneMarker: false,
    assigneeLastActivityAt: null,
    staleness: 'assignee-dead',
  },
};

describe('TasksPage', () => {
  test('renders an unwired, read-only route shell', () => {
    const html = renderToStaticMarkup(<TasksPage />);
    expect(html).toContain('>Tasks</h1>');
    expect(html).toContain('Task API wiring is pending');
  });
  test('row exposes liveness mismatch as evidence without changing its declared status', () => {
    const html = renderToStaticMarkup(<TaskRow task={task} onOpen={() => undefined} />);
    expect(html).toContain('In progress');
    expect(html).toContain('Declared status remains in progress');
    expect(html).toContain('kteam#42');
  });
  test('detail separates feedback and status events', () => {
    const html = renderToStaticMarkup(
      <TaskDetail
        task={{ ...task, description: '## Brief\nKeep the task honest.', createdBy: 'lead' }}
        activity={[
          {
            v: 1,
            seq: 1,
            time: null,
            actor: 'lead',
            actorName: 'lead',
            type: 'status',
            data: { from: 'todo', to: 'in_progress' },
          },
          {
            v: 1,
            seq: 2,
            time: null,
            actor: 'user',
            actorName: 'user',
            type: 'feedback',
            data: { text: 'Show this first' },
          },
        ]}
      />,
    );
    expect(html).toContain('Brief');
    expect(html).toContain('Show this first');
  });
});
