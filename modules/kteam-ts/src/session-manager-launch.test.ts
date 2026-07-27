import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  turn?: number;
  launchedAt?: string;
  subprocessAlive?: boolean;
  finalFrame?: string;
}): Promise<MonitorHarness> {
  const home = await temporaryHome();
  const recorded: Recorded[] = [];
  const state: Record<string, unknown> = {
    id: 's1',
    status: input.status,
    turn: input.turn ?? 1,
    ...(input.launchedAt ? { launchedAt: input.launchedAt } : {}),
  };
  const config = {
    id: 's1',
    harness: 'claude',
    mode: 'auto',
    binary: 'claude-auto-glm52a',
    tmuxSession: 'kteam-s1-agent',
    turn: input.turn ?? 1,
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
  // Production deliberately pauses before the confirming probe. Unit tests
  // exercise the same two-probe control flow without paying that wall time.
  manager.terminalReprobeMs = 0;
  manager.options = { healthIntervalSeconds: 1, warden: { intervalMinutes: 5 } };
  manager.get = async () => ({ directory: path.join(home, 's1'), config, state });
  manager.tmux = {
    // The exact signature of a tmux session that was never created — and of
    // one whose harness died. They are indistinguishable at this layer.
    state: async () => ({
      alive: false,
      dead: true,
      pane: input.finalFrame ?? '',
      visiblePane: input.finalFrame ?? '',
      promptReady: false,
    }),
    subprocessAlive: async () => input.subprocessAlive === true,
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
    expect(harness.state.reason).not.toBe('interactive claude exited unknown');
    expect(String(harness.state.reason)).toContain('exit code unavailable');
  });

  test('one failed has-session probe cannot terminalize a still-live harness process', async () => {
    const harness = await monitorHarness({
      status: 'running',
      launchInFlight: false,
      launchedAt: new Date().toISOString(),
      subprocessAlive: true,
    });
    const abort = new AbortController();
    const loop = runMonitor(harness.manager, abort.signal);
    await Bun.sleep(20);
    abort.abort();
    await loop;
    expect(harness.recorded.map(item => item.type)).toContain('control.false_terminal_averted');
    expect(harness.recorded.map(item => item.type)).not.toContain('session.crashed');
    expect(harness.state.status).toBe('running');
  });
});

describe('done markers are turn-scoped in the live monitor', () => {
  test('a turn-N marker during turn N+1 is journaled as stale and does not complete the session', async () => {
    const harness = await monitorHarness({
      status: 'running',
      launchInFlight: false,
      turn: 4,
      launchedAt: new Date().toISOString(),
    });
    const markerDirectory = path.join(String((harness.manager.paths as { home: string }).home), 's1', 'markers');
    await mkdir(markerDirectory, { recursive: true });
    await writeFile(path.join(markerDirectory, 'done.json'), '{"type":"done","turn":3}\n');
    harness.manager.stopTmuxWithEvidence = async () => undefined;
    const abort = new AbortController();
    const loop = runMonitor(harness.manager, abort.signal);
    await Bun.sleep(30);
    abort.abort();
    await loop;
    expect(harness.recorded.map(item => item.type)).toContain('session.stale_done_marker');
    expect(harness.recorded.map(item => item.type)).not.toContain('session.completed');
  });

  test('a marker for the current turn still completes the session', async () => {
    const harness = await monitorHarness({
      status: 'running',
      launchInFlight: false,
      turn: 4,
      launchedAt: new Date().toISOString(),
    });
    const markerDirectory = path.join(String((harness.manager.paths as { home: string }).home), 's1', 'markers');
    await mkdir(markerDirectory, { recursive: true });
    await writeFile(path.join(markerDirectory, 'done.json'), '{"type":"done","turn":4}\n');
    harness.manager.stopTmuxWithEvidence = async () => undefined;
    await runMonitor(harness.manager, new AbortController().signal);
    expect(harness.recorded.map(item => item.type)).toContain('session.completed');
  });
});

describe('subprocess liveness without transcript tool records', () => {
  test('a live pane child with no open tools keeps a silent session out of the kill verdict', async () => {
    const home = await temporaryHome();
    const directory = path.join(home, 's1');
    await mkdir(path.join(directory, 'checks'), { recursive: true });
    await mkdir(path.join(directory, 'turns'), { recursive: true });
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const state: Record<string, unknown> = {
      id: 's1',
      status: 'running',
      turn: 1,
      startedAt: old,
      lastTranscriptAt: new Date(Date.parse(old) + 1_000).toISOString(),
      lastPaneAt: old,
      lastSubprocessAt: old,
      nudgedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      openTools: [],
      turnCompleted: false,
    };
    const config = {
      id: 's1',
      harness: 'claude',
      mode: 'auto',
      binary: 'claude-auto-loge',
      tmuxSession: 'kteam-s1-agent',
      turn: 1,
      intervalSeconds: 0.01,
      cwd: home,
      createdAt: old,
      timeoutSeconds: 7_200,
      nudgeAfterSeconds: 1,
      killAfterSeconds: 2,
    };
    const manager = bareManager();
    const abort = new AbortController();
    let subprocessProbes = 0;
    let kills = 0;
    const events: string[] = [];
    manager.closed = false;
    manager.paths = { home, sessions: home, daemon: home };
    manager.monitors = new Map();
    manager.launching = new Map();
    manager.doneDeferred = new Set();
    manager.autoContinued = new Set();
    // monitorLoop now routes structured-question reconciliation through the
    // per-session queue. This isolated prototype fixture has no constructor-
    // initialized queue maps, so provide the same uncontended semantics here.
    manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
    manager.options = {
      healthIntervalSeconds: 0.01,
      warden: { susThinkingSeconds: 900, susSubprocessSeconds: 900 },
    };
    manager.get = async () => ({ directory, config, state });
    manager.tmux = {
      state: async () => ({
        alive: true,
        dead: false,
        pane: 'silent static pane',
        visiblePane: 'silent static pane',
        promptReady: false,
      }),
      snapshot: async () => '',
      subprocessAlive: async () => {
        subprocessProbes += 1;
        return true;
      },
      send: async () => undefined,
    };
    manager.gitFingerprint = async () => '';
    manager.updateQuota = async () => undefined;
    manager.transition = async (_id: string, patch: Record<string, unknown>, type: string) => {
      events.push(type);
      // The first frame seen after monitor attachment is a baseline, not new
      // work for this regression: hold the deliberately stale pane timestamp.
      const applied = { ...patch };
      if (type === 'terminal.frame') delete applied.lastPaneAt;
      Object.assign(state, applied);
    };
    manager.store = {
      updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        Object.assign(state, mutate(state));
        if (state.lastSubprocessAt !== old) abort.abort();
        return state;
      },
    };
    manager.stopTmuxWithEvidence = async () => {
      kills += 1;
    };
    manager.emit = async (_id: string, type: string) => {
      events.push(type);
    };

    const fallback = setTimeout(() => abort.abort(), 2_000);
    try {
      await runMonitor(manager, abort.signal);
    } finally {
      clearTimeout(fallback);
    }

    expect(subprocessProbes).toBeGreaterThan(0);
    expect(state.lastSubprocessAt).not.toBe(old);
    expect(kills).toBe(0);
    expect(events).not.toContain('session.stalled');
    expect(state.status).toBe('running');
  });
});

// The 2026-07-26 revive-on-send incident, in its exact harmful order:
// monitor writes failed DURING relaunch -> relaunch succeeds -> running patch
// arrives afterwards. A terminal-preserving transition used to discard that
// correction and leave a healthy pane recorded failed.
describe('revive-on-send relaunch race', () => {
  test('the successful running correction wins after a monitor writes a spurious terminal state', async () => {
    const home = await temporaryHome();
    await Promise.all([
      mkdir(path.join(home, 's1', 'turns'), { recursive: true }),
      mkdir(path.join(home, 's1', 'markers'), { recursive: true }),
      mkdir(path.join(home, 's1', 'channel'), { recursive: true }),
    ]);
    const config: Record<string, unknown> = {
      id: 's1',
      harness: 'claude',
      mode: 'auto',
      binary: 'claude-auto-loge',
      tmuxSession: 'kteam-s1-agent',
      turn: 3,
      intervalSeconds: 1,
      cwd: home,
    };
    let state: Record<string, unknown> = {
      id: 's1',
      status: 'failed',
      health: 'crashed',
      turn: 3,
      finishedAt: new Date().toISOString(),
      pendingQuestion: {
        toolUseId: 'tool-before-resume',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      },
    };
    const order: string[] = [];
    const questionCancellations: Record<string, unknown>[] = [];
    const manager = bareManager();
    manager.paths = {
      home,
      sessions: home,
      daemon: home,
    };
    manager.closed = false;
    manager.launching = new Map();
    manager.monitors = new Map();
    manager.queues = new Map();
    manager.autoContinued = new Set();
    manager.doneDeferred = new Set();
    manager.resolveRef = (id: string) => id;
    manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
    manager.serializedBootstrap = async (work: () => Promise<unknown>) => await work();
    manager.clearNeedsHuman = async () => undefined;
    manager.cancelRetry = () => undefined;
    manager.attachments = { buildImageReferenceBlock: async () => '' };
    manager.promptInstruction = () => 'read the next turn';
    manager.store = {
      getSession: () => ({ config, state }),
      updateConfig: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        Object.assign(config, mutate(config));
        return config;
      },
      updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.get = async () => ({ directory: path.join(home, 's1'), config, state });
    manager.emitDeferred = () => undefined;
    manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
      if (type === 'interaction.question_cancelled') {
        order.push('question-cancelled');
        questionCancellations.push(data);
      }
      return {};
    };
    manager.stopMonitor = async () => {
      order.push('monitor-stopped');
    };
    manager.startMonitor = async () => {
      order.push('monitor-started');
    };
    manager.tmux = {
      state: async () => ({ alive: false, dead: true, promptReady: false, pane: '', visiblePane: '' }),
      send: async () => {
        order.push('prompt-sent');
      },
      subprocessAlive: async () => false,
      snapshot: async () => '',
    };
    manager.stopTmuxWithEvidence = async () => undefined;
    manager.launchWithRetry = async () => {
      order.push('launched');
      expect((manager.launching as Map<string, unknown>).has('s1')).toBe(true);
      // Precisely the racing monitor write from the incident.
      await (
        manager as unknown as {
          transition: (id: string, patch: Record<string, unknown>, type: string) => Promise<void>;
        }
      ).transition(
        's1',
        {
          status: 'failed',
          health: 'crashed',
          reason: 'interactive claude exited unknown',
          finishedAt: new Date().toISOString(),
        },
        'session.crashed',
      );
      order.push('spurious-failed');
    };

    const result = await (
      manager as unknown as {
        send: (id: string, request: { message: string }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: 'continue the same task' });

    expect(result.disposition).toBe('revived');
    expect(order).toEqual([
      'monitor-stopped',
      'question-cancelled',
      'launched',
      'spurious-failed',
      'prompt-sent',
      'monitor-started',
    ]);
    expect(state.launchedAt).toBeDefined();
    expect(state.status).toBe('running');
    expect(state.health).toBe('healthy');
    expect(state.reason).toBeUndefined();
    expect(state.pendingQuestion).toBeUndefined();
    expect(questionCancellations).toEqual([
      {
        toolUseId: 'tool-before-resume',
        reason: 'session relaunched before a daemon-confirmed answer',
        pendingQuestion: null,
      },
    ]);
    expect((manager.launching as Map<string, unknown>).has('s1')).toBe(false);
  });

  test('a launch error cannot make resume kill a pane that re-probes live and prompt-ready', async () => {
    const home = await temporaryHome();
    await Promise.all([
      mkdir(path.join(home, 's1', 'turns'), { recursive: true }),
      mkdir(path.join(home, 's1', 'markers'), { recursive: true }),
    ]);
    let config: Record<string, unknown> = {
      id: 's1',
      harness: 'claude',
      mode: 'auto',
      binary: 'claude-auto-loge',
      tmuxSession: 'kteam-s1-agent',
      turn: 3,
      cwd: home,
    };
    let state: Record<string, unknown> = { id: 's1', status: 'failed', health: 'crashed', turn: 3 };
    let probes = 0;
    let kills = 0;
    let monitors = 0;
    const events: string[] = [];
    const manager = bareManager();
    manager.paths = { home, sessions: home, daemon: home };
    manager.closed = false;
    manager.terminalReprobeMs = 0;
    manager.launching = new Map();
    manager.monitors = new Map();
    manager.autoContinued = new Set();
    manager.doneDeferred = new Set();
    manager.resolveRef = (id: string) => id;
    manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
    manager.serializedBootstrap = async (work: () => Promise<unknown>) => await work();
    manager.clearNeedsHuman = async () => undefined;
    manager.cancelRetry = () => undefined;
    manager.promptInstruction = () => 'continue';
    manager.store = {
      updateConfig: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        config = mutate(config);
        return config;
      },
      updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.get = async () => ({ directory: path.join(home, 's1'), config, state });
    manager.transition = async (_id: string, patch: Record<string, unknown>) => {
      state = { ...state, ...patch };
    };
    manager.emit = async (_id: string, type: string) => {
      events.push(type);
      return {};
    };
    manager.stopMonitor = async () => undefined;
    manager.startMonitor = async () => {
      monitors++;
    };
    manager.stopTmuxWithEvidence = async () => {
      kills++;
    };
    manager.launchWithRetry = async () => {
      throw new Error('interactive harness exited; exit code unavailable (single-probe)');
    };
    manager.tmux = {
      // Old-pane inspection is dead. Both failure probes then see the newly
      // created replacement pane alive and editable.
      state: async () =>
        ++probes === 1
          ? { alive: false, dead: true, promptReady: false, pane: '', visiblePane: '' }
          : { alive: true, dead: false, promptReady: true, pane: '❯ ', visiblePane: '❯ ' },
      subprocessAlive: async () => false,
      snapshot: async () => {
        throw new Error('must not snapshot/kill the live successor');
      },
    };

    const resumed = await (
      manager as unknown as { resume: (id: string, message: string) => Promise<{ state: Record<string, unknown> }> }
    ).resume('s1', 'continue');
    expect(kills).toBe(0);
    expect(monitors).toBe(1);
    expect(events).toContain('control.false_terminal_averted');
    expect(resumed.state.status).toBe('running');
    expect(resumed.state.health).toBe('healthy');
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
