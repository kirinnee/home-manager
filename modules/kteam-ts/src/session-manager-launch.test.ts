import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from './session-manager';

// P0, reproduced live 2026-07-24 (session mrzi4r0p, claude-auto-glm52a):
//
//   session.starting → session.crashed → transcript.discovered → chat.user
//   → session.launch_backgrounded → chat.assistant.thinking
//
// The daemon declared the session CRASHED six seconds into a launch that was
// still queued behind the cross-session bootstrap chain — then the TUI came up
// and did the whole task correctly, replied, and wrote its done marker, while
// `state.status` stayed `failed` forever (a terminal status suppresses every
// later patch, so the launch's own `session.running` was dropped) and every
// control action refused the session.
//
// Root cause, from the daemon journal at 22:18:49Z ("self-check: 1 running
// session(s) without a monitor — repairing"): `start()` registered the session
// in `this.launching` only AFTER awaiting the `starting` transition, and
// transition() awaits emit(), which rides the global event queue — 10+ seconds
// behind during a launch storm. In that window the session was persisted as
// `starting` but invisible to every launch guard, so the self-check "repaired"
// it with a monitor that read a tmux session which did not exist yet and could
// not tell "not launched" from "died".
//
// These tests pin both halves: a launch in flight is PENDING (never crashed),
// and a launch that genuinely dies still fails with the real reason.

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type Loose = Record<string, unknown>;

const bareManager = () => Object.create(SessionManager.prototype) as Loose;

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-launch-test-'));
  temporaryDirectories.push(home);
  return home;
}

interface Recorded {
  type: string;
  patch?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

interface MonitorHarness {
  manager: Loose;
  recorded: Recorded[];
  state: Record<string, unknown>;
  /** Marks the launch as finished (removes it from `launching`). */
  finishLaunch: () => void;
}

/** A manager whose store/tmux are fakes but whose monitorLoop is the real one,
 *  pointed at a tmux session that does not exist. */
async function monitorHarness(input: {
  status: string;
  launchInFlight: boolean;
  launchedAt?: string;
}): Promise<MonitorHarness> {
  const home = await temporaryHome();
  const recorded: Recorded[] = [];
  const state: Record<string, unknown> = {
    id: 's1',
    status: input.status,
    turn: 1,
    ...(input.launchedAt ? { launchedAt: input.launchedAt } : {}),
  };
  const config = {
    id: 's1',
    harness: 'claude',
    mode: 'auto',
    binary: 'claude-auto-glm52a',
    tmuxSession: 'kteam-s1-agent',
    turn: 1,
    intervalSeconds: 1,
    cwd: home,
  };
  const manager = bareManager();
  manager.closed = false;
  manager.paths = { home, sessions: home, daemon: home };
  manager.monitors = new Map();
  manager.launching = new Map(
    input.launchInFlight ? [['s1', { at: Date.now(), bootstrap: new Promise<void>(() => {}) }]] : [],
  );
  manager.doneDeferred = new Set();
  manager.autoContinued = new Set();
  manager.options = { healthIntervalSeconds: 1, warden: { intervalMinutes: 5 } };
  manager.get = async () => ({ directory: path.join(home, 's1'), config, state });
  manager.tmux = {
    // The exact signature of a tmux session that was never created — and of
    // one whose harness died. They are indistinguishable at this layer.
    state: async () => ({ alive: false, dead: true, pane: '', visiblePane: '', promptReady: false }),
    snapshot: async () => '',
  };
  manager.transition = async (_id: string, patch: Record<string, unknown>, type: string) => {
    recorded.push({ type, patch });
    Object.assign(state, patch);
  };
  manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
    recorded.push({ type, data });
  };
  manager.fetchQuota = async () => undefined;
  manager.store = { updateState: async () => state };
  return {
    manager,
    recorded,
    state,
    finishLaunch: () => (manager.launching as Map<string, unknown>).delete('s1'),
  };
}

const runMonitor = (manager: Loose, signal: AbortSignal) =>
  (manager as unknown as { monitorLoop: (id: string, signal: AbortSignal) => Promise<void> }).monitorLoop('s1', signal);

// --- teammate name resolution ( --teammate / kteam name ) ------------------

describe('teammate name resolution', () => {
  interface FakeSession {
    teammate: string;
    status: string;
    /** ms before now the session was created (default: inside the window). */
    ageMs?: number;
    id?: string;
    name?: string;
  }

  /** A bare manager whose store lists exactly these sessions, enough for
   *  teammateNameUsage / resolveTeammateName / suggestNames (which read only
   *  store.listSessions()). */
  function nameManager(sessions: FakeSession[]): Loose {
    const manager = bareManager();
    manager.store = {
      listSessions: () =>
        sessions.map((session, index) => ({
          id: session.id ?? `id-${index}`,
          directory: `/tmp/id-${index}`,
          config: {
            id: session.id ?? `id-${index}`,
            teammate: session.teammate,
            name: session.name ?? `task-${index}`,
            createdAt: new Date(Date.now() - (session.ageMs ?? 60_000)).toISOString(),
          },
          state: { status: session.status },
        })),
    };
    return manager;
  }

  const resolve = (manager: Loose, request: Record<string, unknown>) =>
    (manager as unknown as { resolveTeammateName: (r: Record<string, unknown>) => string }).resolveTeammateName(
      request,
    );

  test('auto-assigns when --teammate is absent', () => {
    const manager = nameManager([{ teammate: 'aaron', status: 'running' }]);
    const name = resolve(manager, {});
    expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(name).not.toBe('aaron'); // avoids the in-window name
  });

  test('accepts and normalises a valid --teammate name', () => {
    const manager = nameManager([]);
    expect(resolve(manager, { teammate: 'Hayden' })).toBe('hayden');
  });

  test('rejects an invalid --teammate slug', () => {
    const manager = nameManager([]);
    expect(() => resolve(manager, { teammate: '[Hayden]' })).toThrow(/invalid --teammate/);
  });

  test('fails loudly when a LIVE session in the window holds the name', () => {
    const manager = nameManager([{ teammate: 'hayden', status: 'running', id: 'ms-live', name: 'Fix Transcript' }]);
    expect(() => resolve(manager, { teammate: 'hayden' })).toThrow(/already taken by a live session/);
    expect(() => resolve(manager, { teammate: 'hayden' })).toThrow(/ms-live/);
  });

  test('a terminal session holding the name is NOT a collision', () => {
    const manager = nameManager([{ teammate: 'hayden', status: 'completed' }]);
    expect(resolve(manager, { teammate: 'hayden' })).toBe('hayden');
  });

  test('a same-name session OUTSIDE the window is NOT a collision', () => {
    const manager = nameManager([
      { teammate: 'hayden', status: 'running', ageMs: 6 * 24 * 60 * 60 * 1000 }, // 6 days > 5-day window
    ]);
    expect(resolve(manager, { teammate: 'hayden' })).toBe('hayden');
  });

  test('--teammate-fallback auto-assigns a free name on collision', () => {
    const manager = nameManager([{ teammate: 'hayden', status: 'running' }]);
    const name = resolve(manager, { teammate: 'hayden', teammateFallback: true });
    expect(name).not.toBe('hayden');
    expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  test('suggestNames returns distinct free names, avoiding in-window names', async () => {
    const manager = nameManager([{ teammate: 'aaron', status: 'running' }]);
    const names = await (manager as unknown as { suggestNames: (n: number) => Promise<string[]> }).suggestNames(5);
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5); // distinct
    expect(names).not.toContain('aaron');
  });
});

describe('a launch still in flight is PENDING, never crashed', () => {
  test('a monitor started mid-launch leaves a starting session alone', async () => {
    const harness = await monitorHarness({ status: 'starting', launchInFlight: true });
    const abort = new AbortController();
    const loop = runMonitor(harness.manager, abort.signal);
    await Bun.sleep(60);
    abort.abort();
    await loop;
    // The regression: session.crashed / status=failed on a healthy teammate.
    expect(harness.recorded.map(item => item.type)).not.toContain('session.crashed');
    expect(harness.recorded.map(item => item.type)).not.toContain('session.launch_failed');
    expect(harness.state.status).toBe('starting');
  });

  test('once the launch is gone and the pane never existed, it fails honestly', async () => {
    // No launch in flight and no launchedAt: the bootstrap died before it ever
    // ran `tmux new-session` (daemon restart mid-queue). That IS a failure —
    // but blaming a harness that never started is not the reason to record.
    const harness = await monitorHarness({ status: 'starting', launchInFlight: false });
    const abort = new AbortController();
    const loop = runMonitor(harness.manager, abort.signal);
    await Bun.sleep(60);
    abort.abort();
    await loop;
    const failure = harness.recorded.find(item => item.type === 'session.launch_failed');
    expect(failure).toBeDefined();
    expect(String(failure!.patch!.reason)).toContain('never created its tmux session');
    expect(harness.recorded.map(item => item.type)).not.toContain('session.crashed');
  });

  test('a pane that DID launch and then died is still a real crash', async () => {
    const harness = await monitorHarness({
      status: 'running',
      launchInFlight: false,
      launchedAt: new Date().toISOString(),
    });
    const abort = new AbortController();
    const loop = runMonitor(harness.manager, abort.signal);
    await Bun.sleep(60);
    abort.abort();
    await loop;
    expect(harness.recorded.map(item => item.type)).toContain('session.crashed');
    expect(harness.state.status).toBe('failed');
  });
});

// --- the bootstrap side: backgrounding must RESOLVE, not strand -------------

interface BootstrapHarness {
  manager: Loose;
  events: Recorded[];
  state: Record<string, unknown>;
  monitored: string[];
}

function bootstrapHarness(input: { launch: () => Promise<void>; backgrounded: boolean }): BootstrapHarness {
  const events: Recorded[] = [];
  const monitored: string[] = [];
  const state: Record<string, unknown> = { id: 's1', status: 'starting', turn: 1 };
  const manager = bareManager();
  manager.closed = false;
  manager.launching = new Map([
    ['s1', { at: Date.now(), bootstrap: Promise.resolve(), backgrounded: input.backgrounded }],
  ]);
  manager.paths = { home: '/tmp', sessions: '/tmp', daemon: '/tmp' };
  manager.serializedBootstrap = async (operation: () => Promise<unknown>) => await operation();
  manager.launchWithRetry = input.launch;
  manager.promptInstruction = () => 'go';
  manager.tmux = { send: async () => undefined, snapshot: async () => '', state: async () => ({ alive: false }) };
  manager.store = {
    updateState: async (_id: string, update: (current: Record<string, unknown>) => Record<string, unknown>) => {
      Object.assign(state, update(state));
      return state;
    },
  };
  manager.transition = async (_id: string, patch: Record<string, unknown>, type: string) => {
    events.push({ type, patch });
    Object.assign(state, patch);
  };
  manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
    events.push({ type, data });
  };
  manager.startMonitor = async (id: string) => {
    monitored.push(id);
  };
  manager.stopTmuxWithEvidence = async () => undefined;
  return { manager, events, state, monitored };
}

const bootstrap = (manager: Loose) =>
  (manager as unknown as { bootstrapSession: (id: string, config: unknown) => Promise<void> }).bootstrapSession('s1', {
    id: 's1',
    tmuxSession: 'kteam-s1-agent',
  });

describe('a backgrounded launch resolves itself', () => {
  test('it comes up running, attaches a monitor, and says so', async () => {
    const harness = bootstrapHarness({ launch: async () => undefined, backgrounded: true });
    await bootstrap(harness.manager);
    expect(harness.state.status).toBe('running');
    expect(harness.state.launchedAt).toBeDefined();
    expect(harness.monitored).toEqual(['s1']);
    const settled = harness.events.find(item => item.type === 'session.launch_settled');
    expect(settled?.data?.outcome).toBe('running');
  });

  test('a launch that genuinely dies still fails, with the real reason', async () => {
    const harness = bootstrapHarness({
      launch: async () => {
        throw new Error('wrapper claude-auto-glm52a not found');
      },
      backgrounded: true,
    });
    await expect(bootstrap(harness.manager)).rejects.toThrow('not found');
    expect(harness.state.status).toBe('failed');
    expect(String(harness.state.reason)).toContain('not found');
    const settled = harness.events.find(item => item.type === 'session.launch_settled');
    expect(settled?.data?.outcome).toBe('failed');
  });

  test('a false terminal record written during the launch does not strand the session', async () => {
    // The composed failure from kteam-prob.md: something records `failed` while
    // the launch is still queued. The launch's own outcome must still win —
    // otherwise the healthy teammate is unsteerable forever.
    const harness = bootstrapHarness({ launch: async () => undefined, backgrounded: true });
    harness.state.status = 'failed';
    harness.state.health = 'crashed';
    harness.state.reason = 'interactive claude exited unknown';
    await bootstrap(harness.manager);
    expect(harness.state.status).toBe('running');
    expect(harness.state.reason).toBeUndefined();
  });

  test('a launch inside its window does not announce a background launch', async () => {
    const harness = bootstrapHarness({ launch: async () => undefined, backgrounded: false });
    await bootstrap(harness.manager);
    expect(harness.events.map(item => item.type)).not.toContain('session.launch_settled');
    expect(harness.state.status).toBe('running');
  });
});

// --- control actions during the launch window ------------------------------

describe('control actions queue behind a launch instead of hard-refusing', () => {
  function controlManager(settleAfterMs: number | undefined) {
    const manager = bareManager();
    manager.launching = new Map([
      [
        's1',
        {
          at: Date.now(),
          bootstrap:
            settleAfterMs === undefined ? new Promise<void>(() => {}) : Bun.sleep(settleAfterMs).then(() => undefined),
        },
      ],
    ]);
    return manager;
  }

  const awaitLaunchSettled = (manager: Loose, waitMs: number) =>
    (manager as unknown as { awaitLaunchSettled: (id: string, waitMs: number) => Promise<boolean> }).awaitLaunchSettled(
      's1',
      waitMs,
    );

  test('a send that lands mid-launch waits for the launch to finish', async () => {
    expect(await awaitLaunchSettled(controlManager(20), 5_000)).toBe(true);
  });

  test('a launch that never settles reports pending rather than blocking forever', async () => {
    expect(await awaitLaunchSettled(controlManager(undefined), 30)).toBe(false);
  });

  test('a failed launch still releases the waiter', async () => {
    const manager = bareManager();
    const bootstrapPromise = Bun.sleep(10).then(() => {
      throw new Error('launch died');
    });
    // The rejection is handled by awaitLaunchSettled; keep it from surfacing
    // as an unhandled rejection in the test runner.
    bootstrapPromise.catch(() => undefined);
    manager.launching = new Map([['s1', { at: Date.now(), bootstrap: bootstrapPromise }]]);
    expect(await awaitLaunchSettled(manager, 5_000)).toBe(true);
  });

  test('no launch in flight is never a wait', async () => {
    const manager = bareManager();
    manager.launching = new Map();
    expect(await awaitLaunchSettled(manager, 5_000)).toBe(true);
  });
});
