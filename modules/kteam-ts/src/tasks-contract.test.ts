import { describe, expect, test } from 'bun:test';
import {
  TASK_STALENESS_COPY,
  matchTaskRoute,
  isTaskPath,
  parseAfterSeq,
  parseTaskActionBody,
  parseTaskCreateBody,
  parseTaskListQuery,
  renderTaskBoardMd,
  renderTaskMd,
  summariseActivity,
  taskErrorBody,
  taskErrorStatus,
  taskWardenDenial,
} from './tasks-contract';
import {
  TASK_SCHEMA_VERSION,
  TaskError,
  type Task,
  type TaskActivity,
  type TaskSummary,
  type TaskView,
} from './tasks-types';

const query = (search: string) => new URLSearchParams(search);

const task = (over: Partial<Task> = {}): TaskView => ({
  v: TASK_SCHEMA_VERSION,
  id: 'F21',
  kind: 'feature',
  title: 'File browser + diff',
  description: '## Brief\nchanges-first',
  status: 'in_progress',
  statusReason: null,
  assignee: 'ines',
  repo: '/repo',
  links: { prs: ['https://github.com/o/r/pull/1'], branch: 'feat/x', commits: ['1cdc820'], docs: ['~/brief.md'] },
  order: 5,
  createdAt: '2026-07-26T12:00:00.000Z',
  createdBy: 'lead',
  updatedAt: '2026-07-27T04:55:00.000Z',
  live: {
    assigneeStatus: 'running',
    assigneeHealth: 'active',
    assigneeDoneMarker: false,
    assigneeLastActivityAt: '2026-07-27T04:00:00.000Z',
    staleness: null,
  },
  ...over,
});

const summary = (over: Partial<Task> = {}): TaskSummary => {
  const { description, ...rest } = task(over);
  return { ...rest, descriptionChars: description.length };
};

describe('routes', () => {
  test('matches the four task routes and nothing else', () => {
    expect(matchTaskRoute('GET', '/v1/tasks')).toEqual({ kind: 'list' });
    expect(matchTaskRoute('GET', '/v1/tasks/')).toEqual({ kind: 'list' });
    expect(matchTaskRoute('POST', '/v1/tasks')).toEqual({ kind: 'create' });
    expect(matchTaskRoute('GET', '/v1/tasks/F21')).toEqual({ kind: 'detail', id: 'F21' });
    expect(matchTaskRoute('POST', '/v1/tasks/F21')).toEqual({ kind: 'action', id: 'F21' });
    expect(matchTaskRoute('DELETE', '/v1/tasks/F21')).toBeNull();
    expect(matchTaskRoute('GET', '/v1/sessions')).toBeNull();
  });

  test('canonicalises the id and refuses anything that is not one', () => {
    expect(matchTaskRoute('GET', '/v1/tasks/f21')).toEqual({ kind: 'detail', id: 'F21' });
    expect(matchTaskRoute('GET', '/v1/tasks/..%2F..%2Fetc')).toBeNull();
    expect(matchTaskRoute('GET', '/v1/tasks/F21/extra')).toBeNull();
  });

  test('isTaskPath covers the route family for 404 handling', () => {
    expect(isTaskPath('/v1/tasks')).toBe(true);
    expect(isTaskPath('/v1/tasks/F1')).toBe(true);
    expect(isTaskPath('/v1/tasksomething')).toBe(false);
  });

  test('the warden-scoped token may read tasks but not change them', () => {
    expect(taskWardenDenial('GET', '/v1/tasks')).toBeNull();
    expect(taskWardenDenial('GET', '/v1/tasks/F1')).toBeNull();
    expect(taskWardenDenial('POST', '/v1/tasks')).toBe('change tasks');
    expect(taskWardenDenial('POST', '/v1/tasks/F1')).toBe('change tasks');
    expect(taskWardenDenial('POST', '/v1/sessions')).toBeNull(); // not ours to judge
  });
});

describe('list query parsing', () => {
  test('reads the board filters', () => {
    expect(parseTaskListQuery(query('repo=/a&assignee=ines&kind=bug'))).toEqual({
      repo: '/a',
      assignee: 'ines',
      kind: 'bug',
    });
  });

  test('status repeats or comma-separates, and de-duplicates', () => {
    expect(parseTaskListQuery(query('status=built&status=live,built')).status).toEqual(['built', 'live']);
  });

  test('an unknown status or kind is REFUSED, not silently ignored', () => {
    expect(() => parseTaskListQuery(query('status=shipped'))).toThrow('unknown status');
    expect(() => parseTaskListQuery(query('kind=epic'))).toThrow('unknown kind');
  });

  test('id filters are canonicalised and junk ids dropped', () => {
    expect(parseTaskListQuery(query('id=f1,B2&id=../x')).ids).toEqual(['F1', 'B2']);
  });

  test('empty values mean "no filter"', () => {
    expect(parseTaskListQuery(query('repo=&assignee=%20'))).toEqual({});
  });

  test('after= drives the incremental fetch and degrades on junk', () => {
    expect(parseAfterSeq(query('after=7'))).toBe(7);
    expect(parseAfterSeq(query('after=abc'))).toBe(0);
    expect(parseAfterSeq(query('after=-3'))).toBe(0);
    expect(parseAfterSeq(query(''))).toBe(0);
  });
});

describe('create body parsing', () => {
  test('takes the fields the CLI sends and stamps the caller-supplied actor', () => {
    const input = parseTaskCreateBody(
      {
        kind: 'bug',
        title: 'Questions never reach the UI',
        description: '## Symptom',
        status: 'built',
        assignee: 'sasha',
        repo: '/repo',
        order: 3,
        links: { prs: ['https://x/1'], branch: 'fix/q', docs: ['~/b.md'] },
      },
      { actor: 'ms-lead', actorName: 'zelda' },
    );
    expect(input).toMatchObject({
      kind: 'bug',
      title: 'Questions never reach the UI',
      status: 'built',
      assignee: 'sasha',
      order: 3,
      actor: 'ms-lead',
      actorName: 'zelda',
      links: { prs: ['https://x/1'], branch: 'fix/q', docs: ['~/b.md'] },
    });
  });

  test('a body-supplied actor cannot forge history', () => {
    const input = parseTaskCreateBody({ kind: 'bug', title: 'x', actor: 'somebody-else' }, { actor: 'ms-real' });
    expect(input.actor).toBe('ms-real');
  });

  test('reason and statusReason are interchangeable on the wire', () => {
    expect(parseTaskCreateBody({ kind: 'bug', title: 'x', reason: 'needs key' }).statusReason).toBe('needs key');
    expect(parseTaskCreateBody({ kind: 'bug', title: 'x', statusReason: 'needs key' }).statusReason).toBe('needs key');
  });

  test('structural problems are refused with a clear message', () => {
    expect(() => parseTaskCreateBody(null)).toThrow('expected a JSON object body');
    expect(() => parseTaskCreateBody([])).toThrow('expected a JSON object body');
    expect(() => parseTaskCreateBody({ title: 'x' })).toThrow('kind is required');
    expect(() => parseTaskCreateBody({ kind: 'bug' })).toThrow('title is required');
    expect(() => parseTaskCreateBody({ kind: 'bug', title: 'x', order: 'high' })).toThrow('order must be a number');
    expect(() => parseTaskCreateBody({ kind: 'bug', title: 'x', description: 5 })).toThrow('must be a string');
  });

  test('null assignee/repo/order pass through as explicit nulls', () => {
    expect(parseTaskCreateBody({ kind: 'bug', title: 'x', assignee: null, repo: null, order: null })).toMatchObject({
      assignee: null,
      repo: null,
      order: null,
    });
  });
});

describe('action body parsing', () => {
  test('status carries the reason and the note', () => {
    expect(
      parseTaskActionBody({ action: 'status', status: 'built', note: 'green', reason: 'x' }, { actor: 'a' }),
    ).toEqual({
      action: 'status',
      status: 'built',
      reason: 'x',
      note: 'green',
      actor: 'a',
    });
  });

  test('note and feedback require text', () => {
    expect(parseTaskActionBody({ action: 'note', text: 'hi' })).toEqual({ action: 'note', text: 'hi' });
    expect(parseTaskActionBody({ action: 'feedback', text: 'hi' })).toEqual({ action: 'feedback', text: 'hi' });
    expect(() => parseTaskActionBody({ action: 'note' })).toThrow('requires text');
  });

  test('link needs a known field and a value', () => {
    expect(parseTaskActionBody({ action: 'link', field: 'pr', value: 'https://x/1' })).toEqual({
      action: 'link',
      field: 'pr',
      value: 'https://x/1',
    });
    expect(() => parseTaskActionBody({ action: 'link', field: 'wiki', value: 'x' })).toThrow(
      'link field must be one of',
    );
    expect(() => parseTaskActionBody({ action: 'link', field: 'pr' })).toThrow('requires a value');
  });

  test('assign and order accept an explicit null to clear', () => {
    expect(parseTaskActionBody({ action: 'assign', assignee: null })).toEqual({ action: 'assign', assignee: null });
    expect(parseTaskActionBody({ action: 'order', order: null })).toEqual({ action: 'order', order: null });
    expect(() => parseTaskActionBody({ action: 'assign', assignee: 7 })).toThrow('must be a string');
    expect(() => parseTaskActionBody({ action: 'order', order: 'high' })).toThrow('must be a number');
  });

  test('an unknown action is refused and lists the real ones', () => {
    expect(() => parseTaskActionBody({ action: 'promote' })).toThrow('action is required, one of');
    expect(() => parseTaskActionBody({})).toThrow('action is required');
  });
});

describe('errors map to statuses a client can act on', () => {
  test.each([
    ['not-found', 404],
    ['too-long', 413],
    ['read-only', 403],
    ['invalid', 400],
    ['reason-required', 400],
  ] as const)('%s → %s', (code, status) => {
    expect(taskErrorStatus(code)).toBe(status);
  });

  test('the body carries the message verbatim plus the machine code', () => {
    expect(taskErrorBody(new TaskError('reason-required', 'status "blocked" requires a reason (--reason)'))).toEqual({
      error: 'status "blocked" requires a reason (--reason)',
      code: 'reason-required',
    });
  });
});

describe('markdown renders (a VIEW, never storage)', () => {
  test('the board leads with what the user has to act on', () => {
    const md = renderTaskBoardMd([
      summary({ id: 'F1', status: 'live' }),
      summary({ id: 'B2', kind: 'bug', status: 'blocked', statusReason: 'needs an API key from you' }),
      summary({ id: 'F3', status: 'in_progress' }),
    ]);
    const blockedAt = md.indexOf('What I need from you');
    expect(blockedAt).toBeGreaterThan(-1);
    expect(blockedAt).toBeLessThan(md.indexOf('🟢 LIVE'));
    expect(md).toContain('needs an API key from you');
    // The blocked row is not repeated in a second section.
    expect(md.match(/B2/g)).toHaveLength(1);
  });

  test('a staleness flag is visible in the table, and never rewrites the status', () => {
    const md = renderTaskBoardMd([
      summary({ id: 'F1', status: 'in_progress' }),
      { ...summary({ id: 'F2', status: 'in_progress' }), live: { ...task().live, staleness: 'assignee-dead' } },
    ]);
    expect(md).toContain('⚠️ assignee-dead');
    expect(md).toContain('🔵 IN PROGRESS (2)');
  });

  test('pipes in a title cannot break the table', () => {
    expect(renderTaskBoardMd([summary({ title: 'a | b' })])).toContain('a \\| b');
  });

  test('an empty board says so instead of rendering nothing', () => {
    expect(renderTaskBoardMd([])).toContain('_No tasks._');
  });

  test('the detail render shows declared status, derived warning, brief and history', () => {
    const md = renderTaskMd({
      task: { ...task(), live: { ...task().live, staleness: 'maybe-finished' } },
      activity: [
        { v: 1, seq: 1, time: 't1', actor: 'ms-lead', actorName: 'zelda', type: 'created', data: { status: 'todo' } },
        {
          v: 1,
          seq: 2,
          time: 't2',
          actor: 'ms-ines',
          actorName: 'ines',
          type: 'status',
          data: { from: 'todo', to: 'in_progress', note: 'started' },
        },
      ],
    });
    expect(md).toContain('# F21 · File browser + diff');
    expect(md).toContain('🔵 IN PROGRESS');
    expect(md).toContain(TASK_STALENESS_COPY['maybe-finished']);
    expect(md).toContain('declared status unchanged');
    expect(md).toContain('## Brief');
    expect(md).toContain('changes-first');
    expect(md).toContain('todo → in_progress');
    expect(md).toContain('PR https://github.com/o/r/pull/1');
  });

  test('a task with no brief and no history says so plainly', () => {
    const md = renderTaskMd({ task: task({ description: '   ' }), activity: [] });
    expect(md).toContain('_No description._');
    expect(md).toContain('_No activity._');
  });

  test('every activity type has a one-line summary', () => {
    const entry = (type: TaskActivity['type'], data: Record<string, unknown>): TaskActivity => ({
      v: 1,
      seq: 1,
      time: 't',
      actor: 'a',
      actorName: null,
      type,
      data,
    });
    expect(summariseActivity(entry('created', { status: 'todo' }))).toBe('as todo');
    expect(summariseActivity(entry('status', { from: 'todo', to: 'built', reason: 'r' }))).toContain('todo → built');
    expect(summariseActivity(entry('note', { text: 'hi' }))).toBe('hi');
    expect(summariseActivity(entry('feedback', { text: 'later' }))).toBe('later');
    expect(summariseActivity(entry('link', { field: 'pr', value: 'u' }))).toBe('pr = u');
    expect(summariseActivity(entry('assign', { from: null, to: 'ines' }))).toBe('— → ines');
    expect(summariseActivity(entry('order', { from: 1, to: 2 }))).toBe('1 → 2');
    expect(summariseActivity(entry('session', { session: 'ms-1', event: 'failed' }))).toBe('ms-1 failed');
    // A malformed record still summarises rather than throwing.
    expect(summariseActivity(entry('note', {}))).toBe('');
  });
});
