import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, type KTeamPaths } from './paths';
import { TaskApi, resolveTaskActor, taskApiRequestFrom, type TaskApiService } from './tasks-api';
import { TaskService } from './tasks';
import type { TaskAssigneeView } from './tasks-live';
import { MAX_TASK_DESCRIPTION_LEN, type TaskDetailResponse, type TaskListResponse, type TaskView } from './tasks-types';

let home: string;
let paths: KTeamPaths;
let fleet: TaskAssigneeView[];
let api: TaskApi;
let service: TaskService;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-tasks-api-'));
  paths = createPaths(home);
  fleet = [];
  service = new TaskService(paths, { list: async () => fleet });
  api = new TaskApi(service);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const url = (pathAndQuery: string) => new URL(`http://d${pathAndQuery}`);

const actor = { actor: 'ms-lead', actorName: 'zelda' };

async function create(body: Record<string, unknown> = {}, requestId?: string) {
  return api.handle({
    method: 'POST',
    url: url('/v1/tasks'),
    body: { kind: 'feature', title: 'File browser', ...body },
    actor,
    ...(requestId !== undefined ? { requestId } : {}),
  });
}

describe('routing', () => {
  test('returns null for a path that is not ours, so the caller 404s as before', async () => {
    expect(await api.handle({ method: 'GET', url: url('/v1/sessions') })).toBeNull();
    expect(await api.handle({ method: 'DELETE', url: url('/v1/tasks/F1') })).toBeNull();
  });

  test('GET /v1/tasks answers the frozen list shape', async () => {
    await create();
    const response = await api.handle({ method: 'GET', url: url('/v1/tasks') });
    expect(response?.status).toBe(200);
    const body = response?.body as TaskListResponse;
    expect(body.tasks).toHaveLength(1);
    expect(body.parseErrors).toBe(0);
    expect(body.tasks[0]).not.toHaveProperty('description');
    expect(body.tasks[0]?.live).toBeDefined();
  });

  test('GET /v1/tasks passes the filters through', async () => {
    await create({ repo: '/a' });
    await create({ repo: '/b', title: 'Second' });
    const response = await api.handle({ method: 'GET', url: url('/v1/tasks?repo=/b') });
    expect((response?.body as TaskListResponse).tasks.map(task => task.title)).toEqual(['Second']);
  });

  test('an unknown status filter is a 400, not a silently unfiltered board', async () => {
    const response = await api.handle({ method: 'GET', url: url('/v1/tasks?status=shipped') });
    expect(response?.status).toBe(400);
    expect(response?.body).toMatchObject({ code: 'invalid' });
  });

  test('GET /v1/tasks/:id answers the frozen detail shape, with the brief', async () => {
    await create({ description: '## Brief' });
    const response = await api.handle({ method: 'GET', url: url('/v1/tasks/F1') });
    const body = response?.body as TaskDetailResponse;
    expect(body.task.description).toBe('## Brief');
    expect(body.task.live).toBeDefined();
    expect(body.activity.map(entry => entry.type)).toEqual(['created']);
  });

  test('GET a detail with ?after= pages the history', async () => {
    await create();
    await api.handle({ method: 'POST', url: url('/v1/tasks/F1'), body: { action: 'note', text: 'x' }, actor });
    const response = await api.handle({ method: 'GET', url: url('/v1/tasks/F1?after=1') });
    expect((response?.body as TaskDetailResponse).activity.map(entry => entry.seq)).toEqual([2]);
  });

  test('a lower-case id in the path resolves', async () => {
    await create();
    expect((await api.handle({ method: 'GET', url: url('/v1/tasks/f1') }))?.status).toBe(200);
  });

  test('an unknown task is a 404 with a machine code', async () => {
    const response = await api.handle({ method: 'GET', url: url('/v1/tasks/F9') });
    expect(response?.status).toBe(404);
    expect(response?.body).toEqual({ error: 'unknown task F9', code: 'not-found' });
  });
});

describe('mutations', () => {
  test('POST /v1/tasks creates and answers 201 with the view', async () => {
    const response = await create();
    expect(response?.status).toBe(201);
    expect(response?.body).toMatchObject({ id: 'F1', status: 'todo', createdBy: 'ms-lead' });
  });

  test('the actor comes from the caller, never from the body', async () => {
    const response = await api.handle({
      method: 'POST',
      url: url('/v1/tasks'),
      body: { kind: 'bug', title: 'x', actor: 'somebody-else', actorName: 'forged' },
      actor,
    });
    expect((response?.body as TaskView).createdBy).toBe('ms-lead');
    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/B1') }))?.body as TaskDetailResponse;
    expect(detail.activity[0]).toMatchObject({ actor: 'ms-lead', actorName: 'zelda' });
  });

  test('POST /v1/tasks/:id applies an action and answers the updated view', async () => {
    await create();
    const response = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'status', status: 'built', note: 'gates green' },
      actor,
    });
    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({ status: 'built' });
  });

  test('a missing reason is a 400 carrying the reason-required code the UI branches on', async () => {
    await create();
    const response = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'status', status: 'blocked' },
      actor,
    });
    expect(response?.status).toBe(400);
    expect(response?.body).toMatchObject({ code: 'reason-required' });
  });

  test('an over-cap brief is a 413 that says it was not truncated', async () => {
    const response = await create({ description: 'x'.repeat(MAX_TASK_DESCRIPTION_LEN + 1) });
    expect(response?.status).toBe(413);
    expect((response?.body as { error: string }).error).toContain('not truncated');
  });

  test('a malformed body is a 400', async () => {
    expect((await api.handle({ method: 'POST', url: url('/v1/tasks'), body: 'nope' }))?.status).toBe(400);
    expect((await api.handle({ method: 'POST', url: url('/v1/tasks'), body: { title: 'x' } }))?.status).toBe(400);
    await create();
    expect((await api.handle({ method: 'POST', url: url('/v1/tasks/F1'), body: { action: 'promote' } }))?.status).toBe(
      400,
    );
  });

  test('an action on a missing task is a 404', async () => {
    const response = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F9'),
      body: { action: 'note', text: 'x' },
    });
    expect(response?.status).toBe(404);
  });

  test('a non-TaskError from the service is rethrown, never laundered into a 400', async () => {
    const broken: TaskApiService = {
      taskList: async () => {
        throw new Error('disk on fire');
      },
      taskDetail: async () => undefined,
      taskCreate: async () => {
        throw new Error('disk on fire');
      },
      taskAct: async () => {
        throw new Error('disk on fire');
      },
    };
    await expect(new TaskApi(broken).handle({ method: 'GET', url: url('/v1/tasks') })).rejects.toThrow('disk on fire');
  });
});

describe('idempotency (a retried POST must not double-write history)', () => {
  test('a repeated create request id creates ONE task and replays the response', async () => {
    const first = await create({}, 'req-1');
    const second = await create({}, 'req-1');
    expect(second).toEqual(first);
    expect(((await api.handle({ method: 'GET', url: url('/v1/tasks') }))?.body as TaskListResponse).tasks).toHaveLength(
      1,
    );
  });

  test('a retry that OVERLAPS the first attempt shares it instead of re-applying', async () => {
    const [a, b] = await Promise.all([create({}, 'req-2'), create({}, 'req-2')]);
    expect(a).toEqual(b);
    expect(((await api.handle({ method: 'GET', url: url('/v1/tasks') }))?.body as TaskListResponse).tasks).toHaveLength(
      1,
    );
  });

  test('one request id reused for a DIFFERENT create payload does not alias to the first task', async () => {
    const first = await create({ title: 'First' }, 'req-shared');
    const second = await create({ title: 'Second' }, 'req-shared');
    expect((first?.body as TaskView).id).toBe('F1');
    // The second payload is a different operation, not a replay of the first —
    // returning F1 here would be a silent wrong answer.
    expect((second?.body as TaskView).id).toBe('F2');
    expect((second?.body as TaskView).title).toBe('Second');
    const listed = (await api.handle({ method: 'GET', url: url('/v1/tasks') }))?.body as TaskListResponse;
    expect(listed.tasks.map(task => task.title).sort()).toEqual(['First', 'Second']);
  });

  test('field order in the body does not split a genuine retry', async () => {
    const a = await api.handle({
      method: 'POST',
      url: url('/v1/tasks'),
      body: { kind: 'feature', title: 'Ordered', repo: '/a' },
      actor,
      requestId: 'req-order',
    });
    const b = await api.handle({
      method: 'POST',
      url: url('/v1/tasks'),
      body: { repo: '/a', title: 'Ordered', kind: 'feature' },
      actor,
      requestId: 'req-order',
    });
    expect(b).toEqual(a);
    expect(((await api.handle({ method: 'GET', url: url('/v1/tasks') }))?.body as TaskListResponse).tasks).toHaveLength(
      1,
    );
  });

  test('one request id reused for a DIFFERENT action payload applies both', async () => {
    await create();
    const post = (text: string) =>
      api.handle({
        method: 'POST',
        url: url('/v1/tasks/F1'),
        body: { action: 'note', text },
        actor,
        requestId: 'req-collide',
      });
    await post('first thing');
    await post('second thing');
    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/F1') }))?.body as TaskDetailResponse;
    const notes = detail.activity.filter(entry => entry.type === 'note');
    expect(notes).toHaveLength(2);
    expect(notes.map(entry => entry.data['text'])).toEqual(['first thing', 'second thing']);
  });

  test('a reused id across DIFFERENT actions does not let one replay as another', async () => {
    await create();
    const statused = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'status', status: 'built' },
      actor,
      requestId: 'req-mixed',
    });
    const assigned = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'assign', assignee: 'ines' },
      actor,
      requestId: 'req-mixed',
    });
    expect((statused?.body as TaskView).status).toBe('built');
    expect((assigned?.body as TaskView).assignee).toBe('ines');
    expect((assigned?.body as TaskView).status).toBe('built');
  });

  test('a retry whose ACTOR metadata changed is still one write (rename between attempts)', async () => {
    await create();
    const post = (actorName: string) =>
      api.handle({
        method: 'POST',
        url: url('/v1/tasks/F1'),
        body: { action: 'note', text: 'said once' },
        actor: { actor: 'ms-ines', actorName },
        requestId: 'req-renamed',
      });
    await post('ines');
    // Same request id, same body, but the teammate resolved to a new callsign
    // (or the lookup transiently failed) — the payload identity must not include
    // actor metadata, or the retry writes a second line.
    await post('inez');
    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/F1') }))?.body as TaskDetailResponse;
    const notes = detail.activity.filter(entry => entry.type === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.actorName).toBe('ines');
  });

  test('a repeated note request id appends ONE line', async () => {
    await create();
    const post = () =>
      api.handle({
        method: 'POST',
        url: url('/v1/tasks/F1'),
        body: { action: 'note', text: 'said once' },
        actor,
        requestId: 'req-3',
      });
    await post();
    await post();
    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/F1') }))?.body as TaskDetailResponse;
    expect(detail.activity.filter(entry => entry.type === 'note')).toHaveLength(1);
  });

  test('the same request id against a DIFFERENT task is a different write', async () => {
    await create();
    await create({ title: 'Second' });
    for (const id of ['F1', 'F2']) {
      await api.handle({
        method: 'POST',
        url: url(`/v1/tasks/${id}`),
        body: { action: 'note', text: 'once each' },
        actor,
        requestId: 'req-4',
      });
    }
    for (const id of ['F1', 'F2']) {
      const detail = (await api.handle({ method: 'GET', url: url(`/v1/tasks/${id}`) }))?.body as TaskDetailResponse;
      expect(detail.activity.filter(entry => entry.type === 'note')).toHaveLength(1);
    }
  });

  test('without a request id nothing is deduped (two notes are two notes)', async () => {
    await create();
    for (const index of [1, 2]) {
      await api.handle({
        method: 'POST',
        url: url('/v1/tasks/F1'),
        body: { action: 'note', text: `n${index}` },
        actor,
      });
    }
    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/F1') }))?.body as TaskDetailResponse;
    expect(detail.activity.filter(entry => entry.type === 'note')).toHaveLength(2);
  });

  test('a FAILED attempt stays retryable — a refusal is not remembered as applied', async () => {
    await create();
    const blocked = () =>
      api.handle({
        method: 'POST',
        url: url('/v1/tasks/F1'),
        body: { action: 'status', status: 'blocked' },
        actor,
        requestId: 'req-5',
      });
    expect((await blocked())?.status).toBe(400);
    const retried = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'status', status: 'blocked', reason: 'needs the age key' },
      actor,
      requestId: 'req-5',
    });
    expect(retried?.status).toBe(200);
    expect(retried?.body).toMatchObject({ status: 'blocked', statusReason: 'needs the age key' });
  });

  test('remembered request ids are capped, so a long-lived daemon does not grow forever', async () => {
    await create();
    for (let index = 0; index < 250; index += 1) {
      await api.handle({
        method: 'POST',
        url: url('/v1/tasks/F1'),
        body: { action: 'note', text: `n${index}` },
        actor,
        requestId: `bulk-${index}`,
      });
    }
    expect(api.rememberedRequests).toBeLessThanOrEqual(200);
  });
});

describe('actor attribution (never authorization)', () => {
  const lookup = {
    get: async (id: string) =>
      id === 'ms-ines' ? { config: { id: 'ms-ines', teammate: 'ines', name: 'Fix File Browser' } } : undefined,
  };

  test('an in-pane caller resolves to the canonical session id and its callsign', async () => {
    expect(await resolveTaskActor(lookup, { sessionId: 'ms-ines' })).toEqual({ actor: 'ms-ines', actorName: 'ines' });
  });

  test('the session id is lifted out of a peer:/warden: actor string too', async () => {
    expect(await resolveTaskActor(lookup, { actorSource: 'peer:ms-ines' })).toEqual({
      actor: 'ms-ines',
      actorName: 'ines',
    });
    expect(await resolveTaskActor(lookup, { actorSource: 'warden:ms-ines' })).toEqual({
      actor: 'ms-ines',
      actorName: 'ines',
    });
  });

  test('a human at the CLI or the browser is user/user', async () => {
    expect(await resolveTaskActor(lookup, { actorSource: 'admin-cli' })).toEqual({ actor: 'user', actorName: 'user' });
    expect(await resolveTaskActor(lookup, { actorSource: 'admin-ui' })).toEqual({ actor: 'user', actorName: 'user' });
    expect(await resolveTaskActor(lookup, {})).toEqual({ actor: 'user', actorName: 'user' });
    expect(await resolveTaskActor(lookup, { sessionId: '   ', actorSource: null })).toEqual({
      actor: 'user',
      actorName: 'user',
    });
  });

  test('an unresolved session id keeps the raw id — it is never relabelled as the human', async () => {
    expect(await resolveTaskActor(lookup, { sessionId: 'ms-ghost' })).toEqual({ actor: 'ms-ghost', actorName: null });
  });

  test('a lookup that throws or is absent still attributes the id', async () => {
    const broken = {
      get: async () => {
        throw new Error('daemon busy');
      },
    };
    expect(await resolveTaskActor(broken, { sessionId: 'ms-ines' })).toEqual({ actor: 'ms-ines', actorName: null });
    expect(await resolveTaskActor(undefined, { sessionId: 'ms-ines' })).toEqual({ actor: 'ms-ines', actorName: null });
  });

  test('a session with no callsign falls back to its name, then to null', async () => {
    const named = { get: async () => ({ config: { id: 'ms-x', name: 'Fix Transcript Scrolling' } }) };
    expect(await resolveTaskActor(named, { sessionId: 'ms-x' })).toEqual({
      actor: 'ms-x',
      actorName: 'Fix Transcript Scrolling',
    });
    const anonymous = { get: async () => ({ config: { id: 'ms-y', teammate: '  ' } }) };
    expect(await resolveTaskActor(anonymous, { sessionId: 'ms-y' })).toEqual({ actor: 'ms-y', actorName: null });
  });

  test('the resolved actor is what lands in history, and a body actor is ignored', async () => {
    const resolved = await resolveTaskActor(lookup, { sessionId: 'ms-ines' });
    await api.handle({
      method: 'POST',
      url: url('/v1/tasks'),
      body: { kind: 'bug', title: 'x', actor: 'ms-forged', actorName: 'somebody' },
      actor: resolved,
    });
    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/B1') }))?.body as TaskDetailResponse;
    expect(detail.activity[0]).toMatchObject({ actor: 'ms-ines', actorName: 'ines' });
    expect(detail.task.createdBy).toBe('ms-ines');
  });
});

describe('request adaptation', () => {
  test('taskApiRequestFrom lifts the method, url, body, actor and request id', () => {
    const request = {
      method: 'POST',
      headers: { get: (name: string) => (name === 'x-kteam-request-id' ? 'req-9' : null) },
    };
    expect(taskApiRequestFrom(request, url('/v1/tasks'), { kind: 'bug' }, actor)).toEqual({
      method: 'POST',
      url: url('/v1/tasks'),
      body: { kind: 'bug' },
      actor,
      requestId: 'req-9',
    });
  });

  test('a missing request-id header simply means "not deduped"', () => {
    const request = { method: 'GET', headers: { get: () => null } };
    expect(taskApiRequestFrom(request, url('/v1/tasks'), undefined, {}).requestId).toBeUndefined();
  });
});

describe('derived liveness reaches the API', () => {
  test('a dead assignee is flagged on both the list row and the detail', async () => {
    await create({ assignee: 'ines', status: 'in_progress' });
    fleet = [
      {
        config: { id: 'ms-ines', teammate: 'ines', turn: 1 },
        state: { status: 'failed', turn: 1, lastActivityAt: '2026-07-27T02:00:00.000Z' },
      },
    ];
    const listed = (await api.handle({ method: 'GET', url: url('/v1/tasks') }))?.body as TaskListResponse;
    expect(listed.tasks[0]?.live.staleness).toBe('assignee-dead');
    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/F1') }))?.body as TaskDetailResponse;
    expect(detail.task.live.staleness).toBe('assignee-dead');
    // …and the declared status is untouched by the annotation.
    expect(detail.task.status).toBe('in_progress');
  });
});
