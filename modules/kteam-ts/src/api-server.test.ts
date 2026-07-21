import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { startApiServer } from './api-server';
import type { AttachmentView, KTeamService, SessionView } from './service';
import type { KTeamEvent, SendRequest, StartSessionRequest } from './types';

const view: SessionView = {
  directory: '/tmp/kteam/s1',
  config: {
    id: 's1',
    name: 'test',
    binary: 'claude-auto-mm3',
    harness: 'claude',
    modelHint: 'MiniMax M3',
    mode: 'interactive',
    cwd: '/tmp',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    turn: 1,
    harnessSessionId: '00000000-0000-4000-8000-000000000001',
    tmuxSession: 'kteam-s1-agent',
    watcherSession: 'kteam-s1-watch',
    intervalSeconds: 5,
    stallSeconds: 900,
    timeoutSeconds: 3600,
    maxSnapshots: 20,
    systemPromptFile: '/tmp/system',
    originalPromptFile: '/tmp/prompt',
  },
  state: { id: 's1', status: 'awaiting_user', turn: 1 },
};

class FakeService implements KTeamService {
  listeners = new Set<(event: KTeamEvent) => void>();
  event: KTeamEvent = {
    sequence: 1,
    time: '2026-01-01T00:00:00Z',
    sessionId: 's1',
    turn: 1,
    type: 'chat.assistant.text',
    source: 'claude',
    data: { text: 'hello' },
  };
  health = async () => ({ ok: true });
  list = async () => [view];
  get = async () => view;
  start = async (_input: StartSessionRequest) => view;
  send = async (_id: string, _input: SendRequest) => view;
  answer = async () => view;
  interrupt = async () => view;
  stop = async () => view;
  resume = async () => view;
  remove = async () => {};
  signal = async () => view;
  snapshot = async () => 'pane';
  chatHistory = async () => ({ total: 0, offset: 0, records: [] });
  lastSnapshot = async () => 'pane (cached)';
  logs = async () => 'log';
  replay = async () => [this.event];
  subscribe = (listener: (event: KTeamEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  addAttachment = async (): Promise<AttachmentView> => ({
    id: 'att_x',
    filename: 'x.png',
    mime: 'image/png',
    size: 8,
    sha256: 'x',
    path: '/tmp/x',
    createdAt: '2026-01-01T00:00:00Z',
  });
  getAttachment = async () => ({ attachment: await this.addAttachment(), bytes: new Uint8Array([1, 2]) });
}

const servers: Server<unknown>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe('kteam daemon API', () => {
  test('requires authentication and exposes session commands', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/v1/health`)).status).toBe(401);
    const response = await fetch(`${base}/v1/sessions/s1/send`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'continue' }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as SessionView).config.id).toBe('s1');
  });

  test('replays history before live WebSocket events', async () => {
    const service = new FakeService();
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const received: KTeamEvent[] = [];
    const queryOnly = await fetch(`http://127.0.0.1:${server.port}/v1/events?token=secret`);
    expect(queryOnly.status).toBe(401);
    const BunWebSocket = WebSocket as unknown as {
      new (url: string | URL, options: Bun.WebSocketOptions): WebSocket;
    };
    const socket = new BunWebSocket(`ws://127.0.0.1:${server.port}/v1/events?sessionId=s1`, {
      headers: { authorization: 'Bearer secret' },
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket timeout')), 3000);
      socket.onmessage = message => {
        received.push(JSON.parse(String(message.data)) as KTeamEvent);
        if (received.length === 1) {
          const live = { ...service.event, sequence: 2, type: 'session.running' };
          for (const listener of service.listeners) listener(live);
        } else {
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
      };
      socket.onerror = () => reject(new Error('websocket error'));
    });
    expect(received.map(event => event.sequence)).toEqual([1, 2]);
  });
  test('serves the browser shell with the daemon token embedded', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    // Served shell is the built dist app when ui-dist exists, else the legacy
    // single-file shell — both must embed the token for loopback requesters,
    // and the dist path must NOT rename the __KTEAM_TOKEN__ global.
    expect(body).toContain('"secret"');
    expect(body).not.toContain('window.secret');
    expect(body).not.toContain('"__KTEAM_TOKEN__"');
  });
});
