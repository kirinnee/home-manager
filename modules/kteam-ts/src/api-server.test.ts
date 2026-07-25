import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { RecentRequestIds, startApiServer } from './api-server';
import { currentActor } from './actor-context';
import type { AttachmentView, KTeamService, SessionView } from './service';
import type { KTeamEvent, SendRequest, StartSessionRequest } from './types';
import { WARDEN_LABEL } from './warden-detect';

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
  get = async () => {
    this.lastActor = currentActor();
    return view;
  };
  suggestNames = async (count = 1) => ['aaron', 'abel', 'abigail'].slice(0, count);
  start = async (_input: StartSessionRequest) => view;
  send = async (_id: string, _input: SendRequest) => ({ ...view, disposition: 'delivered' as const });
  answer = async () => view;
  interrupt = async () => view;
  stop = async () => view;
  resume = async () => view;
  migrate = async (_id: string, _agent: string, _model?: string) => view;
  rename = async (_id: string, _name?: string, _teammate?: string) => view;
  remove = async () => {};
  signal = async () => view;
  wardenMayStop = (_wardenId: string, _targetId: string) => false;
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
  wardenStatus = async () => ({
    config: {
      enabled: false,
      wrapper: 'claude-auto-glm52a',
      intervalMinutes: 5,
      unattendedMinutes: 30,
      minSpawnGapMinutes: 60,
      susThinkingSeconds: 900,
      susSubprocessSeconds: 900,
      maxAssignedWardens: 3,
      assignedCooldownMinutes: 30,
    },
    anomalies: [],
    fingerprint: '',
  });
  wardenRun = async (_spawn?: boolean) => ({ sweptAt: '2026-01-01T00:00:00Z', anomalies: [], message: 'no anomalies' });
  wrappers = async () => [
    {
      name: 'claude-auto-loge',
      harness: 'claude' as const,
      mode: 'auto' as const,
      launchable: true,
      modelHint: 'F5/frontier account',
    },
    {
      name: 'claude-loge',
      harness: 'claude' as const,
      mode: 'interactive' as const,
      launchable: false,
      modelHint: 'loge',
    },
  ];
  projects = async () => [
    { name: 'home-manager', path: '/home/u/.config/home-manager', lastActivity: '2026-01-01T00:00:00Z' },
  ];
  lastActor: string | undefined = undefined;
  wardenVerdicts = async () => {
    this.lastActor = currentActor();
    return [
      {
        at: '2026-01-01T00:00:00Z',
        targetSession: 's1',
        teammate: 'lacey',
        verdict: 'killed' as const,
        reason: 'burning tokens with no progress',
        reportPath: '/home/u/.kteam/daemon/warden/reports/2026-01-01T00-00-00-000Z-s1.md',
      },
    ];
  };
  wardenReport = async (p: string) => `# report ${p}\n\nVerdict: KILL\n`;
  scratchPlan = async () => [];
  scratchSweep = async () => ({ sessions: 0, bytes: 0, failures: 0 });
  usage = async () => ({
    at: '2026-01-01T00:00:00Z',
    stale: false,
    accounts: [
      // The session under test runs claude-auto-mm3, so this one is joinable.
      {
        binary: 'claude-auto-mm3',
        fiveHourPercent: 7,
        weeklyPercent: 49,
        fiveHourResetAt: 1784964000363,
        weeklyResetAt: 1785142800363,
        atLimit: false,
        authOk: true,
      },
      // An exhausted account and a logged-out one: both must survive the wire
      // with their distinguishing field intact rather than collapsing to 0%.
      { binary: 'codex-auto-loai', atLimit: true, authOk: true, fiveHourPercent: 100 },
      { binary: 'claude-auto-dsv4p', authOk: false },
    ],
  });
  search = async (query: string, limit = 30) => ({
    query,
    scanned: 7,
    results: query
      ? [
          {
            sessionId: 's1',
            teammate: 'test',
            turn: 2,
            snippet: `… ${query} matched here …`,
            at: '2026-01-01T00:00:00Z',
          },
        ].slice(0, limit)
      : [],
  });
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

  test('exposes wrappers and projects for the New-session flow', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: 'Bearer secret' };
    expect((await fetch(`${base}/v1/wrappers`)).status).toBe(401);
    const wr = await fetch(`${base}/v1/wrappers`, { headers: auth });
    expect(wr.status).toBe(200);
    const wrappers = (await wr.json()) as Array<{ name: string; launchable: boolean }>;
    expect(wrappers.some(w => w.name === 'claude-auto-loge' && w.launchable)).toBe(true);
    const pr = await fetch(`${base}/v1/projects`, { headers: auth });
    expect(pr.status).toBe(200);
    expect(((await pr.json()) as Array<{ name: string }>)[0]!.name).toBe('home-manager');
  });

  // GET /v1/usage is the ONLY way the browser can learn account quota: session
  // views carry usage fields only after that session's own 60s monitor tick,
  // so a fleet list built from state alone shows blanks (the "quota is not in
  // the UI" gap). These assertions pin the wire contract the UI joins against.
  test('exposes the account usage feed, keyed by wrapper binary', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/v1/usage`)).status).toBe(401);

    const res = await fetch(`${base}/v1/usage`, { headers: { authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      at?: string;
      stale: boolean;
      accounts: Array<{
        binary: string;
        fiveHourPercent?: number;
        weeklyPercent?: number;
        fiveHourResetAt?: number;
        weeklyResetAt?: number;
        atLimit?: boolean;
        authOk?: boolean;
      }>;
    };
    expect(body.stale).toBe(false);
    expect(body.at).toBe('2026-01-01T00:00:00Z');

    // Joinable by the binary a session config already carries.
    const mm3 = body.accounts.find(a => a.binary === 'claude-auto-mm3');
    expect(mm3).toBeDefined();
    expect(mm3!.fiveHourPercent).toBe(7);
    expect(mm3!.weeklyPercent).toBe(49);
    expect(mm3!.fiveHourResetAt).toBe(1784964000363);
    expect(mm3!.weeklyResetAt).toBe(1785142800363);
    expect(mm3!.atLimit).toBe(false);
    expect(mm3!.authOk).toBe(true);

    // atLimit survives distinctly from "100%" — it is what blocks work.
    expect(body.accounts.find(a => a.binary === 'codex-auto-loai')!.atLimit).toBe(true);

    // UNKNOWN IS NOT ZERO: a logged-out wrapper reports authOk:false and NO
    // percentages, so the UI can render "auth!" instead of a confident 0%.
    const loggedOut = body.accounts.find(a => a.binary === 'claude-auto-dsv4p')!;
    expect(loggedOut.authOk).toBe(false);
    expect(loggedOut.fiveHourPercent).toBeUndefined();
    expect(loggedOut.weeklyPercent).toBeUndefined();
  });

  test('the warden-scoped token may READ the usage feed', async () => {
    const server = startApiServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      wardenToken: 'warden-secret',
      service: new FakeService(),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/v1/usage`, { headers: { authorization: 'Bearer warden-secret' } });
    expect(res.status).toBe(200);
  });

  test('exposes transcript search with a scanned count', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: 'Bearer secret' };
    const res = await fetch(`${base}/v1/search?q=hello&limit=10`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scanned: number; results: Array<{ sessionId: string; snippet: string }> };
    expect(body.scanned).toBe(7);
    expect(body.results[0]!.sessionId).toBe('s1');
    expect(body.results[0]!.snippet).toContain('hello');
  });

  test('exposes warden verdicts and a report reader', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: 'Bearer secret' };
    const vr = await fetch(`${base}/v1/warden/verdicts`, { headers: auth });
    expect(vr.status).toBe(200);
    const verdicts = (await vr.json()) as Array<{ verdict: string; targetSession: string }>;
    expect(verdicts[0]!.verdict).toBe('killed');
    expect(verdicts[0]!.targetSession).toBe('s1');
    const rep = await fetch(`${base}/v1/warden/report?path=/x/y.md`, { headers: auth });
    expect(rep.status).toBe(200);
    expect(await rep.text()).toContain('Verdict: KILL');
    expect((await fetch(`${base}/v1/warden/report`, { headers: auth })).status).toBe(400);
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
    expect(body).toContain('secret');
    expect(body).not.toContain('window.secret');
    expect(body).not.toContain('"__KTEAM_TOKEN__"');
    expect(body).not.toContain("'__KTEAM_TOKEN__'");
  });

  test('rejects malformed action inputs with 400', async () => {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service: new FakeService() });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const admin = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const migrate = await fetch(`${base}/v1/sessions/s1/migrate`, { method: 'POST', headers: admin, body: '{}' });
    expect(migrate.status).toBe(400);
    expect(((await migrate.json()) as { error: string }).error).toBe('agent is required');
    const signal = await fetch(`${base}/v1/sessions/s1/signal`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'nope' }),
    });
    expect(signal.status).toBe(400);
    expect(((await signal.json()) as { error: string }).error).toBe('kind must be one of done, help, waiting, working');
  });
});

describe('request-id idempotency for retried mutations', () => {
  const admin = (requestId?: string) => ({
    authorization: 'Bearer secret',
    'content-type': 'application/json',
    ...(requestId ? { 'x-kteam-request-id': requestId } : {}),
  });

  test('a duplicate request id does not re-apply a send; the current view is returned', async () => {
    const service = new FakeService();
    let sends = 0;
    service.send = async () => {
      sends++;
      return { ...view, disposition: 'delivered' as const };
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const request = () =>
      fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/send`, {
        method: 'POST',
        headers: admin('req-1'),
        body: JSON.stringify({ message: 'continue' }),
      });
    const first = await request();
    expect(first.status).toBe(200);
    const retry = await request();
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as SessionView).config.id).toBe('s1');
    expect(sends).toBe(1);
  });

  test('distinct request ids and id-less requests both apply', async () => {
    const service = new FakeService();
    let sends = 0;
    service.send = async () => {
      sends++;
      return { ...view, disposition: 'delivered' as const };
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const body = JSON.stringify({ message: 'continue' });
    await fetch(`${base}/v1/sessions/s1/send`, { method: 'POST', headers: admin('req-a'), body });
    await fetch(`${base}/v1/sessions/s1/send`, { method: 'POST', headers: admin('req-b'), body });
    await fetch(`${base}/v1/sessions/s1/send`, { method: 'POST', headers: admin(), body });
    expect(sends).toBe(3);
  });

  test('a failed attempt stays retryable under the same id', async () => {
    const service = new FakeService();
    let calls = 0;
    service.resume = async () => {
      calls++;
      if (calls === 1) throw new Error('session is already running');
      return view;
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const request = () =>
      fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/resume`, {
        method: 'POST',
        headers: admin('req-r'),
        body: '{}',
      });
    expect((await request()).status).toBe(409);
    expect((await request()).status).toBe(200);
    expect(calls).toBe(2);
  });

  test('a concurrent duplicate shares the in-flight application instead of re-applying', async () => {
    const service = new FakeService();
    let sends = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    service.send = async () => {
      sends++;
      await gate; // hold the first application open until both requests are in flight
      return { ...view, disposition: 'delivered' as const };
    };
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const request = () =>
      fetch(`http://127.0.0.1:${server.port}/v1/sessions/s1/send`, {
        method: 'POST',
        headers: admin('req-dup'),
        body: JSON.stringify({ message: 'continue' }),
      });
    const first = request();
    const second = request();
    // Both requests are on the wire while service.send is still pending — the
    // exact socket-retry overlap G3 exists for. Only one application may run.
    await Bun.sleep(50);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(sends).toBe(1);
    // And a later retry of the same id still answers from the recorded window.
    expect((await request()).status).toBe(200);
    expect(sends).toBe(1);
  });

  test('RecentRequestIds evicts oldest ids beyond capacity, per session', () => {
    const lru = new RecentRequestIds(2);
    lru.record('s1', 'a');
    lru.record('s1', 'b');
    lru.record('s1', 'c');
    expect(lru.seen('s1', 'a')).toBe(false);
    expect(lru.seen('s1', 'b')).toBe(true);
    expect(lru.seen('s1', 'c')).toBe(true);
    // Sessions do not share windows.
    expect(lru.seen('s2', 'b')).toBe(false);
    lru.record('s2', 'b');
    expect(lru.seen('s2', 'b')).toBe(true);
    expect(lru.seen('s1', 'b')).toBe(true);
  });

  test('a seen() hit promotes the id — an actively retried id outlives colder ones', () => {
    const lru = new RecentRequestIds(2);
    lru.record('s1', 'a');
    lru.record('s1', 'b');
    expect(lru.seen('s1', 'a')).toBe(true); // promote a over b
    lru.record('s1', 'c'); // evicts b (now coldest), not a
    expect(lru.seen('s1', 'a')).toBe(true);
    expect(lru.seen('s1', 'b')).toBe(false);
    expect(lru.seen('s1', 'c')).toBe(true);
  });
});

describe('warden-scoped token authorization', () => {
  const scoped = { authorization: 'Bearer warden', 'content-type': 'application/json' };

  function scopedServer(service: KTeamService = new FakeService()): string {
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', wardenToken: 'warden', service });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  }

  test('attributes warden-token requests to the warden actor (admin requests are unattributed)', async () => {
    const service = new FakeService();
    const base = scopedServer(service);
    const r1 = await fetch(`${base}/v1/sessions/s1`, { headers: scoped });
    expect(r1.status).toBe(200);
    expect(service.lastActor).toBe('warden');
    const r2 = await fetch(`${base}/v1/sessions/s1`, { headers: { authorization: 'Bearer secret' } });
    expect(r2.status).toBe(200);
    expect(service.lastActor).toBeUndefined();
  });

  test('permits reads and the safe-recovery writes', async () => {
    const base = scopedServer();
    expect((await fetch(`${base}/v1/sessions`, { headers: scoped })).status).toBe(200);
    expect((await fetch(`${base}/v1/sessions/s1`, { headers: scoped })).status).toBe(200);
    const send = await fetch(`${base}/v1/sessions/s1/send`, {
      method: 'POST',
      headers: scoped,
      body: JSON.stringify({ message: 'steer' }),
    });
    expect(send.status).toBe(200);
    const migrate = await fetch(`${base}/v1/sessions/s1/migrate`, {
      method: 'POST',
      headers: scoped,
      body: JSON.stringify({ agent: 'claude-auto-glm52b' }),
    });
    expect(migrate.status).toBe(200);
  });

  test('rejects start, stop, interrupt, remove, and the warden oversight routes with 403', async () => {
    const base = scopedServer();
    const post = (path: string) => fetch(`${base}${path}`, { method: 'POST', headers: scoped, body: '{}' });
    expect((await post('/v1/sessions')).status).toBe(403); // start
    expect((await post('/v1/sessions/s1/stop')).status).toBe(403);
    expect((await post('/v1/sessions/s1/interrupt')).status).toBe(403);
    expect((await post('/v1/warden/run')).status).toBe(403);
    expect((await fetch(`${base}/v1/sessions/s1`, { method: 'DELETE', headers: scoped })).status).toBe(403);
    expect((await fetch(`${base}/v1/warden/status`, { headers: scoped })).status).toBe(403);
  });

  test('an ASSIGNED warden may stop exactly its assigned target, by capability (A6 sus list)', async () => {
    class AssignedService extends FakeService {
      wardenMayStop = (capability: string, targetId: string) => capability === 'cap-secret-9' && targetId === 's1';
    }
    const base = scopedServer(new AssignedService());
    const stop = (target: string, capability?: string) =>
      fetch(`${base}/v1/sessions/${target}/stop`, {
        method: 'POST',
        headers: { ...scoped, ...(capability ? { 'x-kteam-stop-capability': capability } : {}) },
        body: '{}',
      });
    expect((await stop('s1', 'cap-secret-9')).status).toBe(200); // its assignment
    expect((await stop('s1', 'cap-guessed')).status).toBe(403); // wrong capability
    expect((await stop('s1')).status).toBe(403); // no capability at all
    // A client-chosen identity header is NEVER authority (the old spoof hole).
    const spoofed = await fetch(`${base}/v1/sessions/s1/stop`, {
      method: 'POST',
      headers: { ...scoped, 'x-kteam-session-id': 'warden-9' },
      body: '{}',
    });
    expect(spoofed.status).toBe(403);
    // A different target under the same capability stays forbidden.
    expect((await stop('s2', 'cap-secret-9')).status).toBe(403);
  });

  test('signal is gated to warden-labelled sessions only', async () => {
    // Default FakeService session carries no warden label → self-completion denied.
    const unlabelled = scopedServer();
    const denied = await fetch(`${unlabelled}/v1/sessions/s1/signal`, {
      method: 'POST',
      headers: scoped,
      body: JSON.stringify({ kind: 'done' }),
    });
    expect(denied.status).toBe(403);

    // A warden-labelled session may signal itself done.
    class WardenLabelledService extends FakeService {
      get = async () => ({ ...view, config: { ...view.config, label: WARDEN_LABEL } }) as SessionView;
    }
    const wardenBase = scopedServer(new WardenLabelledService());
    const allowed = await fetch(`${wardenBase}/v1/sessions/s1/signal`, {
      method: 'POST',
      headers: scoped,
      body: JSON.stringify({ kind: 'done' }),
    });
    expect(allowed.status).toBe(200);
  });
});

describe('create idempotency (exit-143 spawn timeouts, 2026-07-23/24)', () => {
  /** A service that counts starts and hands out a distinct session each time. */
  class CountingStartService extends FakeService {
    starts = 0;
    startDelayMs = 0;
    override start = async (_input: StartSessionRequest) => {
      this.starts += 1;
      const id = `s-${this.starts}`;
      if (this.startDelayMs > 0) await Bun.sleep(this.startDelayMs);
      return { ...view, config: { ...view.config, id }, state: { ...view.state, id } };
    };
    override get = async (...args: unknown[]) => {
      const id = String(args[0] ?? 's1');
      return { ...view, config: { ...view.config, id }, state: { ...view.state, id } };
    };
  }

  const post = (base: string, requestId?: string) =>
    fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        ...(requestId ? { 'x-kteam-request-id': requestId } : {}),
      },
      body: JSON.stringify({ prompt: 'go', agent: 'claude-auto-atomi' }),
    });

  test('a retry carrying the same request id returns the FIRST session, not a second one', async () => {
    const service = new CountingStartService();
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const first = (await (await post(base, 'req-1')).json()) as SessionView;
    const retry = (await (await post(base, 'req-1')).json()) as SessionView;
    expect(service.starts).toBe(1);
    expect(retry.config.id).toBe(first.config.id);
    // A different request id is a genuinely different start.
    await post(base, 'req-2');
    expect(service.starts).toBe(2);
  });

  test('a retry that OVERLAPS the first attempt shares it instead of launching twice', async () => {
    const service = new CountingStartService();
    service.startDelayMs = 60;
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const [a, b] = await Promise.all([post(base, 'req-overlap'), post(base, 'req-overlap')]);
    const [first, second] = (await Promise.all([a.json(), b.json()])) as SessionView[];
    expect(service.starts).toBe(1);
    expect(second!.config.id).toBe(first!.config.id);
  });

  test('by-request resolves the session a caller never got a response for', async () => {
    const service = new CountingStartService();
    const server = startApiServer({ host: '127.0.0.1', port: 0, token: 'secret', service });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const created = (await (await post(base, 'req-lost')).json()) as SessionView;
    // The lookup is keyed by request id AND payload, exactly like the create.
    const payload = Bun.hash(JSON.stringify({ prompt: 'go', agent: 'claude-auto-atomi' })).toString(16);

    const found = await fetch(`${base}/v1/sessions/by-request/req-lost?payload=${payload}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(found.status).toBe(200);
    expect(((await found.json()) as SessionView).config.id).toBe(created.config.id);

    const missing = await fetch(`${base}/v1/sessions/by-request/req-never-sent?payload=${payload}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(missing.status).toBe(404);

    // Same id, DIFFERENT task: the lookup must never hand back the first
    // session (an exported KTEAM_REQUEST_ID would otherwise silently alias
    // every start in a shell to the first one).
    const other = Bun.hash(JSON.stringify({ prompt: 'something else' })).toString(16);
    const wrong = await fetch(`${base}/v1/sessions/by-request/req-lost?payload=${other}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(wrong.status).toBe(404);
    expect(service.starts).toBe(1);
  });
});
