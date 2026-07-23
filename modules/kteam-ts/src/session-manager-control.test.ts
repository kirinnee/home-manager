import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaths } from './paths';
import { SessionManager } from './session-manager';
import type { SessionView } from './service';
import type { SessionConfig } from './types';

// Fixture-level tests over prototype instances: the real SessionManager wires a
// daemon, tmux, and event store — these tests exercise the control-path logic
// (F4 auto-revive, F5 queued-send delivery) with the collaborators mocked.

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type Loose = Record<string, unknown>;

function bareManager(): Loose {
  return Object.create(SessionManager.prototype) as Loose;
}

describe('withAutoRevive (F4)', () => {
  const view = { config: { tmuxSession: 'kteam-x-agent' } } as SessionView;

  test('dead pane after a failed control action triggers exactly one revive and emits control.autorevive', async () => {
    const manager = bareManager();
    const events: string[] = [];
    let revives = 0;
    manager.get = async () => view;
    manager.tmux = { state: async () => ({ alive: false, dead: true, promptReady: false }) };
    manager.emit = async (_id: string, type: string) => {
      events.push(type);
    };
    manager.resume = async () => {
      revives++;
      return view;
    };
    const result = await (
      manager as unknown as {
        withAutoRevive: (id: string, action: string, op: () => Promise<SessionView>) => Promise<SessionView>;
      }
    ).withAutoRevive('x', 'interrupt', async () => {
      throw new Error('harness exited');
    });
    expect(result).toBe(view);
    expect(revives).toBe(1);
    expect(events).toEqual(['control.autorevive']);
  });

  test('live pane after a failed control action rethrows without reviving', async () => {
    const manager = bareManager();
    let revives = 0;
    manager.get = async () => view;
    manager.tmux = { state: async () => ({ alive: true, dead: false, promptReady: true }) };
    manager.emit = async () => undefined;
    manager.resume = async () => {
      revives++;
      return view;
    };
    await expect(
      (
        manager as unknown as {
          withAutoRevive: (id: string, action: string, op: () => Promise<SessionView>) => Promise<SessionView>;
        }
      ).withAutoRevive('x', 'answer', async () => {
        throw new Error('question not visible');
      }),
    ).rejects.toThrow('question not visible');
    expect(revives).toBe(0);
  });
});

describe('assigned-warden stop scope (A6)', () => {
  test('wardenMayStop matches only the exact per-assignment capability', () => {
    const manager = bareManager();
    manager.wardenState = {
      assignments: {
        'target-1': { wardenId: 'warden-1', spawnedAt: '2026-07-22T12:00:00.000Z', capability: 'cap-1' },
        'target-2': { wardenId: 'warden-2', spawnedAt: '2026-07-22T12:00:00.000Z', capability: 'cap-2' },
      },
    };
    const mayStop = (capability: string, targetId: string) =>
      (manager as unknown as { wardenMayStop: (c: string, t: string) => boolean }).wardenMayStop(capability, targetId);
    expect(mayStop('cap-1', 'target-1')).toBe(true);
    expect(mayStop('cap-1', 'target-2')).toBe(false); // another warden's target
    expect(mayStop('cap-2', 'target-1')).toBe(false); // cross-capability spoof
    expect(mayStop('warden-1', 'target-1')).toBe(false); // an identity is not a capability
    expect(mayStop('', 'target-1')).toBe(false); // empty never matches
  });

  test('no assignments means no stop permission at all', () => {
    const manager = bareManager();
    manager.wardenState = {};
    expect((manager as unknown as { wardenMayStop: (c: string, t: string) => boolean }).wardenMayStop('cap', 't')).toBe(
      false,
    );
  });
});

describe('assigned-warden capacity (A6 fix round)', () => {
  function capacityManager(maxAssignedWardens: number) {
    const started: string[] = [];
    const manager = bareManager();
    manager.options = {
      warden: { enabled: true, wrapper: 'claude-auto-x', maxAssignedWardens, assignedCooldownMinutes: 30 },
    };
    manager.wardenState = {};
    manager.paths = { wardenReports: '/tmp/kteam-capacity-test-reports' };
    manager.saveWardenState = async () => undefined;
    manager.emitTransient = () => undefined;
    manager.buildAssignedWardenPrompt = () => 'investigate';
    let counter = 0;
    manager.start = async () => {
      const id = `warden-${++counter}`;
      started.push(id);
      return { config: { id, teammate: id }, state: { status: 'running' }, directory: `/x/${id}` };
    };
    return { manager, started };
  }

  const sus = (id: string) => ({ kind: 'sus_thinking', sessionId: id, status: 'running', detail: 'x' });
  const target = (id: string) => ({
    config: { id, teammate: id, cwd: '/repo' },
    state: { status: 'running' },
    directory: `/x/${id}`,
  });

  test('fills the cap exactly: 3 sus sessions => 3 assigned wardens at max 3 (the double-count bug)', async () => {
    const { manager, started } = capacityManager(3);
    const spawned = await (
      manager as unknown as {
        spawnAssignedWardens: (a: unknown[], s: unknown[], f: boolean) => Promise<string[]>;
      }
    ).spawnAssignedWardens(
      [sus('t1'), sus('t2'), sus('t3'), sus('t4')],
      [target('t1'), target('t2'), target('t3'), target('t4')],
      false,
    );
    expect(spawned).toHaveLength(3);
    expect(started).toHaveLength(3);
    const assignments = (manager.wardenState as { assignments: Record<string, { capability: string }> }).assignments;
    expect(Object.keys(assignments).sort()).toEqual(['t1', 't2', 't3']);
    // Each assignment carries its own unguessable capability.
    const capabilities = Object.values(assignments).map(record => record.capability);
    expect(new Set(capabilities).size).toBe(3);
    for (const capability of capabilities) expect(capability.length).toBeGreaterThanOrEqual(32);
  });

  test('dedupes a target that already has a live warden', async () => {
    const { manager, started } = capacityManager(3);
    manager.wardenState = {
      assignments: { t1: { wardenId: 'warden-live', spawnedAt: '2026-07-22T12:00:00.000Z', capability: 'cap' } },
    };
    await (
      manager as unknown as {
        spawnAssignedWardens: (a: unknown[], s: unknown[], f: boolean) => Promise<string[]>;
      }
    ).spawnAssignedWardens(
      [sus('t1'), sus('t2')],
      [{ config: { id: 'warden-live' }, state: { status: 'running' }, directory: '/x/w' }, target('t1'), target('t2')],
      false,
    );
    expect(started).toHaveLength(1); // only t2 got a new warden
  });
});

describe('send() delivery holes (turn-012 fix round)', () => {
  function sendManager(input: { status: string; paneAlive: boolean; promptReady?: boolean }) {
    const calls: string[] = [];
    const manager = bareManager();
    manager.resolveRef = (id: string) => id;
    manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
    manager.attachments = { buildImageReferenceBlock: async () => '' };
    manager.get = async () => ({
      directory: '/tmp/kteam-send-test/s1',
      config: { id: 's1', tmuxSession: 'kteam-s1-agent', turn: 3 },
      state: { id: 's1', status: input.status, turn: 3, promptReady: input.promptReady ?? false },
    });
    manager.tmux = {
      state: async () => ({ alive: input.paneAlive, dead: !input.paneAlive, promptReady: input.promptReady ?? false }),
      snapshot: async () => 'frame\n',
    };
    manager.resume = async (_id: string, message?: string) => {
      calls.push(`resume:${message}`);
      return {
        directory: '/tmp/kteam-send-test/s1',
        config: { id: 's1', turn: 4 },
        state: { id: 's1', status: 'running', turn: 4 },
      };
    };
    manager.sendUnlocked = async (_view: unknown, message: string) => {
      calls.push(`sendUnlocked:${message}`);
      return { config: { id: 's1' }, state: { status: 'running' } };
    };
    manager.stopTmuxWithEvidence = async (_config: unknown, reason: string) => {
      calls.push(`kill:${reason}`);
    };
    return { manager, calls };
  }

  test("a COMPLETED session with a live idle pane is REVIVED, never direct-injected (the pane's a leftover)", async () => {
    const { manager, calls } = sendManager({ status: 'completed', paneAlive: true, promptReady: true });
    const result = await (
      manager as unknown as {
        send: (id: string, request: { message: string }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: 'follow-up work' });
    expect(result.disposition).toBe('revived');
    expect(calls).toEqual(['resume:follow-up work']);
  });

  test('a busy live session types into the NATIVE queue: durable record + disposition=queued', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-disp-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
    const { manager } = sendManager({ status: 'running', paneAlive: true, promptReady: false });
    const typed: string[] = [];
    let state: Record<string, unknown> = { id: 's1', status: 'running', turn: 3, promptReady: false };
    manager.get = async () => ({
      directory: path.join(home, 's1'),
      config: { id: 's1', tmuxSession: 'kteam-s1-agent', turn: 3 },
      state,
    });
    manager.store = {
      updateState: async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.tmux = {
      state: async () => ({ alive: true, dead: false, promptReady: false, visiblePane: '• Working (10s' }),
      typeIntoQueue: async (_name: string, text: string) => {
        typed.push(text);
      },
    };
    manager.emit = async () => ({});
    manager.monitors = new Map();
    const queued = await (
      manager as unknown as {
        send: (id: string, request: { message: string }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: 'steer' });
    expect(queued.disposition).toBe('queued');
    expect(typed).toEqual(['steer']); // typed into the TUI's native queue…
    // …recorded DURABLY for transcript correlation (turn advances at
    // consumption, never at type-in)…
    const pending = state.pendingNativeSends as Array<{ id: string; message: string }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.message).toBe('steer');
    // …and no external mailbox file is created anymore.
    const mailbox = await readFile(path.join(home, 's1', 'channel', 'pending-sends.jsonl'), 'utf8').catch(() => null);
    expect(mailbox === null || mailbox === '').toBe(true);
  });

  test('a failed type-in rolls the durable record back (no phantom pending entry)', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-fail-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
    const { manager } = sendManager({ status: 'running', paneAlive: true, promptReady: false });
    let state: Record<string, unknown> = { id: 's1', status: 'running', turn: 3, promptReady: false };
    manager.get = async () => ({
      directory: path.join(home, 's1'),
      config: { id: 's1', tmuxSession: 'kteam-s1-agent', turn: 3 },
      state,
    });
    manager.store = {
      updateState: async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.tmux = {
      state: async () => ({ alive: true, dead: false, promptReady: false, visiblePane: '• Working (10s' }),
      typeIntoQueue: async () => {
        throw new Error('text did not land in the busy composer');
      },
    };
    manager.emit = async () => ({});
    manager.monitors = new Map();
    await expect(
      (manager as unknown as { send: (id: string, request: { message: string }) => Promise<unknown> }).send('s1', {
        message: 'doomed',
      }),
    ).rejects.toThrow(/did not land/);
    expect((state.pendingNativeSends as unknown[]) ?? []).toHaveLength(0);
  });

  test('terminal transition BETWEEN probe and lock takes the revive path, never types', async () => {
    const { manager, calls } = sendManager({ status: 'running', paneAlive: true, promptReady: false });
    // Pre-lock probe sees running; under the lock the session is completed.
    let reads = 0;
    manager.get = async () => ({
      directory: '/tmp/kteam-send-test/s1',
      config: { id: 's1', tmuxSession: 'kteam-s1-agent', turn: 3 },
      state: { id: 's1', status: ++reads === 1 ? 'running' : 'completed', turn: 3, promptReady: false },
    });
    manager.tmux = {
      state: async () => ({ alive: true, dead: false, promptReady: false, visiblePane: '• Working (10s' }),
      typeIntoQueue: async () => {
        throw new Error('must never type into a terminal session');
      },
    };
    const result = await (
      manager as unknown as {
        send: (id: string, request: { message: string }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: 'late message' });
    expect(result.disposition).toBe('revived');
    expect(calls).toEqual(['resume:late message']);
  });

  test('busy→idle race in the probe window becomes a TRACKED delivered send, not a ghost queue ride', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-race-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
    await mkdir(path.join(home, 's1', 'turns'), { recursive: true });
    const { manager } = sendManager({ status: 'running', paneAlive: true, promptReady: false });
    let paneReads = 0;
    let typedViaQueue = 0;
    let delivered = '';
    manager.paths = createPaths(home);
    manager.autoContinued = new Set();
    manager.doneDeferred = new Set();
    manager.monitors = new Map();
    manager.get = async () => ({
      directory: path.join(home, 's1'),
      config: { id: 's1', tmuxSession: 'kteam-s1-agent', turn: 3, directSendMaxChars: 500 },
      state: { id: 's1', status: 'running', turn: 3, promptReady: false },
    });
    manager.tmux = {
      // First pane read (status probe under lock): busy. Recheck right before
      // typing: prompt-ready — the TUI finished in the window.
      state: async () => ({
        alive: true,
        dead: false,
        promptReady: ++paneReads >= 2,
        visiblePane: paneReads >= 2 ? '❯ ' : '• Working (10s',
      }),
      typeIntoQueue: async () => {
        typedViaQueue++;
      },
      send: async (_config: unknown, text: string) => {
        delivered = text;
      },
    };
    manager.store = {
      updateState: async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => mutate({}),
      updateConfig: async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) =>
        mutate({ id: 's1', tmuxSession: 'kteam-s1-agent', turn: 3, directSendMaxChars: 500 }),
    };
    manager.emit = async () => ({});
    manager.transition = async () => undefined;
    const result = await (
      manager as unknown as {
        send: (id: string, request: { message: string }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: 'raced message' });
    expect(result.disposition).toBe('delivered');
    expect(typedViaQueue).toBe(0); // never treated as a queue ride
    expect(delivered).toBe('raced message'); // tracked direct send
    // Turn file materialized for the tracked turn.
    expect(await readFile(path.join(home, 's1', 'turns', 'turn-004.md'), 'utf8')).toContain('raced message');
  });

  test('--now on an actively-working pane presses Escape before typing (immediate steer)', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-now-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
    const { manager } = sendManager({ status: 'running', paneAlive: true, promptReady: false });
    const typed: string[] = [];
    manager.get = async () => ({
      directory: path.join(home, 's1'),
      config: { id: 's1', tmuxSession: 'kteam-s1-agent', turn: 3 },
      state: { id: 's1', status: 'running', turn: 3, promptReady: false },
    });
    manager.tmux = {
      state: async () => ({
        alive: true,
        dead: false,
        promptReady: false,
        visiblePane: '✻ Lollygagging… (34s · 2.1k tokens)',
      }),
      // Escape stopped the turn but the prompt has not settled to ready in
      // the wait window — the message rides the native queue (tracked).
      waitReady: async () => {
        throw new Error('not ready in window');
      },
      typeIntoQueue: async (_name: string, text: string) => {
        typed.push(text);
      },
    };
    manager.store = {
      updateState: async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => mutate({}),
    };
    manager.emit = async () => ({});
    manager.monitors = new Map();
    const result = await (
      manager as unknown as {
        send: (id: string, request: { message: string; now?: boolean }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: 'urgent steer', now: true });
    expect(result.disposition).toBe('queued');
    expect(typed).toEqual(['urgent steer']);
  });
});

describe('partition-tolerant loud bootstrap (turn-019 P0)', () => {
  test('a phase failure is recorded and LATER phases still run', async () => {
    const manager = bareManager();
    const ran: string[] = [];
    manager.bootstrapErrors = [];
    manager.emitTransient = () => undefined;
    manager.store = {
      importFromDisk: async () => {
        ran.push('import');
        throw new Error('index exploded');
      },
    };
    manager.initializeGlobalSequence = async () => {
      ran.push('global-sequence');
    };
    manager.recover = async () => {
      ran.push('recover');
      throw new Error('recover exploded');
    };
    manager.startWarden = async () => {
      ran.push('warden');
    };
    await (manager as unknown as { bootstrap: () => Promise<void> }).bootstrap();
    expect(ran).toEqual(['import', 'global-sequence', 'recover', 'warden']); // warden ALWAYS armed
    const errors = manager.bootstrapErrors as string[];
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('import');
    expect(errors[1]).toContain('recover');
  });

  test('one bad session cannot abort recovery of the rest', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-recover-isolate-'));
    temporaryDirectories.push(home);
    const recovered: string[] = [];
    const manager = bareManager();
    manager.paths = createPaths(home);
    manager.monitors = new Map();
    manager.bootstrapErrors = [];
    manager.emit = async () => ({});
    manager.list = async () => [
      {
        directory: `${home}/bad`,
        config: { id: 'bad', tmuxSession: 'kteam-bad-agent', retry: {} },
        state: { id: 'bad', status: 'running', turn: 1 },
      },
      {
        directory: `${home}/good`,
        config: { id: 'good', tmuxSession: 'kteam-good-agent', retry: {} },
        state: { id: 'good', status: 'running', turn: 1 },
      },
    ];
    manager.tmux = {
      state: async (name: string) => {
        if (name === 'kteam-bad-agent') throw new Error('tmux exploded for this session');
        return { alive: true, dead: false, promptReady: true };
      },
    };
    manager.transition = async () => undefined;
    manager.startMonitor = async (id: string) => {
      recovered.push(id);
    };
    await (manager as unknown as { recover: () => Promise<void> }).recover();
    expect(recovered).toEqual(['good']); // the good session was still adopted
    expect((manager.bootstrapErrors as string[])[0]).toContain('bad');
  });

  test('a session started by a client during the bootstrap window is not double-adopted', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-recover-race-'));
    temporaryDirectories.push(home);
    const manager = bareManager();
    manager.paths = createPaths(home);
    manager.bootstrapErrors = [];
    manager.emit = async () => ({});
    // The client's start() already registered a live monitor for s1.
    manager.monitors = new Map([['s1', { abort: new AbortController() }]]);
    let transitions = 0;
    manager.list = async () => [
      {
        directory: `${home}/s1`,
        config: { id: 's1', tmuxSession: 'kteam-s1-agent', retry: {} },
        state: { id: 's1', status: 'running', turn: 1 },
      },
    ];
    manager.tmux = {
      state: async () => {
        throw new Error('recover must not even probe a session that already has a monitor');
      },
    };
    manager.transition = async () => {
      transitions++;
    };
    manager.startMonitor = async () => {
      throw new Error('must not restart a live monitor');
    };
    await (manager as unknown as { recover: () => Promise<void> }).recover();
    expect(transitions).toBe(0);
    expect(manager.bootstrapErrors as string[]).toHaveLength(0);
  });

  test('selfCheck repairs unmonitored running sessions and re-arms a dead warden timer', async () => {
    const manager = bareManager();
    const transient: string[] = [];
    const started: string[] = [];
    let wardenArmed = 0;
    manager.closed = false;
    manager.monitors = new Map();
    manager.bootstrapErrors = ['bootstrap phase recover failed: boom'];
    manager.wardenTimer = undefined;
    manager.wardenState = { lastSweepAt: new Date(Date.now() - 60 * 60_000).toISOString() };
    manager.options = { warden: { intervalMinutes: 5 } };
    manager.list = async () => [
      { directory: '/x/s1', config: { id: 's1' }, state: { id: 's1', status: 'running', turn: 1 } },
      { directory: '/x/s2', config: { id: 's2' }, state: { id: 's2', status: 'completed', turn: 1 } },
    ];
    manager.emitTransient = (type: string) => {
      transient.push(type);
    };
    manager.startMonitor = async (id: string) => {
      started.push(id);
    };
    manager.startWarden = async () => {
      wardenArmed++;
    };
    await (manager as unknown as { selfCheck: () => Promise<void> }).selfCheck();
    expect(transient).toEqual(['fleet.self_check_failed']);
    expect(started).toEqual(['s1']); // running-without-monitor repaired; terminal ignored
    expect(wardenArmed).toBe(1); // dead timer re-armed
  });

  test('selfCheck is silent when everything is healthy', async () => {
    const manager = bareManager();
    const transient: string[] = [];
    manager.closed = false;
    manager.monitors = new Map([['s1', {}]]);
    manager.bootstrapErrors = [];
    manager.wardenTimer = setInterval(() => undefined, 1_000_000);
    manager.wardenState = { lastSweepAt: new Date().toISOString() };
    manager.options = { warden: { intervalMinutes: 5 } };
    manager.list = async () => [
      { directory: '/x/s1', config: { id: 's1' }, state: { id: 's1', status: 'running', turn: 1 } },
    ];
    manager.emitTransient = (type: string) => {
      transient.push(type);
    };
    await (manager as unknown as { selfCheck: () => Promise<void> }).selfCheck();
    clearInterval(manager.wardenTimer as ReturnType<typeof setInterval>);
    expect(transient).toEqual([]);
  });
});

describe('needs_human flag + sweep dedupe (turn-018)', () => {
  test('a needs_human verdict sets the durable flag once and emits fleet.needs_human', async () => {
    const transient: string[] = [];
    let state: Record<string, unknown> = { id: 's1', status: 'failed', turn: 9 };
    const manager = bareManager();
    manager.lastSweep = {
      at: 'now',
      anomalies: [{ kind: 'abandoned_wreckage', sessionId: 's1', status: 'failed', detail: 'x' }],
      fingerprint: 'abandoned_wreckage:s1',
    };
    manager.wardenVerdicts = async () => [
      {
        at: 'now',
        targetSession: 's1',
        verdict: 'needs_human',
        reason: 'resume fails deterministically',
        reportPath: '/r.md',
      },
    ];
    manager.store = {
      updateState: async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.emitTransient = (type: string) => {
      transient.push(type);
    };
    const sessions = [{ config: { id: 's1', teammate: 'lacey' }, state, directory: '/x/s1' }];
    await (manager as unknown as { reconcileNeedsHuman: (sessions: unknown[]) => Promise<void> }).reconcileNeedsHuman(
      sessions,
    );
    expect(state.needsHuman).toBe('resume fails deterministically');
    expect(state.needsHumanKind).toBe('abandoned_wreckage');
    expect(transient).toEqual(['fleet.needs_human']);
    // Second reconcile with the flag already set: no re-flag, no re-emit.
    await (manager as unknown as { reconcileNeedsHuman: (sessions: unknown[]) => Promise<void> }).reconcileNeedsHuman([
      { config: { id: 's1', teammate: 'lacey' }, state, directory: '/x/s1' },
    ]);
    expect(transient).toHaveLength(1);
  });

  test('clearNeedsHuman resets the flag only when set', async () => {
    let writes = 0;
    let state: Record<string, unknown> = { id: 's1', needsHuman: 'why', needsHumanKind: 'abandoned_wreckage' };
    const manager = bareManager();
    manager.store = {
      updateState: async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
        writes++;
        state = mutate(state);
        return state;
      },
    };
    await (manager as unknown as { clearNeedsHuman: (id: string) => Promise<void> }).clearNeedsHuman('s1');
    expect(state.needsHuman).toBeUndefined();
    expect(state.needsHumanKind).toBeUndefined();
    expect(writes).toBe(1);
  });
});

describe('native-queue consumption correlation (turn-016 P1)', () => {
  function correlationManager(initial: {
    turn: number;
    pendingNativeSends: Array<{ id: string; at: string; message: string }>;
  }) {
    const events: Array<{ type: string; turn?: number }> = [];
    let config: Record<string, unknown> = { id: 's1', tmuxSession: 'kteam-s1-agent', turn: initial.turn };
    let state: Record<string, unknown> = {
      id: 's1',
      status: 'running',
      turn: initial.turn,
      nudgedAt: '2026-07-23T00:00:00.000Z', // stale nudge must clear on the new turn
      pendingNativeSends: initial.pendingNativeSends,
    };
    const manager = bareManager();
    manager.autoContinued = new Set(['s1']);
    manager.doneDeferred = new Set(['s1']);
    manager.store = {
      updateConfig: async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
        config = mutate(config);
        return config;
      },
      updateState: async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.emit = async (_id: string, type: string, _payload: unknown, _source: string, turn?: number) => {
      events.push({ type, turn });
      return {};
    };
    const call = async (batch: Array<{ type: string; data: unknown }>, home: string) => {
      manager.paths = createPaths(home);
      const view = {
        directory: path.join(home, 's1'),
        config,
        state,
      };
      manager.get = async () => ({ directory: path.join(home, 's1'), config, state });
      await (
        manager as unknown as {
          correlateNativeSends: (id: string, view: unknown, events: unknown[]) => Promise<void>;
        }
      ).correlateNativeSends('s1', view, batch);
    };
    return { manager, call, events, config: () => config, state: () => state };
  }

  test('a matching chat.user advances the turn exactly once with full bookkeeping', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-correlate-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'turns'), { recursive: true });
    await mkdir(path.join(home, 's1', 'markers'), { recursive: true });
    await writeFile(path.join(home, 's1', 'markers', 'done.json'), '{"type":"done","turn":3}\n');
    const harness = correlationManager({
      turn: 3,
      pendingNativeSends: [{ id: 'q1', at: 'then', message: 'queued steer message' }],
    });
    await harness.call([{ type: 'chat.user', data: { text: 'queued steer message' } }], home);
    // Turn advanced atomically on config AND state.
    expect(harness.config().turn).toBe(4);
    expect(harness.state().turn).toBe(4);
    // Queue entry consumed; nudge episode reset; turn marked incomplete.
    expect(harness.state().pendingNativeSends).toHaveLength(0);
    expect(harness.state().nudgedAt).toBeUndefined();
    expect(harness.state().turnCompleted).toBe(false);
    // Turn file materialized; stale turn-3 done marker cleared (cannot
    // complete queued turn 4).
    expect(await readFile(path.join(home, 's1', 'turns', 'turn-004.md'), 'utf8')).toContain('queued steer message');
    expect(await readFile(path.join(home, 's1', 'markers', 'done.json'), 'utf8').catch(() => 'GONE')).toBe('GONE');
    // Consumption event tagged with the NEW turn.
    expect(harness.events).toEqual([{ type: 'control.send_consumed', turn: 4 }]);
  });

  test('replayed/duplicate transcript batches cannot double-advance', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-correlate-dup-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'turns'), { recursive: true });
    const harness = correlationManager({
      turn: 3,
      pendingNativeSends: [{ id: 'q1', at: 'then', message: 'only once' }],
    });
    const batch = [{ type: 'chat.user', data: { text: 'only once' } }];
    await harness.call(batch, home);
    await harness.call(batch, home); // replay
    expect(harness.config().turn).toBe(4); // not 5
    expect(harness.events.filter(event => event.type === 'control.send_consumed')).toHaveLength(1);
  });

  test('an unrelated chat.user does not consume the pending entry', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-correlate-nomatch-'));
    temporaryDirectories.push(home);
    const harness = correlationManager({
      turn: 3,
      pendingNativeSends: [{ id: 'q1', at: 'then', message: 'the queued message text' }],
    });
    await harness.call([{ type: 'chat.user', data: { text: 'a totally different prompt' } }], home);
    expect(harness.config().turn).toBe(3);
    expect(harness.state().pendingNativeSends).toHaveLength(1);
    expect(harness.events).toHaveLength(0);
  });

  test('IDENTICAL queued messages: one chat.user consumes exactly one entry', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-correlate-same-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'turns'), { recursive: true });
    const harness = correlationManager({
      turn: 3,
      pendingNativeSends: [
        { id: 'q1', at: 'then', message: 'continue' },
        { id: 'q2', at: 'later', message: 'continue' },
      ],
    });
    await harness.call([{ type: 'chat.user', data: { text: 'continue' } }], home);
    // One boundary => one consumption: turn 4 only, q2 still pending.
    expect(harness.config().turn).toBe(4);
    expect(harness.state().pendingNativeSends).toHaveLength(1);
    expect(harness.events.filter(event => event.type === 'control.send_consumed')).toHaveLength(1);
  });

  test('SAME-PREFIX queued messages: shared 80-char prefix does not double-consume', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-correlate-prefix-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'turns'), { recursive: true });
    const shared = 'x'.repeat(90); // identical first 80 chars, different tails
    const harness = correlationManager({
      turn: 3,
      pendingNativeSends: [
        { id: 'q1', at: 'then', message: `${shared} alpha` },
        { id: 'q2', at: 'later', message: `${shared} beta` },
      ],
    });
    await harness.call([{ type: 'chat.user', data: { text: `${shared} alpha` } }], home);
    expect(harness.config().turn).toBe(4);
    expect(harness.state().pendingNativeSends).toHaveLength(1);
  });

  test('two queued entries + two chat.user events consume both, in order', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-correlate-two-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'turns'), { recursive: true });
    const harness = correlationManager({
      turn: 3,
      pendingNativeSends: [
        { id: 'q1', at: 'then', message: 'continue' },
        { id: 'q2', at: 'later', message: 'continue' },
      ],
    });
    await harness.call(
      [
        { type: 'chat.user', data: { text: 'continue' } },
        { type: 'chat.user', data: { text: 'continue' } },
      ],
      home,
    );
    expect(harness.config().turn).toBe(5);
    expect(harness.state().pendingNativeSends).toHaveLength(0);
    expect(harness.events.filter(event => event.type === 'control.send_consumed')).toHaveLength(2);
  });

  test('pending entries surviving into a terminal state are reported LOST (recovery: revive)', async () => {
    const events: Array<{ type: string }> = [];
    let state: Record<string, unknown> = {
      id: 's1',
      status: 'stopped',
      turn: 3,
      pendingNativeSends: [{ id: 'q1', at: 'then', message: 'died in composer' }],
    };
    const manager = bareManager();
    manager.get = async () => ({ directory: '/x/s1', config: { id: 's1', turn: 3 }, state });
    manager.store = {
      updateState: async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.emit = async (_id: string, type: string) => {
      events.push({ type });
      return {};
    };
    await (manager as unknown as { reportLostNativeSends: (id: string) => Promise<void> }).reportLostNativeSends('s1');
    expect(events).toEqual([{ type: 'control.send_lost' }]);
    expect(state.pendingNativeSends).toHaveLength(0);
    expect(String(state.reason)).toContain('not consumed before the session ended');
  });
});

describe('short-direct sends (turn-013)', () => {
  const config = (overrides: Record<string, unknown> = {}) => ({ directSendMaxChars: 500, ...overrides });

  function isDirect(payload: string, overrides: Record<string, unknown> = {}): boolean {
    const manager = bareManager();
    return (manager as unknown as { isDirectPayload: (p: string, c: unknown) => boolean }).isDirectPayload(
      payload,
      config(overrides),
    );
  }

  test('short single-line payloads are direct; long/multi-line/control ones are not', () => {
    expect(isDirect('continue with the next step')).toBe(true);
    expect(isDirect('x'.repeat(501))).toBe(false); // over threshold
    expect(isDirect('line one\nline two')).toBe(false); // multi-line
    expect(isDirect('has a tab\there')).toBe(false); // control char fights TUI quoting
    expect(isDirect('')).toBe(false);
    expect(isDirect('fine', { directSendMaxChars: 0 })).toBe(false); // knob disables
    expect(isDirect('x'.repeat(100), { directSendMaxChars: 50 })).toBe(false); // knob shrinks
  });

  test('direct payloads are TYPED verbatim; long payloads use the turn-file instruction', async () => {
    async function deliver(message: string): Promise<{ typed: string; turnFile: string }> {
      const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-direct-'));
      temporaryDirectories.push(home);
      await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
      await mkdir(path.join(home, 's1', 'turns'), { recursive: true });
      let typed = '';
      const manager = bareManager();
      manager.resolveRef = (id: string) => id;
      manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
      manager.paths = createPaths(home);
      manager.attachments = { buildImageReferenceBlock: async () => '' };
      manager.autoContinued = new Set();
      manager.doneDeferred = new Set();
      manager.monitors = new Map();
      manager.get = async () => ({
        directory: path.join(home, 's1'),
        config: { id: 's1', tmuxSession: 'kteam-s1-agent', turn: 1, directSendMaxChars: 500 },
        state: { id: 's1', status: 'awaiting_user', turn: 1, promptReady: true },
      });
      manager.tmux = {
        state: async () => ({ alive: true, dead: false, promptReady: true, visiblePane: '❯ ' }),
        send: async (_config: unknown, text: string) => {
          typed = text;
        },
      };
      manager.store = {
        updateConfig: async (_id: string, mutate: (c: Record<string, unknown>) => Record<string, unknown>) =>
          mutate({ id: 's1', tmuxSession: 'kteam-s1-agent', turn: 1, directSendMaxChars: 500 }),
      };
      manager.emit = async () => ({});
      manager.transition = async () => undefined;
      await (manager as unknown as { send: (id: string, request: { message: string }) => Promise<unknown> }).send(
        's1',
        { message },
      );
      const turnFile = await readFile(path.join(home, 's1', 'turns', 'turn-002.md'), 'utf8').catch(() => '');
      return { typed, turnFile };
    }

    const short = await deliver('run the tests again');
    expect(short.typed).toBe('run the tests again'); // typed verbatim
    expect(short.turnFile).toContain('run the tests again'); // bookkeeping file still written

    const long = await deliver(`do these steps:\n1. one\n2. two`);
    expect(long.typed).toContain('Read the file'); // turn-file instruction
    expect(long.turnFile).toContain('do these steps');
  });
});

describe('nudgedAt is turn-scoped (A6 fix round)', () => {
  test('every turn-committing transition clears nudgedAt so a new turn is nudged before any kill', async () => {
    // Source-level guard across all five turn-start sites: send, answer,
    // resume/relaunch, session start, and auto-continue. Each transition that
    // sets a fresh startedAt must also reset the nudge episode.
    const source = await Bun.file(path.join(import.meta.dir, 'session-manager.ts')).text();
    const turnStarts = source.split('startedAt: now()').length - 1;
    const nudgeResets = source.split('nudgedAt: undefined').length - 1;
    expect(turnStarts).toBeGreaterThanOrEqual(5);
    expect(nudgeResets).toBeGreaterThanOrEqual(turnStarts);
  });
});

describe('snapshot of a dead pane (A6)', () => {
  test('rejects loudly instead of returning an empty capture', async () => {
    const manager = bareManager();
    manager.resolveRef = (id: string) => id;
    manager.serialized = async (_id: string, work: () => Promise<string>) => await work();
    manager.get = async () => ({ config: { tmuxSession: 'kteam-x-agent' }, state: { status: 'stalled' } });
    manager.tmux = {
      state: async () => ({ alive: false, dead: true, promptReady: false }),
      snapshot: async () => '',
    };
    await expect((manager as unknown as { snapshot: (id: string) => Promise<string> }).snapshot('x')).rejects.toThrow(
      /pane dead/,
    );
  });

  test('captures normally while the pane is alive', async () => {
    const manager = bareManager();
    manager.resolveRef = (id: string) => id;
    manager.serialized = async (_id: string, work: () => Promise<string>) => await work();
    manager.get = async () => ({ config: { tmuxSession: 'kteam-x-agent' }, state: { status: 'running' } });
    manager.tmux = {
      state: async () => ({ alive: true, dead: false, promptReady: true }),
      snapshot: async () => 'frame\n',
    };
    expect(await (manager as unknown as { snapshot: (id: string) => Promise<string> }).snapshot('x')).toBe('frame\n');
  });
});

describe('migrate — cross-account continuation', () => {
  const claudeSession = {
    directory: '/tmp/kteam/s1',
    config: {
      id: 's1',
      name: 'work',
      teammate: 'mordecai',
      label: 'lead-abc',
      parent: 'p0',
      binary: 'claude-auto-glm52a',
      harness: 'claude',
      modelHint: 'GLM-5.2',
      model: 'glm-5.2',
      mode: 'auto',
      cwd: '/repo',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      turn: 3,
      harnessSessionId: 'sess-keep-me',
      harnessHome: '/old/home',
      tmuxSession: 'kteam-s1-agent',
      watcherSession: 'kteam-s1-watch',
      intervalSeconds: 5,
      stallSeconds: 900,
      timeoutSeconds: 3600,
      maxSnapshots: 20,
      systemPromptFile: '/tmp/system',
      originalPromptFile: '/tmp/prompt',
    },
    state: { id: 's1', status: 'rate_limited', turn: 3 },
  } as unknown as SessionView;

  function migrateManager(over: Partial<Loose> = {}): Loose {
    const manager = bareManager();
    manager.store = { listSessions: () => [] };
    manager.paths = { kfleetBin: '/nonexistent-kfleet-bin' };
    manager.cancelRetry = () => undefined;
    manager.cancelQuotaWaiter = async () => undefined;
    manager.get = async () => claudeSession;
    return Object.assign(manager, over);
  }

  const callMigrate = (manager: Loose, id: string, agent: string, model?: string) =>
    (manager as unknown as { migrate: (id: string, agent: string, model?: string) => Promise<SessionView> }).migrate(
      id,
      agent,
      model,
    );

  test('rejects cross-harness migration', async () => {
    const manager = migrateManager();
    await expect(callMigrate(manager, 's1', 'codex-auto-loge')).rejects.toThrow(/cross-harness/);
  });

  test('rejects an unknown wrapper', async () => {
    const manager = migrateManager();
    await expect(callMigrate(manager, 's1', 'claude-auto-doesnotexist')).rejects.toThrow(/wrapper not found/);
  });

  test('rejects a non-auto-mode wrapper', async () => {
    const manager = migrateManager();
    await expect(callMigrate(manager, 's1', 'claude-interactive')).rejects.toThrow(/auto-mode fleet wrappers/);
  });

  test('rewrites binary/home/model, keeps identity, emits session.migrated, then resumes', async () => {
    const wrapperDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-migrate-'));
    temporaryDirectories.push(wrapperDir);
    const wrapper = path.join(wrapperDir, 'claude-auto-glm52b');
    await writeFile(
      wrapper,
      '#!/usr/bin/env bash\nexport CLAUDE_CONFIG_DIR="/new/home"\nexport KTEAM_MODEL="glm-5.2-air"\nexec claude "$@"\n',
      { mode: 0o755 },
    );

    let current = { ...(claudeSession.config as unknown as Loose) };
    const configUpdates: Loose[] = [];
    const events: Array<{ type: string; payload: Loose }> = [];
    let resumedWith: string | undefined;

    const manager = migrateManager({
      paths: { kfleetBin: wrapperDir },
      store: {
        listSessions: () => [],
        updateConfig: async (_id: string, mutate: (c: Loose) => Loose) => {
          current = mutate(current);
          configUpdates.push(current);
          return current;
        },
      },
      stopMonitor: async () => undefined,
      tmux: { state: async () => ({ alive: false, dead: true, promptReady: false }) },
      stopTmuxWithEvidence: async () => undefined,
      emit: async (_id: string, type: string, payload: Loose) => {
        events.push({ type, payload });
        return {} as unknown;
      },
      resume: async (_id: string, message?: string) => {
        resumedWith = message;
        return claudeSession;
      },
    });

    await callMigrate(manager, 's1', 'claude-auto-glm52b');

    // Config rewritten to the new account…
    expect(current.binary).toBe('claude-auto-glm52b');
    expect(current.harness).toBe('claude');
    expect(current.modelHint).toBe('GLM-5.2');
    expect(current.model).toBe('glm-5.2-air'); // new wrapper's KTEAM_MODEL
    expect(current.harnessHome).toBe('/new/home');
    // …while identity is preserved.
    expect(current.harnessSessionId).toBe('sess-keep-me');
    expect(current.teammate).toBe('mordecai');
    expect(current.label).toBe('lead-abc');
    expect(current.parent).toBe('p0');
    // Transcript repointed under the new home (claude).
    expect(String(current.transcriptFile)).toContain('/new/home/projects/');

    const migrated = events.find(event => event.type === 'session.migrated');
    expect(migrated?.payload).toMatchObject({ from: 'claude-auto-glm52a', to: 'claude-auto-glm52b' });
    expect(resumedWith).toMatch(/migrated to a different account/);
  });

  test('explicit --model overrides the new wrapper default', async () => {
    const wrapperDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-migrate-'));
    temporaryDirectories.push(wrapperDir);
    const wrapper = path.join(wrapperDir, 'claude-auto-glm52b');
    await writeFile(wrapper, 'export CLAUDE_CONFIG_DIR="/new/home"\nexport KTEAM_MODEL="glm-5.2-air"\n', {
      mode: 0o755,
    });

    let current = { ...(claudeSession.config as unknown as Loose) };
    const manager = migrateManager({
      paths: { kfleetBin: wrapperDir },
      store: {
        listSessions: () => [],
        updateConfig: async (_id: string, mutate: (c: Loose) => Loose) => {
          current = mutate(current);
          return current;
        },
      },
      stopMonitor: async () => undefined,
      tmux: { state: async () => ({ alive: false, dead: true, promptReady: false }) },
      stopTmuxWithEvidence: async () => undefined,
      emit: async () => ({}) as unknown,
      resume: async () => claudeSession,
    });

    await callMigrate(manager, 's1', 'claude-auto-glm52b', 'fable');
    expect(current.model).toBe('fable');
  });

  test('rolls the config back to the original account and fails the session when the relaunch throws', async () => {
    const wrapperDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-migrate-'));
    temporaryDirectories.push(wrapperDir);
    const wrapper = path.join(wrapperDir, 'claude-auto-glm52b');
    await writeFile(wrapper, 'export CLAUDE_CONFIG_DIR="/new/home"\nexport KTEAM_MODEL="glm-5.2-air"\n', {
      mode: 0o755,
    });

    let current = { ...(claudeSession.config as unknown as Loose) };
    const events: string[] = [];
    const transitions: Array<{ status?: string; reason?: string }> = [];
    const manager = migrateManager({
      paths: { kfleetBin: wrapperDir },
      store: {
        listSessions: () => [],
        updateConfig: async (_id: string, mutate: (c: Loose) => Loose) => {
          current = mutate(current);
          return current;
        },
      },
      stopMonitor: async () => undefined,
      tmux: { state: async () => ({ alive: false, dead: true, promptReady: false }) },
      stopTmuxWithEvidence: async () => undefined,
      emit: async (_id: string, type: string) => {
        events.push(type);
        return {} as unknown;
      },
      transition: async (_id: string, patch: { status?: string; reason?: string }) => {
        transitions.push(patch);
      },
      resume: async () => {
        throw new Error('pane never became ready');
      },
    });

    await expect(callMigrate(manager, 's1', 'claude-auto-glm52b')).rejects.toThrow(
      'migration to claude-auto-glm52b failed: pane never became ready; session restored to claude-auto-glm52a (stopped)',
    );
    // Config rolled back to the original account — never left on the wrapper that
    // never launched.
    expect(current.binary).toBe('claude-auto-glm52a');
    expect(current.harnessHome).toBe('/old/home');
    expect(current.model).toBe('glm-5.2');
    expect(current.migration).toBeUndefined();
    // Intent was journaled BEFORE stopping, then the session was marked failed.
    expect(events).toContain('session.migrating');
    expect(transitions.at(-1)?.status).toBe('failed');
    expect(transitions.at(-1)?.reason).toContain('restored to claude-auto-glm52a');
  });
});

describe('boot recovery re-adopts live panes (A1)', () => {
  test('a running session whose pane survived the restart is re-adopted, not killed', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-readopt-'));
    temporaryDirectories.push(home);
    const events: Array<{ type: string; patch: { status?: string; health?: string } }> = [];
    let kills = 0;
    let monitors = 0;
    const manager = bareManager();
    manager.paths = createPaths(home);
    manager.monitors = new Map();
    manager.bootstrapErrors = [];
    manager.emit = async () => ({});
    manager.list = async () => [
      {
        directory: path.join(home, 's1'),
        config: { id: 's1', tmuxSession: 'kteam-s1-agent', retry: {} },
        state: { id: 's1', status: 'running', turn: 3 },
      },
    ];
    manager.tmux = {
      state: async () => ({ alive: true, dead: false, promptReady: true }),
      snapshot: async () => 'frame\n',
    };
    manager.stopTmuxWithEvidence = async () => {
      kills++;
    };
    manager.transition = async (_id: string, patch: { status?: string; health?: string }, type: string) => {
      events.push({ type, patch });
    };
    manager.startMonitor = async () => {
      monitors++;
    };
    await (manager as unknown as { recover: () => Promise<void> }).recover();
    expect(kills).toBe(0);
    expect(monitors).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('daemon.readopted');
    expect(events[0]!.patch).toEqual({ status: 'running', health: 'healthy' });
  });

  test('a starting session with a live pane is adopted as running', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-readopt-'));
    temporaryDirectories.push(home);
    const events: Array<{ patch: { status?: string } }> = [];
    const manager = bareManager();
    manager.paths = createPaths(home);
    manager.monitors = new Map();
    manager.bootstrapErrors = [];
    manager.emit = async () => ({});
    manager.list = async () => [
      {
        directory: path.join(home, 's1'),
        config: { id: 's1', tmuxSession: 'kteam-s1-agent', retry: {} },
        state: { id: 's1', status: 'starting', turn: 1 },
      },
    ];
    manager.tmux = { state: async () => ({ alive: true, dead: false, promptReady: false }) };
    manager.stopTmuxWithEvidence = async () => {
      throw new Error('must not kill a live pane during recovery');
    };
    manager.transition = async (_id: string, patch: { status?: string }) => {
      events.push({ patch });
    };
    manager.startMonitor = async () => undefined;
    await (manager as unknown as { recover: () => Promise<void> }).recover();
    expect(events[0]!.patch.status).toBe('running');
  });
});

describe('boot reconciliation honors the done marker (G4)', () => {
  async function recoverInto(markerJson?: string): Promise<Array<{ status?: string }>> {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-recover-'));
    temporaryDirectories.push(home);
    const paths = createPaths(home);
    if (markerJson) {
      await mkdir(path.join(home, 's1', 'markers'), { recursive: true });
      await writeFile(path.join(home, 's1', 'markers', 'done.json'), `${markerJson}\n`);
    }
    const transitions: Array<{ status?: string }> = [];
    const manager = bareManager();
    manager.paths = paths;
    manager.monitors = new Map();
    manager.bootstrapErrors = [];
    manager.emit = async () => ({});
    manager.list = async () => [
      {
        directory: path.join(home, 's1'),
        config: { id: 's1', tmuxSession: 'kteam-s1-agent', retry: { waitForQuotaReset: true } },
        state: { id: 's1', status: 'running', turn: 2 },
      },
    ];
    manager.tmux = { state: async () => ({ alive: false, dead: true, promptReady: false }) };
    manager.transition = async (_id: string, patch: { status?: string }) => {
      transitions.push(patch);
    };
    await (manager as unknown as { recover: () => Promise<void> }).recover();
    return transitions;
  }

  test('a dead session with a current-turn done marker reconciles to completed, not failed', async () => {
    const transitions = await recoverInto('{"type":"done","turn":2}');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.status).toBe('completed');
  });

  test('a done marker from an OLDER turn is stale evidence — the session still fails', async () => {
    // send bumps the persisted turn at queue time; if the daemon dies before the
    // gated injection clears markers, turn-1 evidence must not complete turn 2.
    const transitions = await recoverInto('{"type":"done","turn":1}');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.status).toBe('failed');
  });

  test('a pre-upgrade marker without a turn is treated as stale, not current', async () => {
    const transitions = await recoverInto('{"type":"done"}');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.status).toBe('failed');
  });

  test('a dead session without a done marker still fails as before', async () => {
    const transitions = await recoverInto(undefined);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.status).toBe('failed');
  });
});

describe('launchWithRetry (G5)', () => {
  const config = { id: 's1', tmuxSession: 'kteam-s1-agent' } as SessionConfig;
  const call = (manager: Loose) =>
    (manager as unknown as { launchWithRetry: (config: SessionConfig) => Promise<void> }).launchWithRetry(config);

  test('startup timeout relaunches once and emits control.launch_retry', async () => {
    const manager = bareManager();
    const events: string[] = [];
    let launches = 0;
    let stops = 0;
    manager.tmux = {
      launch: async () => {
        launches++;
        if (launches === 1) throw new Error('interactive harness did not become ready within 90s');
      },
      stop: async () => void stops++,
    };
    manager.emit = async (_id: string, type: string) => void events.push(type);
    await call(manager);
    expect(launches).toBe(2);
    expect(stops).toBe(1);
    expect(events).toEqual(['control.launch_retry']);
  });

  test('a second startup timeout fails the launch (single retry only)', async () => {
    const manager = bareManager();
    let launches = 0;
    manager.tmux = {
      launch: async () => {
        launches++;
        throw new Error('interactive harness did not become ready within 90s');
      },
      stop: async () => undefined,
    };
    manager.emit = async () => undefined;
    await expect(call(manager)).rejects.toThrow(/did not become ready/);
    expect(launches).toBe(2);
  });

  test('non-timeout launch failures are not retried', async () => {
    const manager = bareManager();
    let launches = 0;
    manager.tmux = {
      launch: async () => {
        launches++;
        throw new Error('interactive harness exited (1)');
      },
      stop: async () => undefined,
    };
    manager.emit = async () => undefined;
    await expect(call(manager)).rejects.toThrow(/exited/);
    expect(launches).toBe(1);
  });
});
