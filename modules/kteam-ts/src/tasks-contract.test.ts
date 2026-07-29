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

/** The settled v2 transport contract requires `ask` on every create. Shared
 *  exact fixture so every "valid create body" case in this file carries the
 *  same verbatim text + source, and cases testing some OTHER malformed field
 *  don't trip the (now-earlier) ask-required check instead. */
const TEST_ASK = { text: 'Build the file browser and diff', source: 'session:lead#21' };

const task = (over: Partial<TaskView> = {}): TaskView => ({
  v: TASK_SCHEMA_VERSION,
  id: 'F21',
  kind: 'feature',
  title: 'File browser + diff',
  description: '## Brief\nchanges-first',
  ask: { text: 'Build the file browser and diff', source: 'session:lead#21' },
  clarifications: [],
  workflow: 'quick',
  phase: 'build',
  dependsOn: [],
  files: [],
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
  blocked: false,
  blockedReason: null,
  blockedSince: null,
  blockedBy: [],
  ...over,
});

const summary = (over: Partial<TaskView> = {}): TaskSummary => {
  const { description, ask, clarifications, ...rest } = task(over);
  return {
    ...rest,
    descriptionChars: description.length,
    askChars: ask.text.length,
    askSource: ask.source,
    clarificationCount: clarifications.length,
  };
};

/** A pre-v2 record as it actually arrives at runtime: read off disk before the
 *  additive fields existed, so they are simply ABSENT (not null) even though
 *  `TaskView` now declares them required. This is what the on-disk parser must
 *  survive without throwing — a real record, not a hypothetical. */
const legacyTask = (over: Partial<TaskView> = {}): TaskView => {
  const built = task(over) as unknown as Record<string, unknown>;
  delete built['dependsOn'];
  delete built['files'];
  delete built['blockedBy'];
  delete built['clarifications'];
  delete built['workflow'];
  delete built['phase'];
  delete built['ask'];
  return built as unknown as TaskView;
};

describe('routes', () => {
  test('matches aggregate reads plus the four session task routes', () => {
    expect(matchTaskRoute('GET', '/v1/tasks')).toEqual({ kind: 'list' });
    expect(matchTaskRoute('GET', '/v1/tasks/')).toEqual({ kind: 'list' });
    expect(matchTaskRoute('POST', '/v1/tasks')).toEqual({ kind: 'create' });
    expect(matchTaskRoute('GET', '/v1/tasks/F21')).toEqual({ kind: 'detail', id: 'F21' });
    expect(matchTaskRoute('POST', '/v1/tasks/F21')).toEqual({ kind: 'action', id: 'F21' });
    expect(matchTaskRoute('GET', '/v1/sessions/ms-a/tasks')).toEqual({
      kind: 'session-list',
      sessionId: 'ms-a',
    });
    expect(matchTaskRoute('POST', '/v1/sessions/ms-a/tasks')).toEqual({
      kind: 'session-create',
      sessionId: 'ms-a',
    });
    expect(matchTaskRoute('GET', '/v1/sessions/ms-a/tasks/f21')).toEqual({
      kind: 'session-detail',
      sessionId: 'ms-a',
      id: 'F21',
    });
    expect(matchTaskRoute('POST', '/v1/sessions/ms-a/tasks/F21')).toEqual({
      kind: 'session-action',
      sessionId: 'ms-a',
      id: 'F21',
    });
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
    expect(isTaskPath('/v1/sessions/ms-a/tasks/F1')).toBe(true);
    expect(isTaskPath('/v1/tasksomething')).toBe(false);
  });

  test('the warden-scoped token may read tasks but not change them', () => {
    expect(taskWardenDenial('GET', '/v1/tasks')).toBeNull();
    expect(taskWardenDenial('GET', '/v1/tasks/F1')).toBeNull();
    expect(taskWardenDenial('POST', '/v1/tasks')).toBe('change tasks');
    expect(taskWardenDenial('POST', '/v1/tasks/F1')).toBe('change tasks');
    expect(taskWardenDenial('GET', '/v1/sessions/ms-a/tasks')).toBeNull();
    expect(taskWardenDenial('POST', '/v1/sessions/ms-a/tasks/F1')).toBe('change tasks');
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
  test('takes the fields the CLI sends without accepting provenance', () => {
    const input = parseTaskCreateBody({
      kind: 'bug',
      title: 'Questions never reach the UI',
      description: '## Symptom',
      ask: TEST_ASK,
      status: 'built',
      assignee: 'sasha',
      repo: '/repo',
      order: 3,
      links: { prs: ['https://x/1'], branch: 'fix/q', docs: ['~/b.md'] },
    });
    expect(input).toMatchObject({
      kind: 'bug',
      title: 'Questions never reach the UI',
      ask: TEST_ASK,
      status: 'built',
      assignee: 'sasha',
      order: 3,
      links: { prs: ['https://x/1'], branch: 'fix/q', docs: ['~/b.md'] },
    });
  });

  test('a body-supplied actor cannot forge history', () => {
    const input = parseTaskCreateBody({ kind: 'bug', title: 'x', ask: TEST_ASK, actor: 'somebody-else' });
    expect(input).not.toHaveProperty('actor');
  });

  test('reason and statusReason are interchangeable on the wire', () => {
    expect(parseTaskCreateBody({ kind: 'bug', title: 'x', ask: TEST_ASK, reason: 'needs key' }).statusReason).toBe(
      'needs key',
    );
    expect(
      parseTaskCreateBody({ kind: 'bug', title: 'x', ask: TEST_ASK, statusReason: 'needs key' }).statusReason,
    ).toBe('needs key');
  });

  test('structural problems are refused with a clear message', () => {
    expect(() => parseTaskCreateBody(null)).toThrow('expected a JSON object body');
    expect(() => parseTaskCreateBody([])).toThrow('expected a JSON object body');
    expect(() => parseTaskCreateBody({ title: 'x' })).toThrow('kind is required');
    expect(() => parseTaskCreateBody({ kind: 'bug' })).toThrow('title is required');
    expect(() => parseTaskCreateBody({ kind: 'bug', title: 'x', ask: TEST_ASK, order: 'high' })).toThrow(
      'order must be a number',
    );
    expect(() => parseTaskCreateBody({ kind: 'bug', title: 'x', ask: TEST_ASK, description: 5 })).toThrow(
      'must be a string',
    );
  });

  test('null assignee/repo/order pass through as explicit nulls', () => {
    expect(
      parseTaskCreateBody({ kind: 'bug', title: 'x', ask: TEST_ASK, assignee: null, repo: null, order: null }),
    ).toMatchObject({
      assignee: null,
      repo: null,
      order: null,
    });
  });

  test('ask carries the verbatim text and its source link, both required together', () => {
    expect(
      parseTaskCreateBody({
        kind: 'feature',
        title: 'x',
        ask: { text: 'Build the file browser', source: 'session:lead#21' },
      }).ask,
    ).toEqual({ text: 'Build the file browser', source: 'session:lead#21' });
    expect(() => parseTaskCreateBody({ kind: 'feature', title: 'x', ask: { text: 'no source' } })).toThrow(
      'ask requires verbatim text and a source message link',
    );
    expect(() => parseTaskCreateBody({ kind: 'feature', title: 'x', ask: { source: 'no text' } })).toThrow(
      'ask requires verbatim text and a source message link',
    );
  });

  test('ask is required on every create — its absence is refused, not defaulted', () => {
    expect(() => parseTaskCreateBody({ kind: 'feature', title: 'x' })).toThrow(
      'ask requires verbatim text and a source message link',
    );
  });

  test('direct API creation shares the five-word title rule and guidance', () => {
    expect(parseTaskCreateBody({ kind: 'feature', title: 'One two three four five', ask: TEST_ASK }).title).toBe(
      'One two three four five',
    );
    expect(() => parseTaskCreateBody({ kind: 'feature', title: 'One two three four five six', ask: TEST_ASK })).toThrow(
      /6 words.*description/,
    );
  });

  test('workflow picks the sub-workflow at creation and refuses an unknown one', () => {
    expect(
      parseTaskCreateBody({ kind: 'feature', title: 'x', ask: TEST_ASK, workflow: 'research-first' }).workflow,
    ).toBe('research-first');
    expect(() =>
      parseTaskCreateBody({ kind: 'feature', title: 'x', ask: TEST_ASK, workflow: 'skip-straight-to-live' }),
    ).toThrow('workflow must be one of');
  });

  test('dependsOn is an id array, refused when not an array', () => {
    expect(
      parseTaskCreateBody({ kind: 'feature', title: 'x', ask: TEST_ASK, dependsOn: ['F5', 'B2'] }).dependsOn,
    ).toEqual(['F5', 'B2']);
    expect(() => parseTaskCreateBody({ kind: 'feature', title: 'x', ask: TEST_ASK, dependsOn: 'F5' })).toThrow(
      'dependsOn must be an array',
    );
  });

  test('files is an advisory path array, passed through and refused when not an array', () => {
    expect(
      parseTaskCreateBody({ kind: 'feature', title: 'x', ask: TEST_ASK, files: ['src/a.ts', 'src/b.ts'] }).files,
    ).toEqual(['src/a.ts', 'src/b.ts']);
    // Absent files stays absent (the service applies the empty-set default).
    expect(parseTaskCreateBody({ kind: 'feature', title: 'x', ask: TEST_ASK }).files).toBeUndefined();
    expect(() => parseTaskCreateBody({ kind: 'feature', title: 'x', ask: TEST_ASK, files: 'src/a.ts' })).toThrow(
      'files must be an array',
    );
  });
});

describe('action body parsing', () => {
  test('status carries the reason and the note', () => {
    expect(
      parseTaskActionBody({ action: 'status', status: 'built', note: 'green', reason: 'x', actor: 'forged' }),
    ).toEqual({
      action: 'status',
      status: 'built',
      reason: 'x',
      note: 'green',
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

  test('phase requires a known phase and a reason — this is structural parsing only, not transition legality', () => {
    expect(parseTaskActionBody({ action: 'phase', phase: 'design', reason: 'human approved research' })).toEqual({
      action: 'phase',
      phase: 'design',
      reason: 'human approved research',
    });
    expect(() => parseTaskActionBody({ action: 'phase', phase: 'orbit', reason: 'x' })).toThrow('phase must be one of');
    expect(() => parseTaskActionBody({ action: 'phase', phase: 'build' })).toThrow('phase requires a reason');
  });

  test('clarify requires verbatim text and a source, same as ask', () => {
    expect(
      parseTaskActionBody({ action: 'clarify', text: 'actually also handle diffs', source: 'session:lead#30' }),
    ).toEqual({
      action: 'clarify',
      text: 'actually also handle diffs',
      source: 'session:lead#30',
    });
    expect(() => parseTaskActionBody({ action: 'clarify', text: 'no source' })).toThrow(
      'clarify requires verbatim text and a source message link',
    );
    expect(() => parseTaskActionBody({ action: 'clarify', source: 'no text' })).toThrow(
      'clarify requires verbatim text and a source message link',
    );
  });

  test('reopen requires the reason and verbatim sourced ask as one atomic action', () => {
    expect(
      parseTaskActionBody({
        action: 'reopen',
        reason: 'The deployed route is still broken.',
        ask: 'The browser still returns 404; fix it here.',
        source: 'session:lead#44',
      }),
    ).toEqual({
      action: 'reopen',
      reason: 'The deployed route is still broken.',
      ask: 'The browser still returns 404; fix it here.',
      source: 'session:lead#44',
    });
    expect(() => parseTaskActionBody({ action: 'reopen', reason: 'broken', source: 'session:lead#44' })).toThrow(
      'verbatim new ask',
    );
    expect(() => parseTaskActionBody({ action: 'reopen', ask: 'fix it', source: 'session:lead#44' })).toThrow(
      'requires a reason',
    );
  });

  test('dependency takes a task id (or its dependsOn alias) and an optional remove flag', () => {
    expect(parseTaskActionBody({ action: 'dependency', taskId: 'F5' })).toEqual({
      action: 'dependency',
      taskId: 'F5',
    });
    expect(parseTaskActionBody({ action: 'dependency', dependsOn: 'F6' })).toEqual({
      action: 'dependency',
      taskId: 'F6',
    });
    expect(parseTaskActionBody({ action: 'dependency', taskId: 'F5', remove: true })).toEqual({
      action: 'dependency',
      taskId: 'F5',
      remove: true,
    });
    expect(() => parseTaskActionBody({ action: 'dependency' })).toThrow('dependency requires a task id');
    expect(() => parseTaskActionBody({ action: 'dependency', taskId: 'F5', remove: 'yes' })).toThrow(
      'dependency remove must be a boolean',
    );
  });

  test('file claims a path with an optional remove flag and an optional reason (never required)', () => {
    expect(parseTaskActionBody({ action: 'file', path: 'src/api.ts' })).toEqual({
      action: 'file',
      path: 'src/api.ts',
    });
    expect(parseTaskActionBody({ action: 'file', path: 'src/api.ts', remove: true })).toEqual({
      action: 'file',
      path: 'src/api.ts',
      remove: true,
    });
    expect(parseTaskActionBody({ action: 'file', path: 'src/api.ts', reason: 'owns transport' })).toEqual({
      action: 'file',
      path: 'src/api.ts',
      reason: 'owns transport',
    });
    // Unlike phase/status, a file claim needs no reason — only a path.
    expect(() => parseTaskActionBody({ action: 'file' })).toThrow('file requires a path');
    expect(() => parseTaskActionBody({ action: 'file', path: 'src/api.ts', remove: 'yes' })).toThrow(
      'file remove must be a boolean',
    );
  });
});

describe('errors map to statuses a client can act on', () => {
  test.each([
    ['not-found', 404],
    ['too-long', 413],
    ['read-only', 403],
    ['forbidden', 403],
    ['ambiguous', 409],
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
      summary({
        id: 'B2',
        kind: 'bug',
        status: 'blocked',
        blocked: true,
        blockedReason: 'needs an API key from you',
      }),
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

  test('the board folds research and design into in progress while detail keeps their audit phases', () => {
    const md = renderTaskBoardMd([
      summary({ id: 'F1', status: 'researched', phase: 'research' }),
      summary({ id: 'F2', status: 'designed', phase: 'design' }),
      summary({ id: 'F3', status: 'in_progress', phase: 'build' }),
    ]);
    expect(md).toContain('🔵 IN PROGRESS (3)');
    expect(md).not.toContain('🟠 RESEARCHED');
    expect(md).not.toContain('🟣 DESIGNED');
    expect(renderTaskMd({ task: task({ status: 'researched', phase: 'research' }), activity: [] })).toContain(
      'phase: research',
    );
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
    expect(md).toContain('# #F21 · File browser + diff');
    expect(md).toContain('🔵 IN PROGRESS');
    expect(md).toContain(TASK_STALENESS_COPY['maybe-finished']);
    expect(md).toContain('declared status unchanged');
    expect(md).toContain('## Brief');
    expect(md).toContain('changes-first');
    expect(md).toContain('todo → in_progress');
    expect(md).toContain('PR https://github.com/o/r/pull/1');
  });

  test('the detail render shows workflow, dependencies and clarifications as human references (#F12)', () => {
    const md = renderTaskMd({
      task: task({
        dependsOn: ['F5', 'B2'],
        files: ['src/api-server.ts', 'src/tasks.ts'],
        clarifications: [
          { at: 't0', by: 'ms-lead', byName: 'zelda', text: 'also handle diffs', source: 'session:lead#30' },
        ],
      }),
      activity: [],
    });
    expect(md).toContain('workflow: quick');
    expect(md).toContain('depends on: #F5, #B2');
    expect(md).toContain('files (advisory): `src/api-server.ts`, `src/tasks.ts`');
    expect(md).toContain('## Clarifications');
    expect(md).toContain('also handle diffs — session:lead#30');
  });

  test('a blocked task shows since/reason/blocking ids, all as #-references', () => {
    const md = renderTaskMd({
      task: task({
        blocked: true,
        blockedSince: '2026-07-27T05:00:00.000Z',
        blockedReason: 'waiting on #F5',
        blockedBy: ['F5'],
      }),
      activity: [],
    });
    expect(md).toContain('🚧 blocked since 2026-07-27T05:00:00.000Z: waiting on #F5 (#F5)');
  });

  test('a legacy record missing every v2 addition renders instead of throwing', () => {
    const legacy = legacyTask({ status: 'researched', blocked: true, blockedReason: 'stuck', blockedSince: null });
    expect(() => renderTaskMd({ task: legacy, activity: [] })).not.toThrow();
    const md = renderTaskMd({ task: legacy, activity: [] });
    // Missing dependsOn/blockedBy render as an empty list, not a crash.
    expect(md).toContain('depends on: —');
    expect(md).toContain('🚧 blocked since unknown: stuck');
    expect(md).not.toContain('blocked since unknown: stuck (');
    // Missing workflow/phase fall back rather than printing "undefined".
    expect(md).toContain('workflow: quick');
    expect(md).toContain('phase: research'); // derived from status: 'researched'
    // Missing clarifications: section is omitted entirely, not an empty heading.
    expect(md).not.toContain('## Clarifications');
    // Missing ask: falls back to the brief/title, flagged as a legacy source.
    expect(md).toContain('## Original ask');
    expect(md).toContain('[Source message](legacy record (source unavailable))');
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
    expect(
      summariseActivity(
        entry('status', {
          from: 'live',
          to: 'in_progress',
          phaseFrom: 'live',
          phaseTo: 'build',
          reason: 'broken after deploy',
          backward: true,
          reopened: true,
        }),
      ),
    ).toBe('REOPENED live → build (broken after deploy)');
    expect(summariseActivity(entry('note', { text: 'hi' }))).toBe('hi');
    expect(summariseActivity(entry('feedback', { text: 'later' }))).toBe('later');
    expect(summariseActivity(entry('link', { field: 'pr', value: 'u' }))).toBe('pr = u');
    expect(summariseActivity(entry('assign', { from: null, to: 'ines' }))).toBe('— → ines');
    expect(summariseActivity(entry('order', { from: 1, to: 2 }))).toBe('1 → 2');
    expect(summariseActivity(entry('session', { session: 'ms-1', event: 'failed' }))).toBe('ms-1 failed');
    expect(summariseActivity(entry('clarification', { text: 'also handle diffs', source: 'session:lead#30' }))).toBe(
      'also handle diffs (session:lead#30)',
    );
    expect(summariseActivity(entry('dependency', { operation: 'add', taskId: 'F5' }))).toBe('add #F5');
    expect(summariseActivity(entry('dependency', { operation: 'remove', taskId: 'F6' }))).toBe('remove #F6');
    expect(summariseActivity(entry('file', { operation: 'add', path: 'src/api.ts' }))).toBe('add `src/api.ts`');
    expect(summariseActivity(entry('file', { operation: 'remove', path: 'src/api.ts' }))).toBe('remove `src/api.ts`');
    expect(summariseActivity(entry('file', { operation: 'add', path: 'src/api.ts', reason: 'owns it' }))).toBe(
      'add `src/api.ts` (owns it)',
    );
    // A malformed record still summarises rather than throwing.
    expect(summariseActivity(entry('note', {}))).toBe('');
  });
});
