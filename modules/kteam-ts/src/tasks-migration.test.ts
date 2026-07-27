import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, type KTeamPaths } from './paths';
import { SessionTaskStore } from './session-tasks-store';
import { TaskService } from './tasks';
import { TaskStore } from './tasks-store';
import { migrateLegacyTasks, taskMigrationReportFile } from './tasks-migration';
import type { TaskAssigneeView } from './tasks-live';
import { TASK_SCHEMA_VERSION, emptyTaskLinks, type Task, type TaskActivity, type TaskKind } from './tasks-types';

let home: string;
let paths: KTeamPaths;
let legacy: TaskStore;
let sessions: SessionTaskStore;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-task-migration-'));
  paths = createPaths(home);
  legacy = new TaskStore(paths, { role: 'daemon' });
  sessions = new SessionTaskStore(paths, { role: 'daemon' });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const at = '2026-07-27T12:00:00.000Z';

function view(id: string, teammate = id): TaskAssigneeView {
  return {
    config: { id, teammate, turn: 1 },
    state: { status: 'running', turn: 1, lastActivityAt: at },
  };
}

async function createLegacy(assignee: string | null, options: { kind?: TaskKind; title?: string } = {}): Promise<Task> {
  const kind = options.kind ?? 'feature';
  const id = await legacy.allocateId(kind);
  const task: Task = {
    v: TASK_SCHEMA_VERSION,
    id,
    kind,
    title: options.title ?? `Legacy ${id}`,
    description: `brief ${id}`,
    status: 'in_progress',
    statusReason: null,
    assignee,
    repo: '/repo',
    links: emptyTaskLinks(),
    order: null,
    createdAt: at,
    createdBy: 'user',
    updatedAt: at,
  };
  await legacy.transact(id, async mutation => {
    const written = await mutation.write(task, { updatedAt: at });
    await mutation.append({
      type: 'created',
      actor: 'user',
      actorName: 'user',
      time: at,
      data: { status: task.status, kind, title: task.title },
    });
    return written;
  });
  return task;
}

describe('copy-only migration', () => {
  test('resolvable assignees copy to their session; unresolved records stay global and visible', async () => {
    const direct = await createLegacy('ms-a');
    const byCallsign = await createLegacy('bravo');
    const unassigned = await createLegacy(null);
    const missing = await createLegacy('ghost');
    const report = await migrateLegacyTasks(paths, legacy, sessions, [view('ms-a', 'alpha'), view('ms-b', 'bravo')]);

    expect(report.imported).toEqual([
      { sessionId: 'ms-a', taskId: direct.id },
      { sessionId: 'ms-b', taskId: byCallsign.id },
    ]);
    expect(report.unresolved).toEqual([unassigned.id, missing.id]);
    expect(report.globalStoreRetained).toBe(true);
    expect(report.proven).toBe(false);
    expect((await sessions.read('ms-a')).file.tasks[0]?.task.id).toBe(direct.id);
    expect((await sessions.read('ms-a')).file.tasks[0]?.activity.at(-1)).toMatchObject({
      type: 'session',
      actor: 'daemon',
      data: { event: 'migrated', from: 'global', resolvedSession: 'ms-a' },
    });
    expect((await sessions.read('ms-b')).file.tasks[0]?.task.id).toBe(byCallsign.id);
    expect(await legacy.readTask(unassigned.id)).toBeDefined();
    expect(await legacy.readTask(direct.id)).toBeDefined();

    const persisted = JSON.parse(await readFile(taskMigrationReportFile(paths), 'utf8'));
    expect(persisted).toMatchObject({ globalStoreRetained: true, unresolved: [unassigned.id, missing.id] });

    const service = new TaskService(paths, { list: async () => [view('ms-a', 'alpha'), view('ms-b', 'bravo')] });
    const fleet = await service.taskList();
    expect(fleet.tasks).toHaveLength(4);
    expect(fleet.tasks.find(task => task.id === direct.id)?.sessionId).toBe('ms-a');
    expect(fleet.tasks.find(task => task.id === byCallsign.id)?.sessionId).toBe('ms-b');
    expect(fleet.tasks.find(task => task.id === unassigned.id)?.sessionId).toBeNull();
    expect(fleet.tasks.find(task => task.id === missing.id)?.sessionId).toBeNull();
  });

  test('a restart is idempotent and reports already-imported ids', async () => {
    const task = await createLegacy('ms-a');
    const first = await migrateLegacyTasks(paths, legacy, sessions, [view('ms-a')]);
    expect(first.imported).toEqual([{ sessionId: 'ms-a', taskId: task.id }]);
    const second = await migrateLegacyTasks(paths, legacy, sessions, [view('ms-a')]);
    expect(second.imported).toEqual([]);
    expect(second.alreadyImported).toEqual([{ sessionId: 'ms-a', taskId: task.id }]);
    expect((await sessions.read('ms-a')).file.tasks).toHaveLength(1);
  });

  test('human names, ambiguous callsigns, and sessions born after assignment are never guessed', async () => {
    const human = await createLegacy('kirin');
    const ambiguous = await createLegacy('shared');
    const tooNew = await createLegacy('future');
    const later = '2026-07-28T12:00:00.000Z';
    const report = await migrateLegacyTasks(paths, legacy, sessions, [
      view('ms-kirin', 'kirin'),
      view('ms-shared-a', 'shared'),
      view('ms-shared-b', 'shared'),
      {
        config: { id: 'ms-future', teammate: 'future', createdAt: later, turn: 1 },
        state: { status: 'running', turn: 1, lastActivityAt: later },
      },
    ]);
    expect(report.unresolved).toEqual([human.id, ambiguous.id, tooNew.id]);
    expect(report.unresolvedDetails).toEqual([
      { taskId: human.id, assignee: 'kirin', reason: 'human', candidates: [] },
      {
        taskId: ambiguous.id,
        assignee: 'shared',
        reason: 'ambiguous',
        candidates: ['ms-shared-a', 'ms-shared-b'],
      },
      { taskId: tooNew.id, assignee: 'future', reason: 'not-found', candidates: [] },
    ]);
  });

  test('a damaged activity source is not partially certified or hidden', async () => {
    const task = await createLegacy('ms-a');
    await appendFile(legacy.activityFile(task.id), '{ broken\n');
    const report = await migrateLegacyTasks(paths, legacy, sessions, [view('ms-a')]);
    expect(report.damagedActivity).toEqual([{ taskId: task.id, parseErrors: 1 }]);
    expect((await sessions.read('ms-a')).file.tasks).toHaveLength(0);
    expect(report.proven).toBe(false);
  });

  test('a damaged destination is contained while healthy sessions migrate and aggregate reads survive', async () => {
    const damaged = await createLegacy('ms-a');
    const healthy = await createLegacy('ms-b');
    await mkdir(path.dirname(sessions.file('ms-a')), { recursive: true });
    await writeFile(sessions.file('ms-a'), '{ torn\n');

    const report = await migrateLegacyTasks(paths, legacy, sessions, [view('ms-a'), view('ms-b')]);
    expect(report.imported).toEqual([{ sessionId: 'ms-b', taskId: healthy.id }]);
    expect(report.damagedDestinations).toHaveLength(1);
    expect(report.damagedDestinations[0]).toMatchObject({
      sessionId: 'ms-a',
      taskIds: [damaged.id],
    });
    expect(report.damagedDestinations[0]?.error).toContain('refusing to overwrite unreadable');
    expect(report.proven).toBe(false);
    expect((await sessions.read('ms-b')).file.tasks[0]?.task.id).toBe(healthy.id);

    const service = new TaskService(paths, { list: async () => [view('ms-a'), view('ms-b')] });
    const fleet = await service.taskList();
    expect(fleet.tasks.find(task => task.id === damaged.id)?.sessionId).toBeNull();
    expect(fleet.tasks.find(task => task.id === healthy.id)?.sessionId).toBe('ms-b');
    expect(fleet.parseErrorIds).toContain('ms-a:<file>');
  });

  test('a failed initialization can retry in the same service after the report path is repaired', async () => {
    await writeFile(paths.daemon, 'not a directory');
    const retrying = new TaskService(paths, { list: async () => [] });

    await expect(retrying.initialize()).rejects.toThrow();
    await rm(paths.daemon, { force: true });
    await mkdir(paths.daemon, { recursive: true });

    const report = await retrying.initialize();
    expect(report.proven).toBe(true);
    expect(JSON.parse(await readFile(taskMigrationReportFile(paths), 'utf8'))).toMatchObject({ proven: true });
  });

  test('a destination collision is reported, never overwritten, and aggregate detail refuses ambiguity', async () => {
    const floor = await createLegacy(null, { title: 'unresolved floor' });
    await sessions.create('ms-a', 'feature', id => ({
      task: { ...floor, id, title: 'destination', assignee: 'ms-a' },
      activity: [
        {
          v: TASK_SCHEMA_VERSION,
          seq: 1,
          time: at,
          actor: 'ms-a',
          actorName: 'alpha',
          type: 'created',
          data: {},
        } satisfies TaskActivity,
      ],
    }));
    const source = await createLegacy('ms-a', { title: 'source' });
    const report = await migrateLegacyTasks(paths, legacy, sessions, [view('ms-a', 'alpha')]);
    expect(report.conflicts).toEqual([{ sessionId: 'ms-a', taskId: 'F2' }]);
    expect((await sessions.read('ms-a')).file.tasks[0]?.task.title).toBe('destination');
    expect((await sessions.read('ms-a')).file.migratedGlobalIds).toEqual([]);

    const service = new TaskService(paths, { list: async () => [view('ms-a', 'alpha')] });
    const fleet = await service.taskList();
    expect(fleet.tasks.filter(task => task.id === 'F2')).toHaveLength(2);
    await expect(service.taskDetail('F2')).rejects.toMatchObject({ code: 'ambiguous' });
  });

  test('a clean, fully resolvable source is proven but still retained', async () => {
    const task = await createLegacy('ms-a');
    const report = await migrateLegacyTasks(paths, legacy, sessions, [view('ms-a')]);
    expect(report.proven).toBe(true);
    expect(report.globalStoreRetained).toBe(true);
    expect(await legacy.readTask(task.id)).toBeDefined();
  });
});
