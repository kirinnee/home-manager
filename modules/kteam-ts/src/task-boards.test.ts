import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, type KTeamPaths } from './paths';
import { SessionTaskStore } from './session-tasks-store';
import {
  appendTaskBoardAppliedRequest,
  compactTaskBoardGrantRequests,
  emptyTaskBoardFile,
  hashTaskBoardSecret,
  mintTaskBoardId,
  TaskBoardStore,
} from './task-boards-store';
import {
  TASK_BOARD_BINDING_VERSION,
  taskBoardActionsForCurrentCoordinator,
  taskBoardActionsForRole,
  TaskBoardError,
  type TaskBoardAppliedRequest,
  type TaskBoardBinding,
  type TaskBoardFile,
  type TaskBoardGrant,
  type TaskBoardGrantRequest,
  type TaskBoardRole,
} from './task-boards-types';
import {
  TaskBoardService,
  type TaskBoardSessionDeps,
  type TaskBoardServiceOptions,
  type TaskBoardSessionView,
} from './task-boards';
import { TaskService } from './tasks';
import { TaskError, type TaskActor } from './tasks-types';
import type { KTeamEvent } from './types';

const at = '2026-07-29T12:00:00.000Z';
const topCapability = 'top-capability-secret';
const coordinatorCapability = 'coordinator-capability-secret';
const workerCapability = 'worker-capability-secret';

let home: string;
let paths: KTeamPaths;
let store: TaskBoardStore;
let service: TaskBoardService;
let boardId: string;

function freshSessions(): TaskBoardSessionView[] {
  return [
    {
      config: {
        id: 'ms-top',
        incarnation: 'inc-top',
        runtimeGeneration: 1,
        teammate: 'top',
        parent: undefined,
        mode: 'interactive',
        createdAt: at,
      },
      state: { status: 'running' },
    },
    {
      config: {
        id: 'ms-coordinator',
        incarnation: 'inc-coordinator',
        runtimeGeneration: 1,
        teammate: 'coordinator',
        parent: 'ms-top',
        mode: 'auto',
        createdAt: at,
      },
      state: { status: 'running' },
    },
    {
      config: {
        id: 'ms-worker',
        incarnation: 'inc-worker',
        runtimeGeneration: 1,
        teammate: 'worker',
        parent: 'ms-top',
        mode: 'auto',
        createdAt: at,
      },
      state: { status: 'running' },
    },
    {
      config: {
        id: 'ms-child-a',
        incarnation: 'inc-child-a',
        runtimeGeneration: 1,
        teammate: 'child-a',
        parent: 'ms-coordinator',
        mode: 'auto',
        createdAt: at,
      },
      state: { status: 'running' },
    },
    {
      config: {
        id: 'ms-child-b',
        incarnation: 'inc-child-b',
        runtimeGeneration: 1,
        teammate: 'child-b',
        parent: 'ms-coordinator',
        mode: 'auto',
        createdAt: at,
      },
      state: { status: 'running' },
    },
    {
      config: {
        id: 'ms-outside',
        incarnation: 'inc-outside',
        runtimeGeneration: 1,
        teammate: 'outside',
        parent: undefined,
        mode: 'interactive',
        createdAt: at,
      },
      state: { status: 'running' },
    },
    {
      config: {
        id: 'ms-new-top',
        incarnation: 'inc-new-top',
        runtimeGeneration: 1,
        teammate: 'new-top',
        parent: undefined,
        mode: 'interactive',
        createdAt: at,
      },
      state: { status: 'running' },
    },
    {
      config: {
        id: 'ms-new-coordinator',
        incarnation: 'inc-new-coordinator',
        runtimeGeneration: 1,
        teammate: 'new-coordinator',
        parent: 'ms-new-top',
        mode: 'auto',
        createdAt: at,
      },
      state: { status: 'running' },
    },
    {
      config: {
        id: 'ms-wrong-branch',
        incarnation: 'inc-wrong-branch',
        runtimeGeneration: 1,
        teammate: 'wrong-branch',
        parent: 'ms-outside',
        mode: 'auto',
        createdAt: at,
      },
      state: { status: 'running' },
    },
    {
      config: {
        id: 'ms-replacement',
        incarnation: 'inc-replacement',
        runtimeGeneration: 1,
        teammate: 'replacement',
        parent: 'ms-top',
        mode: 'auto',
        createdAt: at,
      },
      state: { status: 'running' },
    },
  ];
}

let sessions = freshSessions();

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-task-board-service-'));
  paths = createPaths(home);
  sessions = freshSessions();
  const allocator = new SessionTaskStore(paths, { role: 'daemon' });
  store = new TaskBoardStore(paths, {
    role: 'daemon',
    allocateId: kind => allocator.allocateId(kind),
    resolveAssignedSessionId: async taskValue => {
      if (!taskValue.assignee) return null;
      const exact = sessions.find(view => view.config.id === taskValue.assignee);
      if (exact) return exact.config.id;
      const named = sessions.filter(
        view => view.config.teammate === taskValue.assignee || view.config.name === taskValue.assignee,
      );
      return named.length === 1 ? named[0]!.config.id : null;
    },
    resolveSessionIdentity: async sessionId => {
      const view = sessions.find(candidate => candidate.config.id === sessionId);
      return view
        ? {
            sessionIncarnation: view.config.incarnation!,
            runtimeGeneration: view.config.runtimeGeneration!,
          }
        : null;
    },
  });
  boardId = mintTaskBoardId();
  const grants = [
    grant('tg-top', 'ms-top', 'inc-top', 'top_agent', topCapability),
    grant('tg-coordinator', 'ms-coordinator', 'inc-coordinator', 'coordinator', coordinatorCapability),
    grant('tg-worker', 'ms-worker', 'inc-worker', 'worker', workerCapability),
  ];
  const board = await store.createBoard({
    ...emptyTaskBoardFile({
      boardId,
      creator: 'ms-top',
      canonicalSessionId: 'ms-top',
      coordinatorSessionId: 'ms-coordinator',
      at,
    }),
    grants,
  });
  for (const [entry, capability] of [
    [grants[0]!, topCapability],
    [grants[1]!, coordinatorCapability],
    [grants[2]!, workerCapability],
  ] as const) {
    await store.writeBinding(binding(board, entry, capability));
  }
  service = boardService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function boardService(
  overrides: Partial<TaskBoardSessionDeps> = {},
  options: TaskBoardServiceOptions = {},
): TaskBoardService {
  return new TaskBoardService(
    paths,
    store,
    {
      async get(ref) {
        const view = sessions.find(candidate => candidate.config.id === ref || candidate.config.teammate === ref);
        if (!view) throw new Error(`unknown session ${ref}`);
        return view;
      },
      async list() {
        return sessions;
      },
      ...overrides,
    },
    options,
  );
}

function tasks(board = service): TaskService {
  const deps: TaskBoardSessionDeps = {
    async get(ref) {
      const view = sessions.find(candidate => candidate.config.id === ref || candidate.config.teammate === ref);
      if (!view) throw new Error(`unknown session ${ref}`);
      return view;
    },
    async list() {
      return sessions;
    },
  };
  return new TaskService(paths, deps, { boardService: board });
}

const grantedActor = (sessionId: 'ms-top' | 'ms-coordinator' | 'ms-worker', requestId: string): TaskActor => ({
  actor: sessionId,
  actorName: sessionId.slice(3),
  boardCapability:
    sessionId === 'ms-top' ? topCapability : sessionId === 'ms-coordinator' ? coordinatorCapability : workerCapability,
  runtimeGeneration: sessions.find(view => view.config.id === sessionId)!.config.runtimeGeneration,
  requestId,
});

async function createAssignedTask(taskService: TaskService, title = 'Shared task'): Promise<string> {
  return (
    await taskService.sessionTaskCreate(
      'ms-top',
      {
        kind: 'feature',
        title,
        ask: { text: title, source: 'session:ms-top' },
        assignee: 'ms-worker',
        phase: 'build',
        workflow: 'quick',
      },
      grantedActor('ms-top', `create:${title}`),
    )
  ).id;
}

function pauseNextTaskMutation(): {
  entered: Promise<void>;
  release(): void;
  restore(): void;
} {
  const original = store.transactTask.bind(store);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const reached = new Promise<void>(resolve => {
    entered = resolve;
  });
  let first = true;
  store.transactTask = async (...args: Parameters<TaskBoardStore['transactTask']>) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return original(...args);
  };
  return {
    entered: reached,
    release,
    restore() {
      store.transactTask = original;
    },
  };
}

function session(id: string): TaskBoardSessionView {
  const view = sessions.find(candidate => candidate.config.id === id);
  if (!view) throw new Error(`unknown fixture session ${id}`);
  return view;
}

async function requestChild(
  targetSessionId = 'ms-child-a',
  requestedRole: 'read' | 'worker' | 'coordinator' = 'worker',
  requestId = `grant-request:${targetSessionId}:${requestedRole}`,
): Promise<TaskBoardGrantRequest> {
  return service.requestChildGrant({
    sourceCapability: topCapability,
    sourceRuntimeGeneration: 1,
    targetSessionId,
    requestedRole,
    requestId,
  });
}

async function approveChild(
  grantRequestId: string,
  requestId = `grant-approval:${grantRequestId}`,
): Promise<TaskBoardBinding> {
  return service.approveChildGrant({
    coordinatorCapability,
    coordinatorRuntimeGeneration: 1,
    grantRequestId,
    requestId,
  });
}

function pauseNextBoardTransaction(): {
  entered: Promise<void>;
  release(): void;
  restore(): void;
} {
  const original = store.transact.bind(store);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const reached = new Promise<void>(resolve => {
    entered = resolve;
  });
  let first = true;
  store.transact = async (...args: Parameters<TaskBoardStore['transact']>) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return original(...args);
  };
  return {
    entered: reached,
    release,
    restore() {
      store.transact = original;
    },
  };
}

describe('task-board creation', () => {
  test('serializes concurrent retries into one stable board creation', async () => {
    const input = {
      creatorSessionId: 'ms-new-top',
      coordinatorSessionId: 'ms-new-coordinator',
      requestId: 'concurrent-create-new-tree-board',
    };
    const results = await Promise.all([service.createBoard(input), service.createBoard(input)]);
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(results.filter(result => !result.created)).toHaveLength(1);
    expect(results[0]!.creatorBinding.boardId).toBe(results[1]!.creatorBinding.boardId);
    expect(results[0]!.creatorBinding.capability).toBe(results[1]!.creatorBinding.capability);
    expect(await store.listBoardIds()).toHaveLength(2);
  });

  test('creates one stable opaque board with exact creator/coordinator grants and replays safely', async () => {
    const created = await service.createBoard({
      creatorSessionId: 'ms-new-top',
      coordinatorSessionId: 'ms-new-coordinator',
      requestId: 'create-new-tree-board',
      creatorMarkDone: true,
    });
    expect(created.created).toBe(true);
    expect(created.creatorBinding.role).toBe('top_agent');
    expect(created.creatorBinding.allowedActions).toContain('mark_done');
    expect(created.coordinatorBinding.role).toBe('coordinator');
    expect(created.coordinatorBinding.allowedActions).toEqual(taskBoardActionsForCurrentCoordinator());
    expect(created.creatorBinding.boardId).toBe(created.coordinatorBinding.boardId);

    const file = await store.require(created.creatorBinding.boardId);
    expect(file.creator).toBe('ms-new-top');
    expect(file.coordinatorSessionId).toBe('ms-new-coordinator');
    expect(file.grants.filter(grant => grant.active)).toHaveLength(2);
    expect(file.audit.at(-1)).toMatchObject({
      event: 'board.created',
      role: 'human_admin',
      requestId: 'create-new-tree-board',
      outcome: 'applied',
    });
    expect(file.appliedRequests.some(request => request.pendingCapability !== undefined)).toBe(false);

    const replay = await service.createBoard({
      creatorSessionId: 'ms-new-top',
      coordinatorSessionId: 'ms-new-coordinator',
      requestId: 'create-new-tree-board',
      creatorMarkDone: true,
    });
    expect(replay.created).toBe(false);
    expect(replay.creatorBinding.capability).toBe(created.creatorBinding.capability);
    expect(replay.coordinatorBinding.capability).toBe(created.coordinatorBinding.capability);
    expect(await store.listBoardIds()).toHaveLength(2);
  });

  test('requires a live interactive root and a descendant coordinator', async () => {
    await expect(
      service.createBoard({
        creatorSessionId: 'ms-worker',
        coordinatorSessionId: 'ms-child-a',
        requestId: 'invalid-nonroot-creator',
      }),
    ).rejects.toThrow(/creator/);
    await expect(
      service.createBoard({
        creatorSessionId: 'ms-new-top',
        coordinatorSessionId: 'ms-outside',
        requestId: 'invalid-external-coordinator',
      }),
    ).rejects.toThrow(/descendant/);
  });
});

describe('task-board two-key child grants', () => {
  test('requires both keys and supports interactive-root to coordinator to worker lineage', async () => {
    const request = await requestChild();
    expect(request).toMatchObject({
      status: 'pending',
      interactiveSourceSessionId: 'ms-top',
      targetSessionId: 'ms-child-a',
      targetParentSessionId: 'ms-coordinator',
      parentLineage: ['ms-child-a', 'ms-coordinator', 'ms-top'],
      coordinatorSessionId: 'ms-coordinator',
      coordinatorLineage: ['ms-coordinator', 'ms-top'],
    });
    expect(await store.readBinding('ms-child-a')).toBeNull();

    await expect(
      service.approveChildGrant({
        coordinatorCapability: topCapability,
        coordinatorRuntimeGeneration: 1,
        grantRequestId: request.requestId,
        requestId: 'wrong-approval-key',
      }),
    ).rejects.toThrow(TaskBoardError);
    expect(await store.readBinding('ms-child-a')).toBeNull();

    const childBinding = await approveChild(request.requestId);
    expect(childBinding.role).toBe('worker');
    expect(childBinding.allowedActions).toEqual(taskBoardActionsForRole('worker'));
    expect(childBinding.allowedActions).not.toContain('mark_done');
    expect(childBinding.allowedActions).not.toContain('grant_request');
    const grant = (await store.require(boardId)).grants.find(candidate => candidate.grantId === childBinding.grantId);
    expect(grant).toMatchObject({
      parentSessionId: 'ms-coordinator',
      interactiveSourceSessionId: 'ms-top',
      coordinatorSessionId: 'ms-coordinator',
    });

    const replay = await approveChild(request.requestId);
    expect(replay.capability).toBe(childBinding.capability);

    // A lost start response may retry the originating request after approval
    // has bumped the board epoch. Exact intent replays its durable result;
    // request-id reuse for another role still fails closed.
    await expect(requestChild()).resolves.toMatchObject({
      requestId: request.requestId,
      status: 'approved',
      grantId: childBinding.grantId,
    });
    await expect(requestChild('ms-child-a', 'read', request.requestId)).rejects.toThrow(
      /reused with a different payload/,
    );
  });

  test('denies known-board, noninteractive, invalid-role, and wrong-branch origination', async () => {
    await expect(
      service.requestChildGrant({
        sourceCapability: boardId,
        sourceRuntimeGeneration: 1,
        targetSessionId: 'ms-child-a',
        requestedRole: 'worker',
        requestId: 'known-board-is-not-authority',
      }),
    ).rejects.toThrow(/unknown board grant capability/);
    await expect(
      service.requestChildGrant({
        sourceCapability: coordinatorCapability,
        sourceRuntimeGeneration: 1,
        targetSessionId: 'ms-child-a',
        requestedRole: 'worker',
        requestId: 'noninteractive-coordinator-origin',
      }),
    ).rejects.toThrow(TaskBoardError);
    session('ms-top').config.mode = 'auto';
    await expect(requestChild('ms-child-a', 'worker', 'top-is-no-longer-interactive')).rejects.toThrow(
      /live interactive/,
    );
    session('ms-top').config.mode = 'interactive';
    await expect(requestChild('ms-wrong-branch', 'worker', 'wrong-branch')).rejects.toThrow(/not descended/);
    await expect(
      service.requestChildGrant({
        sourceCapability: topCapability,
        sourceRuntimeGeneration: 1,
        targetSessionId: 'ms-child-a',
        requestedRole: 'top_agent' as 'worker',
        requestId: 'no-top-agent-propagation',
      }),
    ).rejects.toThrow(/cannot be propagated/);
    await expect(
      service.requestChildGrant({
        sourceCapability: topCapability,
        sourceRuntimeGeneration: 1,
        targetSessionId: 'ms-child-a',
        requestedRole: 'future-role' as 'worker',
        requestId: 'no-unknown-role-propagation',
      }),
    ).rejects.toThrow(/cannot be propagated/);
  });

  test('rechecks coordinator incarnation, runtime, and lineage inside the approval transaction', async () => {
    const request = await requestChild();
    const coordinator = session('ms-coordinator');
    const cases: Array<{ label: string; mutate(): () => void }> = [
      {
        label: 'incarnation',
        mutate() {
          const prior = coordinator.config.incarnation;
          coordinator.config.incarnation = 'inc-coordinator-restarted';
          return () => {
            coordinator.config.incarnation = prior;
          };
        },
      },
      {
        label: 'runtime',
        mutate() {
          const prior = coordinator.config.runtimeGeneration;
          coordinator.config.runtimeGeneration = 2;
          return () => {
            coordinator.config.runtimeGeneration = prior;
          };
        },
      },
      {
        label: 'lineage',
        mutate() {
          const prior = coordinator.config.parent;
          coordinator.config.parent = 'ms-outside';
          return () => {
            coordinator.config.parent = prior;
          };
        },
      },
    ];

    for (const candidate of cases) {
      const gate = pauseNextBoardTransaction();
      const approval = approveChild(request.requestId, `stale-coordinator-${candidate.label}`);
      await gate.entered;
      const restoreIdentity = candidate.mutate();
      gate.release();
      await expect(approval).rejects.toThrow(TaskBoardError);
      restoreIdentity();
      gate.restore();
      expect(await store.readBinding('ms-child-a')).toBeNull();
    }
  });

  test('rejects target identity and full-lineage changes before approval', async () => {
    const request = await requestChild();
    session('ms-child-a').config.parent = 'ms-outside';
    await expect(approveChild(request.requestId, 'changed-target-lineage')).rejects.toThrow(/lineage changed/);
    expect(await store.readBinding('ms-child-a')).toBeNull();
  });

  test('rejects revoke and epoch races between resolution and the request write', async () => {
    const gate = pauseNextBoardTransaction();
    const request = requestChild('ms-child-a', 'worker', 'request-racing-coordinator-revoke');
    await gate.entered;
    try {
      await service.revokeGrant({
        sessionId: 'ms-top',
        requestId: 'revoke-coordinator-during-request',
        grantId: 'tg-coordinator',
        reason: 'coordinator fenced',
      });
    } finally {
      gate.release();
    }
    await expect(request).rejects.toThrow(TaskBoardError);
    gate.restore();
    expect((await store.require(boardId)).grantRequests).toHaveLength(0);
  });

  test('rejects stale request epochs, revoked sources, and coordinator outage before approval', async () => {
    const staleEpoch = await requestChild('ms-child-a', 'worker', 'request-before-epoch');
    await service.setTopAgentMarkDone({ sessionId: 'ms-top', requestId: 'epoch-fence-request', enabled: true });
    await expect(approveChild(staleEpoch.requestId, 'approve-stale-request-epoch')).rejects.toThrow(/stale/);

    const second = await requestChild('ms-child-b', 'worker', 'request-before-source-revoke');
    await store.transact(boardId, current => ({
      ...current,
      grants: current.grants.map(candidate =>
        candidate.grantId === 'tg-top' ? { ...candidate, active: false, revokedAt: at } : candidate,
      ),
    }));
    await expect(approveChild(second.requestId, 'approve-after-source-revoke')).rejects.toThrow(/revoked/);
  });

  test('denies approval when the coordinator goes down after a valid request', async () => {
    session('ms-coordinator').state.status = 'stopped';
    await expect(requestChild('ms-child-a', 'read', 'request-during-outage')).rejects.toThrow(/coordinator/);
    session('ms-coordinator').state.status = 'running';
    const request = await requestChild();
    session('ms-coordinator').state.status = 'stopped';
    await expect(approveChild(request.requestId, 'approval-during-outage')).rejects.toThrow(/coordinator/);
    expect(await store.readBinding('ms-child-a')).toBeNull();
  });

  test('repairs the approval commit-to-binding crash bridge after restart', async () => {
    const request = await requestChild();
    const originalWriteBinding = store.writeBinding.bind(store);
    let crash = true;
    store.writeBinding = async value => {
      if (crash && value.sessionId === 'ms-child-a') {
        crash = false;
        throw new Error('simulated binding write crash');
      }
      return originalWriteBinding(value);
    };
    await expect(approveChild(request.requestId, 'approval-crash-bridge')).rejects.toThrow(/binding write crash/);
    store.writeBinding = originalWriteBinding;

    const committed = await store.require(boardId);
    expect(committed.grantRequests.find(candidate => candidate.requestId === request.requestId)).toMatchObject({
      status: 'approved',
      pendingCapability: expect.any(String),
    });
    expect(await store.readBinding('ms-child-a')).toBeNull();

    service = boardService();
    await service.initialize();
    const repaired = await store.readBinding('ms-child-a');
    if (!repaired) throw new Error('restart reconciliation did not write the child binding');
    expect(repaired.role).toBe('worker');
    expect(
      (await store.require(boardId)).grantRequests.find(candidate => candidate.requestId === request.requestId),
    ).not.toHaveProperty('pendingCapability');
    expect((await approveChild(request.requestId, 'approval-crash-bridge')).capability).toBe(repaired.capability);
  });

  test('does not enlarge coordinator children and never lets them originate or approve', async () => {
    const request = await requestChild('ms-child-a', 'coordinator', 'request-child-coordinator');
    const child = await approveChild(request.requestId, 'approve-child-coordinator');
    expect(child.allowedActions).toEqual(taskBoardActionsForRole('coordinator'));
    expect(child.allowedActions).not.toContain('grant_approve');
    expect(child.allowedActions).not.toContain('grant_request');
    expect(child.allowedActions).not.toContain('mark_done');
    expect(child.allowedActions).not.toContain('acl_admin');

    await expect(
      service.requestChildGrant({
        sourceCapability: child.capability,
        sourceRuntimeGeneration: 1,
        targetSessionId: 'ms-child-b',
        requestedRole: 'worker',
        requestId: 'child-cannot-originate',
      }),
    ).rejects.toThrow(TaskBoardError);
    const second = await requestChild('ms-child-b', 'worker', 'top-originates-second');
    await expect(
      service.approveChildGrant({
        coordinatorCapability: child.capability,
        coordinatorRuntimeGeneration: 1,
        grantRequestId: second.requestId,
        requestId: 'child-cannot-approve',
      }),
    ).rejects.toThrow(/not allowed to grant_approve/);
    expect(await store.readBinding('ms-child-b')).toBeNull();
  });

  test('keeps terminal replay identities at the grant cap and fails closed for new intent', async () => {
    service = boardService({}, { maxGrantRequests: 1 });
    const request = await requestChild('ms-child-a', 'worker', 'cap-request');
    await approveChild(request.requestId, 'cap-approval');

    expect((await requestChild('ms-child-a', 'worker', 'cap-request')).status).toBe('approved');
    await expect(requestChild('ms-child-a', 'read', 'cap-request')).rejects.toThrow(/request id|different payload/);
    await expect(requestChild('ms-child-b', 'worker', 'over-cap-request')).rejects.toThrow(/fail-closed capacity/);
    expect((await store.require(boardId)).grantRequests.map(candidate => candidate.requestId)).toEqual(['cap-request']);
  });

  test('persists expired intent as an audited replay-safe terminal denial', async () => {
    const request = await requestChild('ms-child-a', 'worker', 'expiring-grant-request');
    await store.transact(boardId, current => ({
      ...current,
      grantRequests: current.grantRequests.map(candidate =>
        candidate.requestId === request.requestId ? { ...candidate, expiresAt: '2020-01-01T00:00:00.000Z' } : candidate,
      ),
    }));

    await expect(approveChild(request.requestId, 'expired-grant-approval')).rejects.toThrow(/has expired/);
    let file = await store.require(boardId);
    expect(file.grantRequests.find(candidate => candidate.requestId === request.requestId)).toMatchObject({
      status: 'expired',
      refusalReason: 'grant request expired before approval',
    });
    expect(file.audit.at(-1)).toMatchObject({
      event: 'grant.expired',
      outcome: 'applied',
      requestId: 'expired-grant-approval',
      detail: { grantRequestId: request.requestId },
    });

    await expect(approveChild(request.requestId, 'expired-grant-approval')).rejects.toThrow(/has expired/);
    file = await store.require(boardId);
    expect(file.audit.at(-1)).toMatchObject({ event: 'grant.expired', outcome: 'replayed' });
    expect((await requestChild('ms-child-a', 'worker', 'expiring-grant-request')).status).toBe('expired');
    await expect(requestChild('ms-child-a', 'read', 'expiring-grant-request')).rejects.toThrow(/request id|payload/);

    const second = await requestChild('ms-child-b', 'worker', 'second-grant-request');
    await expect(approveChild(second.requestId, 'expired-grant-approval')).rejects.toThrow(/request id/);
    expect(await store.readBinding('ms-child-b')).toBeNull();
  });

  test('retains applied request identity beyond the former lifetime cap with bounded append cost', () => {
    let ledger: TaskBoardAppliedRequest[] = [];
    const started = performance.now();
    for (let index = 0; index < 5_000; index += 1) {
      ledger = appendTaskBoardAppliedRequest(ledger, {
        requestId: `request-${index}`,
        payloadHash: 'a'.repeat(64),
        action: 'status',
        actorSessionId: 'ms-worker',
        role: 'worker',
        grantId: 'tg-worker',
        capabilityId: 'tg-worker',
        boardEpoch: 1,
        coordinatorEpoch: 1,
        runtimeGeneration: 1,
        appliedAt: at,
        taskId: '#F1',
      });
    }
    expect(ledger).toHaveLength(5_000);
    expect(ledger[0]?.requestId).toBe('request-0');
    expect(ledger.at(-1)?.requestId).toBe('request-4999');
    expect(performance.now() - started).toBeLessThan(1_000);

    const pending = {
      requestId: 'pending',
      status: 'pending',
    } as TaskBoardGrantRequest;
    const terminal = {
      requestId: 'terminal',
      status: 'approved',
    } as TaskBoardGrantRequest;
    expect(() => compactTaskBoardGrantRequests([terminal, pending], 1)).toThrow(/fail-closed capacity/);
  });
});

describe('explicit external-root membership', () => {
  test('lets only one board claim an external root under concurrent acceptance', async () => {
    const second = await service.createBoard({
      creatorSessionId: 'ms-new-top',
      coordinatorSessionId: 'ms-new-coordinator',
      requestId: 'create-competing-board',
    });
    const firstInvitation = await service.requestExternalInvitation({
      sourceCapability: topCapability,
      sourceRuntimeGeneration: 1,
      targetSessionId: 'ms-outside',
      requestId: 'first-board-invitation',
    });
    const secondInvitation = await service.requestExternalInvitation({
      sourceCapability: second.creatorBinding.capability,
      sourceRuntimeGeneration: 1,
      targetSessionId: 'ms-outside',
      requestId: 'second-board-invitation',
    });
    const firstApproved = await service.approveExternalInvitation({
      coordinatorCapability,
      coordinatorRuntimeGeneration: 1,
      invitationRequestId: firstInvitation.requestId,
      requestId: 'approve-first-board-invitation',
    });
    const secondApproved = await service.approveExternalInvitation({
      coordinatorCapability: second.coordinatorBinding.capability,
      coordinatorRuntimeGeneration: 1,
      invitationRequestId: secondInvitation.requestId,
      requestId: 'approve-second-board-invitation',
    });

    const outcomes = await Promise.allSettled([
      service.acceptExternalInvitation({
        targetSessionId: 'ms-outside',
        targetRuntimeGeneration: 1,
        acceptanceCapability: firstApproved.acceptanceCapability,
        requestId: 'accept-first-board-invitation',
      }),
      service.acceptExternalInvitation({
        targetSessionId: 'ms-outside',
        targetRuntimeGeneration: 1,
        acceptanceCapability: secondApproved.acceptanceCapability,
        requestId: 'accept-second-board-invitation',
      }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);

    const outsideBinding = await store.readBinding('ms-outside');
    expect(outsideBinding).not.toBeNull();
    let activeMemberships = 0;
    for (const candidateBoardId of await store.listBoardIds()) {
      const file = await store.require(candidateBoardId);
      activeMemberships += file.grants.filter(grant => grant.active && grant.sessionId === 'ms-outside').length;
    }
    expect(activeMemberships).toBe(1);
  });

  test('serializes crash-bridge reconciliation against cross-board creation', async () => {
    const invitation = await service.requestExternalInvitation({
      sourceCapability: topCapability,
      sourceRuntimeGeneration: 1,
      targetSessionId: 'ms-new-top',
      requestId: 'reconcile-create-race-invitation',
    });
    const approved = await service.approveExternalInvitation({
      coordinatorCapability,
      coordinatorRuntimeGeneration: 1,
      invitationRequestId: invitation.requestId,
      requestId: 'approve-reconcile-create-race',
    });

    const originalWriteBinding = store.writeBinding.bind(store);
    let crash = true;
    store.writeBinding = async value => {
      if (crash && value.sessionId === 'ms-new-top') {
        crash = false;
        throw new Error('simulated invitation binding crash');
      }
      return originalWriteBinding(value);
    };
    await expect(
      service.acceptExternalInvitation({
        targetSessionId: 'ms-new-top',
        targetRuntimeGeneration: 1,
        acceptanceCapability: approved.acceptanceCapability,
        requestId: 'accept-reconcile-create-race',
      }),
    ).rejects.toThrow(/binding crash/);

    let releaseWrite!: () => void;
    let enteredWrite!: () => void;
    const writeGate = new Promise<void>(resolve => {
      releaseWrite = resolve;
    });
    const writeEntered = new Promise<void>(resolve => {
      enteredWrite = resolve;
    });
    let pause = true;
    store.writeBinding = async value => {
      if (pause && value.sessionId === 'ms-new-top') {
        pause = false;
        enteredWrite();
        await writeGate;
      }
      return originalWriteBinding(value);
    };

    const reconciliation = service.reconcilePendingBindings();
    await writeEntered;
    const creation = service.createBoard({
      creatorSessionId: 'ms-new-top',
      coordinatorSessionId: 'ms-new-coordinator',
      requestId: 'create-during-binding-reconciliation',
    });
    let creationSettled = false;
    void creation.then(
      () => {
        creationSettled = true;
      },
      () => {
        creationSettled = true;
      },
    );
    await Bun.sleep(20);
    expect(creationSettled).toBe(false);

    releaseWrite();
    await reconciliation;
    await expect(creation).rejects.toThrow(/already a task-board member/);
    store.writeBinding = originalWriteBinding;

    const targetBinding = await store.readBinding('ms-new-top');
    expect(targetBinding?.boardId).toBe(boardId);
    let activeMemberships = 0;
    for (const candidateBoardId of await store.listBoardIds()) {
      const file = await store.require(candidateBoardId);
      activeMemberships += file.grants.filter(grant => grant.active && grant.sessionId === 'ms-new-top').length;
    }
    expect(activeMemberships).toBe(1);
  });

  test('requires originator, coordinator, and invitee acceptance before access or voluntary relinquish', async () => {
    const invitation = await service.requestExternalInvitation({
      sourceCapability: topCapability,
      sourceRuntimeGeneration: 1,
      targetSessionId: 'ms-outside',
      requestId: 'invite-external-root',
    });
    expect(invitation).toMatchObject({
      status: 'pending',
      sourceSessionId: 'ms-top',
      targetSessionId: 'ms-outside',
      coordinatorSessionId: 'ms-coordinator',
    });
    expect(await store.readBinding('ms-outside')).toBeNull();
    await expect(
      service.relinquishMembership({
        capability: topCapability,
        runtimeGeneration: 1,
        requestId: 'relinquish-before-acceptance',
      }),
    ).rejects.toThrow(/accepted replacement root/);

    await expect(
      service.approveExternalInvitation({
        coordinatorCapability: topCapability,
        coordinatorRuntimeGeneration: 1,
        invitationRequestId: invitation.requestId,
        requestId: 'wrong-invitation-approval-key',
      }),
    ).rejects.toThrow(TaskBoardError);
    const approved = await service.approveExternalInvitation({
      coordinatorCapability,
      coordinatorRuntimeGeneration: 1,
      invitationRequestId: invitation.requestId,
      requestId: 'approve-external-root',
    });
    expect(approved.invitation.status).toBe('approved');
    expect(approved.acceptanceCapability).toBeTruthy();
    expect(await store.readBinding('ms-outside')).toBeNull();

    await expect(
      service.acceptExternalInvitation({
        targetSessionId: 'ms-new-top',
        targetRuntimeGeneration: 1,
        acceptanceCapability: approved.acceptanceCapability,
        requestId: 'wrong-invitee-acceptance',
      }),
    ).rejects.toThrow(/invitee generation/);
    const outsideBinding = await service.acceptExternalInvitation({
      targetSessionId: 'ms-outside',
      targetRuntimeGeneration: 1,
      acceptanceCapability: approved.acceptanceCapability,
      requestId: 'accept-external-root',
    });
    expect(outsideBinding.role).toBe('top_agent');
    expect(outsideBinding.allowedActions).toEqual(taskBoardActionsForRole('top_agent'));
    expect(outsideBinding.allowedActions).not.toContain('mark_done');
    const acceptedBoard = await store.require(boardId);
    expect(acceptedBoard.grants.filter(grant => grant.active && grant.role === 'top_agent')).toHaveLength(2);
    expect(acceptedBoard.grants.find(grant => grant.grantId === outsideBinding.grantId)).toMatchObject({
      membershipRootSessionId: 'ms-outside',
      parentSessionId: null,
    });

    // A descendant gains nothing from its invited root until that root opens
    // an exact child request and the same current coordinator approves it.
    expect(await store.readBinding('ms-wrong-branch')).toBeNull();
    const descendantRequest = await service.requestChildGrant({
      sourceCapability: outsideBinding.capability,
      sourceRuntimeGeneration: 1,
      targetSessionId: 'ms-wrong-branch',
      requestedRole: 'read',
      requestId: 'external-root-child-request',
    });
    expect(await store.readBinding('ms-wrong-branch')).toBeNull();
    const descendantBinding = await service.approveChildGrant({
      coordinatorCapability,
      coordinatorRuntimeGeneration: 1,
      grantRequestId: descendantRequest.requestId,
      requestId: 'external-root-child-approval',
    });
    expect(descendantBinding.role).toBe('read');

    const relinquished = await service.relinquishMembership({
      capability: topCapability,
      runtimeGeneration: 1,
      requestId: 'voluntary-root-relinquish',
    });
    expect(relinquished.grants.find(grant => grant.grantId === 'tg-top')?.active).toBe(false);
    expect(session('ms-top').state.status).toBe('running');
    await expect(
      service.resolveTaskScope(
        'ms-top',
        { boardCapability: topCapability, runtimeGeneration: 1, requestId: 'old-root-read' },
        'read',
      ),
    ).rejects.toThrow(/revoked/);
    const replay = await service.relinquishMembership({
      capability: topCapability,
      runtimeGeneration: 1,
      requestId: 'voluntary-root-relinquish',
    });
    expect(replay.boardEpoch).toBe(relinquished.boardEpoch);
  });

  test('denies non-root targets, multiple outstanding invitations, and stale approval epochs', async () => {
    await expect(
      service.requestExternalInvitation({
        sourceCapability: topCapability,
        sourceRuntimeGeneration: 1,
        targetSessionId: 'ms-wrong-branch',
        requestId: 'invite-nonroot',
      }),
    ).rejects.toThrow(/top-level/);
    const invitation = await service.requestExternalInvitation({
      sourceCapability: topCapability,
      sourceRuntimeGeneration: 1,
      targetSessionId: 'ms-outside',
      requestId: 'invite-before-epoch-change',
    });
    await expect(
      service.requestExternalInvitation({
        sourceCapability: topCapability,
        sourceRuntimeGeneration: 1,
        targetSessionId: 'ms-new-top',
        requestId: 'second-outstanding-invite',
      }),
    ).rejects.toThrow(/outstanding/);

    await service.setTopAgentMarkDone({
      sessionId: 'ms-top',
      requestId: 'bump-before-invite-approval',
      enabled: true,
    });
    await expect(
      service.approveExternalInvitation({
        coordinatorCapability,
        coordinatorRuntimeGeneration: 1,
        invitationRequestId: invitation.requestId,
        requestId: 'stale-invite-approval',
      }),
    ).rejects.toThrow(/stale/);
    expect(await store.readBinding('ms-outside')).toBeNull();
    const refused = await store.require(boardId);
    expect(refused.invitations.find(candidate => candidate.requestId === invitation.requestId)).toMatchObject({
      status: 'refused',
      refusalReason: 'board epoch advanced when creator mark_done authority changed',
    });
    expect(refused.audit).toContainEqual(
      expect.objectContaining({
        event: 'invitation.refused',
        role: 'human_admin',
        outcome: 'applied',
        detail: expect.objectContaining({ invitationRequestId: invitation.requestId, automatic: true }),
      }),
    );
  });
});

describe('task-board coordinator replacement', () => {
  test('recovers from coordinator outage, fences the old epoch, and accepts only the replacement key', async () => {
    const oldRequest = await requestChild('ms-child-a', 'worker', 'request-before-coordinator-outage');
    const oldInvitation = await service.requestExternalInvitation({
      sourceCapability: topCapability,
      sourceRuntimeGeneration: 1,
      targetSessionId: 'ms-outside',
      requestId: 'invitation-before-coordinator-outage',
    });
    session('ms-coordinator').state.status = 'stopped';
    await expect(approveChild(oldRequest.requestId, 'old-coordinator-is-down')).rejects.toThrow(/coordinator/);

    const replacement = await service.replaceCoordinator({
      sessionId: 'ms-top',
      replacementSessionId: 'ms-replacement',
      requestId: 'replace-coordinator',
    });
    expect(replacement).toMatchObject({
      sessionId: 'ms-replacement',
      role: 'coordinator',
      boardEpoch: 2,
      coordinatorEpoch: 2,
    });
    const replaced = await store.require(boardId);
    expect(replaced.coordinatorSessionId).toBe('ms-replacement');
    expect(replaced.grantRequests.find(candidate => candidate.requestId === oldRequest.requestId)).toMatchObject({
      status: 'refused',
      refusalReason: 'coordinator replaced before approval',
    });
    expect(replaced.invitations.find(candidate => candidate.requestId === oldInvitation.requestId)).toMatchObject({
      status: 'refused',
      refusalReason: 'coordinator replaced before approval',
    });
    expect(replaced.grants.find(candidate => candidate.grantId === 'tg-coordinator')?.active).toBe(false);
    expect(replaced.audit.at(-1)).toMatchObject({
      event: 'coordinator.replaced',
      role: 'human_admin',
      outcome: 'applied',
      boardEpoch: 2,
      coordinatorEpoch: 2,
      detail: {
        revokedGrantIds: ['tg-coordinator'],
        refusedGrantRequestIds: [oldRequest.requestId],
        refusedInvitationRequestIds: [oldInvitation.requestId],
      },
    });
    expect(replaced.audit).toContainEqual(
      expect.objectContaining({
        event: 'grant.revoked',
        role: 'human_admin',
        detail: expect.objectContaining({ grantId: 'tg-coordinator', automatic: true }),
      }),
    );
    expect(replaced.audit).toContainEqual(
      expect.objectContaining({
        event: 'invitation.refused',
        role: 'human_admin',
        detail: expect.objectContaining({ invitationRequestId: oldInvitation.requestId, automatic: true }),
      }),
    );

    expect(
      (
        await service.replaceCoordinator({
          sessionId: 'ms-top',
          replacementSessionId: 'ms-replacement',
          requestId: 'replace-coordinator',
        })
      ).capability,
    ).toBe(replacement.capability);

    const next = await requestChild('ms-child-b', 'worker', 'request-after-coordinator-replacement');
    await expect(
      service.approveChildGrant({
        coordinatorCapability,
        coordinatorRuntimeGeneration: 1,
        grantRequestId: next.requestId,
        requestId: 'old-coordinator-cannot-approve',
      }),
    ).rejects.toThrow(TaskBoardError);
    const child = await service.approveChildGrant({
      coordinatorCapability: replacement.capability,
      coordinatorRuntimeGeneration: 1,
      grantRequestId: next.requestId,
      requestId: 'replacement-coordinator-approves',
    });
    expect(child.role).toBe('worker');

    await expect(
      service.resolveTaskScope(
        'ms-replacement',
        {
          boardCapability: replacement.capability,
          runtimeGeneration: 1,
          requestId: 'agent-cannot-replace-coordinator',
        },
        'acl_admin',
      ),
    ).rejects.toThrow(TaskBoardError);
  });

  test('repairs a coordinator central-commit to binding-write crash on restart', async () => {
    const originalWriteBinding = store.writeBinding.bind(store);
    let crash = true;
    store.writeBinding = async value => {
      if (crash && value.sessionId === 'ms-replacement') {
        crash = false;
        throw new Error('simulated replacement binding crash');
      }
      return originalWriteBinding(value);
    };
    await expect(
      service.replaceCoordinator({
        sessionId: 'ms-top',
        replacementSessionId: 'ms-replacement',
        requestId: 'replacement-crash-bridge',
      }),
    ).rejects.toThrow(/replacement binding crash/);
    store.writeBinding = originalWriteBinding;

    const committed = await store.require(boardId);
    expect(committed.coordinatorSessionId).toBe('ms-replacement');
    expect(
      committed.appliedRequests.find(candidate => candidate.requestId === 'replacement-crash-bridge'),
    ).toMatchObject({
      resultSessionId: 'ms-replacement',
      pendingCapability: expect.any(String),
      resultBoardEpoch: 2,
      resultCoordinatorEpoch: 2,
    });
    expect(await store.readBinding('ms-replacement')).toBeNull();

    service = boardService();
    await service.initialize();
    const repaired = await store.readBinding('ms-replacement');
    if (!repaired) throw new Error('replacement binding was not reconciled');
    expect(repaired.coordinatorEpoch).toBe(2);
    expect((await store.readBinding('ms-top'))?.coordinatorEpoch).toBe(2);
    expect((await store.readBinding('ms-worker'))?.coordinatorEpoch).toBe(2);
    expect(
      (await store.require(boardId)).appliedRequests.find(
        candidate => candidate.requestId === 'replacement-crash-bridge',
      ),
    ).not.toHaveProperty('pendingCapability');
    expect(
      (
        await service.replaceCoordinator({
          sessionId: 'ms-top',
          replacementSessionId: 'ms-replacement',
          requestId: 'replacement-crash-bridge',
        })
      ).capability,
    ).toBe(repaired.capability);
  });

  test('audits automatic crash-bridge refusal as daemon provenance', async () => {
    const request = await requestChild();
    const originalWriteBinding = store.writeBinding.bind(store);
    store.writeBinding = async value => {
      if (value.sessionId === 'ms-child-a') throw new Error('simulated child binding crash');
      return originalWriteBinding(value);
    };
    await expect(approveChild(request.requestId, 'approval-before-invalid-restart')).rejects.toThrow(
      /child binding crash/,
    );
    store.writeBinding = originalWriteBinding;
    session('ms-child-a').config.parent = 'ms-outside';

    service = boardService();
    await service.initialize();
    const reconciled = await store.require(boardId);
    const refused = reconciled.grantRequests.find(candidate => candidate.requestId === request.requestId);
    expect(refused).toMatchObject({ status: 'refused', refusalReason: 'target identity or lineage changed' });
    expect(reconciled.grants.find(candidate => candidate.grantId === refused?.grantId)?.active).toBe(false);
    expect(reconciled.audit.at(-1)).toMatchObject({
      event: 'grant.revoked',
      actorSessionId: null,
      actorName: 'daemon',
      role: 'daemon',
      action: 'reconcile',
      capabilityId: 'daemon-internal-reconciler',
      outcome: 'applied',
      detail: { automatic: true, grantRequestId: request.requestId },
    });
  });

  test('retains security audit provenance beyond the former 8192-record bound', async () => {
    await store.transact(boardId, current => ({
      ...current,
      audit: Array.from({ length: 8_192 }, (_, index) => ({
        seq: index + 1,
        time: at,
        event: 'task.mutation' as const,
        actorSessionId: null,
        actorName: 'user',
        role: 'human_admin' as const,
        boardEpoch: 1,
        coordinatorEpoch: 1,
        runtimeGeneration: null,
        action: 'status' as const,
        capabilityId: 'daemon-admin-token',
        requestId: `historical-audit-${index}`,
        payloadHash: 'b'.repeat(64),
        outcome: 'denied' as const,
      })),
    }));
    await service.setTopAgentMarkDone({
      sessionId: 'ms-top',
      requestId: 'audit-beyond-former-cap',
      enabled: true,
    });
    const file = await store.require(boardId);
    expect(file.audit).toHaveLength(8_193);
    expect(file.audit[0]?.requestId).toBe('historical-audit-0');
    expect(file.audit.at(-1)?.requestId).toBe('audit-beyond-former-cap');
  });
});

describe('task-board ACL replay', () => {
  test('replays each self-induced epoch exactly once and fences request reuse after a later ACL epoch', async () => {
    const enabled = await service.setTopAgentMarkDone({
      sessionId: 'ms-top',
      requestId: 'enable-mark-done',
      enabled: true,
    });
    expect(enabled.boardEpoch).toBe(2);
    expect(enabled.allowedActions).toContain('mark_done');

    const enableReplay = await service.setTopAgentMarkDone({
      sessionId: 'ms-top',
      requestId: 'enable-mark-done',
      enabled: true,
    });
    expect(enableReplay.boardEpoch).toBe(2);

    const disabled = await service.setTopAgentMarkDone({
      sessionId: 'ms-top',
      requestId: 'disable-mark-done',
      enabled: false,
    });
    expect(disabled.boardEpoch).toBe(3);
    expect(disabled.allowedActions).not.toContain('mark_done');
    expect(
      (
        await service.setTopAgentMarkDone({
          sessionId: 'ms-top',
          requestId: 'disable-mark-done',
          enabled: false,
        })
      ).boardEpoch,
    ).toBe(3);

    await expect(
      service.setTopAgentMarkDone({
        sessionId: 'ms-top',
        requestId: 'enable-mark-done',
        enabled: true,
      }),
    ).rejects.toThrow(TaskBoardError);

    await service.setTopAgentMarkDone({
      sessionId: 'ms-top',
      requestId: 'reenable-mark-done',
      enabled: true,
    });
    const revoked = await service.revokeGrant({
      sessionId: 'ms-top',
      requestId: 'revoke-worker',
      grantId: 'tg-worker',
      reason: 'worker finished',
    });
    expect(revoked.boardEpoch).toBe(5);
    expect(revoked.grants.find(candidate => candidate.grantId === 'tg-worker')?.active).toBe(false);
    expect(
      (
        await service.revokeGrant({
          sessionId: 'ms-top',
          requestId: 'revoke-worker',
          grantId: 'tg-worker',
          reason: 'worker finished',
        })
      ).boardEpoch,
    ).toBe(5);

    await service.setTopAgentMarkDone({
      sessionId: 'ms-top',
      requestId: 'final-disable-mark-done',
      enabled: false,
    });
    await expect(
      service.revokeGrant({
        sessionId: 'ms-top',
        requestId: 'revoke-worker',
        grantId: 'tg-worker',
        reason: 'worker finished',
      }),
    ).rejects.toThrow(/another authorization generation/);

    const file = await store.require(boardId);
    const enableApplied = file.appliedRequests.find(entry => entry.requestId === 'enable-mark-done');
    expect(enableApplied).toMatchObject({
      boardEpoch: 1,
      coordinatorEpoch: 1,
      resultBoardEpoch: 2,
      resultCoordinatorEpoch: 1,
    });
    const revokeApplied = file.appliedRequests.find(entry => entry.requestId === 'revoke-worker');
    expect(revokeApplied).toMatchObject({
      boardEpoch: 4,
      coordinatorEpoch: 1,
      resultBoardEpoch: 5,
      resultCoordinatorEpoch: 1,
    });

    const mutationEvents = new Map(
      file.audit.filter(entry => entry.outcome === 'applied').map(entry => [entry.requestId, entry.event] as const),
    );
    expect(mutationEvents.get('enable-mark-done')).toBe('grant.updated');
    expect(mutationEvents.get('disable-mark-done')).toBe('grant.updated');
    expect(mutationEvents.get('revoke-worker')).toBe('grant.revoked');
  });
});

describe('TaskService central-board integration', () => {
  test('shares one board without aggregate duplicates, hides board identity, and restricts peer aggregate reads', async () => {
    const taskService = tasks();
    const sharedId = await createAssignedTask(taskService);
    const outside = await taskService.sessionTaskCreate(
      'ms-outside',
      { kind: 'bug', title: 'Outside task', ask: { text: 'Outside task', source: 'session:ms-outside' } },
      { actor: 'user', actorName: 'user' },
    );

    const human = await taskService.taskList();
    expect(human.tasks.map(task => task.id).sort()).toEqual([outside.id, sharedId].sort());
    expect(human.tasks.filter(task => task.id === sharedId)).toHaveLength(1);

    const peer = await taskService.taskList({}, grantedActor('ms-top', 'aggregate-read'));
    expect(peer.tasks.map(task => task.id)).toEqual([sharedId]);
    expect(peer.authorization).toMatchObject({ role: 'top_agent', action: 'read' });
    expect(JSON.stringify(peer)).not.toContain('boardId');

    const outsidePeer = await taskService.taskList({}, { actor: 'ms-outside', actorName: 'outside' });
    expect(outsidePeer.tasks.map(task => task.id)).toEqual([outside.id]);
    expect(await taskService.taskDetail(outside.id, 0, grantedActor('ms-worker', 'foreign-detail'))).toBeUndefined();

    const coordinatorList = await taskService.sessionTaskList(
      'ms-coordinator',
      {},
      grantedActor('ms-coordinator', 'coordinator-read'),
    );
    expect(coordinatorList.tasks.map(task => task.id)).toEqual([sharedId]);
    expect(coordinatorList.authorization).toMatchObject({ role: 'coordinator', action: 'read' });
    expect(coordinatorList.authorization).not.toHaveProperty('boardId');
  });

  test('enforces worker assignment and explicit top-agent mark_done without coordinator inheritance', async () => {
    const taskService = tasks();
    const id = await createAssignedTask(taskService);
    const noted = await taskService.sessionTaskAct(
      'ms-worker',
      id,
      { action: 'note', text: 'worker-owned note' },
      grantedActor('ms-worker', 'worker-note'),
    );
    expect(noted.id).toBe(id);

    await taskService.sessionTaskAct(
      'ms-top',
      id,
      { action: 'assign', assignee: 'ms-coordinator' },
      grantedActor('ms-top', 'reassign'),
    );
    await expect(
      taskService.sessionTaskAct(
        'ms-worker',
        id,
        { action: 'note', text: 'stale worker note' },
        grantedActor('ms-worker', 'stale-worker-note'),
      ),
    ).rejects.toThrow(/worker edits are limited/);

    await taskService.sessionTaskAct(
      'ms-top',
      id,
      { action: 'phase', phase: 'built', reason: 'built' },
      grantedActor('ms-top', 'to-built'),
    );
    await taskService.sessionTaskAct(
      'ms-top',
      id,
      { action: 'phase', phase: 'live', reason: 'deployed' },
      grantedActor('ms-top', 'to-live'),
    );
    await expect(
      taskService.sessionTaskAct(
        'ms-coordinator',
        id,
        { action: 'phase', phase: 'done', reason: 'not allowed' },
        grantedActor('ms-coordinator', 'coordinator-done'),
      ),
    ).rejects.toThrow(/not allowed to mark_done/);
    await expect(
      taskService.sessionTaskAct(
        'ms-top',
        id,
        { action: 'phase', phase: 'done', reason: 'not yet granted' },
        grantedActor('ms-top', 'top-done-before-grant'),
      ),
    ).rejects.toThrow(/not allowed to mark_done/);

    await service.setTopAgentMarkDone({ sessionId: 'ms-top', requestId: 'enable-top-done', enabled: true });
    const done = await taskService.sessionTaskAct(
      'ms-top',
      id,
      { action: 'phase', phase: 'done', reason: 'creator-granted verification' },
      { ...grantedActor('ms-top', 'top-done'), runtimeGeneration: 1 },
    );
    expect(done.phase).toBe('done');
  });

  test('rejects a stale mutation when an epoch bump lands after resolution but before the board write', async () => {
    const taskService = tasks();
    const id = await createAssignedTask(taskService);
    const pause = pauseNextTaskMutation();
    const pending = taskService.sessionTaskAct(
      'ms-worker',
      id,
      { action: 'note', text: 'must not land' },
      grantedActor('ms-worker', 'raced-epoch-note'),
    );
    await pause.entered;
    await service.setTopAgentMarkDone({ sessionId: 'ms-top', requestId: 'raced-epoch-bump', enabled: true });
    pause.release();
    await expect(pending).rejects.toThrow(TaskBoardError);
    pause.restore();
    expect((await store.detailTask(boardId, id))?.activity.some(item => item.data['text'] === 'must not land')).toBe(
      false,
    );
  });

  test('rejects the fence-before-central-rebind window using current daemon generation', async () => {
    const taskService = tasks();
    const id = await createAssignedTask(taskService);
    const pause = pauseNextTaskMutation();
    const pending = taskService.sessionTaskAct(
      'ms-worker',
      id,
      { action: 'note', text: 'old runtime write' },
      grantedActor('ms-worker', 'raced-runtime-note'),
    );
    await pause.entered;
    sessions.find(view => view.config.id === 'ms-worker')!.config.runtimeGeneration = 2;
    pause.release();
    await expect(pending).rejects.toThrow(TaskBoardError);
    pause.restore();
    expect(
      (await store.detailTask(boardId, id))?.activity.some(item => item.data['text'] === 'old runtime write'),
    ).toBe(false);
  });

  test('rechecks worker assignment inside the board queue', async () => {
    const taskService = tasks();
    const id = await createAssignedTask(taskService);
    const pause = pauseNextTaskMutation();
    const pending = taskService.sessionTaskAct(
      'ms-worker',
      id,
      { action: 'note', text: 'stale assignment write' },
      grantedActor('ms-worker', 'raced-assignment-note'),
    );
    await pause.entered;
    await store.transact(boardId, current => ({
      ...current,
      taskState: {
        ...current.taskState,
        tasks: current.taskState.tasks.map(entry =>
          entry.task.id === id
            ? { ...entry, task: { ...entry.task, assignee: 'ms-coordinator', updatedAt: at } }
            : entry,
        ),
      },
    }));
    pause.release();
    await expect(pending).rejects.toThrow(TaskBoardError);
    pause.restore();
    const current = await store.detailTask(boardId, id);
    expect(current?.task.assignee).toBe('ms-coordinator');
    expect(current?.activity.some(item => item.data['text'] === 'stale assignment write')).toBe(false);
  });

  test('rechecks the task-derived action class inside the board queue', async () => {
    const taskService = tasks();
    const id = await createAssignedTask(taskService, 'Action-class race');
    const pause = pauseNextTaskMutation();
    const pending = taskService.sessionTaskAct(
      'ms-top',
      id,
      { action: 'phase', phase: 'done', reason: 'must not cross into mark_done' },
      grantedActor('ms-top', 'raced-action-class'),
    );
    await pause.entered;
    await store.transact(boardId, current => ({
      ...current,
      taskState: {
        ...current.taskState,
        tasks: current.taskState.tasks.map(entry =>
          entry.task.id === id
            ? { ...entry, task: { ...entry.task, phase: 'live', status: 'live', updatedAt: at } }
            : entry,
        ),
      },
    }));
    pause.release();
    await expect(pending).rejects.toThrow(/authorization class/);
    pause.restore();
    expect((await store.detailTask(boardId, id))?.task.phase).toBe('live');
  });

  test('keeps daemon authorization least-privilege and never treats it as human approval', async () => {
    const taskService = tasks();
    const research = await taskService.sessionTaskCreate(
      'ms-top',
      {
        kind: 'feature',
        title: 'Research gate',
        ask: { text: 'Research gate', source: 'session:ms-top' },
        phase: 'research',
        workflow: 'investigate',
      },
      grantedActor('ms-top', 'create-research'),
    );
    await expect(
      taskService.sessionTaskAct(
        'ms-top',
        research.id,
        { action: 'phase', phase: 'done', reason: 'daemon is not the human' },
        { actor: 'daemon', daemonAdmin: true, requestId: 'daemon-research-approval' },
      ),
    ).rejects.toThrow(TaskError);

    for (const action of ['create', 'mark_done', 'grant_request', 'grant_approve', 'acl_admin', 'reconcile'] as const) {
      await expect(
        service.resolveTaskScope(
          'ms-top',
          { actor: 'daemon', daemonAdmin: true, requestId: `daemon-${action}` },
          action,
        ),
      ).rejects.toThrow(/daemon is not allowed/);
    }
    await expect(
      service.resolveTaskScope('ms-top', { actor: 'daemon', daemonAdmin: true, requestId: 'daemon-read' }, 'read'),
    ).resolves.toMatchObject({ kind: 'board' });
  });

  test('rejects a delayed completion event after the live session generation changes', async () => {
    const taskService = tasks();
    const id = await createAssignedTask(taskService, 'Generation-bound completion');
    const workerView = sessions.find(view => view.config.id === 'ms-worker')!;
    const staleEvent: KTeamEvent = {
      sequence: 1,
      time: at,
      sessionId: 'ms-worker',
      turn: 7,
      type: 'session.completed',
      source: 'daemon',
      data: { sessionIncarnation: 'inc-worker', runtimeGeneration: 1 },
    };
    workerView.config.runtimeGeneration = 2;

    await expect(taskService.recordSessionCompletion(staleEvent)).rejects.toThrow(/generation|fenced/);
    expect((await store.detailTask(boardId, id))?.task.phase).toBe('build');
  });
});

function grant(
  grantId: string,
  sessionId: string,
  sessionIncarnation: string,
  role: Exclude<TaskBoardRole, 'none'>,
  capability: string,
): TaskBoardGrant {
  return {
    grantId,
    capabilityHash: hashTaskBoardSecret(capability),
    sessionId,
    sessionIncarnation,
    runtimeGeneration: 1,
    role,
    allowedActions:
      role === 'coordinator' && sessionId === 'ms-coordinator'
        ? taskBoardActionsForCurrentCoordinator()
        : taskBoardActionsForRole(role),
    parentSessionId: sessionId === 'ms-top' ? null : 'ms-top',
    interactiveSourceSessionId: 'ms-top',
    coordinatorSessionId: 'ms-coordinator',
    membershipRootSessionId: role === 'top_agent' ? sessionId : 'ms-top',
    boardEpoch: 1,
    coordinatorEpoch: 1,
    grantedAt: at,
    grantedBySessionId: role === 'top_agent' ? null : 'ms-coordinator',
    active: true,
  };
}

function binding(file: TaskBoardFile, entry: TaskBoardGrant, capability: string): TaskBoardBinding {
  return {
    v: TASK_BOARD_BINDING_VERSION,
    sessionId: entry.sessionId,
    sessionIncarnation: entry.sessionIncarnation,
    runtimeGeneration: entry.runtimeGeneration,
    boardId: file.boardId,
    grantId: entry.grantId,
    capability,
    role: entry.role,
    allowedActions: [...entry.allowedActions],
    boardEpoch: file.boardEpoch,
    coordinatorEpoch: file.coordinatorEpoch,
    boundAt: at,
    updatedAt: at,
  };
}
