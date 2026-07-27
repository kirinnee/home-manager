import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import {
  TASK_CLI_USAGE,
  parseTaskCli,
  renderTaskCli,
  renderTaskListText,
  renderTaskShowText,
  splitTaskArgs,
  taskCliRequest,
  type TaskCliCommand,
} from './tasks-cli';
import { TASK_SCHEMA_VERSION, TaskError, type Task, type TaskSummary, type TaskView } from './tasks-types';

const view = (over: Partial<Task> = {}): TaskView => ({
  v: TASK_SCHEMA_VERSION,
  id: 'F21',
  kind: 'feature',
  title: 'File browser',
  description: '## Brief\nchanges-first',
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
  ...over,
});

const summary = (over: Partial<Task> = {}): TaskSummary => {
  const { description, ...rest } = view(over);
  return { ...rest, descriptionChars: description.length };
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
        repo: '/repo',
        assignee: 'ines',
        order: 3,
        links: { prs: ['https://x/1', 'https://x/2'], commits: ['abc'], docs: ['~/b.md'], branch: 'feat/x' },
      },
    });
    expect(taskCliRequest(command)).toEqual({
      method: 'POST',
      path: '/v1/tasks',
      body: (command as { body: unknown }).body,
    });
  });

  test('--description-file is returned as a PATH for the wiring to read', () => {
    const command = parseTaskCli(['create', '--kind', 'bug', '--title', 'x', '--description-file', 'brief.md']);
    expect(command).toMatchObject({ command: 'create', descriptionFile: 'brief.md' });
    expect((command as { body: { description?: string } }).body.description).toBeUndefined();
  });

  test('--description and --description-file together are refused', () => {
    expect(() =>
      parseTaskCli(['create', '--kind', 'bug', '--title', 'x', '--description', 'a', '--description-file', 'b']),
    ).toThrow('not both');
  });

  test('a bare positional title works too', () => {
    expect(parseTaskCli(['create', '--kind', 'bug', 'Questions', 'never', 'reach', 'the', 'UI'])).toMatchObject({
      body: { title: 'Questions never reach the UI' },
    });
  });

  test('creating straight into blocked needs --reason, locally', () => {
    expect(() => parseTaskCli(['create', '--kind', 'bug', '--title', 'x', '--status', 'blocked'])).toThrow(
      'requires --reason',
    );
    expect(
      parseTaskCli(['create', '--kind', 'bug', '--title', 'x', '--status', 'blocked', '--reason', 'needs a key']),
    ).toMatchObject({ body: { status: 'blocked', statusReason: 'needs a key' } });
  });

  test('a bad or missing kind/title is refused with the usage block attached', () => {
    const attempt = () => parseTaskCli(['create', '--kind', 'epic', '--title', 'x']);
    expect(attempt).toThrow(TaskError);
    expect(attempt).toThrow('--kind must be one of');
    expect(attempt).toThrow('kteam task <command>');
    expect(() => parseTaskCli(['create', '--kind', 'bug'])).toThrow('--title is required');
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
    expect(taskCliRequest(command).path).toBe('/v1/tasks?repo=%2Fa&assignee=ines&kind=bug&status=built&status=live');
    expect(command).toMatchObject({ md: false });
  });

  test('a bare list has no query at all', () => {
    expect(taskCliRequest(parseTaskCli(['list']))).toEqual({ method: 'GET', path: '/v1/tasks' });
  });

  test('--md is carried on the command, so rendering decides, not the daemon', () => {
    expect(parseTaskCli(['list', '--md'])).toMatchObject({ md: true });
  });

  test('an unknown status or kind filter is refused before the round trip', () => {
    expect(() => parseTaskCli(['list', '--status', 'shipped'])).toThrow('status must be one of');
    expect(() => parseTaskCli(['list', '--kind', 'epic'])).toThrow('--kind must be one of');
  });
});

describe('show', () => {
  test('canonicalises the id and passes ?after=', () => {
    expect(taskCliRequest(parseTaskCli(['show', 'f21', '--after', '4']))).toEqual({
      method: 'GET',
      path: '/v1/tasks/F21?after=4',
    });
    expect(taskCliRequest(parseTaskCli(['show', 'F21']))).toEqual({ method: 'GET', path: '/v1/tasks/F21' });
  });

  test('a junk id is refused before any request', () => {
    expect(() => parseTaskCli(['show', 'nonsense'])).toThrow('expected a task id');
    expect(() => parseTaskCli(['show'])).toThrow('expected a task id');
  });
});

describe('the five mutations', () => {
  test('status', () => {
    const command = parseTaskCli(['status', 'F21', 'built', '--note', '590 tests green']);
    expect(command).toEqual({
      command: 'act',
      id: 'F21',
      body: { action: 'status', status: 'built', note: '590 tests green' },
    });
    expect(taskCliRequest(command)).toEqual({
      method: 'POST',
      path: '/v1/tasks/F21',
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
    expect(TASK_CLI_USAGE).toContain('blocked or dropped REQUIRES --reason');
  });
});

describe('terminal rendering', () => {
  test('the board leads with what the user must act on and never restates a flag as a status', () => {
    const text = renderTaskListText({
      tasks: [
        summary({ id: 'F1', status: 'live' }),
        summary({ id: 'B2', kind: 'bug', status: 'blocked', statusReason: 'needs an API key from you' }),
        { ...summary({ id: 'F3', status: 'in_progress' }), live: { ...view().live, staleness: 'assignee-dead' } },
      ],
      parseErrors: 0,
    });
    expect(text.indexOf('NEEDS YOU')).toBeLessThan(text.indexOf('🟢 LIVE'));
    expect(text).toContain('needs an API key from you');
    expect(text).toContain('⚠ assignee-dead');
    // The status column still says in_progress; the flag is an annotation.
    expect(text).toContain('🔵 IN PROGRESS (1)');
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
        ...view(),
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
    expect(text).toContain('F21  File browser');
    expect(text).toContain('status    in_progress');
    expect(text).toContain('assignee  ines (failed)');
    expect(text).toContain('⚠ derived');
    expect(text).toContain('changes-first');
    expect(text).toContain('activity (2)');
    expect(text).toContain('1 history line(s) unreadable');
  });

  test('create prints only the new id, so it can be captured in a shell variable', () => {
    expect(renderTaskCli({ command: 'create', body: { kind: 'feature', title: 'x' } }, view({ id: 'F30' }))).toBe(
      'F30\n',
    );
  });

  test('an action prints the resulting declared status plus any derived warning', () => {
    const command: TaskCliCommand = { command: 'act', id: 'F21', body: { action: 'note', text: 'x' } };
    expect(renderTaskCli(command, view({ status: 'built' }))).toBe('F21  built\n');
    const flagged = {
      ...view({ status: 'in_progress' }),
      live: { ...view().live, staleness: 'maybe-finished' as const },
    };
    expect(renderTaskCli(command, flagged)).toContain('⚠ assignee reported finished');
  });

  test('--md switches both renders to markdown without another round trip', () => {
    const md = renderTaskCli(
      { command: 'list', query: new URLSearchParams(), md: true },
      { tasks: [summary()], parseErrors: 0 },
    );
    expect(md).toContain('| id | title | who | note |');
    const detailMd = renderTaskCli(
      { command: 'show', id: 'F21', afterSeq: 0, md: true },
      { task: view(), activity: [] },
    );
    expect(detailMd).toContain('# F21 · File browser');
  });
});
