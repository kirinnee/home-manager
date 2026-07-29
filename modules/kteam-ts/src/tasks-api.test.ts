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
  fleet = [
    {
      config: { id: 'ms-lead', teammate: 'zelda', turn: 1 },
      state: { status: 'running', turn: 1, lastActivityAt: '2026-07-27T02:00:00.000Z' },
    },
  ];
  service = new TaskService(paths, { list: async () => fleet });
  api = new TaskApi(service);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const url = (pathAndQuery: string) =>
  new URL(`http://d${pathAndQuery.replace(/^\/v1\/tasks/, '/v1/sessions/ms-lead/tasks')}`);
const fleetUrl = (pathAndQuery: string) => new URL(`http://d${pathAndQuery}`);

const actor = { actor: 'ms-lead', actorName: 'zelda' };

// Transport parsing now REQUIRES a verbatim ask {text, source} on every create,
// so the shared helper carries a valid one; a test that wants a malformed ask
// overrides it explicitly (spreading `ask: undefined` removes it).
async function create(body: Record<string, unknown> = {}, requestId?: string) {
  return api.handle({
    method: 'POST',
    url: url('/v1/tasks'),
    body: {
      kind: 'feature',
      title: 'File browser',
      ask: { text: 'Build a file browser', source: 'ms-lead:msg-1' },
      ...body,
    },
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
    const response = await api.handle({ method: 'GET', url: fleetUrl('/v1/tasks') });
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
    const response = await api.handle({ method: 'GET', url: fleetUrl('/v1/tasks?repo=/b') });
    expect((response?.body as TaskListResponse).tasks.map(task => task.title)).toEqual(['Second']);
  });

  test('an unknown status filter is a 400, not a silently unfiltered board', async () => {
    const response = await api.handle({ method: 'GET', url: url('/v1/tasks?status=shipped') });
    expect(response?.status).toBe(400);
    expect(response?.body).toMatchObject({ code: 'invalid' });
  });

  test('GET /v1/tasks/:id answers the frozen detail shape, with the brief', async () => {
    await create({ description: '## Brief' });
    const response = await api.handle({ method: 'GET', url: fleetUrl('/v1/tasks/F1') });
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
    expect(response?.body).toEqual({ error: 'unknown task F9 in session ms-lead', code: 'not-found' });
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
      body: {
        kind: 'bug',
        title: 'x',
        ask: { text: 'x', source: 'ms-lead:msg-1' },
        actor: 'somebody-else',
        actorName: 'forged',
      },
      actor,
    });
    expect((response?.body as TaskView).createdBy).toBe('ms-lead');
    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/B1') }))?.body as TaskDetailResponse;
    expect(detail.activity[0]).toMatchObject({ actor: 'ms-lead', actorName: 'zelda' });
  });

  test('POST /v1/tasks/:id applies an action and answers the updated view', async () => {
    await create();
    // A fresh task sits at phase todo; the only legal quick-workflow step is into
    // build (status in_progress). A status move requires a nonblank reason.
    const response = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'status', status: 'in_progress', reason: 'starting the build' },
      actor,
    });
    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({ status: 'in_progress', phase: 'build' });
  });

  test('advisory file claims survive create and the file action end-to-end', async () => {
    // Repeated files on create are normalized and persisted on the view.
    const created = await create({ files: ['  src/a.ts  ', 'src/a.ts', 'src/b.ts'] });
    expect(created?.status).toBe(201);
    expect((created?.body as TaskView).files).toEqual(['src/a.ts', 'src/b.ts']);

    // The file action adds a claim (no reason required) and answers the updated view.
    const added = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'file', path: 'src/c.ts' },
      actor,
    });
    expect(added?.status).toBe(200);
    expect((added?.body as TaskView).files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);

    // --remove drops a claim; the change is named in authoritative history.
    const removed = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'file', path: 'src/a.ts', remove: true },
      actor,
    });
    expect((removed?.body as TaskView).files).toEqual(['src/b.ts', 'src/c.ts']);

    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/F1') }))?.body as TaskDetailResponse;
    expect(detail.activity.filter(entry => entry.type === 'file').map(entry => entry.data)).toEqual([
      { path: 'src/c.ts', operation: 'add' },
      { path: 'src/a.ts', operation: 'remove' },
    ]);
  });

  test('legacy global POST routes transparently write the caller session store', async () => {
    const created = await api.handle({
      method: 'POST',
      url: fleetUrl('/v1/tasks'),
      body: {
        kind: 'feature',
        title: 'old client create',
        ask: { text: 'old client create', source: 'ms-lead:msg-1' },
      },
      actor,
    });
    expect(created).toMatchObject({ status: 201, body: { id: 'F1', sessionId: 'ms-lead' } });
    expect((await service.sessionTaskList('ms-lead')).tasks.map(task => task.id)).toEqual(['F1']);

    const updated = await api.handle({
      method: 'POST',
      url: fleetUrl('/v1/tasks/F1'),
      body: { action: 'status', status: 'in_progress', reason: 'picking it up' },
      actor,
    });
    expect(updated).toMatchObject({ status: 200, body: { id: 'F1', status: 'in_progress', sessionId: 'ms-lead' } });
    expect((await service.sessionTaskDetail('ms-lead', 'F1'))?.task.status).toBe('in_progress');
  });

  test('cross-session writes map forbidden to HTTP 403', async () => {
    fleet.push({
      config: { id: 'ms-other', teammate: 'other', turn: 1 },
      state: { status: 'running', turn: 1, lastActivityAt: '2026-07-27T02:00:00.000Z' },
    });
    const response = await api.handle({
      method: 'POST',
      url: new URL('http://d/v1/sessions/ms-other/tasks'),
      body: { kind: 'feature', title: 'wrong board', ask: { text: 'wrong board', source: 'ms-lead:msg-1' } },
      actor,
    });
    expect(response).toMatchObject({ status: 403, body: { code: 'forbidden' } });
  });

  test('ambiguous aggregate detail maps to HTTP 409', async () => {
    await create();
    fleet.push({
      config: { id: 'ms-other', teammate: 'other', turn: 1 },
      state: { status: 'running', turn: 1, lastActivityAt: '2026-07-27T02:00:00.000Z' },
    });
    const source = (await service.tasks.read('ms-lead')).file.tasks[0]!;
    await service.tasks.importLegacy('ms-other', [source]);

    const response = await api.handle({ method: 'GET', url: fleetUrl('/v1/tasks/F1') });
    expect(response).toMatchObject({ status: 409, body: { code: 'ambiguous' } });
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
    await expect(new TaskApi(broken).handle({ method: 'GET', url: fleetUrl('/v1/tasks') })).rejects.toThrow(
      'disk on fire',
    );
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
      body: { kind: 'feature', title: 'Ordered', repo: '/a', ask: { text: 'Ordered', source: 'ms-lead:msg-1' } },
      actor,
      requestId: 'req-order',
    });
    const b = await api.handle({
      method: 'POST',
      url: url('/v1/tasks'),
      body: { ask: { source: 'ms-lead:msg-1', text: 'Ordered' }, repo: '/a', title: 'Ordered', kind: 'feature' },
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
      body: { action: 'status', status: 'in_progress', reason: 'starting work' },
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
    expect((statused?.body as TaskView).status).toBe('in_progress');
    expect((assigned?.body as TaskView).assignee).toBe('ines');
    expect((assigned?.body as TaskView).status).toBe('in_progress');
  });

  test('a retry whose ACTOR metadata changed is still one write (rename between attempts)', async () => {
    await create();
    const post = (actorName: string) =>
      api.handle({
        method: 'POST',
        url: url('/v1/tasks/F1'),
        body: { action: 'note', text: 'said once' },
        actor: { actor: 'ms-lead', actorName },
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
  }, 15_000);
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
    await api.handle({
      method: 'POST',
      url: url('/v1/tasks'),
      body: {
        kind: 'bug',
        title: 'x',
        ask: { text: 'x', source: 'ms-lead:msg-1' },
        actor: 'ms-forged',
        actorName: 'somebody',
      },
      actor,
    });
    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/B1') }))?.body as TaskDetailResponse;
    expect(detail.activity[0]).toMatchObject({ actor: 'ms-lead', actorName: 'zelda' });
    expect(detail.task.createdBy).toBe('ms-lead');
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

describe('v2 ask + workflow fields cross the transport', () => {
  test('a create with no ask is a 400 invalid, and writes nothing', async () => {
    const response = await create({ ask: undefined });
    expect(response?.status).toBe(400);
    expect(response?.body).toMatchObject({ code: 'invalid' });
    // The refusal happens at the transport before the service, so the board stays empty.
    const listed = (await api.handle({ method: 'GET', url: url('/v1/tasks') }))?.body as TaskListResponse;
    expect(listed.tasks).toHaveLength(0);
  });

  test('an ask missing text or missing source is a 400 invalid', async () => {
    expect((await create({ ask: { source: 'ms-lead:msg-1' } }))?.status).toBe(400);
    expect((await create({ ask: { text: 'only text' } }))?.status).toBe(400);
    const listed = (await api.handle({ method: 'GET', url: url('/v1/tasks') }))?.body as TaskListResponse;
    expect(listed.tasks).toHaveLength(0);
  });

  test('the verbatim ask round-trips onto the created view, the detail, and the summary', async () => {
    const ask = { text: 'Please build the file browser exactly like the mock', source: 'ms-lead:msg-42' };
    const created = (await create({ ask }))?.body as TaskView;
    expect(created.ask).toEqual(ask);

    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/F1') }))?.body as TaskDetailResponse;
    expect(detail.task.ask).toEqual(ask);

    const listed = (await api.handle({ method: 'GET', url: url('/v1/tasks') }))?.body as TaskListResponse;
    // The list row omits the full ask but reports its source and length honestly.
    expect(listed.tasks[0]).toMatchObject({ askSource: ask.source, askChars: ask.text.length });
    expect(listed.tasks[0]).not.toHaveProperty('ask');
  });

  test('v2 create fields round-trip, and absent ones take their defaults', async () => {
    // Defaults: no workflow/phase/dependsOn supplied → quick / todo / [].
    const plain = (await create())?.body as TaskView;
    expect(plain).toMatchObject({ workflow: 'quick', phase: 'todo', dependsOn: [] });

    // An explicit workflow is honoured; phase still starts at todo.
    const researchFirst = (await create({ title: 'Investigate first', workflow: 'research-first' }))?.body as TaskView;
    expect(researchFirst).toMatchObject({ workflow: 'research-first', phase: 'todo' });

    // A declared dependency edge survives the round-trip.
    const dependent = (await create({ title: 'Depends on F1', dependsOn: ['F1'] }))?.body as TaskView;
    expect(dependent.dependsOn).toEqual(['F1']);
    const detail = (await api.handle({ method: 'GET', url: url(`/v1/tasks/${dependent.id}`) }))
      ?.body as TaskDetailResponse;
    expect(detail.task.dependsOn).toEqual(['F1']);
  });

  test('a v2 action round-trips: a clarify lands in the detail with its source', async () => {
    await create();
    const response = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'clarify', text: 'Actually make it read-only', source: 'ms-lead:msg-7' },
      actor,
    });
    expect(response?.status).toBe(200);
    const detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/F1') }))?.body as TaskDetailResponse;
    expect(detail.task.clarifications).toMatchObject([{ text: 'Actually make it read-only', source: 'ms-lead:msg-7' }]);
    expect(detail.activity.map(entry => entry.type)).toContain('clarification');
  });

  test('a legal phase step round-trips; a gate exit refuses the agent but admits the human', async () => {
    // research-first starts at research; the agent may sit in the gate but not leave it.
    await create({ workflow: 'research-first', status: 'researched' });
    const blockedExit = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'phase', phase: 'design', reason: 'research is done' },
      actor,
    });
    expect(blockedExit?.status).toBe(403);
    expect(blockedExit?.body).toMatchObject({ code: 'approval-required' });

    // The human at the CLI/UI resolves to session:null and may approve the exit.
    const humanExit = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'phase', phase: 'design', reason: 'approved' },
      actor: { actor: 'user', actorName: 'user' },
    });
    expect(humanExit?.status).toBe(200);
    expect(humanExit?.body).toMatchObject({ phase: 'design' });
  });

  test('live → done and reopening verified work are human-gated through the resolved API actor', async () => {
    await create({ workflow: 'quick', status: 'live' });
    const agentVerify = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'phase', phase: 'done', reason: 'The agent thinks deployment worked.' },
      actor,
    });
    expect(agentVerify?.status).toBe(403);
    expect(agentVerify?.body).toMatchObject({ code: 'approval-required' });
    expect((agentVerify?.body as { error: string }).error).toContain('leave it live for human verification');

    const humanVerify = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { action: 'phase', phase: 'done', reason: 'The human verified the deployed behavior.' },
      actor: { actor: 'user', actorName: 'user' },
    });
    expect(humanVerify?.status).toBe(200);
    expect(humanVerify?.body).toMatchObject({ phase: 'done', status: 'done' });

    const reopenBody = {
      action: 'reopen',
      reason: 'The verified route regressed.',
      ask: 'The route regressed after verification; repair it in this task.',
      source: 'session:user#99',
    };
    const beforeAgentReopen = (await api.handle({ method: 'GET', url: url('/v1/tasks/F1') }))
      ?.body as TaskDetailResponse;
    const agentReopen = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: { ...reopenBody, actor: 'user', actorName: 'forged-human' },
      actor,
    });
    expect(agentReopen?.status).toBe(403);
    expect((agentReopen?.body as { error: string }).error).toContain('ask the human to reopen it');
    let detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/F1') }))?.body as TaskDetailResponse;
    expect(detail).toEqual(beforeAgentReopen);

    const humanReopen = await api.handle({
      method: 'POST',
      url: url('/v1/tasks/F1'),
      body: reopenBody,
      actor: { actor: 'user', actorName: 'user' },
    });
    expect(humanReopen?.status).toBe(200);
    expect(humanReopen?.body).toMatchObject({ phase: 'build', status: 'in_progress' });
    detail = (await api.handle({ method: 'GET', url: url('/v1/tasks/F1') }))?.body as TaskDetailResponse;
    expect(detail.task.clarifications.at(-1)).toMatchObject({
      text: 'The route regressed after verification; repair it in this task.',
      source: 'session:user#99',
    });
    expect(detail.activity.slice(-2).map(entry => entry.type)).toEqual(['clarification', 'status']);
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
