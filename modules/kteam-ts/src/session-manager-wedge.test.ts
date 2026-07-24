import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from './session-manager';

// The 2026-07-23 daemon wedge: the event loop stopped for 11 minutes (23:26:46Z
// → 23:37:55Z — no timer ticks, no accepts), and AFTER it recovered `kteam ps`
// stayed incomplete: done-marked sessions were missing from the listing while
// their journals kept growing. Only a full restart restored coherence. These
// tests simulate the wedge and pin the recovery: detect the starvation from the
// self-check timer's own lateness, verify the index against the session
// directories, repair in place, and escalate to a clean restart only when the
// repair does not take.

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type Loose = Record<string, unknown>;

function bareManager(): Loose {
  return Object.create(SessionManager.prototype) as Loose;
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-wedge-test-'));
  temporaryDirectories.push(home);
  return home;
}

interface Harness {
  manager: Loose;
  transient: Array<{ type: string; data: Record<string, unknown> }>;
  synced: string[];
  monitored: string[];
  restarts: { count: number };
}

/** A manager whose store/monitors are fakes but whose consistency logic is real. */
function wedgeManager(input: {
  home: string;
  onDisk: string[];
  indexed: Array<{ id: string; status?: string }>;
  states: Record<string, Record<string, unknown>>;
  /** Sessions the index keeps failing to see, however often we reindex. */
  unhealable?: string[];
}): Harness {
  const transient: Array<{ type: string; data: Record<string, unknown> }> = [];
  const synced: string[] = [];
  const monitored: string[] = [];
  const restarts = { count: 0 };
  const manager = bareManager();
  manager.closed = false;
  manager.paths = { home: input.home, sessions: input.home, daemon: input.home };
  manager.monitors = new Map();
  manager.launching = new Map<string, number>();
  manager.lastSelfCheckAt = 0;
  manager.consecutiveIncoherentChecks = 0;
  manager.selfRestartRequested = false;
  manager.selfRestartAnnounced = false;
  manager.indexImported = true;
  manager.readoptedZombies = new Set<string>();
  manager.options = {
    warden: { intervalMinutes: 5 },
    onSelfRestart: () => {
      restarts.count += 1;
      return true;
    },
  };
  manager.store = {
    sessionIdsOnDisk: async () => input.onDisk,
    listSessions: () => input.indexed,
    readState: async (id: string) => {
      const state = input.states[id];
      if (!state) throw new Error(`no state for ${id}`);
      return state;
    },
    syncSession: async (id: string) => {
      synced.push(id);
      return { sessionId: id, eventCount: 0, lastSequence: 0, problems: [] };
    },
    getSession: (id: string) => (input.unhealable?.includes(id) ? undefined : { id }),
  };
  manager.emitTransient = (type: string, data: Record<string, unknown>) => {
    transient.push({ type, data });
  };
  manager.emit = async () => undefined;
  manager.startMonitor = async (id: string) => {
    monitored.push(id);
  };
  return { manager, transient, synced, monitored, restarts };
}

const consistency = (manager: Loose, deep: boolean) =>
  (manager as unknown as { consistencyCheck: (deep: boolean) => Promise<unknown> }).consistencyCheck(deep);

describe('post-wedge index consistency (ps vs session directories)', () => {
  test('a session directory missing from the index is reindexed and reported', async () => {
    const home = await temporaryHome();
    const harness = wedgeManager({
      home,
      onDisk: ['s-indexed', 's-missing'],
      indexed: [{ id: 's-indexed', status: 'running' }],
      states: { 's-indexed': { status: 'running' }, 's-missing': { status: 'running' } },
    });
    const report = (await consistency(harness.manager, false)) as { missingFromIndex: string[]; repaired: string[] };
    expect(report.missingFromIndex).toEqual(['s-missing']);
    expect(harness.synced).toEqual(['s-missing']);
    expect(harness.transient.map(item => item.type)).toEqual(['fleet.index_incoherent']);
    expect(report.repaired).toContain('s-missing');
  });

  test('an index row whose status disagrees with state.json is resynced (deep pass only)', async () => {
    const home = await temporaryHome();
    const make = () =>
      wedgeManager({
        home,
        onDisk: ['s1'],
        indexed: [{ id: 's1', status: 'completed' }],
        states: { s1: { status: 'running' } },
      });
    // Cheap pass: membership agrees, so nothing is read or repaired.
    const shallow = make();
    const quiet = (await consistency(shallow.manager, false)) as { staleRows: string[] };
    expect(quiet.staleRows).toEqual([]);
    expect(shallow.synced).toEqual([]);
    // Deep pass (post-wedge): the disagreement is found and healed.
    const deep = make();
    const report = (await consistency(deep.manager, true)) as { staleRows: string[] };
    expect(report.staleRows).toEqual(['s1']);
    expect(deep.synced).toEqual(['s1']);
  });

  test('a terminal session whose journal keeps growing is re-adopted, not left invisible', async () => {
    const home = await temporaryHome();
    // The exact 2026-07-23 shape: done-marked at 23:40, still writing at 23:48.
    const finishedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await mkdir(path.join(home, 's-zombie'), { recursive: true });
    await writeFile(path.join(home, 's-zombie', 'events.jsonl'), '{}\n');
    const harness = wedgeManager({
      home,
      onDisk: ['s-zombie'],
      indexed: [{ id: 's-zombie', status: 'completed' }],
      states: { 's-zombie': { status: 'completed', finishedAt } },
    });
    const report = (await consistency(harness.manager, true)) as { zombies: string[] };
    expect(report.zombies).toEqual(['s-zombie']);
    expect(harness.monitored).toEqual(['s-zombie']); // a live monitor can finish the job
  });

  test('a terminal session whose journal stopped when it finished is NOT a zombie', async () => {
    const home = await temporaryHome();
    await mkdir(path.join(home, 's-done'), { recursive: true });
    await writeFile(path.join(home, 's-done', 'events.jsonl'), '{}\n');
    const harness = wedgeManager({
      home,
      onDisk: ['s-done'],
      indexed: [{ id: 's-done', status: 'completed' }],
      // finishedAt is NOW, so the journal's mtime is within the grace window.
      states: { 's-done': { status: 'completed', finishedAt: new Date().toISOString() } },
    });
    const report = (await consistency(harness.manager, true)) as { zombies: string[] };
    expect(report.zombies).toEqual([]);
    expect(harness.monitored).toEqual([]);
    expect(harness.transient).toEqual([]);
  });

  test('a healthy fleet is silent and clears the escalation counter', async () => {
    const home = await temporaryHome();
    const harness = wedgeManager({
      home,
      onDisk: ['s1'],
      indexed: [{ id: 's1', status: 'running' }],
      states: { s1: { status: 'running' } },
    });
    harness.manager.consecutiveIncoherentChecks = 2;
    await consistency(harness.manager, true);
    expect(harness.transient).toEqual([]);
    expect(harness.manager.consecutiveIncoherentChecks).toBe(0);
  });

  test('an index that will not heal escalates to exactly one clean self-restart', async () => {
    const home = await temporaryHome();
    const harness = wedgeManager({
      home,
      onDisk: ['s-ghost'],
      indexed: [],
      states: { 's-ghost': { status: 'running' } },
      unhealable: ['s-ghost'],
    });
    await consistency(harness.manager, true);
    expect(harness.restarts.count).toBe(0); // one bad pass is not enough
    await consistency(harness.manager, true);
    expect(harness.restarts.count).toBe(0);
    await consistency(harness.manager, true);
    expect(harness.restarts.count).toBe(1);
    // Idempotent: a restart is requested once, not once per later pass.
    await consistency(harness.manager, true);
    expect(harness.restarts.count).toBe(1);
    expect(harness.transient.filter(item => item.type === 'fleet.daemon_self_restart')).toHaveLength(1);
  });

  test('an UNSUPERVISED daemon reports the unhealable index instead of exiting', async () => {
    const home = await temporaryHome();
    const harness = wedgeManager({
      home,
      onDisk: ['s-ghost'],
      indexed: [],
      states: { 's-ghost': { status: 'running' } },
      unhealable: ['s-ghost'],
    });
    // No entrypoint handler = nothing would bring this daemon back.
    (harness.manager.options as Record<string, unknown>).onSelfRestart = undefined;
    for (let pass = 0; pass < 4; pass += 1) await consistency(harness.manager, true);
    // Announced once, but the process is never taken down: standalone daemons
    // have nothing to bring them back.
    const announced = harness.transient.filter(item => item.type === 'fleet.daemon_self_restart');
    expect(announced).toHaveLength(1);
    expect(announced[0]!.data.supervised).toBe(false);
    expect(harness.restarts.count).toBe(0);
  });
});

describe('wedge detection from the self-check timer', () => {
  function selfCheckManager(lastSelfCheckAt: number) {
    const transient: Array<{ type: string; data: Record<string, unknown> }> = [];
    const deepCalls: boolean[] = [];
    const manager = bareManager();
    manager.closed = false;
    manager.monitors = new Map([['s1', {}]]);
    manager.launching = new Map<string, number>();
    manager.bootstrapErrors = [];
    manager.lastSelfCheckAt = lastSelfCheckAt;
    manager.wardenTimer = setInterval(() => undefined, 1_000_000);
    manager.wardenState = { lastSweepAt: new Date().toISOString() };
    manager.options = { warden: { intervalMinutes: 5 } };
    manager.list = async () => [{ directory: '/x/s1', config: { id: 's1' }, state: { id: 's1', status: 'running' } }];
    manager.emitTransient = (type: string, data: Record<string, unknown>) => {
      transient.push({ type, data });
    };
    manager.consistencyCheck = async (deep: boolean) => {
      deepCalls.push(deep);
      return { missingFromIndex: [], staleRows: [], zombies: [], repaired: [] };
    };
    return { manager, transient, deepCalls };
  }

  const runSelfCheck = (manager: Loose) => (manager as unknown as { selfCheck: () => Promise<void> }).selfCheck();

  test('an 11-minute timer gap is reported as a wedge and forces a deep pass', async () => {
    const { manager, transient, deepCalls } = selfCheckManager(Date.now() - 11 * 60_000);
    await runSelfCheck(manager);
    clearInterval(manager.wardenTimer as ReturnType<typeof setInterval>);
    const wedge = transient.find(item => item.type === 'fleet.daemon_wedge');
    expect(wedge).toBeDefined();
    expect(wedge?.data.gapSeconds as number).toBeGreaterThanOrEqual(660);
    expect(deepCalls).toEqual([true]);
  });

  test('an on-time tick is not a wedge and only runs the cheap pass', async () => {
    const { manager, transient, deepCalls } = selfCheckManager(Date.now() - 60_000);
    await runSelfCheck(manager);
    clearInterval(manager.wardenTimer as ReturnType<typeof setInterval>);
    expect(transient).toEqual([]);
    expect(deepCalls).toEqual([false]);
  });

  test('the first tick after boot has no predecessor and is never a wedge', async () => {
    const { manager, transient, deepCalls } = selfCheckManager(0);
    await runSelfCheck(manager);
    clearInterval(manager.wardenTimer as ReturnType<typeof setInterval>);
    expect(transient).toEqual([]);
    expect(deepCalls).toEqual([false]);
    expect(manager.lastSelfCheckAt as number).toBeGreaterThan(0);
  });
});

describe('bounded start (exit-143 spawn timeouts)', () => {
  function startManager() {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const manager = bareManager();
    manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
      events.push({ type, data });
    };
    return { manager, events };
  }

  const awaitBootstrap = (manager: Loose, id: string, bootstrap: Promise<void>, waitMs: number) =>
    (
      manager as unknown as {
        awaitBootstrap: (id: string, bootstrap: Promise<void>, waitMs: number) => Promise<void>;
      }
    ).awaitBootstrap(id, bootstrap, waitMs);

  test('a launch slower than the window is announced, not awaited forever', async () => {
    const { manager, events } = startManager();
    let released = () => {};
    const bootstrap = new Promise<void>(resolve => {
      released = resolve;
    });
    // The caller's request returns while the bootstrap is still queued behind
    // other launches — the exact stretch during which callers SIGTERMed the CLI.
    await awaitBootstrap(manager, 's1', bootstrap, 20);
    expect(events.map(item => item.type)).toEqual(['session.launch_backgrounded']);
    expect(String(events[0]!.data.reason)).toContain('continues in the background');
    released();
    await bootstrap;
  });

  test('a launch that fails INSIDE the window still throws to the caller', async () => {
    const { manager, events } = startManager();
    await expect(awaitBootstrap(manager, 's1', Promise.reject(new Error('wrapper not found')), 5_000)).rejects.toThrow(
      'wrapper not found',
    );
    expect(events).toEqual([]);
  });

  test('a launch that succeeds inside the window is silent', async () => {
    const { manager, events } = startManager();
    await awaitBootstrap(manager, 's1', Promise.resolve(), 5_000);
    expect(events).toEqual([]);
  });

  test('detach (waitMs 0) returns immediately and says so', async () => {
    const { manager, events } = startManager();
    let released = () => {};
    const bootstrap = new Promise<void>(resolve => {
      released = resolve;
    });
    await awaitBootstrap(manager, 's1', bootstrap, 0);
    expect(String(events[0]!.data.reason)).toContain('detached start');
    released();
    await bootstrap;
  });

  test('a background failure after the window never becomes an unhandled rejection', async () => {
    const { manager } = startManager();
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', collect);
    try {
      const bootstrap = new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late launch failure')), 30);
      });
      await awaitBootstrap(manager, 's1', bootstrap, 5);
      await Bun.sleep(80); // the rejection lands here, long after the caller left
    } finally {
      process.off('unhandledRejection', collect);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('monitor arming order (the 2026-07-24 unsupervised-session bug)', () => {
  test('the tick loop starts even when the transcript watcher never becomes ready', async () => {
    const manager = bareManager();
    let ticks = 0;
    let releaseWatcher = () => {};
    manager.monitors = new Map();
    manager.launching = new Map<string, number>();
    manager.stopMonitor = async () => undefined;
    manager.get = async () => ({
      directory: '/x/s1',
      // A claude session with a harness home takes the transcript-watcher path.
      config: { id: 's1', harness: 'claude', harnessHome: '/x/home', harnessSessionId: 'u', tmuxSession: 't' },
      state: { id: 's1', status: 'running', turn: 1 },
    });
    manager.monitorLoop = async () => {
      ticks += 1;
    };
    // The watcher's first reconcile walks the SHARED harness home; under the
    // notification storm it never settled, and every session started then ran
    // with no snapshots, no heartbeat.json, no liveness.yaml and no stall
    // reflex while `monitors.has(id)` reported it healthy.
    manager.startTranscriptWatcher = async () =>
      await new Promise(resolve => (releaseWatcher = () => resolve(undefined)));

    const started = (manager as unknown as { startMonitor: (id: string) => Promise<void> }).startMonitor('s1');
    await Bun.sleep(20);
    expect(ticks).toBe(1); // armed BEFORE the watcher, not after it
    releaseWatcher();
    await started.catch(() => undefined);
  });
});

describe('fleet-feed policy in SessionManager.replay', () => {
  function replayManager(latest: number) {
    const calls: Array<{ kind: 'window' | 'tail'; cursor: number; limit: number; id?: string }> = [];
    const manager = bareManager();
    manager.resolveRef = (id: string) => id;
    manager.store = {
      latestGlobalSequence: () => latest,
      sessionNeedsGlobalBackfill: () => false,
      replayGlobal: (cursor: number, limit: number, id?: string) => {
        calls.push({ kind: 'window', cursor, limit, id });
        return { events: [], rows: 0, cursor };
      },
      tailGlobal: (limit: number, id?: string) => {
        calls.push({ kind: 'tail', cursor: 0, limit, id });
        return [];
      },
    };
    return { manager, calls };
  }

  const replay = (manager: Loose, id: string | undefined, after: number, limit?: number) =>
    (
      manager as unknown as {
        replay: (id: string | undefined, after: number, limit?: number) => Promise<unknown[]>;
      }
    ).replay(id, after, limit);

  test('a fleet-wide cursor is floored to the live window, never the whole archive', async () => {
    const { manager, calls } = replayManager(1_000_000);
    await replay(manager, undefined, 0, 1_000);
    // Paging a million events one page at a time is what wedged the daemon.
    expect(calls[0]).toEqual({ kind: 'window', cursor: 995_000, limit: 1_000, id: undefined });
  });

  test('a cursor already inside the window is honoured verbatim', async () => {
    const { manager, calls } = replayManager(1_000_000);
    await replay(manager, undefined, 999_000, 1_000);
    expect(calls[0]!.cursor).toBe(999_000);
  });

  test('per-session replay stays COMPLETE — the window is a fleet-feed rule only', async () => {
    const { manager, calls } = replayManager(1_000_000);
    await replay(manager, 's1', 0, 1_000);
    expect(calls[0]).toEqual({ kind: 'window', cursor: 0, limit: 1_000, id: 's1' });
  });

  test('a negative cursor is tail semantics, fleet-wide or per session', async () => {
    const { manager, calls } = replayManager(50);
    await replay(manager, undefined, -200);
    await replay(manager, 's1', -200);
    expect(calls).toEqual([
      { kind: 'tail', cursor: 0, limit: 200, id: undefined },
      { kind: 'tail', cursor: 0, limit: 200, id: 's1' },
    ]);
  });

  test('a session whose rows predate the global-sequence column is healed on demand', async () => {
    const { manager, calls } = replayManager(10);
    const healed: string[] = [];
    (manager.store as Record<string, unknown>).sessionNeedsGlobalBackfill = (id: string) => id === 's-legacy';
    (manager.store as Record<string, unknown>).backfillGlobalSequence = async (id: string) => {
      healed.push(id);
    };
    await replay(manager, 's-legacy', 0);
    expect(healed).toEqual(['s-legacy']);
    expect(calls[0]!.id).toBe('s-legacy');
  });
});

describe('self-restart cooldown across process lifetimes', () => {
  test('a restart that already happened inside the cooldown is refused, not repeated', async () => {
    const home = await temporaryHome();
    const harness = wedgeManager({
      home,
      onDisk: ['s-ghost'],
      indexed: [],
      states: { 's-ghost': { status: 'running' } },
      unhealable: ['s-ghost'],
    });
    // A predecessor process restarted for this same condition a minute ago.
    await writeFile(path.join(home, 'self-restart.json'), JSON.stringify({ at: new Date().toISOString() }));
    for (let pass = 0; pass < 3; pass += 1) await consistency(harness.manager, true);
    const announced = harness.transient.filter(item => item.type === 'fleet.daemon_self_restart');
    expect(announced).toHaveLength(1);
    expect(announced[0]!.data.cooling).toBe(true);
    expect(harness.restarts.count).toBe(0); // restart loops are worse than the bug
  });

  test('a restart outside the cooldown proceeds and stamps the time', async () => {
    const home = await temporaryHome();
    const harness = wedgeManager({
      home,
      onDisk: ['s-ghost'],
      indexed: [],
      states: { 's-ghost': { status: 'running' } },
      unhealable: ['s-ghost'],
    });
    await writeFile(
      path.join(home, 'self-restart.json'),
      JSON.stringify({ at: new Date(Date.now() - 60 * 60_000).toISOString() }),
    );
    for (let pass = 0; pass < 3; pass += 1) await consistency(harness.manager, true);
    expect(harness.restarts.count).toBe(1);
    const stamped = JSON.parse(await readFile(path.join(home, 'self-restart.json'), 'utf8')) as { at: string };
    expect(Date.now() - Date.parse(stamped.at)).toBeLessThan(60_000);
  });
});

describe('a declined self-restart stays retryable', () => {
  test('an entrypoint that says "no supervisor" un-latches so a later pass can try again', async () => {
    const home = await temporaryHome();
    const harness = wedgeManager({
      home,
      onDisk: ['s-ghost'],
      indexed: [],
      states: { 's-ghost': { status: 'running' } },
      unhealable: ['s-ghost'],
    });
    // Supervision is probed AT restart time, so it can change: a boot-time
    // latch would disable the repair for the whole process lifetime.
    let supervised = false;
    let restarts = 0;
    (harness.manager.options as Record<string, unknown>).onSelfRestart = () => {
      if (!supervised) return false;
      restarts += 1;
      return true;
    };
    for (let pass = 0; pass < 3; pass += 1) await consistency(harness.manager, true);
    expect(restarts).toBe(0);
    supervised = true;
    await consistency(harness.manager, true);
    expect(restarts).toBe(1);
  });
});
