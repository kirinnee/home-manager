import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import {
  TASK_CLI_USAGE,
  parseTaskCli,
  renderTaskCli,
  renderTaskDagText,
  renderTaskKanbanText,
  renderTaskListText,
  renderTaskShowText,
  splitTaskArgs,
  taskCliRequest,
  type TaskCliCommand,
} from './tasks-cli';
import { TASK_SCHEMA_VERSION, TaskError, type Task, type TaskSummary, type TaskView } from './tasks-types';

const SELF = 'ms-self-1';

const view = (over: Partial<TaskView> = {}): TaskView => ({
  v: TASK_SCHEMA_VERSION,
  id: 'F21',
  kind: 'feature',
  title: 'File browser',
  description: '## Brief\nchanges-first',
  ask: { text: 'Build the file browser', source: 'session:lead#21' },
  clarifications: [],
  workflow: 'quick',
  phase: 'build',
  dependsOn: [],
  files: [],
  status: 'in_progress',
  statusReason: null,
  assignee: 'ines',
  repo: '/repo',
  links: { prs: ['https://github.com/o/r/pull/1'], branch: 'feat/x', commits: [], docs: [] },
  order: null,
  createdAt: '2026-07-26T12:00:00.000Z',
  createdBy: 'lead',
  updatedAt: '2026-07-27T04:00:00.000Z',
  live: {
    assigneeStatus: 'running',
    assigneeHealth: 'active',
    assigneeDoneMarker: false,
    assigneeLastActivityAt: '2026-07-27T03:00:00.000Z',
    staleness: null,
  },
  blocked: false,
  blockedReason: null,
  blockedSince: null,
  blockedBy: [],
  ...over,
});

const summary = (over: Partial<TaskView> = {}): TaskSummary => {
  const { description, ask, clarifications, ...rest } = view(over);
  return {
    ...rest,
    descriptionChars: description.length,
    askChars: ask.text.length,
    askSource: ask.source,
    clarificationCount: clarifications.length,
  };
};

describe('argv splitting', () => {
  test('Commander preserves task-specific flags in the variadic argv', async () => {
    let captured: string[] = [];
    const program = new Command();
    program.exitOverride();
    program
      .command('task')
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .argument('[args...]')
      .action((argv: string[]) => {
        captured = argv;
      });
    await program.parseAsync(['node', 'kteam', 'task', 'list', '--repo', '/tmp/repo', '--md']);
    expect(captured).toEqual(['list', '--repo', '/tmp/repo', '--md']);
  });

  test('handles `--flag value`, `--flag=value`, bare flags and repeats', () => {
    const { positional, flags } = splitTaskArgs([
      'show',
      'F1',
      '--after',
      '3',
      '--md',
      '--status=built',
      '--status',
      'live',
    ]);
    expect(positional).toEqual(['show', 'F1']);
    expect(flags.get('after')).toEqual(['3']);
    expect(flags.get('md')).toEqual(['']);
    expect(flags.get('status')).toEqual(['built', 'live']);
  });

  test('a flag followed by another flag does not swallow it', () => {
    const { flags } = splitTaskArgs(['list', '--md', '--repo', '/a']);
    expect(flags.get('md')).toEqual(['']);
    expect(flags.get('repo')).toEqual(['/a']);
  });
});

describe('create', () => {
  test('builds the POST body', () => {
    const command = parseTaskCli([
      'create',
      '--kind',
      'feature',
      '--title',
      'File browser',
      '--ask',
      'Build the file browser',
      '--ask-source',
      'session:lead#21',
      '--description',
      'the brief',
      '--repo',
      '/repo',
      '--assignee',
      'ines',
      '--order',
      '3',
      '--pr',
      'https://x/1',
      '--pr',
      'https://x/2',
      '--branch',
      'feat/x',
      '--commit',
      'abc',
      '--doc',
      '~/b.md',
    ]);
    expect(command).toEqual({
      command: 'create',
      body: {
        kind: 'feature',
        title: 'File browser',
        description: 'the brief',
        ask: { text: 'Build the file browser', source: 'session:lead#21' },
        workflow: 'quick',
        repo: '/repo',
        assignee: 'ines',
        order: 3,
        links: { prs: ['https://x/1', 'https://x/2'], commits: ['abc'], docs: ['~/b.md'], branch: 'feat/x' },
      },
    });
    expect(taskCliRequest(command, SELF)).toEqual({
      method: 'POST',
      path: '/v1/sessions/ms-self-1/tasks',
      body: (command as { body: unknown }).body,
    });
  });

  test('repeated --file collects advisory claims onto the body', () => {
    const command = parseTaskCli([
      'create',
      '--kind',
      'feature',
      '--title',
      'File browser',
      '--ask',
      'Build it',
      '--ask-source',
      'session:lead#21',
      '--file',
      '  src/a.ts  ',
      '--file',
      'src/b.ts',
      '--file',
      '   ',
    ]);
    // Blanks are dropped and paths trimmed at the CLI edge; dedupe/normalize is the service's job.
    expect((command as { body: { files?: string[] } }).body.files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('a create with no --file omits files entirely (additive, not []) ', () => {
    const command = parseTaskCli(['create', '--kind', 'bug', '--title', 'x', '--ask', 'y', '--ask-source', 's']);
    expect((command as { body: Record<string, unknown> }).body).not.toHaveProperty('files');
  });

  test('--description-file is returned as a PATH for the wiring to read', () => {
    const command = parseTaskCli([
      'create',
      '--kind',
      'bug',
      '--title',
      'x',
      '--ask',
      'fix',
      '--ask-source',
      's',
      '--description-file',
      'brief.md',
    ]);
    expect(command).toMatchObject({ command: 'create', descriptionFile: 'brief.md' });
    expect((command as { body: { description?: string } }).body.description).toBeUndefined();
  });

  test('--description and --description-file together are refused', () => {
    expect(() =>
      parseTaskCli([
        'create',
        '--kind',
        'bug',
        '--title',
        'x',
        '--ask',
        'fix',
        '--ask-source',
        's',
        '--description',
        'a',
        '--description-file',
        'b',
      ]),
    ).toThrow('not both');
  });

  test('a bare positional title works too', () => {
    expect(
      parseTaskCli([
        'create',
        '--kind',
        'bug',
        '--ask',
        'fix',
        '--ask-source',
        's',
        'Questions',
        'never',
        'reach',
        'the',
        'UI',
      ]),
    ).toMatchObject({
      body: { title: 'Questions never reach the UI' },
    });
  });

  test('creating straight into blocked needs --reason, locally', () => {
    expect(() =>
      parseTaskCli([
        'create',
        '--kind',
        'bug',
        '--title',
        'x',
        '--ask',
        'fix',
        '--ask-source',
        's',
        '--status',
        'blocked',
      ]),
    ).toThrow('requires --reason');
    expect(
      parseTaskCli([
        'create',
        '--kind',
        'bug',
        '--title',
        'x',
        '--ask',
        'fix',
        '--ask-source',
        's',
        '--status',
        'blocked',
        '--reason',
        'needs a key',
      ]),
    ).toMatchObject({ body: { status: 'blocked', statusReason: 'needs a key' } });
  });

  test('create without --ask or --ask-source is refused', () => {
    expect(() => parseTaskCli(['create', '--kind', 'feature', '--title', 'x'])).toThrow('--ask');
    expect(() => parseTaskCli(['create', '--kind', 'feature', '--title', 'x', '--ask', 'fix'])).toThrow('--ask-source');
    expect(() =>
      parseTaskCli(['create', '--kind', 'feature', '--title', 'x', '--ask', 'fix', '--ask-source', '']),
    ).toThrow('--ask-source');
  });

  test('--workflow defaults to quick and accepts all four variants', () => {
    expect(
      parseTaskCli(['create', '--kind', 'bug', '--title', 'x', '--ask', 'fix', '--ask-source', 's']),
    ).toMatchObject({ body: { workflow: 'quick' } });
    expect(
      parseTaskCli([
        'create',
        '--kind',
        'feature',
        '--title',
        'x',
        '--ask',
        'fix',
        '--ask-source',
        's',
        '--workflow',
        'design-first',
      ]),
    ).toMatchObject({ body: { workflow: 'design-first' } });
    expect(
      parseTaskCli([
        'create',
        '--kind',
        'infra',
        '--title',
        'x',
        '--ask',
        'fix',
        '--ask-source',
        's',
        '--workflow',
        'research-first',
      ]),
    ).toMatchObject({ body: { workflow: 'research-first' } });
    expect(
      parseTaskCli([
        'create',
        '--kind',
        'chore',
        '--title',
        'x',
        '--ask',
        'fix',
        '--ask-source',
        's',
        '--workflow',
        'investigate',
      ]),
    ).toMatchObject({ body: { workflow: 'investigate' } });
    expect(() =>
      parseTaskCli([
        'create',
        '--kind',
        'bug',
        '--title',
        'x',
        '--ask',
        'fix',
        '--ask-source',
        's',
        '--workflow',
        'unknown',
      ]),
    ).toThrow('--workflow must be one of');
  });

  test('--depends-on collects multiple dependency ids', () => {
    const command = parseTaskCli([
      'create',
      '--kind',
      'feature',
      '--title',
      'x',
      '--ask',
      'fix',
      '--ask-source',
      's',
      '--depends-on',
      'F12',
      '--depends-on',
      'b7',
    ]);
    expect(command).toMatchObject({ body: { dependsOn: ['F12', 'B7'] } });
  });

  test('a bad or missing kind/title is refused with the usage block attached', () => {
    const attempt = () => parseTaskCli(['create', '--kind', 'epic', '--title', 'x']);
    expect(attempt).toThrow(TaskError);
    expect(attempt).toThrow('--kind must be one of');
    expect(attempt).toThrow('kteam task <command>');
    expect(() => parseTaskCli(['create', '--kind', 'bug'])).toThrow('--title is required');
  });

  test('creation accepts five title words and sends longer detail to the description', () => {
    expect(
      parseTaskCli([
        'create',
        '--kind',
        'feature',
        '--title',
        'One two three four five',
        '--ask',
        'ship it',
        '--ask-source',
        'message:1',
      ]),
    ).toMatchObject({ body: { title: 'One two three four five' } });
    expect(() =>
      parseTaskCli([
        'create',
        '--kind',
        'feature',
        '--title',
        'One two three four five six',
        '--ask',
        'ship it',
        '--ask-source',
        'message:1',
      ]),
    ).toThrow(/6 words.*description/);
  });
});

describe('list', () => {
  test('builds the query string, repeating status', () => {
    const command = parseTaskCli([
      'list',
      '--repo',
      '/a',
      '--status',
      'built',
      '--status',
      'live',
      '--assignee',
      'ines',
      '--kind',
      'bug',
    ]);
    expect(taskCliRequest(command, SELF).path).toBe(
      '/v1/sessions/ms-self-1/tasks?repo=%2Fa&assignee=ines&kind=bug&status=built&status=live',
    );
    expect(command).toMatchObject({ md: false });
  });

  test('a bare list has no query at all', () => {
    expect(taskCliRequest(parseTaskCli(['list']), SELF)).toEqual({
      method: 'GET',
      path: '/v1/sessions/ms-self-1/tasks',
    });
    expect(taskCliRequest(parseTaskCli(['list', '--all']))).toEqual({ method: 'GET', path: '/v1/tasks' });
  });

  test('--md is carried on the command, so rendering decides, not the daemon', () => {
    expect(parseTaskCli(['list', '--md'])).toMatchObject({ md: true });
  });

  test('an unknown status or kind filter is refused before the round trip', () => {
    expect(() => parseTaskCli(['list', '--status', 'shipped'])).toThrow('status must be one of');
    expect(() => parseTaskCli(['list', '--kind', 'epic'])).toThrow('--kind must be one of');
  });

  test('--view kanban and --view dag select the right view', () => {
    expect(parseTaskCli(['list', '--view', 'kanban'])).toMatchObject({ view: 'kanban' });
    expect(parseTaskCli(['list', '--view', 'dag'])).toMatchObject({ view: 'dag' });
    expect(parseTaskCli(['list', '--kanban'])).toMatchObject({ view: 'kanban' });
    expect(parseTaskCli(['list', '--dag'])).toMatchObject({ view: 'dag' });
    expect(parseTaskCli(['list'])).toMatchObject({ view: 'list' });
    expect(() => parseTaskCli(['list', '--view', 'calendar'])).toThrow('must be list, kanban, or dag');
  });

  test('--all and --session are mutually exclusive', () => {
    expect(() => parseTaskCli(['list', '--all', '--session', 'ms-x'])).toThrow('not both');
  });

  test('--all is only valid with list', () => {
    expect(() => parseTaskCli(['show', 'F21', '--all'])).toThrow('--all is only valid with task list');
  });
});

describe('show', () => {
  test('canonicalises the id and passes ?after=', () => {
    expect(taskCliRequest(parseTaskCli(['show', 'f21', '--after', '4']), SELF)).toEqual({
      method: 'GET',
      path: '/v1/sessions/ms-self-1/tasks/F21?after=4',
    });
    expect(taskCliRequest(parseTaskCli(['show', 'F21']), SELF)).toEqual({
      method: 'GET',
      path: '/v1/sessions/ms-self-1/tasks/F21',
    });
  });

  test('a junk id is refused before any request', () => {
    expect(() => parseTaskCli(['show', 'nonsense'])).toThrow('expected a task id');
    expect(() => parseTaskCli(['show'])).toThrow('expected a task id');
  });
});

describe('task actions', () => {
  test('status', () => {
    const command = parseTaskCli(['status', 'F21', 'built', '--reason', '590 tests green', '--note', 'all passed']);
    expect(command).toEqual({
      command: 'act',
      id: 'F21',
      body: { action: 'status', status: 'built', reason: '590 tests green', note: 'all passed' },
    });
    expect(taskCliRequest(command, SELF)).toEqual({
      method: 'POST',
      path: '/v1/sessions/ms-self-1/tasks/F21',
      body: (command as { body: unknown }).body,
    });
  });

  test('status refuses blocked/dropped with no --reason, locally, with the reason named', () => {
    expect(() => parseTaskCli(['status', 'F21', 'blocked'])).toThrow('requires --reason');
    expect(() => parseTaskCli(['status', 'F21', 'dropped'])).toThrow('requires --reason');
    expect(parseTaskCli(['status', 'F21', 'dropped', '--reason', 'not possible: no API'])).toMatchObject({
      body: { action: 'status', status: 'dropped', reason: 'not possible: no API' },
    });
  });

  test('an unknown status is refused', () => {
    expect(() => parseTaskCli(['status', 'F21', 'shipped'])).toThrow('status must be one of');
  });

  test('phase requires --reason and rejects bad phase', () => {
    expect(parseTaskCli(['phase', 'F21', 'build', '--reason', 'starting implementation'])).toEqual({
      command: 'act',
      id: 'F21',
      body: { action: 'phase', phase: 'build', reason: 'starting implementation' },
    });
    expect(() => parseTaskCli(['phase', 'F21', 'build'])).toThrow('--reason');
    expect(() => parseTaskCli(['phase', 'F21', 'invalid'])).toThrow('phase must be one of');
    expect(() => parseTaskCli(['phase', 'F21', 'todo', '--reason', ''])).toThrow('--reason');
  });

  test('note and feedback join their words', () => {
    expect(parseTaskCli(['note', 'F21', 'fs', 'API', 'needs', 'a', 'guard'])).toEqual({
      command: 'act',
      id: 'F21',
      body: { action: 'note', text: 'fs API needs a guard' },
    });
    expect(parseTaskCli(['feedback', 'F21', 'default to changes-only'])).toMatchObject({
      body: { action: 'feedback', text: 'default to changes-only' },
    });
    expect(() => parseTaskCli(['note', 'F21'])).toThrow('needs some text');
  });

  test('clarify requires verbatim text and --source', () => {
    expect(parseTaskCli(['clarify', 'F21', 'use', 'SSE', 'not', 'polling', '--source', 'session:lead#33'])).toEqual({
      command: 'act',
      id: 'F21',
      body: { action: 'clarify', text: 'use SSE not polling', source: 'session:lead#33' },
    });
    expect(() => parseTaskCli(['clarify', 'F21', 'text'])).toThrow('--source');
    expect(() => parseTaskCli(['clarify', 'F21', '--source', 's'])).toThrow('verbatim');
  });

  test('depend adds and removes a dependency', () => {
    expect(parseTaskCli(['depend', 'F21', 'B7'])).toEqual({
      command: 'act',
      id: 'F21',
      body: { action: 'dependency', taskId: 'B7' },
    });
    expect(parseTaskCli(['depend', 'F21', 'B7', '--remove'])).toEqual({
      command: 'act',
      id: 'F21',
      body: { action: 'dependency', taskId: 'B7', remove: true },
    });
    const lowercase = parseTaskCli(['depend', 'F21', 'f12']);
    expect((lowercase as { body: { taskId: string } }).body.taskId).toBe('F12');
  });

  test('file claims a path, removes with --remove, and keeps --reason optional', () => {
    expect(parseTaskCli(['file', 'F21', 'src/api.ts'])).toEqual({
      command: 'act',
      id: 'F21',
      body: { action: 'file', path: 'src/api.ts' },
    });
    expect(parseTaskCli(['file', 'F21', 'src/api.ts', '--remove'])).toEqual({
      command: 'act',
      id: 'F21',
      body: { action: 'file', path: 'src/api.ts', remove: true },
    });
    expect(parseTaskCli(['file', 'F21', 'src/api.ts', '--reason', 'owns transport'])).toMatchObject({
      body: { action: 'file', path: 'src/api.ts', reason: 'owns transport' },
    });
    // No --reason required (unlike status/phase), and a missing path is refused.
    expect(() => parseTaskCli(['file', 'F21'])).toThrow('needs a path');
    expect(() => parseTaskCli(['file', 'F21', '   '])).toThrow('needs a path');
  });

  test('link takes exactly one field', () => {
    expect(parseTaskCli(['link', 'F21', '--pr', 'https://x/1'])).toMatchObject({
      body: { action: 'link', field: 'pr', value: 'https://x/1' },
    });
    expect(() => parseTaskCli(['link', 'F21'])).toThrow('exactly one of');
    expect(() => parseTaskCli(['link', 'F21', '--pr', 'u', '--branch', 'b'])).toThrow('exactly one of');
    expect(() => parseTaskCli(['link', 'F21', '--doc'])).toThrow('--doc needs a value');
  });

  test('assign and order both unset with --none', () => {
    expect(parseTaskCli(['assign', 'F21', 'ines'])).toMatchObject({ body: { action: 'assign', assignee: 'ines' } });
    expect(parseTaskCli(['assign', 'F21', '--none'])).toMatchObject({ body: { action: 'assign', assignee: null } });
    expect(parseTaskCli(['order', 'F21', '3'])).toMatchObject({ body: { action: 'order', order: 3 } });
    expect(parseTaskCli(['order', 'F21', '--none'])).toMatchObject({ body: { action: 'order', order: null } });
    expect(() => parseTaskCli(['assign', 'F21'])).toThrow('or --none');
    expect(() => parseTaskCli(['order', 'F21', 'high'])).toThrow('whole number');
  });

  test('an unknown or missing subcommand prints the usage', () => {
    expect(() => parseTaskCli([])).toThrow('which task command?');
    expect(() => parseTaskCli(['promote', 'F21'])).toThrow('unknown task command "promote"');
    expect(TASK_CLI_USAGE).toContain('kteam task <command>');
    expect(TASK_CLI_USAGE).toContain('phase  <id>');
  });
});

describe('terminal rendering', () => {
  test('the list uses Attention vocabulary and never restates a flag as a phase', () => {
    const text = renderTaskListText({
      tasks: [
        summary({ id: 'F1', status: 'live', phase: 'live' }),
        summary({
          id: 'B2',
          kind: 'bug',
          status: 'blocked',
          statusReason: 'needs an API key from you',
          blocked: true,
          blockedReason: 'needs an API key from you',
          blockedSince: '2026-07-26T00:00:00.000Z',
        }),
        { ...summary({ id: 'F3', status: 'in_progress' }), live: { ...view().live, staleness: 'assignee-dead' } },
      ],
      parseErrors: 0,
    });
    expect(text).toContain('ATTENTION');
    expect(text).toContain('BLOCKED');
    expect(text).toContain('🚧 needs an API key from you');
    expect(text).toContain('needs an API key from you');
    expect(text).toContain('⚠ assignee-dead');
    expect(text).toContain('#B2');
    expect(text).toMatch(/#B2\s+BLOCKED/);
    expect(text.indexOf('#F3')).toBeLessThan(text.indexOf('#F1'));
  });

  test('unreadable records are reported, never silently missing', () => {
    const text = renderTaskListText({ tasks: [], parseErrors: 2, parseErrorIds: ['F4', 'F5'] });
    expect(text).toContain('No tasks.');
    expect(text).toContain('2 task record(s) could not be read');
    expect(text).toContain('F4, F5');
  });

  test('show prints the record, the brief, the derived warning and the history', () => {
    const text = renderTaskShowText({
      task: {
        ...view({ files: ['src/api-server.ts', 'src/tasks.ts'] }),
        live: { ...view().live, assigneeStatus: 'failed', assigneeHealth: 'dead', staleness: 'assignee-dead' },
      },
      activity: [
        { v: 1, seq: 1, time: 't1', actor: 'ms-lead', actorName: 'zelda', type: 'created', data: {} },
        {
          v: 1,
          seq: 2,
          time: 't2',
          actor: 'ms-ines',
          actorName: 'ines',
          type: 'status',
          data: { from: 'todo', to: 'in_progress' },
        },
      ],
      activityParseErrors: 1,
    });
    expect(text).toContain('#F21  File browser');
    expect(text).toContain('phase     build');
    expect(text).toContain('status    in_progress');
    expect(text).toContain('files     src/api-server.ts, src/tasks.ts (advisory)');
    expect(text).toContain('assignee  ines (failed)');
    expect(text).toContain('⚠ derived');
    expect(text).toContain('changes-first');
    expect(text).toContain('activity (2)');
    expect(text).toContain('1 history line(s) unreadable');
  });

  test('create prints only the new id, so it can be captured in a shell variable', () => {
    expect(renderTaskCli({ command: 'create', body: { kind: 'feature', title: 'x' } }, view({ id: 'F30' }))).toBe(
      '#F30\n',
    );
  });

  test('an action prints the resulting declared status plus any derived warning', () => {
    const command: TaskCliCommand = { command: 'act', id: 'F21', body: { action: 'note', text: 'x' } };
    expect(renderTaskCli(command, view({ status: 'built', phase: 'built' }))).toBe('#F21  built\n');
    const flagged = {
      ...view({ status: 'in_progress' }),
      live: { ...view().live, staleness: 'maybe-finished' as const },
    };
    expect(renderTaskCli(command, flagged)).toContain('⚠ assignee reported finished');
  });

  test('--md switches both renders to markdown without another round trip', () => {
    const md = renderTaskCli(
      { command: 'list', query: new URLSearchParams(), md: true, view: 'list' },
      { tasks: [summary()], parseErrors: 0 },
    );
    expect(md).toContain('| id | title | who | note |');
    const detailMd = renderTaskCli(
      { command: 'show', id: 'F21', afterSeq: 0, md: true },
      { task: view(), activity: [] },
    );
    expect(detailMd).toContain('# #F21 · File browser');
  });

  test('kanban render folds research, design, and build into the in-progress board lane', () => {
    const text = renderTaskKanbanText({
      tasks: [
        summary({ id: 'F1', phase: 'todo', status: 'todo' }),
        summary({ id: 'B2', phase: 'design', status: 'designed', blocked: true, blockedReason: 'needs input' }),
        summary({ id: 'F3', phase: 'build', status: 'in_progress' }),
        summary({ id: 'F4', phase: 'research', status: 'researched' }),
      ],
      parseErrors: 0,
    });
    expect(text).toContain('TODO (1)');
    expect(text).toContain('IN PROGRESS (3)');
    expect(text).not.toContain('DESIGN (');
    expect(text).not.toContain('RESEARCH (');
    expect(text).not.toContain('BUILD (');
    expect(text).toContain('#B2');
    expect(text).toContain('#B2 BLOCKED');
    expect(text).toContain('🚧 needs input');
    expect(text).toContain('#F3');
    expect(text).toContain('#F4');
  });

  test('dag render shows dependency edges', () => {
    const text = renderTaskDagText({
      tasks: [
        { ...summary({ id: 'F1', phase: 'build', status: 'in_progress' }), dependsOn: ['F2', 'B3'] },
        { ...summary({ id: 'F2', phase: 'todo', status: 'todo', dependsOn: [] }) },
        summary({ id: 'B3', phase: 'build', status: 'blocked', blocked: true, blockedReason: 'waiting' }),
      ],
      parseErrors: 0,
    });
    expect(text).toContain('#F1 → #F2, #B3');
    expect(text).toContain('#F2 → ∅');
    expect(text).toContain('#B3');
    expect(text).toContain('🚧 waiting');
  });

  test('empty kanban and dag render gracefully', () => {
    expect(renderTaskKanbanText({ tasks: [], parseErrors: 0 })).toContain('No tasks.');
    expect(renderTaskDagText({ tasks: [], parseErrors: 0 })).toContain('No tasks.');
  });
});
