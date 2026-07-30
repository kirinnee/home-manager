import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPaths, taskBoardSessionCapabilityFile, type KTeamPaths } from './paths';
import { startApiServer } from './api-server';
import type { KTeamService } from './service';
import { SessionTaskStore } from './session-tasks-store';
import {
  TaskBoardApi,
  TASK_BOARD_API_PREFIX,
  TASK_BOARD_CAPABILITY_HEADER,
  TASK_BOARD_SESSION_CAPABILITY_HEADER,
} from './task-boards-api';
import { TaskBoardStore } from './task-boards-store';
import { TaskBoardService, type TaskBoardSessionDeps, type TaskBoardSessionView } from './task-boards';
import { TaskService } from './tasks';
import { TaskApi } from './tasks-api';

const createdAt = '2026-07-30T12:00:00.000Z';
const boardAdminCapability = 'board-admin-capability-secret-value';

const session = (id: string, mode: 'auto' | 'interactive', parent?: string): TaskBoardSessionView => ({
  config: {
    id,
    incarnation: `inc-${id}`,
    runtimeGeneration: 1,
    teammate: id.slice(3),
    parent,
    mode,
    createdAt,
  },
  state: { status: 'running' },
});

describe('task-board API capability boundary', () => {
  let home: string;
  let paths: KTeamPaths;
  let sessions: TaskBoardSessionView[];
  let deps: TaskBoardSessionDeps;
  let store: TaskBoardStore;
  let service: TaskBoardService;
  let api: TaskBoardApi;
  let topCapability: string;
  let coordinatorCapability: string;
  let servers: Server<unknown>[];

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'kteam-task-board-api-'));
    servers = [];
    paths = createPaths(home);
    sessions = [
      session('ms-top', 'interactive'),
      session('ms-coordinator', 'auto', 'ms-top'),
      session('ms-child', 'auto', 'ms-coordinator'),
      session('ms-outside', 'interactive'),
      session('ms-create-top', 'interactive'),
      session('ms-create-coordinator', 'auto', 'ms-create-top'),
    ];
    deps = {
      async get(ref) {
        const view = sessions.find(candidate => candidate.config.id === ref || candidate.config.teammate === ref);
        if (!view) throw new Error(`unknown session ${ref}`);
        return view;
      },
      async list() {
        return sessions;
      },
    };
    const allocator = new SessionTaskStore(paths, { role: 'daemon' });
    store = new TaskBoardStore(paths, {
      role: 'daemon',
      allocateId: kind => allocator.allocateId(kind),
      resolveAssignedSessionId: async () => null,
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
    service = new TaskBoardService(paths, store, deps);
    api = new TaskBoardApi(service, deps, boardAdminCapability);
    const created = await service.createBoard({
      creatorSessionId: 'ms-top',
      coordinatorSessionId: 'ms-coordinator',
      requestId: 'create-board',
    });
    topCapability = created.creatorBinding.capability;
    coordinatorCapability = created.coordinatorBinding.capability;
  });

  afterEach(async () => {
    for (const server of servers) server.stop(true);
    await rm(home, { recursive: true, force: true });
  });

  test('rejects an admin bearer plus spoofed session header without the target binding secret', async () => {
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'shared-admin-secret',
      service: {
        get: deps.get,
        list: deps.list,
        subscribe: () => () => undefined,
      } as unknown as KTeamService,
      taskBoards: api,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const spoofedHeaders = {
      authorization: 'Bearer shared-admin-secret',
      'x-kteam-session-id': 'ms-top',
    };

    const read = await fetch(`${base}${TASK_BOARD_API_PREFIX}/membership`, { headers: spoofedHeaders });
    expect(read.status).toBe(403);
    expect(await read.json()).toMatchObject({ code: 'forbidden' });

    const mutate = await fetch(`${base}${TASK_BOARD_API_PREFIX}/child-grants/request`, {
      method: 'POST',
      headers: {
        ...spoofedHeaders,
        'content-type': 'application/json',
        'x-kteam-request-id': 'spoofed-child-request',
      },
      body: JSON.stringify({ targetSessionId: 'ms-child', role: 'worker' }),
    });
    expect(mutate.status).toBe(403);
    const top = await store.readBinding('ms-top');
    expect((await store.require(top!.boardId)).grantRequests).toHaveLength(0);

    const authenticated = await fetch(`${base}${TASK_BOARD_API_PREFIX}/membership`, {
      headers: { ...spoofedHeaders, 'x-kteam-board-capability': topCapability },
    });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({ sessionId: 'ms-top', role: 'top_agent' });
  });

  test('does not treat the shared bearer or omitted identity as board administration authority', async () => {
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'shared-admin-secret',
      service: {
        get: deps.get,
        list: deps.list,
        subscribe: () => () => undefined,
      } as unknown as KTeamService,
      taskBoards: api,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const createBody = JSON.stringify({
      creatorSessionId: 'ms-create-top',
      coordinatorSessionId: 'ms-create-coordinator',
    });
    const ordinaryAdminHeaders = {
      authorization: 'Bearer shared-admin-secret',
      'content-type': 'application/json',
      'x-kteam-request-id': 'admin-create-board',
    };
    const deniedCreate = await fetch(`${base}${TASK_BOARD_API_PREFIX}/create`, {
      method: 'POST',
      headers: ordinaryAdminHeaders,
      body: createBody,
    });
    expect(deniedCreate.status).toBe(403);
    expect(await store.readBinding('ms-create-top')).toBeNull();

    const spoofedCreate = await fetch(`${base}${TASK_BOARD_API_PREFIX}/create`, {
      method: 'POST',
      headers: {
        ...ordinaryAdminHeaders,
        'x-kteam-session-id': 'ms-top',
        'x-kteam-board-admin-capability': boardAdminCapability,
      },
      body: createBody,
    });
    expect(spoofedCreate.status).toBe(403);

    const created = await fetch(`${base}${TASK_BOARD_API_PREFIX}/create`, {
      method: 'POST',
      headers: { ...ordinaryAdminHeaders, 'x-kteam-board-admin-capability': boardAdminCapability },
      body: createBody,
    });
    expect(created.status).toBe(201);
    expect(await store.readBinding('ms-create-top')).not.toBeNull();

    const deniedAcl = await fetch(`${base}${TASK_BOARD_API_PREFIX}/mark-done`, {
      method: 'POST',
      headers: { ...ordinaryAdminHeaders, 'x-kteam-request-id': 'admin-mark-done' },
      body: JSON.stringify({ sessionId: 'ms-top', enabled: true }),
    });
    expect(deniedAcl.status).toBe(403);
    expect((await store.readBinding('ms-top'))?.allowedActions).not.toContain('mark_done');
    const allowedAcl = await fetch(`${base}${TASK_BOARD_API_PREFIX}/mark-done`, {
      method: 'POST',
      headers: {
        ...ordinaryAdminHeaders,
        'x-kteam-request-id': 'admin-mark-done',
        'x-kteam-board-admin-capability': boardAdminCapability,
      },
      body: JSON.stringify({ sessionId: 'ms-top', enabled: true }),
    });
    expect(allowedAcl.status).toBe(200);
    expect((await store.readBinding('ms-top'))?.allowedActions).toContain('mark_done');
  });

  test('creates only pending child grants for each explicit start choice and preserves none/legacy starts', async () => {
    let startCount = 0;
    const transport = {
      get: deps.get,
      list: deps.list,
      subscribe: () => () => undefined,
      start: async (input: { mode?: 'auto' | 'interactive'; parent?: string; boardAccess?: string }) => {
        startCount += 1;
        const created = session(`ms-start-${startCount}`, input.mode ?? 'auto', input.parent);
        created.config.name = `start-${startCount}`;
        created.config.teammate = `start-${startCount}`;
        (created.config as Record<string, unknown>)['boardAccess'] = input.boardAccess;
        sessions.push(created);
        return created;
      },
    } as unknown as KTeamService;
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'shared-admin-secret',
      service: transport,
      taskBoards: api,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const topHeaders = {
      authorization: 'Bearer shared-admin-secret',
      'content-type': 'application/json',
      'x-kteam-session-id': 'ms-top',
      'x-kteam-board-capability': topCapability,
    };
    const start = async (boardAccess: 'read' | 'worker' | 'coordinator' | 'none' | undefined, requestId: string) =>
      await fetch(`${base}/v1/sessions`, {
        method: 'POST',
        headers: { ...topHeaders, 'x-kteam-request-id': requestId },
        body: JSON.stringify({
          prompt: `start ${requestId}`,
          agent: 'claude-auto-loge',
          mode: 'auto',
          parent: 'ms-top',
          ...(boardAccess === undefined ? {} : { boardAccess }),
        }),
      });

    for (const role of ['read', 'worker', 'coordinator'] as const) {
      const response = await start(role, `start-${role}`);
      expect(response.status).toBe(201);
      const created = (await response.json()) as TaskBoardSessionView;
      const top = (await store.readBinding('ms-top'))!;
      const file = await store.require(top.boardId);
      const pending = file.grantRequests.find(
        candidate => candidate.targetSessionId === created.config.id && candidate.requestedRole === role,
      );
      expect(pending).toMatchObject({
        status: 'pending',
        targetSessionId: created.config.id,
        requestedRole: role,
      });
      expect(await store.readBinding(created.config.id)).toBeNull();
      await service.approveChildGrant({
        coordinatorCapability,
        coordinatorRuntimeGeneration: 1,
        grantRequestId: pending!.requestId,
        requestId: `approve-start-${role}`,
      });
      expect((await store.readBinding(created.config.id))?.role).toBe(role);

      // The same lost-response start identity returns the same child and exact
      // approved grant result; it never creates or requests twice.
      const replay = await start(role, `start-${role}`);
      expect(replay.status).toBe(201);
      expect(((await replay.json()) as TaskBoardSessionView).config.id).toBe(created.config.id);
    }
    expect(startCount).toBe(3);

    const beforeNone = (await store.require((await store.readBinding('ms-top'))!.boardId)).grantRequests.length;
    expect((await start('none', 'start-none')).status).toBe(201);
    expect((await start(undefined, 'start-legacy')).status).toBe(201);
    const afterNone = (await store.require((await store.readBinding('ms-top'))!.boardId)).grantRequests.length;
    expect(afterNone).toBe(beforeNone);
    expect(startCount).toBe(5);
  });

  test('fails board-access start authorization before creating a child', async () => {
    let starts = 0;
    const transport = {
      get: deps.get,
      list: deps.list,
      subscribe: () => () => undefined,
      start: async () => {
        starts += 1;
        throw new Error('must not launch');
      },
    } as unknown as KTeamService;
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'shared-admin-secret',
      service: transport,
      taskBoards: api,
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer shared-admin-secret',
        'content-type': 'application/json',
        'x-kteam-session-id': 'ms-top',
        'x-kteam-request-id': 'unauthorized-board-start',
      },
      body: JSON.stringify({
        prompt: 'child',
        agent: 'claude-auto-loge',
        mode: 'auto',
        parent: 'ms-top',
        boardAccess: 'worker',
      }),
    });
    expect(response.status).toBe(403);
    expect(starts).toBe(0);
  });

  test('requires the same exact binding secret for ordinary task reads and mutations', async () => {
    const taskService = new TaskService(paths, deps as never, { boardService: service });
    await taskService.initialize();
    const transport = {
      get: deps.get,
      list: deps.list,
      subscribe: () => () => undefined,
    } as unknown as KTeamService;
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'shared-admin-secret',
      service: transport,
      tasks: new TaskApi(taskService),
      taskBoards: api,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}/v1/sessions/ms-top/tasks`;
    const spoofed = {
      authorization: 'Bearer shared-admin-secret',
      'x-kteam-session-id': 'ms-top',
    };

    expect((await fetch(base, { headers: { authorization: 'Bearer shared-admin-secret' } })).status).toBe(403);
    expect(
      (
        await fetch(base, {
          headers: {
            authorization: 'Bearer shared-admin-secret',
            'x-kteam-board-admin-capability': boardAdminCapability,
          },
        })
      ).status,
    ).toBe(200);

    expect((await fetch(base, { headers: spoofed })).status).toBe(403);
    expect(
      (
        await fetch(base, {
          headers: { authorization: 'Bearer shared-admin-secret', 'x-kteam-session-id': 'user' },
        })
      ).status,
    ).toBe(403);
    const deniedCreate = await fetch(base, {
      method: 'POST',
      headers: {
        ...spoofed,
        'content-type': 'application/json',
        'x-kteam-request-id': 'spoofed-task-create',
      },
      body: JSON.stringify({
        kind: 'feature',
        title: 'Spoofed task',
        ask: { text: 'must not land', source: 'test' },
        workflow: 'quick',
      }),
    });
    expect(deniedCreate.status).toBe(403);
    expect((await taskService.sessionTaskList('ms-top', {}, { actor: 'user', humanAdmin: true })).tasks).toHaveLength(
      0,
    );

    const allowedCreate = await fetch(base, {
      method: 'POST',
      headers: {
        ...spoofed,
        'content-type': 'application/json',
        'x-kteam-request-id': 'authenticated-task-create',
        'x-kteam-board-capability': topCapability,
      },
      body: JSON.stringify({
        kind: 'feature',
        title: 'Authenticated task',
        ask: { text: 'land this', source: 'test' },
        workflow: 'quick',
      }),
    });
    expect(allowedCreate.status).toBe(201);
    const allowedRead = await fetch(base, {
      headers: { ...spoofed, 'x-kteam-board-capability': topCapability },
    });
    expect(allowedRead.status).toBe(200);
    expect(((await allowedRead.json()) as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  test('never turns a spoofable session id into board authority', async () => {
    const url = new URL(`http://daemon${TASK_BOARD_API_PREFIX}/membership`);
    const missing = await api.handle({
      method: 'GET',
      url,
      actor: { sessionId: 'ms-top', humanAdmin: false },
    });
    expect(missing).toEqual({
      status: 403,
      body: { error: 'a board-bound peer must present its binding capability', code: 'forbidden' },
    });

    const otherMembersSecret = await api.handle({
      method: 'GET',
      url,
      actor: { sessionId: 'ms-top', humanAdmin: false },
      boardCapability: coordinatorCapability,
    });
    expect(otherMembersSecret?.status).toBe(403);

    const allowed = await api.handle({
      method: 'GET',
      url,
      actor: { sessionId: 'ms-top', humanAdmin: false },
      boardCapability: topCapability,
    });
    expect(allowed?.status).toBe(200);
    expect(allowed?.body).toMatchObject({ sessionId: 'ms-top', role: 'top_agent', runtimeGeneration: 1 });
    expect(allowed?.body).not.toHaveProperty('boardId');
    expect(allowed?.body).not.toHaveProperty('capability');

    await expect(api.hydrateTaskActor({ actor: 'ms-top', actorName: 'top' }, false)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      api.hydrateTaskActor({ actor: 'ms-top', actorName: 'top' }, false, coordinatorCapability),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      api.hydrateTaskActor({ actor: 'ms-top', actorName: 'top' }, false, topCapability),
    ).resolves.toMatchObject({
      actor: 'ms-top',
      boardCapability: topCapability,
      runtimeGeneration: 1,
    });
  });

  test('denies a grant mutation before state changes when the binding secret is absent', async () => {
    const response = await api.handle({
      method: 'POST',
      url: new URL(`http://daemon${TASK_BOARD_API_PREFIX}/child-grants/request`),
      actor: { sessionId: 'ms-top', humanAdmin: false },
      requestId: 'request-child',
      body: { targetSessionId: 'ms-child', role: 'worker' },
    });
    expect(response?.status).toBe(403);
    const binding = await store.readBinding('ms-top');
    expect(binding).not.toBeNull();
    expect((await store.require(binding!.boardId)).grantRequests).toHaveLength(0);

    const allowed = await api.handle({
      method: 'POST',
      url: new URL(`http://daemon${TASK_BOARD_API_PREFIX}/child-grants/request`),
      actor: { sessionId: 'ms-top', humanAdmin: false },
      boardCapability: topCapability,
      requestId: 'request-child',
      body: { targetSessionId: 'ms-child', role: 'worker' },
    });
    expect(allowed?.status).toBe(202);
  });

  test('keeps invitation acceptance secret out of JSON input and proves access before success', async () => {
    const requested = await api.handle({
      method: 'POST',
      url: new URL(`http://daemon${TASK_BOARD_API_PREFIX}/invitations/request`),
      actor: { sessionId: 'ms-top', humanAdmin: false },
      boardCapability: topCapability,
      requestId: 'invite-outside',
      body: { targetSessionId: 'ms-outside' },
    });
    expect(requested?.status).toBe(202);
    const approved = await api.handle({
      method: 'POST',
      url: new URL(`http://daemon${TASK_BOARD_API_PREFIX}/invitations/approve`),
      actor: { sessionId: 'ms-coordinator', humanAdmin: false },
      boardCapability: coordinatorCapability,
      requestId: 'approve-outside',
      body: { invitationRequestId: 'invite-outside' },
    });
    expect(approved?.status).toBe(200);
    expect(approved?.body).toMatchObject({ requestId: 'invite-outside', status: 'approved' });
    expect(approved?.body).not.toHaveProperty('acceptanceCapability');
    const sessionCapabilityRecord = JSON.parse(
      await readFile(taskBoardSessionCapabilityFile(paths, 'ms-outside'), 'utf8'),
    ) as { capability: string; invitationCapability: string; invitationRequestId: string };
    expect(sessionCapabilityRecord.capability).toHaveLength(68);
    expect(sessionCapabilityRecord.invitationCapability).toHaveLength(43);
    expect(sessionCapabilityRecord.invitationRequestId).toBe('invite-outside');
    expect(JSON.stringify(approved?.body)).not.toContain(sessionCapabilityRecord.invitationCapability);
    expect((await stat(taskBoardSessionCapabilityFile(paths, 'ms-outside'))).mode & 0o777).toBe(0o600);
    const acceptanceCapability = sessionCapabilityRecord.invitationCapability;

    const bodyOnly = await api.handle({
      method: 'POST',
      url: new URL(`http://daemon${TASK_BOARD_API_PREFIX}/invitations/accept`),
      actor: { sessionId: 'ms-outside', humanAdmin: false },
      requestId: 'accept-outside',
      body: { acceptanceCapability },
    });
    expect(bodyOnly?.status).toBe(403);
    expect(await store.readBinding('ms-outside')).toBeNull();

    const invitationOnly = await api.handle({
      method: 'POST',
      url: new URL(`http://daemon${TASK_BOARD_API_PREFIX}/invitations/accept`),
      actor: { sessionId: 'ms-outside', humanAdmin: false },
      boardCapability: acceptanceCapability,
      requestId: 'accept-outside',
      body: {},
    });
    expect(invitationOnly?.status).toBe(403);
    expect(await store.readBinding('ms-outside')).toBeNull();

    const wrongInvitee = await api.handle({
      method: 'POST',
      url: new URL(`http://daemon${TASK_BOARD_API_PREFIX}/invitations/accept`),
      actor: { sessionId: 'ms-outside', humanAdmin: false },
      boardCapability: acceptanceCapability,
      sessionCapability: 'coordinator-or-source-cannot-accept-this-invitation',
      requestId: 'accept-outside',
      body: {},
    });
    expect(wrongInvitee?.status).toBe(403);
    expect(await store.readBinding('ms-outside')).toBeNull();

    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'shared-admin-secret',
      service: {
        get: deps.get,
        list: deps.list,
        subscribe: () => () => undefined,
      } as unknown as KTeamService,
      taskBoards: api,
    });
    servers.push(server);
    const accepted = await fetch(`http://127.0.0.1:${server.port}${TASK_BOARD_API_PREFIX}/invitations/accept`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer shared-admin-secret',
        'content-type': 'application/json',
        'x-kteam-session-id': 'ms-outside',
        'x-kteam-request-id': 'accept-outside',
        [TASK_BOARD_CAPABILITY_HEADER]: acceptanceCapability,
        [TASK_BOARD_SESSION_CAPABILITY_HEADER]: sessionCapabilityRecord.capability,
      },
      body: '{}',
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as Record<string, unknown>;
    expect(acceptedBody).toMatchObject({ sessionId: 'ms-outside', role: 'top_agent' });
    expect(acceptedBody).not.toHaveProperty('capability');
    expect(await store.readBinding('ms-outside')).not.toBeNull();
  });
});
