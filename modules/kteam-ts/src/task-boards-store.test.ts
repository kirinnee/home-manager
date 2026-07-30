import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, taskBoardBindingFile, taskBoardFile, type KTeamPaths } from './paths';
import { SessionTaskStore, sessionTaskCounterFile, type StoredSessionTask } from './session-tasks-store';
import {
  emptyTaskBoardFile,
  hashTaskBoardPayload,
  mintTaskBoardId,
  TaskBoardStore,
  type TaskBoardMutationContext,
} from './task-boards-store';
import {
  TASK_BOARD_BINDING_VERSION,
  TaskBoardError,
  type TaskBoardAuthorization,
  type TaskBoardBinding,
} from './task-boards-types';
import { TASK_SCHEMA_VERSION, emptyTaskLinks, type Task, type TaskActivity } from './tasks-types';

let home: string;
let paths: KTeamPaths;
let allocator: SessionTaskStore;
let boards: TaskBoardStore;

const at = '2026-07-29T12:00:00.000Z';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-task-boards-'));
  paths = createPaths(home);
  allocator = new SessionTaskStore(paths, { role: 'daemon' });
  boards = new TaskBoardStore(paths, { role: 'daemon', allocateId: kind => allocator.allocateId(kind) });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function task(id: string, sessionId = 'ms-root'): Task {
  return {
    v: TASK_SCHEMA_VERSION,
    id,
    kind: 'feature',
    title: `Task ${id}`,
    description: '',
    ask: { text: `Task ${id}`, source: `session:${sessionId}` },
    clarifications: [],
    workflow: 'quick',
    phase: 'todo',
    dependsOn: [],
    status: 'todo',
    statusReason: null,
    assignee: sessionId,
    repo: '/repo',
    files: [],
    links: emptyTaskLinks(),
    order: null,
    createdAt: at,
    createdBy: null,
    updatedAt: at,
  };
}

function activity(): TaskActivity {
  return {
    v: TASK_SCHEMA_VERSION,
    seq: 1,
    time: at,
    actor: 'user',
    actorName: 'user',
    type: 'created',
    data: { reason: 'test' },
  };
}

function built(id: string): StoredSessionTask {
  return { task: task(id), activity: [activity()] };
}

function humanAuthorization(requestId: string): TaskBoardAuthorization {
  return {
    boardId: 'placeholder',
    grantId: 'human-admin',
    actorSessionId: null,
    actorName: 'user',
    role: 'human_admin',
    allowedActions: ['read', 'create'],
    boardEpoch: 1,
    coordinatorEpoch: 1,
    runtimeGeneration: null,
    capabilityId: 'daemon-admin-token',
    requestId,
  };
}

function context(boardId: string, requestId: string, payload: unknown): TaskBoardMutationContext {
  return {
    authorization: { ...humanAuthorization(requestId), boardId },
    action: 'create',
    payloadHash: hashTaskBoardPayload(payload),
  };
}

async function createBoard(): Promise<string> {
  const boardId = mintTaskBoardId();
  await boards.createBoard(
    emptyTaskBoardFile({
      boardId,
      creator: 'ms-root',
      canonicalSessionId: 'ms-root',
      coordinatorSessionId: 'ms-coordinator',
      at,
    }),
  );
  return boardId;
}

describe('central task board store', () => {
  test('concurrent creates on multiple boards share one monotonic allocator and recover its floor', async () => {
    const [firstBoard, secondBoard] = await Promise.all([createBoard(), createBoard()]);
    const [first, second] = await Promise.all([
      boards.createTask(firstBoard, 'feature', context(firstBoard, 'request-a', { title: 'a' }), built),
      boards.createTask(secondBoard, 'feature', context(secondBoard, 'request-b', { title: 'b' }), built),
    ]);
    expect(new Set([first.value.task.id, second.value.task.id])).toEqual(new Set(['F1', 'F2']));

    await rm(sessionTaskCounterFile(paths), { force: true });
    const restarted = new SessionTaskStore(paths, { role: 'daemon' });
    expect(await restarted.allocateId('feature')).toBe('F3');
  });

  test('a corrupt central board plus a lost counter fails closed instead of recycling an id', async () => {
    const boardId = mintTaskBoardId();
    await mkdir(path.dirname(taskBoardFile(paths, boardId)), { recursive: true });
    await writeFile(taskBoardFile(paths, boardId), '{"v":1,"taskState":', 'utf8');
    await rm(sessionTaskCounterFile(paths), { force: true });

    const restarted = new SessionTaskStore(paths, { role: 'daemon' });
    await expect(restarted.allocateId('feature')).rejects.toThrow(/cannot prove the global task-id floor/);
  });

  test('durable replay binds actor, grant, action and every authorization epoch', async () => {
    const boardId = await createBoard();
    const original = context(boardId, 'same-request', { title: 'same' });
    const first = await boards.createTask(boardId, 'feature', original, built);
    expect(first.replayed).toBe(false);
    expect((await boards.createTask(boardId, 'feature', original, built)).replayed).toBe(true);

    const changedActor: TaskBoardMutationContext = {
      ...original,
      authorization: {
        ...original.authorization,
        actorSessionId: 'ms-worker',
        actorName: 'worker',
        role: 'worker',
        grantId: 'tg-worker',
        capabilityId: 'tg-worker',
        runtimeGeneration: 1,
      },
    };
    await expect(boards.createTask(boardId, 'feature', changedActor, built)).rejects.toThrow(TaskBoardError);

    const staleGeneration: TaskBoardMutationContext = {
      ...original,
      authorization: { ...original.authorization, runtimeGeneration: 2 },
    };
    await expect(boards.createTask(boardId, 'feature', staleGeneration, built)).rejects.toThrow(TaskBoardError);
    expect((await boards.require(boardId)).taskState.tasks).toHaveLength(1);
  });

  test('unknown persisted ACL enums and partial bindings fail the whole security record closed', async () => {
    const boardId = await createBoard();
    const raw = JSON.parse(await readFile(taskBoardFile(paths, boardId), 'utf8')) as Record<string, unknown>;
    raw['grants'] = [
      {
        grantId: 'tg_bad',
        capabilityHash: '0'.repeat(64),
        sessionId: 'ms-worker',
        sessionIncarnation: 'incarnation',
        runtimeGeneration: 1,
        role: 'owner',
        allowedActions: ['read'],
        parentSessionId: 'ms-root',
        interactiveSourceSessionId: 'ms-root',
        coordinatorSessionId: 'ms-coordinator',
        coordinatorEpoch: 1,
        grantedAt: at,
        grantedBySessionId: 'ms-coordinator',
        active: true,
      },
    ];
    await writeFile(taskBoardFile(paths, boardId), `${JSON.stringify(raw)}\n`, 'utf8');
    expect((await boards.read(boardId)).fatal).toBe(true);
    await expect(boards.require(boardId)).rejects.toThrow(/grant 0 is invalid/);

    const binding = {
      v: TASK_BOARD_BINDING_VERSION,
      sessionId: 'ms-worker',
      sessionIncarnation: 'incarnation',
      runtimeGeneration: 1,
      boardId,
      grantId: 'tg_bad',
      capability: 'secret',
      role: 'owner',
      allowedActions: ['read'],
      boardEpoch: 1,
      coordinatorEpoch: 1,
      boundAt: at,
      updatedAt: at,
    } as unknown as TaskBoardBinding;
    await mkdir(path.dirname(taskBoardBindingFile(paths, 'ms-worker')), { recursive: true });
    await writeFile(taskBoardBindingFile(paths, 'ms-worker'), `${JSON.stringify(binding)}\n`, 'utf8');
    await expect(boards.readBinding('ms-worker')).rejects.toThrow(/unreadable board binding/);
  });
});
