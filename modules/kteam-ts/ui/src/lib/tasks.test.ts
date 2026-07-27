import { describe, expect, test } from 'bun:test';
import {
  filterTasks,
  groupTasks,
  parseTaskActivity,
  parseTaskList,
  parseTaskListResponse,
  parseTaskRecord,
  TASK_STALENESS_COPY,
} from './tasks';

const raw = {
  id: 'F21',
  title: 'Tasks',
  status: 'in_progress',
  assignee: 'ines',
  repo: '/repo',
  links: { prs: ['https://github.com/a/b/pull/7'] },
  live: { assigneeStatus: 'failed', staleness: 'assignee-dead' },
};

describe('task UI parsing', () => {
  test('keeps valid summaries while dropping malformed and duplicate records', () => {
    expect(
      parseTaskList([raw, { id: 'F21', title: 'duplicate', status: 'todo' }, { id: 'x', title: '', status: 'todo' }]),
    ).toHaveLength(1);
  });
  test('parses optional fields defensively and never requires a description on summary data', () => {
    expect(parseTaskRecord({ ...raw, description: 3 })?.description).toBe('');
    expect(parseTaskRecord({ ...raw, status: 'guessing' })).toBeNull();
  });
  test('only accepts known activity event types', () => {
    expect(parseTaskActivity({ seq: 1, type: 'feedback', data: { text: 'keep it' } })?.type).toBe('feedback');
    expect(parseTaskActivity({ seq: 2, type: 'order', data: { from: null, to: 3 } })?.type).toBe('order');
    expect(parseTaskActivity({ seq: 1.5, type: 'feedback' })).toBeNull();
    expect(parseTaskActivity({ seq: 1, type: 'surprise' })).toBeNull();
  });
  test('preserves the daemon parse-error count without trusting malformed counts', () => {
    expect(parseTaskListResponse({ tasks: [raw], parseErrors: 2 })).toMatchObject({ parseErrors: 2 });
    expect(parseTaskListResponse({ tasks: [raw], parseErrors: -1 }).parseErrors).toBe(0);
  });
});

describe('task board grouping', () => {
  test('uses declared-status order and filters without deriving status from liveness', () => {
    const tasks = parseTaskList([
      raw,
      { id: 'B1', title: 'Ready', status: 'live', repo: '/repo' },
      { id: 'F2', title: 'Other', status: 'todo', repo: '/other' },
    ]);
    const filtered = filterTasks(tasks, { repo: '/repo', status: 'all', assignee: 'all' });
    expect(groupTasks(filtered).map(g => g.status)).toEqual(['live', 'in_progress']);
    expect(TASK_STALENESS_COPY['assignee-dead'].reason).toContain('Declared status remains');
  });
});
