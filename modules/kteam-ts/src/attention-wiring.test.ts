import { afterEach, describe, expect, test } from 'bun:test';
import { startApiServer } from './api-server';
import type { AttentionApi, AttentionApiRequest } from './attention-api';
import type { KTeamService } from './service';

const SID = 'ms3g6a8p-71542ce1';
const servers: Array<ReturnType<typeof startApiServer>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const service = {
  subscribe: () => () => undefined,
} as unknown as KTeamService;

function mountedAttention() {
  const requests: AttentionApiRequest[] = [];
  let subscriptions = 0;
  let unsubscriptions = 0;
  const api = {
    subscribe: () => {
      subscriptions += 1;
      return () => {
        unsubscriptions += 1;
      };
    },
    handle: async (request: AttentionApiRequest) => {
      requests.push(request);
      return {
        status: 200,
        body: { sessionId: SID, count: request.method === 'POST' ? 1 : 0 },
      };
    },
  } as unknown as AttentionApi;
  return { api, requests, subscriptions: () => subscriptions, unsubscriptions: () => unsubscriptions };
}

describe('Attention HTTP mounting', () => {
  test('dispatches before the generic session action route and tears down its subscription', async () => {
    const attention = mountedAttention();
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      service,
      attention: attention.api,
    });
    servers.push(server);

    const http = await fetch(`http://127.0.0.1:${server.port}/v1/sessions/${SID}/attention`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        'x-kteam-request-id': 'attention-wiring-1',
      },
      body: JSON.stringify({ action: 'add', subject: 'Ship it' }),
    });

    expect(http.status).toBe(200);
    expect(await http.json()).toEqual({ sessionId: SID, count: 1 });
    expect(attention.requests).toHaveLength(1);
    expect(attention.requests[0]).toMatchObject({
      method: 'POST',
      body: { action: 'add', subject: 'Ship it' },
      requestId: 'attention-wiring-1',
    });
    expect(attention.requests[0]?.actorSource).toMatch(/^admin-/);
    expect(attention.subscriptions()).toBe(1);

    server.stop(true);
    servers.pop();
    expect(attention.unsubscriptions()).toBe(1);
  });

  test('lets a warden read Attention but denies mutation before dispatch', async () => {
    const attention = mountedAttention();
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      wardenToken: 'warden',
      service,
      attention: attention.api,
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}/v1/sessions/${SID}/attention`;

    const read = await fetch(url, { headers: { authorization: 'Bearer warden' } });
    expect(read.status).toBe(200);
    const write = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer warden', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', subject: 'No' }),
    });
    expect(write.status).toBe(403);
    expect(attention.requests.map(request => request.method)).toEqual(['GET']);
  });
});

test('the production daemon owns the Attention service, sources, API, and lifecycle', async () => {
  const source = await Bun.file(new URL('./daemon-entry.ts', import.meta.url)).text();
  for (const required of [
    'new AttentionService(paths, attentionSessions)',
    'new AttentionApi(attentionService, manager, {',
    'new AttentionSources(attentionService, manager, taskService)',
    'attention: attentionApi',
    'await attentionSources.start()',
    'attentionSources.close()',
    // &F140: new items push through the notifier; direct notify is mounted.
    'new AttentionNotifier(manager, pushService)',
    'attentionNotifier?.notifyNewItem(sessionId, item)',
    'attentionNotifier.notifyDirect(sessionId, input, actor)',
  ]) {
    expect(source).toContain(required);
  }
});

test('the CLI entry point registers the Attention command', async () => {
  const source = await Bun.file(new URL('./index.ts', import.meta.url)).text();
  expect(source).toContain(".command('attention')");
  expect(source).toContain('attentionCliRequest(command, process.env.KTEAM_SESSION_ID)');
  expect(source).toContain('renderAttentionCli(command, response)');
});
