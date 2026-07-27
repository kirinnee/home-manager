import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, markerFile, type KTeamPaths } from './paths';
import {
  annotateTask,
  annotateTasks,
  assigneeHealthOf,
  computeTaskLive,
  hasCurrentDoneMarker,
  resolveAssignee,
  type TaskAssigneeView,
} from './tasks-live';
import { TASK_SCHEMA_VERSION, type Task, type TaskStatus } from './tasks-types';

let home: string;
let paths: KTeamPaths;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-tasks-live-'));
  paths = createPaths(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const task = (over: Partial<Task> = {}): Task => ({
  v: TASK_SCHEMA_VERSION,
  id: 'F1',
  kind: 'feature',
  title: 'File browser',
  description: '',
  status: 'in_progress',
  statusReason: null,
  assignee: 'ines',
  repo: '/repo',
  links: { prs: [], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: '2026-07-26T12:00:00.000Z',
  createdBy: 'lead',
  updatedAt: '2026-07-26T12:00:00.000Z',
  ...over,
});

const session = (over: {
  id?: string;
  status?: string;
  teammate?: string;
  name?: string;
  lastActivityAt?: string;
  turn?: number;
  hasDoneMarker?: boolean;
}): TaskAssigneeView => ({
  config: { id: over.id ?? 'ms-1', teammate: over.teammate ?? 'ines', name: over.name, turn: over.turn },
  state: {
    status: over.status ?? 'running',
    turn: over.turn,
    lastActivityAt: over.lastActivityAt ?? '2026-07-27T02:00:00.000Z',
  },
  ...(over.hasDoneMarker !== undefined ? { hasDoneMarker: over.hasDoneMarker } : {}),
});

describe('assignee health', () => {
  test.each([
    ['running', 'active'],
    ['thinking', 'active'],
    ['tool_running', 'active'],
    ['starting', 'active'],
    ['retrying', 'active'],
    ['awaiting_question', 'waiting'],
    ['awaiting_user', 'waiting'],
    ['waiting', 'waiting'],
    ['rate_limited', 'waiting'],
    ['interrupted', 'waiting'],
    ['failed', 'dead'],
    ['stalled', 'dead'],
    ['stopped', 'dead'],
    ['kill_failed', 'dead'],
    ['completed', 'dead'],
  ])('%s → %s', (status, health) => {
    expect(assigneeHealthOf(status)).toBe(health as ReturnType<typeof assigneeHealthOf>);
  });

  test('an unrecognised status is unknown, never optimistically active', () => {
    expect(assigneeHealthOf('teleporting')).toBe('unknown');
    expect(assigneeHealthOf(undefined)).toBe('unknown');
  });
});

describe('staleness is the mismatch detector', () => {
  test('in_progress + a failed assignee is assignee-dead', () => {
    const live = computeTaskLive(task(), session({ status: 'failed' }));
    expect(live.staleness).toBe('assignee-dead');
    expect(live.assigneeHealth).toBe('dead');
    expect(live.assigneeStatus).toBe('failed');
  });

  test.each(['failed', 'stalled', 'stopped', 'kill_failed'])('in_progress + %s is assignee-dead', status => {
    expect(computeTaskLive(task(), session({ status })).staleness).toBe('assignee-dead');
  });

  test('in_progress + an assignee the fleet cannot find is assignee-dead', () => {
    const live = computeTaskLive(task({ assignee: 'ghost' }), null);
    expect(live.staleness).toBe('assignee-dead');
    expect(live.assigneeStatus).toBeNull();
    expect(live.assigneeHealth).toBeNull();
  });

  test('in_progress with NOBODY assigned makes no claim, so there is nothing to contradict', () => {
    expect(computeTaskLive(task({ assignee: null }), null).staleness).toBeNull();
  });

  test('in_progress + completed is maybe-finished — a prompt to verify, not a promotion', () => {
    const live = computeTaskLive(task(), session({ status: 'completed' }));
    expect(live.staleness).toBe('maybe-finished');
  });

  test('in_progress + a done marker is maybe-finished even while the session still runs', () => {
    const live = computeTaskLive(task(), session({ status: 'running', hasDoneMarker: true }));
    expect(live.staleness).toBe('maybe-finished');
    expect(live.assigneeDoneMarker).toBe(true);
  });

  test('a dead assignee outranks its own done marker (it failed AFTER claiming done)', () => {
    expect(computeTaskLive(task(), session({ status: 'failed', hasDoneMarker: true })).staleness).toBe('assignee-dead');
  });

  test('a healthy assignee on an in_progress task is not flagged', () => {
    expect(computeTaskLive(task(), session({ status: 'running' })).staleness).toBeNull();
  });

  test.each<TaskStatus>(['todo', 'researched', 'designed', 'built', 'live', 'blocked', 'dropped'])(
    'a dead assignee on a %s task is normal, not a mismatch',
    status => {
      const record = task({ status, statusReason: status === 'blocked' || status === 'dropped' ? 'why' : null });
      expect(computeTaskLive(record, session({ status: 'failed' })).staleness).toBeNull();
    },
  );
});

describe('quiet is opt-in and needs a clock', () => {
  const stale = task({ updatedAt: '2026-07-27T00:00:00.000Z' });
  const quietSession = session({ status: 'running', lastActivityAt: '2026-07-27T00:30:00.000Z' });
  const nowMs = Date.parse('2026-07-27T06:00:00.000Z');

  test('without options, quiet is never reported (phase 1 default)', () => {
    expect(computeTaskLive(stale, quietSession).staleness).toBeNull();
  });

  test('with a threshold and a clock, a long-silent in_progress task is quiet', () => {
    expect(computeTaskLive(stale, quietSession, { quietAfterMs: 3 * 3600_000, nowMs }).staleness).toBe('quiet');
  });

  test('recent activity on EITHER the task or the session keeps it un-quiet', () => {
    const busySession = session({ status: 'running', lastActivityAt: '2026-07-27T05:59:00.000Z' });
    expect(computeTaskLive(stale, busySession, { quietAfterMs: 3600_000, nowMs }).staleness).toBeNull();
    const busyTask = task({ updatedAt: '2026-07-27T05:59:00.000Z' });
    expect(computeTaskLive(busyTask, quietSession, { quietAfterMs: 3600_000, nowMs }).staleness).toBeNull();
  });

  test('a dead or finished assignee still wins over quiet', () => {
    const options = { quietAfterMs: 3600_000, nowMs };
    expect(computeTaskLive(stale, session({ status: 'failed' }), options).staleness).toBe('assignee-dead');
    expect(computeTaskLive(stale, session({ status: 'completed' }), options).staleness).toBe('maybe-finished');
  });

  test('unparseable timestamps never fabricate a quiet flag', () => {
    const broken = task({ updatedAt: 'not a date' });
    const brokenSession = session({ status: 'running', lastActivityAt: 'also not a date' });
    expect(computeTaskLive(broken, brokenSession, { quietAfterMs: 1, nowMs }).staleness).toBeNull();
  });
});

describe('annotation never touches the declared record', () => {
  test('status is copied through verbatim and the input is not mutated', () => {
    const record = task({ status: 'in_progress' });
    const frozen = JSON.parse(JSON.stringify(record));
    const view = annotateTask(record, session({ status: 'completed', hasDoneMarker: true }));
    expect(view.status).toBe('in_progress');
    expect(view.live.staleness).toBe('maybe-finished');
    expect(record).toEqual(frozen);
    expect(view).not.toBe(record);
  });

  test('annotating a whole board resolves each assignee once', () => {
    const views = [
      session({ id: 'ms-a', teammate: 'ines', status: 'failed' }),
      session({ id: 'ms-b', teammate: 'sasha', status: 'running' }),
    ];
    const annotated = annotateTasks(
      [task({ id: 'F1', assignee: 'ines' }), task({ id: 'F2', assignee: 'sasha' }), task({ id: 'F3', assignee: null })],
      views,
    );
    expect(annotated.map(view => view.live.staleness)).toEqual(['assignee-dead', null, null]);
  });
});

describe('assignee resolution', () => {
  const views = [
    session({ id: 'ms-old', teammate: 'ines', lastActivityAt: '2026-07-20T00:00:00.000Z' }),
    session({ id: 'ms-new', teammate: 'ines', lastActivityAt: '2026-07-27T00:00:00.000Z' }),
    session({ id: 'ms-named', teammate: 'zelda', name: 'Fix Transcript Scrolling' }),
  ];

  test('an id match always wins', () => {
    expect(resolveAssignee('ms-old', views)?.config.id).toBe('ms-old');
  });

  test('a reused callsign resolves to the most recently active holder', () => {
    expect(resolveAssignee('ines', views)?.config.id).toBe('ms-new');
  });

  test('a session name resolves too', () => {
    expect(resolveAssignee('Fix Transcript Scrolling', views)?.config.id).toBe('ms-named');
  });

  test('an unknown or empty assignee resolves to null, not to a guess', () => {
    expect(resolveAssignee('nobody', views)).toBeNull();
    expect(resolveAssignee('   ', views)).toBeNull();
    expect(resolveAssignee(null, views)).toBeNull();
  });
});

describe('done marker reading is evidence-only', () => {
  async function writeMarker(id: string, body: unknown): Promise<void> {
    const file = markerFile(paths, id, 'done');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
  }

  test('a marker certifying the current turn counts', async () => {
    await writeMarker('ms-1', { turn: 3, at: 'now' });
    expect(await hasCurrentDoneMarker(paths, 'ms-1', 3)).toBe(true);
  });

  test('a marker for an older turn is not a claim about now', async () => {
    await writeMarker('ms-1', { turn: 2 });
    expect(await hasCurrentDoneMarker(paths, 'ms-1', 3)).toBe(false);
  });

  test('a missing or corrupt marker is absence of evidence, never invented evidence', async () => {
    expect(await hasCurrentDoneMarker(paths, 'ms-missing', 1)).toBe(false);
    await writeMarker('ms-2', '{ torn');
    expect(await hasCurrentDoneMarker(paths, 'ms-2', 1)).toBe(false);
  });

  test('with no known current turn, a marker cannot certify this run', async () => {
    await writeMarker('ms-3', { turn: 9 });
    expect(await hasCurrentDoneMarker(paths, 'ms-3', undefined)).toBe(false);
  });

  test('a legacy turnless marker cannot certify the current run', async () => {
    await writeMarker('ms-4', { at: 'now' });
    expect(await hasCurrentDoneMarker(paths, 'ms-4', 3)).toBe(false);
  });
});
