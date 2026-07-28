import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { actorContext } from './actor-context';
import { createPaths } from './paths';
import { SessionManager } from './session-manager';
import type { SessionView } from './service';
import type { RuntimeControlRequest, SessionConfig, SessionState } from './types';

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

  test('automatic control/warden revive still dedupes a live same-label and same-cwd recovery', async () => {
    const manager = bareManager();
    const targetConfig = {
      id: 'target',
      teammate: 'old-worker',
      label: 'batch-a4',
      cwd: '/repo',
      tmuxSession: 'kteam-target-agent',
      harness: 'claude',
      mode: 'auto',
      turn: 3,
    };
    const targetState = { id: 'target', status: 'failed', turn: 3 };
    manager.resolveRef = (id: string) => id;
    manager.launching = new Map();
    manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
    manager.clearNeedsHuman = async () => undefined;
    manager.cancelRetry = () => undefined;
    manager.get = async () => ({ directory: '/sessions/target', config: targetConfig, state: targetState });
    manager.store = {
      listSessions: () => [
        { id: 'target', config: targetConfig, state: targetState },
        {
          id: 'successor',
          config: {
            id: 'successor',
            teammate: 'new-worker',
            label: 'batch-a4',
            cwd: '/repo',
            tmuxSession: 'kteam-successor-agent',
          },
          state: { id: 'successor', status: 'running' },
        },
      ],
    };
    manager.tmux = { state: async () => ({ alive: false, dead: true, promptReady: false }) };
    manager.emit = async () => ({});
    manager.stopMonitor = async () => {
      throw new Error('must refuse before relaunch teardown');
    };
    const error = await (
      manager as unknown as {
        withAutoRevive: (
          id: string,
          action: string,
          operation: () => Promise<SessionView>,
          message?: string,
        ) => Promise<SessionView>;
      }
    )
      .withAutoRevive(
        'target',
        'send',
        async () => {
          throw new Error('old pane died');
        },
        'continue',
      )
      .then(
        () => undefined,
        caught => caught,
      );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(
      /automatic revive suppressed for session target: live session new-worker \(successor\) shares label batch-a4.*run `kteam resume target`/,
    );
    expect(String(error)).not.toContain('successor new-worker');
    expect(String(error)).not.toContain('already owns');
    expect((manager.launching as Map<string, unknown>).has('target')).toBe(false);
  });
});

describe('manual resume vs automatic recovery dedupe', () => {
  async function recoveryManager(status = 'stalled') {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-revive-dedupe-'));
    temporaryDirectories.push(home);
    await Promise.all(
      ['turns', 'markers', 'channel'].map(directory =>
        mkdir(path.join(home, 'target', directory), { recursive: true }),
      ),
    );
    let config: Record<string, unknown> = {
      id: 'target',
      name: 'original-work',
      teammate: 'old-worker',
      label: 'batch-a4',
      cwd: home,
      binary: 'claude-auto-loge',
      harness: 'claude',
      mode: 'auto',
      harnessSessionId: '00000000-0000-4000-8000-000000000001',
      tmuxSession: 'kteam-target-agent',
      turn: 3,
    };
    let state: Record<string, unknown> = { id: 'target', status, health: 'stalled', turn: 3 };
    const conflictConfig = {
      id: 'unrelated',
      name: 'different-work',
      teammate: 'other-worker',
      label: 'batch-a4',
      cwd: home,
      tmuxSession: 'kteam-unrelated-agent',
    };
    let launches = 0;
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const manager = bareManager();
    manager.paths = createPaths(home);
    manager.closed = false;
    manager.launching = new Map();
    manager.monitors = new Map();
    manager.autoContinued = new Set();
    manager.doneDeferred = new Set();
    manager.resolveRef = (id: string) => id;
    manager.serialized = async (_id: string, operation: () => Promise<unknown>) => await operation();
    manager.serializedBootstrap = async (operation: () => Promise<unknown>) => await operation();
    manager.clearNeedsHuman = async () => undefined;
    manager.cancelRetry = () => undefined;
    manager.attachments = { buildImageReferenceBlock: async () => '' };
    manager.promptInstruction = () => 'read the next turn';
    manager.store = {
      listSessions: () => [
        { id: 'target', config, state },
        { id: 'unrelated', config: conflictConfig, state: { id: 'unrelated', status: 'running' } },
      ],
      updateConfig: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        config = mutate(config);
        return config;
      },
      updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.get = async () => ({ directory: path.join(home, 'target'), config, state });
    manager.transition = async (_id: string, patch: Record<string, unknown>) => {
      state = { ...state, ...patch };
    };
    manager.tmux = {
      state: async () => ({ alive: false, dead: true, promptReady: false, pane: '', visiblePane: '' }),
      send: async () => undefined,
      snapshot: async () => '',
      subprocessAlive: async () => false,
    };
    manager.stopMonitor = async () => undefined;
    manager.startMonitor = async () => undefined;
    manager.stopTmuxWithEvidence = async () => undefined;
    manager.launchWithRetry = async () => {
      launches++;
    };
    manager.emitDeferred = () => undefined;
    manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
      events.push({ type, data });
      return {};
    };
    return {
      manager,
      home,
      events,
      get launches() {
        return launches;
      },
    };
  }

  test('explicit admin and peer resumes bypass an unrelated session sharing only the batch label and cwd', async () => {
    for (const actor of ['admin-cli', 'peer:lead-session'] as const) {
      const fixture = await recoveryManager();
      const resumed = await actorContext.run({ actor }, () =>
        (fixture.manager as unknown as { resume: (id: string, message?: string) => Promise<SessionView> }).resume(
          'target',
          'continue the original task',
        ),
      );

      expect(fixture.launches).toBe(1);
      expect(resumed.state.status).toBe('running');
      expect((fixture.manager.launching as Map<string, unknown>).has('target')).toBe(false);
    }
  });

  test('a public resume from a warden actor keeps the original automatic-recovery dedupe', async () => {
    const fixture = await recoveryManager();
    const error = await actorContext
      .run({ actor: 'warden:warden-session' }, () =>
        (fixture.manager as unknown as { resume: (id: string, message?: string) => Promise<SessionView> }).resume(
          'target',
          'automatic recovery',
        ),
      )
      .then(
        () => undefined,
        caught => caught,
      );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('automatic revive suppressed for session target');
    expect(fixture.launches).toBe(0);
    expect((fixture.manager.launching as Map<string, unknown>).has('target')).toBe(false);
  });

  test('two concurrent automatic revivers launch the same target exactly once', async () => {
    const fixture = await recoveryManager();
    await (
      fixture.manager.store as {
        updateConfig: (
          id: string,
          mutate: (current: Record<string, unknown>) => Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).updateConfig('target', current => ({ ...current, label: 'target-only' }));

    let releaseLaunch = () => {};
    const launchMayFinish = new Promise<void>(resolve => {
      releaseLaunch = resolve;
    });
    let announceLaunch = () => {};
    const launchStarted = new Promise<void>(resolve => {
      announceLaunch = resolve;
    });
    const originalLaunch = fixture.manager.launchWithRetry as () => Promise<void>;
    fixture.manager.launchWithRetry = async () => {
      announceLaunch();
      await launchMayFinish;
      await originalLaunch();
    };
    (fixture.manager.tmux as Loose).state = async () => ({
      alive: fixture.launches > 0,
      dead: fixture.launches === 0,
      promptReady: fixture.launches > 0,
      pane: '',
      visiblePane: '',
    });
    fixture.manager.sendUnlocked = async (view: SessionView) => view;

    const resume = (message: string) =>
      (
        fixture.manager as unknown as {
          resume: (
            id: string,
            message: string,
            policy: { automatic: boolean; dedupeSharedRecoveryScope: boolean },
          ) => Promise<SessionView>;
        }
      ).resume('target', message, { automatic: true, dedupeSharedRecoveryScope: true });

    const first = resume('automatic recovery one');
    await launchStarted;
    const second = resume('automatic recovery two');
    releaseLaunch();
    await Promise.all([first, second]);

    expect(fixture.launches).toBe(1);
    expect((fixture.manager.launching as Map<string, unknown>).has('target')).toBe(false);
  });

  test('terminal send revives its intended recipient despite an unrelated live batch sibling', async () => {
    const fixture = await recoveryManager();
    const result = await (
      fixture.manager as unknown as {
        send: (id: string, request: { message: string }) => Promise<SessionView & { disposition: string }>;
      }
    ).send('target', { message: 'final handover' });

    expect(result.disposition).toBe('revived');
    expect(fixture.launches).toBe(1);
    expect(await readFile(path.join(fixture.home, 'target', 'turns', 'turn-004.md'), 'utf8')).toContain(
      'final handover',
    );
    expect((fixture.manager.launching as Map<string, unknown>).has('target')).toBe(false);
  });

  test('terminal send is durably queued when a real revive refusal prevents delivery', async () => {
    const fixture = await recoveryManager('kill_failed');
    const result = await (
      fixture.manager as unknown as {
        send: (id: string, request: { message: string }) => Promise<SessionView & { disposition: string }>;
      }
    ).send('target', { message: 'final handover' });

    expect(result.disposition).toBe('queued-for-revive');
    expect(fixture.launches).toBe(0);
    const rows = (await readFile(path.join(fixture.home, 'target', 'channel', 'inbox.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'message',
      queuedForRevive: true,
      message: 'final handover',
      reviveRefusal: 'the previous tmux kill failed; use stop again before resume',
    });
    expect(typeof rows[0]?.queueId).toBe('string');
    expect(
      fixture.events.some(event => event.type === 'control.send_queued' && event.data['queuedForRevive'] === true),
    ).toBe(true);
    expect((fixture.manager.launching as Map<string, unknown>).has('target')).toBe(false);
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
      warden: {
        enabled: true,
        wrapper: 'claude-auto-x',
        maxAssignedWardens,
        assignedCooldownMinutes: 30,
        blessMinutes: 15,
      },
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

describe('in-session runtime model controls', () => {
  const callRuntime = (manager: Loose, request: RuntimeControlRequest) =>
    (manager as unknown as SessionManager).runtime('s1', request);

  function runtimeManager(input: {
    harness: 'claude' | 'codex';
    binary: string;
    promptReady?: boolean;
    outcome?: 'handled-local' | 'turn-started';
  }) {
    const commands: string[] = [];
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const view = {
      directory: '/tmp/kteam-runtime-test/s1',
      config: {
        id: 's1',
        harness: input.harness,
        binary: input.binary,
        tmuxSession: 'kteam-s1-agent',
        turn: 7,
      },
      state: { id: 's1', status: 'awaiting_user', turn: 7, observedModel: 'previous-model' },
    } as SessionView;
    const manager = bareManager();
    manager.resolveRef = (id: string) => id;
    manager.serialized = async (_id: string, work: () => Promise<SessionView>) => await work();
    manager.get = async () => view;
    manager.tmux = {
      state: async () => ({ alive: true, dead: false, promptReady: input.promptReady ?? true }),
      inject: async (_name: string, command: string) => {
        commands.push(command);
        return input.outcome ?? 'handled-local';
      },
    };
    manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
      events.push({ type, data });
      return {};
    };
    return { manager, view, commands, events };
  }

  test('Claude injects one allowlisted account model without advancing the turn or lying about observed state', async () => {
    const { manager, view, commands, events } = runtimeManager({
      harness: 'claude',
      binary: 'claude-auto-loge',
    });
    const result = await callRuntime(manager, { action: 'model', model: 'claude-sonnet-5' });

    expect(result).toBe(view);
    expect(commands).toEqual(['/model claude-sonnet-5']);
    expect(result.config.turn).toBe(7);
    expect(result.state.observedModel).toBe('previous-model');
    expect(events).toEqual([
      {
        type: 'control.runtime_model',
        data: { harness: 'claude', requestedModel: 'claude-sonnet-5' },
      },
    ]);
  });

  test('Codex opens its native account-aware model and reasoning picker', async () => {
    const { manager, commands, events } = runtimeManager({ harness: 'codex', binary: 'codex-auto-loai' });
    await callRuntime(manager, { action: 'model' });
    expect(commands).toEqual(['/model']);
    expect(events[0]).toEqual({ type: 'control.runtime_model', data: { harness: 'codex', picker: true } });
  });

  test('Claude injects one persistable effort level without advancing the turn', async () => {
    const { manager, view, commands, events } = runtimeManager({
      harness: 'claude',
      binary: 'claude-auto-loge',
    });
    const result = await callRuntime(manager, { action: 'effort', effort: ' high ' });

    expect(result).toBe(view);
    expect(commands).toEqual(['/effort high']);
    expect(result.config.turn).toBe(7);
    expect(events).toEqual([
      {
        type: 'control.runtime_model',
        data: { harness: 'claude', requestedEffort: 'high' },
      },
    ]);
  });

  test('refuses unsupported effort levels and Codex effort before typing', async () => {
    const claude = runtimeManager({ harness: 'claude', binary: 'claude-auto-loge' });
    await expect(callRuntime(claude.manager, { action: 'effort', effort: 'auto' })).rejects.toThrow(
      /low, medium, high, xhigh/,
    );
    expect(claude.commands).toEqual([]);

    const codex = runtimeManager({ harness: 'codex', binary: 'codex-auto-loge' });
    await expect(callRuntime(codex.manager, { action: 'effort', effort: 'high' })).rejects.toThrow(/native picker/);
    expect(codex.commands).toEqual([]);
  });

  test('refuses busy panes and unsupported Claude model ids before typing', async () => {
    const busy = runtimeManager({ harness: 'claude', binary: 'claude-auto-loge', promptReady: false });
    await expect(callRuntime(busy.manager, { action: 'model', model: 'claude-sonnet-5' })).rejects.toThrow(
      /idle prompt/,
    );
    expect(busy.commands).toEqual([]);

    const provider = runtimeManager({ harness: 'claude', binary: 'claude-auto-mm3' });
    await expect(callRuntime(provider.manager, { action: 'model', model: 'claude-sonnet-5' })).rejects.toThrow(
      /not available on wrapper/,
    );
    expect(provider.commands).toEqual([]);
  });

  test('requires native local handling instead of silently accepting a model turn', async () => {
    const { manager, events } = runtimeManager({
      harness: 'codex',
      binary: 'codex-auto-loge',
      outcome: 'turn-started',
    });
    await expect(callRuntime(manager, { action: 'model' })).rejects.toThrow(/model turn instead of a native/);
    expect(events).toEqual([]);
  });

  // OBSERVED 2026-07-27 on throwaway probes: Claude /clear is a local wipe;
  // Claude /compact runs a model turn; Codex compacts locally.
  test('Claude /clear injects one local command, records disposition, and does not advance the turn', async () => {
    const { manager, view, commands, events } = runtimeManager({
      harness: 'claude',
      binary: 'claude-auto-loge',
      outcome: 'handled-local',
    });
    const result = await callRuntime(manager, { action: 'clear' });

    expect(result).toBe(view);
    expect(commands).toEqual(['/clear']);
    expect(result.config.turn).toBe(7);
    expect(events).toEqual([
      {
        type: 'control.session_command',
        data: { harness: 'claude', command: 'clear', disposition: 'handled-local' },
      },
    ]);
  });

  test('/clear that the harness turns into a model turn is refused, not silently accepted', async () => {
    const { manager, commands, events } = runtimeManager({
      harness: 'claude',
      binary: 'claude-auto-loge',
      outcome: 'turn-started',
    });
    await expect(callRuntime(manager, { action: 'clear' })).rejects.toThrow(/model turn instead of a local clear/);
    expect(commands).toEqual(['/clear']);
    expect(events).toEqual([]);
  });

  test('/compact accepts a real model turn and records turn-started', async () => {
    const { manager, commands, events } = runtimeManager({
      harness: 'claude',
      binary: 'claude-auto-loge',
      outcome: 'turn-started',
    });
    await callRuntime(manager, { action: 'compact' });
    expect(commands).toEqual(['/compact']);
    expect(events).toEqual([
      {
        type: 'control.session_command',
        data: { harness: 'claude', command: 'compact', disposition: 'turn-started' },
      },
    ]);
  });

  test('/compact also accepts a local completion', async () => {
    const { manager, commands, events } = runtimeManager({
      harness: 'codex',
      binary: 'codex-auto-loge',
      outcome: 'handled-local',
    });
    await callRuntime(manager, { action: 'compact' });
    expect(commands).toEqual(['/compact']);
    expect(events).toEqual([
      {
        type: 'control.session_command',
        data: { harness: 'codex', command: 'compact', disposition: 'handled-local' },
      },
    ]);
  });

  test('/clear and /compact refuse a busy pane before typing anything', async () => {
    const clearBusy = runtimeManager({ harness: 'claude', binary: 'claude-auto-loge', promptReady: false });
    await expect(callRuntime(clearBusy.manager, { action: 'clear' })).rejects.toThrow(/idle prompt/);
    expect(clearBusy.commands).toEqual([]);

    const compactBusy = runtimeManager({ harness: 'codex', binary: 'codex-auto-loge', promptReady: false });
    await expect(callRuntime(compactBusy.manager, { action: 'compact' })).rejects.toThrow(/idle prompt/);
    expect(compactBusy.commands).toEqual([]);
  });
});

describe('send() delivery holes (turn-012 fix round)', () => {
  function sendManager(input: { status: string; paneAlive: boolean; promptReady?: boolean }) {
    const calls: string[] = [];
    const manager = bareManager();
    manager.resolveRef = (id: string) => id;
    manager.launching = new Map<string, number>();
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
    manager.launching = new Map<string, number>();
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
    manager.launching = new Map<string, number>();
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
    manager.launching = new Map<string, number>();
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
    manager.launching = new Map<string, number>();
    const result = await (
      manager as unknown as {
        send: (id: string, request: { message: string; now?: boolean }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: 'urgent steer', now: true });
    expect(result.disposition).toBe('queued');
    expect(typed).toEqual(['urgent steer']);
  });

  test('a failed idle injection leaves no inbox row and does not bump the turn', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-idle-rollback-'));
    temporaryDirectories.push(home);
    await Promise.all([
      mkdir(path.join(home, 's1', 'channel'), { recursive: true }),
      mkdir(path.join(home, 's1', 'turns'), { recursive: true }),
      mkdir(path.join(home, 's1', 'markers'), { recursive: true }),
    ]);
    await writeFile(path.join(home, 's1', 'channel', 'inbox.jsonl'), '');
    let config: Record<string, unknown> = {
      id: 's1',
      mode: 'auto',
      tmuxSession: 'kteam-s1-agent',
      turn: 3,
      directSendMaxChars: 500,
    };
    const manager = bareManager();
    manager.paths = createPaths(home);
    manager.attachments = { buildImageReferenceBlock: async () => '' };
    manager.autoContinued = new Set();
    manager.doneDeferred = new Set();
    manager.tmux = {
      send: async () => {
        throw new Error('the prompt never started');
      },
    };
    manager.store = {
      updateConfig: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        config = mutate(config);
        return config;
      },
    };
    manager.emit = async () => ({});
    manager.transition = async () => undefined;
    await expect(
      (
        manager as unknown as {
          deliverToIdlePrompt: (id: string, view: SessionView, request: { message: string }) => Promise<void>;
        }
      ).deliverToIdlePrompt(
        's1',
        {
          directory: path.join(home, 's1'),
          config,
          state: { id: 's1', status: 'running', turn: 3 },
        } as unknown as SessionView,
        { message: 'must be atomic' },
      ),
    ).rejects.toThrow(/never started/);
    expect(config.turn).toBe(3);
    expect(await readFile(path.join(home, 's1', 'channel', 'inbox.jsonl'), 'utf8')).toBe('');
  });

  test('a composer rejection falls back once to a durable file-backed native queue', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-fallback-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
    const typed: string[] = [];
    let state: Record<string, unknown> = { id: 's1', status: 'running', turn: 3, promptReady: false };
    const { manager } = sendManager({ status: 'running', paneAlive: true, promptReady: false });
    manager.get = async () => ({
      directory: path.join(home, 's1'),
      config: { id: 's1', tmuxSession: 'kteam-s1-agent', turn: 3 },
      state,
    });
    manager.store = {
      updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.tmux = {
      state: async () => ({ alive: true, dead: false, promptReady: false, visiblePane: '• Working (10s' }),
      typeIntoQueue: async (_name: string, text: string) => {
        typed.push(text);
        if (typed.length === 1) throw new Error('the message left the composer without queue evidence');
      },
    };
    manager.emit = async () => ({});
    manager.monitors = new Map();
    manager.launching = new Map();
    const queued = await (
      manager as unknown as {
        send: (id: string, request: { message: string }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: 'fallback payload' });
    expect(queued.disposition).toBe('queued');
    expect(typed).toHaveLength(2);
    expect(typed[0]).toBe('fallback payload');
    expect(typed[1]).toContain('Read the queued message file');
    const pending = state.pendingNativeSends as Array<{ message: string; queueText?: string; payloadFile?: string }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.message).toBe('fallback payload');
    expect(pending[0]!.queueText).toBe(typed[1]);
    expect(await readFile(pending[0]!.payloadFile!, 'utf8')).toBe('fallback payload\n');
  });

  test('a multi-kilobyte busy send queues only a short durable file instruction', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-long-fallback-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
    const long = `LONG SPEC\n${'x'.repeat(4_300)}`;
    const typed: string[] = [];
    let state: Record<string, unknown> = { id: 's1', status: 'running', turn: 3, promptReady: false };
    const { manager } = sendManager({ status: 'running', paneAlive: true, promptReady: false });
    manager.get = async () => ({
      directory: path.join(home, 's1'),
      config: { id: 's1', tmuxSession: 'kteam-s1-agent', turn: 3 },
      state,
    });
    manager.store = {
      updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
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
    manager.launching = new Map();
    const queued = await (
      manager as unknown as {
        send: (id: string, request: { message: string }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: long });
    expect(queued.disposition).toBe('queued');
    expect(typed).toHaveLength(1);
    expect(typed[0]!.length).toBeLessThan(1_000);
    expect(typed[0]).toContain('Read the queued message file');
    expect(typed[0]).not.toContain('x'.repeat(500));
    const pending = state.pendingNativeSends as Array<{ message: string; queueText?: string; payloadFile?: string }>;
    expect(pending[0]!.message).toBe(long);
    expect(pending[0]!.queueText).toBe(typed[0]);
    expect(await readFile(pending[0]!.payloadFile!, 'utf8')).toBe(`${long}\n`);
  });

  test('a successful peer send appends a sender-side outbox row', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-outbox-'));
    temporaryDirectories.push(home);
    await Promise.all(
      ['sender', 's1'].flatMap(id => [
        mkdir(path.join(home, id, 'channel'), { recursive: true }),
        mkdir(path.join(home, id, 'turns'), { recursive: true }),
        mkdir(path.join(home, id, 'markers'), { recursive: true }),
      ]),
    );
    await writeFile(path.join(home, 'sender', 'channel', 'outbox.jsonl'), '');
    let targetConfig: Record<string, unknown> = {
      id: 's1',
      mode: 'interactive',
      tmuxSession: 'kteam-s1-agent',
      turn: 3,
      directSendMaxChars: 500,
    };
    const targetState = { id: 's1', status: 'awaiting_user', turn: 3, promptReady: true };
    const manager = bareManager();
    manager.paths = createPaths(home);
    manager.resolveRef = (id: string) => id;
    manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
    manager.launching = new Map();
    manager.monitors = new Map();
    manager.autoContinued = new Set();
    manager.doneDeferred = new Set();
    manager.attachments = { buildImageReferenceBlock: async () => '' };
    manager.get = async (id: string) =>
      id === 'sender'
        ? {
            directory: path.join(home, 'sender'),
            config: { id: 'sender', teammate: 'georgia', turn: 1 },
            state: { id: 'sender', status: 'running', turn: 1 },
          }
        : { directory: path.join(home, 's1'), config: targetConfig, state: targetState };
    manager.store = {
      updateConfig: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        targetConfig = mutate(targetConfig);
        return targetConfig;
      },
    };
    manager.tmux = {
      state: async () => ({ alive: true, dead: false, promptReady: true, visiblePane: '❯ ' }),
      send: async () => undefined,
    };
    manager.emit = async () => ({});
    manager.transition = async () => undefined;
    manager.endPeerWait = async () => undefined;
    const result = await (
      manager as unknown as {
        send: (id: string, request: { message: string; from: string }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: 'peer update', from: 'sender' });
    expect(result.disposition).toBe('delivered');
    const rows = (await readFile(path.join(home, 'sender', 'channel', 'outbox.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: 'sender', to: 's1', disposition: 'delivered', message: 'peer update' });
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
    manager.recover = async () => {
      ran.push('recover');
      throw new Error('recover exploded');
    };
    manager.startWarden = async () => {
      ran.push('warden');
    };
    manager.sweepScratch = async () => {
      ran.push('scratch-gc');
    };
    await (manager as unknown as { bootstrap: () => Promise<void> }).bootstrap();
    // warden ALWAYS armed, and scratch gc runs after it
    expect(ran).toEqual(['import', 'recover', 'warden', 'scratch-gc']);
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
    manager.launching = new Map<string, number>();
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
      // recover() inventories tmux ONCE (see recover()): an empty set means no
      // terminal pane survived the restart, which is what these cases model.
      listSessions: async () => new Set<string>(),
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
      // recover() inventories tmux ONCE (see recover()): an empty set means no
      // terminal pane survived the restart, which is what these cases model.
      listSessions: async () => new Set<string>(),
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
    manager.launching = new Map<string, number>();
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
    manager.consistencyCheck = async () => ({ missingFromIndex: [], staleRows: [], zombies: [], repaired: [] });
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
    manager.launching = new Map<string, number>();
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
    manager.consistencyCheck = async () => ({ missingFromIndex: [], staleRows: [], zombies: [], repaired: [] });
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
    manager.consistencyCheck = async () => ({ missingFromIndex: [], staleRows: [], zombies: [], repaired: [] });
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
    pendingNativeSends: Array<{
      id: string;
      at: string;
      message: string;
      queueText?: string;
      payloadFile?: string;
    }>;
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

  test('a file-backed queue matches its short instruction and materializes the full payload', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-correlate-file-backed-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'turns'), { recursive: true });
    const fullMessage = `LONG SPEC\n${'x'.repeat(4_300)}`;
    const queueText = `Read the queued message file at ${path.join(home, 's1', 'channel', 'queued-q1.md')}`;
    const harness = correlationManager({
      turn: 3,
      pendingNativeSends: [
        {
          id: 'q1',
          at: 'then',
          message: fullMessage,
          queueText,
          payloadFile: path.join(home, 's1', 'channel', 'queued-q1.md'),
        },
      ],
    });
    await harness.call([{ type: 'chat.user', data: { text: queueText } }], home);
    expect(harness.config().turn).toBe(4);
    expect(harness.state().pendingNativeSends).toHaveLength(0);
    expect(await readFile(path.join(home, 's1', 'turns', 'turn-004.md'), 'utf8')).toBe(`${fullMessage}\n`);
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
      manager.launching = new Map<string, number>();
      manager.launching = new Map<string, number>();
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
    manager.options = { contextWindows: {} };
    manager.cancelRetry = () => undefined;
    manager.cancelQuotaWaiter = async () => undefined;
    manager.get = async () => claudeSession;
    const configured = Object.assign(manager, over);
    const store = configured.store as Loose;
    store.updateState ??= async (_id: string, mutate: (state: SessionState) => SessionState) =>
      mutate(claudeSession.state);
    return configured;
  }

  const callMigrate = (manager: Loose, id: string, agent: string, model?: string, allowContextDowngrade?: boolean) =>
    (
      manager as unknown as {
        migrate: (id: string, agent: string, model?: string, allowContextDowngrade?: boolean) => Promise<SessionView>;
      }
    ).migrate(id, agent, model, allowContextDowngrade);

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

  test('refuses a 1M-to-200k context downgrade without the flag and names the 1M variant', async () => {
    const wrapperDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-migrate-window-'));
    temporaryDirectories.push(wrapperDir);
    await writeFile(
      path.join(wrapperDir, 'claude-auto-smaller'),
      'export CLAUDE_CONFIG_DIR="/new/home"\nexport KTEAM_MODEL="claude-fable-5"\n',
      { mode: 0o755 },
    );
    const oneMillionSession = {
      ...claudeSession,
      config: { ...claudeSession.config, model: 'claude-fable-5[1m]' },
      state: { ...claudeSession.state, contextTokens: 100_000 },
    } as SessionView;
    let journaled = false;
    const manager = migrateManager({
      paths: { kfleetBin: wrapperDir },
      get: async () => oneMillionSession,
      store: {
        listSessions: () => [],
        updateConfig: async () => {
          journaled = true;
          throw new Error('must refuse before journaling migration intent');
        },
      },
    });

    await expect(callMigrate(manager, 's1', 'claude-auto-smaller')).rejects.toThrow(
      /claude-fable-5\[1m\].*--allow-context-downgrade/,
    );
    expect(journaled).toBe(false);
  });

  test('refuses an over-capacity target even when context downgrade is allowed', async () => {
    const wrapperDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-migrate-capacity-'));
    temporaryDirectories.push(wrapperDir);
    await writeFile(
      path.join(wrapperDir, 'claude-auto-smaller'),
      'export CLAUDE_CONFIG_DIR="/new/home"\nexport KTEAM_MODEL="claude-fable-5"\n',
      { mode: 0o755 },
    );
    const overCapacitySession = {
      ...claudeSession,
      config: { ...claudeSession.config, model: 'claude-fable-5[1m]' },
      state: { ...claudeSession.state, contextTokens: 639_000 },
    } as SessionView;
    let journaled = false;
    const manager = migrateManager({
      paths: { kfleetBin: wrapperDir },
      get: async () => overCapacitySession,
      store: {
        listSessions: () => [],
        updateConfig: async () => {
          journaled = true;
          throw new Error('must refuse before journaling migration intent');
        },
      },
    });

    await expect(callMigrate(manager, 's1', 'claude-auto-smaller', undefined, true)).rejects.toThrow(/639000.*200000/);
    expect(journaled).toBe(false);
  });

  test('a window-equal migration rewrites binary/home/model, keeps identity, and resumes', async () => {
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

  test('rolls back the account but preserves a model that demonstrably launched', async () => {
    const wrapperDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-migrate-launched-model-'));
    temporaryDirectories.push(wrapperDir);
    await writeFile(
      path.join(wrapperDir, 'claude-auto-next'),
      'export CLAUDE_CONFIG_DIR="/new/home"\nexport KTEAM_MODEL="claude-fable-5"\n',
      { mode: 0o755 },
    );

    let current = { ...(claudeSession.config as unknown as Loose) };
    let reads = 0;
    const manager = migrateManager({
      paths: { kfleetBin: wrapperDir },
      get: async () => {
        reads++;
        if (reads === 1) return claudeSession;
        return {
          ...claudeSession,
          config: current,
          state: { ...claudeSession.state, observedModel: 'claude-fable-5', promptReady: false },
        };
      },
      store: {
        listSessions: () => [],
        updateConfig: async (_id: string, mutate: (c: Loose) => Loose) => {
          current = mutate(current);
          return current;
        },
      },
      stopMonitor: async () => undefined,
      tmux: { state: async () => ({ alive: false, dead: true, promptReady: false }) },
      emit: async () => ({}) as unknown,
      transition: async () => undefined,
      resume: async () => {
        throw new Error('monitor attach failed after the model answered');
      },
    });

    await expect(callMigrate(manager, 's1', 'claude-auto-next')).rejects.toThrow(/kept launched model/);
    expect(current.binary).toBe('claude-auto-glm52a');
    expect(current.harnessHome).toBe('/old/home');
    expect(current.model).toBe('claude-fable-5');
    expect(current.migration).toBeUndefined();
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
    manager.launching = new Map<string, number>();
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
      // recover() inventories tmux ONCE (see recover()): an empty set means no
      // terminal pane survived the restart, which is what these cases model.
      listSessions: async () => new Set<string>(),
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
    manager.launching = new Map<string, number>();
    manager.bootstrapErrors = [];
    manager.emit = async () => ({});
    manager.list = async () => [
      {
        directory: path.join(home, 's1'),
        config: { id: 's1', tmuxSession: 'kteam-s1-agent', retry: {} },
        state: { id: 's1', status: 'starting', turn: 1 },
      },
    ];
    manager.tmux = {
      state: async () => ({ alive: true, dead: false, promptReady: false }),
      // recover() inventories tmux ONCE (see recover()): an empty set means no
      // terminal pane survived the restart, which is what these cases model.
      listSessions: async () => new Set<string>(),
    };
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
    manager.launching = new Map<string, number>();
    manager.bootstrapErrors = [];
    manager.emit = async () => ({});
    manager.list = async () => [
      {
        directory: path.join(home, 's1'),
        config: { id: 's1', tmuxSession: 'kteam-s1-agent', retry: { waitForQuotaReset: true } },
        state: { id: 's1', status: 'running', turn: 2 },
      },
    ];
    manager.tmux = {
      state: async () => ({ alive: false, dead: true, promptReady: false }),
      // recover() inventories tmux ONCE (see recover()): an empty set means no
      // terminal pane survived the restart, which is what these cases model.
      listSessions: async () => new Set<string>(),
    };
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
