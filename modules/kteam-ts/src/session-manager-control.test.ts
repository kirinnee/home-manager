import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { actorContext } from './actor-context';
import {
  codexRuntimeModelCatalog,
  driveCodexModelPicker,
  preflightCodexModelPicker,
  waitForCodexRuntimeObservation,
  waitForCodexThreadSettingsApplied,
  type CodexPickerKeyExpectation,
  type CodexPickerTarget,
  type CodexPickerTransport,
} from './codex-runtime';
import { runtimeModelsForWrapper } from './fleet-inventory';
import { createPaths } from './paths';
import { newAcceptedSend, type SendRecord } from './send-ledger';
import { dismissCodexPicker, SessionManager } from './session-manager';
import type { ObservedHumanInput } from './observed-human-input';
import type { SessionView } from './service';
import type { RuntimeControlRequest, SessionConfig, SessionState } from './types';

// Fixture-level tests over prototype instances: the real SessionManager wires a
// daemon, tmux, and event store — these tests exercise the control-path logic
// (F4 auto-revive, F5 queued-send delivery) with the collaborators mocked.

const temporaryDirectories: string[] = [];
const originalCodexRuntimeCatalogGet = codexRuntimeModelCatalog.get;

afterEach(async () => {
  codexRuntimeModelCatalog.get = originalCodexRuntimeCatalogGet;
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type Loose = Record<string, unknown>;

function bareManager(): Loose {
  const manager = Object.create(SessionManager.prototype) as Loose;
  const home = path.join(os.tmpdir(), `kteam-control-${crypto.randomUUID()}`);
  temporaryDirectories.push(home);
  manager.paths = createPaths(home);
  manager.sendLedgers = new Map();
  manager.reconciledSendLedgers = new Set();
  manager.terminalSendFinalizers = new Map();
  manager.deleting = new Set();
  manager.queues = new Map();
  manager.runtimeControlQueues = new Map();
  manager.monitors = new Map();
  manager.closed = false;
  manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
  manager.emit = async () => ({});
  return manager;
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

  test('kill_failed panes reject input before delivery or revive side effects', async () => {
    const fixture = await recoveryManager('kill_failed');
    await expect(
      (
        fixture.manager as unknown as {
          send: (id: string, request: { message: string }) => Promise<SessionView & { disposition: string }>;
        }
      ).send('target', { message: 'final handover' }),
    ).rejects.toThrow('previous tmux shutdown was not confirmed');
    expect(fixture.launches).toBe(0);
    await expect(readFile(path.join(fixture.home, 'target', 'channel', 'inbox.jsonl'), 'utf8')).rejects.toThrow();
    expect(fixture.events).toEqual([]);
    expect((fixture.manager.launching as Map<string, unknown>).has('target')).toBe(false);
  });

  test('a pre-start revive error finalizes the newly accepted send instead of leaving it latched forever', async () => {
    const fixture = await recoveryManager('failed');
    fixture.manager.resume = async () => {
      throw new Error('tmux state probe failed before resume could start');
    };
    await expect(
      (
        fixture.manager as unknown as {
          send: (id: string, request: { message: string }) => Promise<SessionView & { disposition: string }>;
        }
      ).send('target', { message: 'classify this accepted row' }),
    ).rejects.toThrow('tmux state probe failed before resume could start');

    const ledger = await (
      fixture.manager as unknown as { sendLedger: (id: string) => Promise<{ all: () => SendRecord[] }> }
    ).sendLedger('target');
    expect(ledger.all()).toEqual([
      expect.objectContaining({
        path: 'revive',
        fate: 'unaccounted',
        unaccountedReason: 'session_ended',
      }),
    ]);
    expect(ledger.all()[0]?.withdrawn).toBeUndefined();
    expect(fixture.events.some(event => event.type === 'control.send_unaccounted')).toBe(true);
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
      return {
        config: {
          id,
          teammate: id,
          binary: 'claude-auto-x',
          harness: 'claude',
          model: 'claude-opus-4-8',
          createdAt: '2026-07-28T12:00:00.000Z',
        },
        state: { status: 'running' },
        directory: `/x/${id}`,
      };
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
    cwd?: string;
    transcriptFile?: string;
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
        cwd: input.cwd ?? '/tmp',
        tmuxSession: 'kteam-s1-agent',
        turn: 7,
        ...(input.transcriptFile ? { transcriptFile: input.transcriptFile } : {}),
      },
      state: { id: 's1', status: 'awaiting_user', turn: 7, observedModel: 'previous-model' },
    } as SessionView;
    const manager = bareManager();
    manager.resolveRef = (id: string) => id;
    manager.serialized = async (_id: string, work: () => Promise<SessionView>) => await work();
    manager.get = async () => view;
    manager.tmux = {
      state: async () => ({
        alive: true,
        dead: false,
        promptReady: input.promptReady ?? true,
        visiblePane: 'Select Model and Effort\n  1. gpt-5.5',
      }),
      inject: async (_name: string, command: string) => {
        commands.push(command);
        return input.outcome ?? 'handled-local';
      },
      snapshot: async () => '',
    };
    manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
      events.push({ type, data });
      return {};
    };
    return { manager, view, commands, events };
  }

  async function transcriptFixture() {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kteam-codex-runtime-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'rollout.jsonl');
    const prefix = '{"old":true}\n';
    await writeFile(file, prefix);
    return { directory, file, prefix };
  }

  const rawSettingsApplied = (target: CodexPickerTarget) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: target.model, reasoning_effort: target.effort },
      },
    });

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

  test('bare Codex model control still opens its native account-aware picker', async () => {
    const { manager, commands, events } = runtimeManager({ harness: 'codex', binary: 'codex-auto-loai' });
    let catalogReads = 0;
    codexRuntimeModelCatalog.get = async () => {
      catalogReads++;
      throw new Error('bare picker must not load a catalog');
    };
    await callRuntime(manager, { action: 'model' });
    expect(commands).toEqual(['/model']);
    expect(events[0]).toEqual({ type: 'control.runtime_model', data: { harness: 'codex', picker: true } });
    expect(catalogReads).toBe(0);
  });

  test('runtimeModels returns the authoritative wire shape for each harness', async () => {
    const claude = runtimeManager({ harness: 'claude', binary: 'claude-auto-loge' });
    const claudeCatalog = await (claude.manager as unknown as SessionManager).runtimeModels('s1');
    expect(claudeCatalog).toEqual({
      harness: 'claude',
      source: 'wrapper-inventory',
      choices: runtimeModelsForWrapper('claude-auto-loge').map(choice => ({ ...choice, reasoningEfforts: [] })),
    });

    const codexChoices = [
      {
        value: 'gpt-5.5',
        label: 'GPT-5.5',
        reasoningEfforts: [{ value: 'high' }],
        defaultReasoningEffort: 'high',
      },
    ];
    codexRuntimeModelCatalog.get = async (binary, cwd) => {
      expect(binary).toBe('/bin/true');
      expect(cwd).toBe('/tmp');
      return codexChoices;
    };
    const codex = runtimeManager({ harness: 'codex', binary: '/bin/true' });
    await expect((codex.manager as unknown as SessionManager).runtimeModels('s1')).resolves.toEqual({
      harness: 'codex',
      source: 'codex-app-server',
      choices: codexChoices,
    });
  });

  test('screen-aware Codex quick-picker preflight refuses a mismatched direct-default row before its digit', async () => {
    const transcript = await transcriptFixture();
    const target = { model: 'gpt-5.5', effort: 'high' };
    codexRuntimeModelCatalog.get = async () => [
      {
        value: target.model,
        label: 'GPT-5.5',
        reasoningEfforts: [{ value: 'medium' }, { value: target.effort }],
        defaultReasoningEffort: 'medium',
      },
    ];
    const { manager, commands, events } = runtimeManager({
      harness: 'codex',
      binary: '/bin/true',
      cwd: transcript.directory,
      transcriptFile: transcript.file,
    });
    let stateReads = 0;
    manager.tmux = {
      state: async () => {
        stateReads++;
        return stateReads < 3
          ? { alive: true, dead: false, promptReady: true, visiblePane: '› ' }
          : {
              alive: true,
              dead: false,
              promptReady: false,
              visiblePane: 'Select Model\n› 1. gpt-5.5\n  2. All models',
            };
      },
      inject: async (_name: string, command: string) => {
        commands.push(command);
        return 'handled-local' as const;
      },
    };
    const pickerKeys: string[] = [];
    let preflightCalls = 0;
    let driverCalls = 0;
    let cleanupCalls = 0;
    manager.codexRuntimeControl = {
      preflightModelPicker: async (transport: CodexPickerTransport, requested: CodexPickerTarget) => {
        preflightCalls++;
        return await preflightCodexModelPicker(transport, requested, { pollMs: 0 });
      },
      driveModelPicker: async () => {
        driverCalls++;
      },
      sendPickerKey: async (_session: string, key: string) => {
        pickerKeys.push(key);
      },
      dismissPicker: async () => {
        cleanupCalls++;
      },
      waitForThreadSettingsApplied: waitForCodexThreadSettingsApplied,
      waitForRuntimeObservation: waitForCodexRuntimeObservation,
    };

    await expect(callRuntime(manager, { action: 'model', model: target.model, effort: target.effort })).rejects.toThrow(
      'can only select its default medium reasoning level',
    );
    expect(preflightCalls).toBe(1);
    expect(driverCalls).toBe(0);
    expect(commands).toEqual(['/model']);
    expect(pickerKeys).toEqual([]);
    expect(cleanupCalls).toBe(1);
    expect(events).toEqual([]);
  });

  test('Codex picker drive failure closes the verified exact pane before rethrowing', async () => {
    const transcript = await transcriptFixture();
    const target = { model: 'gpt-5.5', effort: 'high' };
    codexRuntimeModelCatalog.get = async () => [
      {
        value: target.model,
        label: 'GPT-5.5',
        reasoningEfforts: [{ value: target.effort }],
        defaultReasoningEffort: target.effort,
      },
    ];
    const { manager, commands, events } = runtimeManager({
      harness: 'codex',
      binary: '/bin/true',
      cwd: transcript.directory,
      transcriptFile: transcript.file,
    });
    const cleanupCalls: string[] = [];
    let frame = 0;
    let clock = 0;
    manager.codexRuntimeControl = {
      driveModelPicker: async (transport: CodexPickerTransport) => {
        expect(await transport.openPicker()).toBe('handled-local');
        throw new Error('picker stage failed');
      },
      sendPickerKey: async () => undefined,
      dismissPicker: async (tmuxSession: string) => {
        expect(tmuxSession).toBe('kteam-s1-agent');
        await dismissCodexPicker(
          {
            resolvePane: async () => {
              cleanupCalls.push('resolve');
              return '%42';
            },
            capturePane: async paneId => {
              cleanupCalls.push(`capture:${paneId}`);
              frame++;
              return frame === 1
                ? { visiblePane: 'Select Model\n› 1. gpt-5.5', promptReady: false }
                : { visiblePane: '› ', promptReady: true };
            },
            sendEscape: async paneId => {
              cleanupCalls.push(`escape:${paneId}`);
            },
          },
          {
            timeoutMs: 4,
            pollMs: 1,
            clock: () => clock,
            sleep: async milliseconds => {
              clock += milliseconds;
            },
          },
        );
      },
      waitForThreadSettingsApplied: waitForCodexThreadSettingsApplied,
      waitForRuntimeObservation: waitForCodexRuntimeObservation,
    };

    await expect(callRuntime(manager, { action: 'model', model: target.model, effort: target.effort })).rejects.toThrow(
      'picker stage failed',
    );
    expect(commands).toEqual(['/model']);
    expect(cleanupCalls).toEqual(['resolve', 'capture:%42', 'escape:%42', 'capture:%42']);
    expect(events).toEqual([]);
  });

  test('Codex final picker-close timeout reaches cleanup before runtime returns its failure', async () => {
    const transcript = await transcriptFixture();
    const target = { model: 'gpt-5.5', effort: 'high' };
    codexRuntimeModelCatalog.get = async () => [
      {
        value: target.model,
        label: 'GPT-5.5',
        reasoningEfforts: [{ value: target.effort }],
        defaultReasoningEffort: target.effort,
      },
    ];
    const { manager, commands, events } = runtimeManager({
      harness: 'codex',
      binary: '/bin/true',
      cwd: transcript.directory,
      transcriptFile: transcript.file,
    });
    const frames = [
      { alive: true, dead: false, promptReady: true, visiblePane: '› ' },
      { alive: true, dead: false, promptReady: true, visiblePane: '› ' },
      { alive: true, dead: false, promptReady: false, visiblePane: 'Select Model and Effort\n› 1. gpt-5.5' },
      { alive: true, dead: false, promptReady: false, visiblePane: 'Select Reasoning Level for gpt-5.5\n› 1. High' },
      {
        alive: true,
        dead: false,
        promptReady: false,
        visiblePane: 'Apply reasoning change\n› 1. Apply to global default and Plan mode override',
      },
      { alive: true, dead: false, promptReady: false, visiblePane: 'Applying settingâ¦' },
    ];
    let frame = 0;
    manager.tmux = {
      state: async () => frames[Math.min(frame++, frames.length - 1)]!,
      inject: async (_session: string, command: string) => {
        commands.push(command);
        return 'handled-local' as const;
      },
      snapshot: async () => '',
    };
    const pickerKeys: string[] = [];
    let cleanupCalls = 0;
    manager.codexRuntimeControl = {
      driveModelPicker: async (...args: Parameters<typeof driveCodexModelPicker>) => {
        const [transport, pickerTarget, , preflightScreen] = args;
        await driveCodexModelPicker(
          transport,
          pickerTarget,
          { timeoutMs: 10, pollMs: 0, sleep: async () => await Bun.sleep(1) },
          preflightScreen,
        );
      },
      sendPickerKey: async (_session: string, key: string) => {
        pickerKeys.push(key);
      },
      dismissPicker: async () => {
        cleanupCalls++;
      },
      waitForThreadSettingsApplied: waitForCodexThreadSettingsApplied,
      waitForRuntimeObservation: waitForCodexRuntimeObservation,
    };

    await expect(callRuntime(manager, { action: 'model', model: target.model, effort: target.effort })).rejects.toThrow(
      'did not reach the applied setting to return to an idle prompt',
    );
    expect(commands).toEqual(['/model']);
    expect(pickerKeys).toEqual(['1', '1', '1']);
    expect(cleanupCalls).toBe(1);
    expect(events).toEqual([]);
  });

  test('Codex picker cleanup bounds Escape, quarantines the session, and never lets a later send type into it', async () => {
    const transcript = await transcriptFixture();
    const target = { model: 'gpt-5.5', effort: 'high' };
    codexRuntimeModelCatalog.get = async () => [
      {
        value: target.model,
        label: 'GPT-5.5',
        reasoningEfforts: [{ value: target.effort }],
        defaultReasoningEffort: target.effort,
      },
    ];
    const { manager, view, commands, events } = runtimeManager({
      harness: 'codex',
      binary: '/bin/true',
      cwd: transcript.directory,
      transcriptFile: transcript.file,
    });
    let clock = 0;
    let captures = 0;
    let escapes = 0;
    const quarantines: Array<{ patch: Partial<SessionState>; type: string; data: Record<string, unknown> }> = [];
    const stopped: string[] = [];
    manager.transition = async (
      _id: string,
      patch: Partial<SessionState>,
      type: string,
      data: Record<string, unknown>,
    ) => {
      quarantines.push({ patch, type, data });
      view.state = { ...view.state, ...patch };
    };
    manager.stopManagedSession = async (_config: SessionConfig, reason: string) => {
      stopped.push(reason);
    };
    manager.codexRuntimeControl = {
      driveModelPicker: async (transport: CodexPickerTransport) => {
        expect(await transport.openPicker()).toBe('handled-local');
        throw new Error('picker stage failed');
      },
      sendPickerKey: async () => undefined,
      dismissPicker: async () =>
        await dismissCodexPicker(
          {
            resolvePane: async () => '%42',
            capturePane: async paneId => {
              expect(paneId).toBe('%42');
              captures++;
              return { visiblePane: 'Select Model\n› 1. gpt-5.5', promptReady: false };
            },
            sendEscape: async paneId => {
              expect(paneId).toBe('%42');
              escapes++;
            },
          },
          {
            timeoutMs: 4,
            pollMs: 2,
            clock: () => clock,
            sleep: async milliseconds => {
              clock += milliseconds;
            },
          },
        ),
      waitForThreadSettingsApplied: waitForCodexThreadSettingsApplied,
      waitForRuntimeObservation: waitForCodexRuntimeObservation,
    };

    await expect(callRuntime(manager, { action: 'model', model: target.model, effort: target.effort })).rejects.toThrow(
      /picker stage failed; picker cleanup failed: Codex picker cleanup did not close Select Model within 1s; session was stopped for safety/,
    );
    expect(captures).toBe(3);
    expect(escapes).toBe(2);
    expect(commands).toEqual(['/model']);
    expect(events).toEqual([]);
    expect(view.state.status).toBe('failed');
    expect(stopped).toEqual([
      'Codex picker cleanup could not confirm the exact pane returned to an idle prompt; the session was quarantined to prevent input into an unknown modal',
    ]);
    expect(quarantines).toEqual([
      {
        patch: expect.objectContaining({
          status: 'failed',
          promptReady: false,
          needsHumanKind: 'codex_picker_cleanup',
        }),
        type: 'session.codex_picker_quarantined',
        data: expect.objectContaining({ driveError: 'picker stage failed' }),
      },
    ]);

    manager.launchingRecently = () => false;
    await expect(
      (manager as unknown as SessionManager).send('s1', { message: '1 must not be typed into a picker' }),
    ).rejects.toThrow('input is blocked because Codex picker cleanup was not confirmed');
    expect(commands).toEqual(['/model']);
    await expect(callRuntime(manager, { action: 'model', model: target.model, effort: target.effort })).rejects.toThrow(
      'input is blocked because Codex picker cleanup was not confirmed',
    );

    let unknownEscapes = 0;
    await expect(
      dismissCodexPicker({
        resolvePane: async () => '%42',
        capturePane: async () => ({ visiblePane: 'unrecognized native modal', promptReady: false }),
        sendEscape: async () => {
          unknownEscapes++;
        },
      }),
    ).rejects.toThrow('could not verify that the exact pane returned to an idle prompt');
    expect(unknownEscapes).toBe(0);
  });

  test('Codex picker quarantine survives refused recovery paths and blocks all later pane input', async () => {
    const transcript = await transcriptFixture();
    const target = { model: 'gpt-5.5', effort: 'high' };
    codexRuntimeModelCatalog.get = async () => [
      {
        value: target.model,
        label: 'GPT-5.5',
        reasoningEfforts: [{ value: target.effort }],
        defaultReasoningEffort: target.effort,
      },
    ];
    const { manager, view, commands, events } = runtimeManager({
      harness: 'codex',
      binary: '/bin/true',
      cwd: transcript.directory,
      transcriptFile: transcript.file,
    });
    view.directory = transcript.directory;
    const pickerKeys: string[] = [];
    const stopReasons: string[] = [];
    const clearStates: SessionState[] = [];
    manager.store = {
      updateState: async (_id: string, mutate: (current: SessionState) => SessionState) => {
        const next = mutate(view.state);
        clearStates.push(next);
        view.state = next;
        return next;
      },
    };
    manager.transition = async (_id: string, patch: Partial<SessionState>) => {
      view.state = { ...view.state, ...patch };
    };
    manager.stopManagedSession = async (_config: SessionConfig, reason: string) => {
      stopReasons.push(reason);
      view.state = { ...view.state, status: 'kill_failed', promptReady: false };
      throw new Error('tmux stop failed');
    };
    manager.codexRuntimeControl = {
      driveModelPicker: async (transport: CodexPickerTransport) => {
        expect(await transport.openPicker()).toBe('handled-local');
        throw new Error('picker stage failed');
      },
      sendPickerKey: async (_session: string, key: string) => {
        pickerKeys.push(key);
      },
      dismissPicker: async () => {
        throw new Error('could not verify the picker closed');
      },
      waitForThreadSettingsApplied: waitForCodexThreadSettingsApplied,
      waitForRuntimeObservation: waitForCodexRuntimeObservation,
    };

    await expect(callRuntime(manager, { action: 'model', model: target.model, effort: target.effort })).rejects.toThrow(
      /session remains quarantined because its tmux pane could not be stopped: tmux stop failed/,
    );
    expect(view.state.status).toBe('kill_failed');
    expect(view.state.needsHumanKind).toBe('codex_picker_cleanup');

    manager.launching = new Map();
    manager.launchingRecently = () => false;
    manager.cancelRetry = () => undefined;
    manager.cancelQuotaWaiter = async () => undefined;
    await expect((manager as unknown as SessionManager).resume('s1')).rejects.toThrow(
      'the previous tmux kill failed; use stop again before resume',
    );
    expect(view.state.needsHumanKind).toBe('codex_picker_cleanup');

    await expect((manager as unknown as SessionManager).answer('s1', 'stale-question', ['1'])).rejects.toThrow(
      'input is blocked because Codex picker cleanup was not confirmed',
    );
    expect(view.state.needsHumanKind).toBe('codex_picker_cleanup');

    await expect((manager as unknown as SessionManager).stop('s1')).rejects.toThrow('tmux stop failed');
    expect(view.state.needsHumanKind).toBe('codex_picker_cleanup');
    expect(clearStates).toEqual([expect.objectContaining({ needsHumanKind: 'codex_picker_cleanup' })]);

    await expect(
      (manager as unknown as SessionManager).send('s1', { message: '7 must not become a picker shortcut' }),
    ).rejects.toThrow('previous tmux shutdown was not confirmed');
    await expect(callRuntime(manager, { action: 'model', model: target.model, effort: target.effort })).rejects.toThrow(
      'previous tmux shutdown was not confirmed',
    );
    expect(commands).toEqual(['/model']);
    expect(pickerKeys).toEqual([]);
    expect(events).toEqual([]);
    expect(stopReasons).toHaveLength(2);

    manager.stopManagedSession = async (_config: SessionConfig, reason: string) => {
      stopReasons.push(reason);
    };
    await expect((manager as unknown as SessionManager).stop('s1')).resolves.toBe(view);
    expect(view.state.status).toBe('stopped');
    expect(view.state.needsHumanKind).toBeUndefined();
    expect(clearStates.at(-1)).toEqual(expect.objectContaining({ needsHuman: undefined, needsHumanKind: undefined }));
  });

  test('Codex does not emit runtime success after raw confirmation without a fresh persisted observation', async () => {
    const transcript = await transcriptFixture();
    const target = { model: 'gpt-5.5', effort: 'high' };
    codexRuntimeModelCatalog.get = async () => [
      {
        value: target.model,
        label: 'GPT-5.5',
        reasoningEfforts: [{ value: target.effort }],
        defaultReasoningEffort: target.effort,
      },
    ];
    const { manager, view, commands, events } = runtimeManager({
      harness: 'codex',
      binary: '/bin/true',
      cwd: transcript.directory,
      transcriptFile: transcript.file,
    });
    view.state = {
      ...view.state,
      observedModel: target.model,
      observedReasoningEffort: target.effort,
      observedModelAt: 'before',
      transcriptOffset: transcript.prefix.length,
    };
    const phases: string[] = [];
    manager.codexRuntimeControl = {
      driveModelPicker: async (transport: CodexPickerTransport) => {
        expect(await transport.openPicker()).toBe('handled-local');
        await writeFile(transcript.file, `${transcript.prefix}${rawSettingsApplied(target)}\n`);
      },
      sendPickerKey: async () => undefined,
      dismissPicker: async () => undefined,
      waitForThreadSettingsApplied: async (...args: Parameters<typeof waitForCodexThreadSettingsApplied>) => {
        const applied = await waitForCodexThreadSettingsApplied(...args);
        phases.push('raw-confirmed');
        return applied;
      },
      waitForRuntimeObservation: async () => {
        phases.push('persisted-observation-wait');
        throw new Error('persisted runtime observation did not refresh');
      },
    };

    await expect(callRuntime(manager, { action: 'model', model: target.model, effort: target.effort })).rejects.toThrow(
      'persisted runtime observation did not refresh',
    );
    expect(phases).toEqual(['raw-confirmed', 'persisted-observation-wait']);
    expect(commands).toEqual(['/model']);
    expect(events).toEqual([]);
  });

  test('Codex drives an exact advertised target and emits only after fresh raw and persisted confirmation', async () => {
    const transcript = await transcriptFixture();
    const target = { model: 'gpt-5.5', effort: 'high' };
    codexRuntimeModelCatalog.get = async () => [
      {
        value: target.model,
        label: 'GPT-5.5',
        reasoningEfforts: [{ value: target.effort }],
        defaultReasoningEffort: target.effort,
      },
    ];
    const { manager, view, commands, events } = runtimeManager({
      harness: 'codex',
      binary: '/bin/true',
      cwd: transcript.directory,
      transcriptFile: transcript.file,
    });
    view.state = {
      ...view.state,
      observedModel: target.model,
      observedReasoningEffort: target.effort,
      observedModelAt: 'before',
      transcriptOffset: transcript.prefix.length,
    };
    const phases: string[] = [];
    const pickerKeys: string[] = [];
    manager.codexRuntimeControl = {
      driveModelPicker: async (transport: CodexPickerTransport, requested: CodexPickerTarget) => {
        phases.push('picker');
        expect(requested).toEqual(target);
        expect(await transport.openPicker()).toBe('handled-local');
        expect((await transport.readPane()).alive).toBe(true);
        await transport.sendKey('1', {
          kind: 'all-models',
          title: 'Select Model and Effort',
          row: { number: 1, name: target.model },
        });
        const applied = rawSettingsApplied(requested);
        await writeFile(transcript.file, `${transcript.prefix}${applied}\n`);
        view.state = {
          ...view.state,
          observedModel: requested.model,
          observedReasoningEffort: requested.effort,
          observedModelAt: 'after',
          transcriptOffset: (await stat(transcript.file)).size,
        };
      },
      sendPickerKey: async (_session: string, key: string, expected: CodexPickerKeyExpectation) => {
        pickerKeys.push(`${key}:${expected.row.name}`);
        phases.push('key');
      },
      waitForThreadSettingsApplied: async (...args: Parameters<typeof waitForCodexThreadSettingsApplied>) => {
        const applied = await waitForCodexThreadSettingsApplied(...args);
        phases.push('raw-confirmed');
        return applied;
      },
      waitForRuntimeObservation: async (...args: Parameters<typeof waitForCodexRuntimeObservation>) => {
        const observed = await waitForCodexRuntimeObservation(...args);
        phases.push('state-confirmed');
        return observed;
      },
    };
    manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
      phases.push('event');
      events.push({ type, data });
      return {};
    };

    const result = await callRuntime(manager, { action: 'model', model: target.model, effort: target.effort });

    expect(result).toBe(view);
    expect(commands).toEqual(['/model']);
    expect(pickerKeys).toEqual(['1:gpt-5.5']);
    expect(phases).toEqual(['picker', 'key', 'raw-confirmed', 'state-confirmed', 'event']);
    expect(events).toEqual([
      {
        type: 'control.runtime_model',
        data: { harness: 'codex', requestedModel: target.model, requestedEffort: target.effort, verified: true },
      },
    ]);
  });

  test('Codex rejects incomplete or unadvertised targeted choices before picker input', async () => {
    const target = { model: 'gpt-5.5', effort: 'high' };
    codexRuntimeModelCatalog.get = async () => [
      {
        value: target.model,
        label: 'GPT-5.5',
        reasoningEfforts: [{ value: target.effort }],
        defaultReasoningEffort: target.effort,
      },
    ];
    const { manager, commands } = runtimeManager({ harness: 'codex', binary: '/bin/true' });

    await expect(callRuntime(manager, { action: 'model', model: target.model })).rejects.toThrow(
      'requires both model and effort',
    );
    await expect(
      callRuntime(manager, { action: 'model', model: 'gpt-5.6-sol', effort: target.effort }),
    ).rejects.toThrow('not in this Codex account');
    await expect(callRuntime(manager, { action: 'model', model: target.model, effort: 'low' })).rejects.toThrow(
      'not advertised for Codex model',
    );
    expect(commands).toEqual([]);
  });

  test('Codex does not claim runtime success after a conflicting raw confirmation', async () => {
    const transcript = await transcriptFixture();
    const target = { model: 'gpt-5.5', effort: 'high' };
    codexRuntimeModelCatalog.get = async () => [
      {
        value: target.model,
        label: 'GPT-5.5',
        reasoningEfforts: [{ value: target.effort }],
        defaultReasoningEffort: target.effort,
      },
    ];
    const { manager, commands, events } = runtimeManager({
      harness: 'codex',
      binary: '/bin/true',
      cwd: transcript.directory,
      transcriptFile: transcript.file,
    });
    manager.codexRuntimeControl = {
      driveModelPicker: async (transport: CodexPickerTransport) => {
        expect(await transport.openPicker()).toBe('handled-local');
        await writeFile(
          transcript.file,
          `${transcript.prefix}${rawSettingsApplied({ model: 'gpt-5.2', effort: 'medium' })}\n`,
        );
      },
      sendPickerKey: async () => undefined,
      waitForThreadSettingsApplied: waitForCodexThreadSettingsApplied,
      waitForRuntimeObservation: waitForCodexRuntimeObservation,
    };

    await expect(callRuntime(manager, { action: 'model', model: target.model, effort: target.effort })).rejects.toThrow(
      'reported gpt-5.2 · medium instead of gpt-5.5 · high',
    );
    expect(commands).toEqual(['/model']);
    expect(events).toEqual([]);
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

  test('/compact refuses a busy pane before typing anything', async () => {
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

  test('an ambiguous native type-in error stays ACCEPTED and a same-id retry never types twice', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-fail-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
    const { manager } = sendManager({ status: 'running', paneAlive: true, promptReady: false });
    manager.paths = createPaths(home);
    let state: Record<string, unknown> = { id: 's1', status: 'running', turn: 3, promptReady: false };
    let typeAttempts = 0;
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
        typeAttempts++;
        throw new Error('text did not land in the busy composer');
      },
    };
    manager.emit = async () => ({});
    manager.monitors = new Map();
    manager.launching = new Map<string, number>();
    await expect(
      (
        manager as unknown as {
          send: (id: string, request: { message: string; requestId: string }) => Promise<unknown>;
        }
      ).send('s1', { message: 'doomed', requestId: 'ambiguous-native' }),
    ).rejects.toThrow(/did not land/);
    expect((state.pendingNativeSends as unknown[]) ?? []).toHaveLength(1);
    const retry = await (
      manager as unknown as {
        send: (id: string, request: { message: string; requestId: string }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: 'doomed', requestId: 'ambiguous-native' });
    expect(retry.disposition).toBe('queued');
    expect(typeAttempts).toBe(1);
    const rows = (
      await (manager as unknown as { sendLedger: (id: string) => Promise<{ all: () => unknown[] }> }).sendLedger('s1')
    ).all() as Array<{ sendId: string; fate: string }>;
    expect(rows).toEqual([expect.objectContaining({ sendId: 'ambiguous-native', fate: 'accepted' })]);
  });

  test('a proven pre-submit persistence failure tombstones, then the same id resurrects for one safe retry', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-pre-submit-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
    const { manager } = sendManager({ status: 'running', paneAlive: true, promptReady: false });
    manager.paths = createPaths(home);
    let state: Record<string, unknown> = { id: 's1', status: 'running', turn: 3, promptReady: false };
    let failPersistence = true;
    let typed = 0;
    manager.get = async () => ({
      directory: path.join(home, 's1'),
      config: { id: 's1', tmuxSession: 'kteam-s1-agent', turn: 3 },
      state,
    });
    manager.store = {
      updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        if (failPersistence) throw new Error('state disk unavailable before submit');
        state = mutate(state);
        return state;
      },
    };
    manager.tmux = {
      state: async () => ({ alive: true, dead: false, promptReady: false, visiblePane: '• Working (10s' }),
      typeIntoQueue: async () => {
        typed++;
      },
    };
    const send = () =>
      (
        manager as unknown as {
          send: (id: string, request: { message: string; requestId: string }) => Promise<{ disposition: string }>;
        }
      ).send('s1', { message: 'retry safely', requestId: 'retryable-pre-submit' });
    await expect(send()).rejects.toThrow(/disk unavailable/);
    expect(typed).toBe(0);
    const ledger = await (
      manager as unknown as {
        sendLedger: (id: string) => Promise<{
          all: (options?: { includeWithdrawn?: boolean }) => Array<{ sendId: string; withdrawn?: boolean }>;
        }>;
      }
    ).sendLedger('s1');
    expect(ledger.all()).toEqual([]);
    expect(ledger.all({ includeWithdrawn: true })).toEqual([
      expect.objectContaining({ sendId: 'retryable-pre-submit', withdrawn: true }),
    ]);

    failPersistence = false;
    expect((await send()).disposition).toBe('queued');
    expect(typed).toBe(1);
    expect(ledger.all()).toEqual([expect.objectContaining({ sendId: 'retryable-pre-submit', withdrawn: undefined })]);
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

  test('an ambiguous idle injection error leaves ACCEPTED visible and does not bump the turn', async () => {
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
        sends++;
        throw new Error('the prompt never started');
      },
    };
    let sends = 0;
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
          deliverToIdlePrompt: (
            id: string,
            view: SessionView,
            request: { message: string; requestId: string },
          ) => Promise<unknown>;
        }
      ).deliverToIdlePrompt(
        's1',
        {
          directory: path.join(home, 's1'),
          config,
          state: { id: 's1', status: 'running', turn: 3 },
        } as unknown as SessionView,
        { message: 'must be atomic', requestId: 'idle-uncertain' },
      ),
    ).rejects.toThrow(/never started/);
    expect(config.turn).toBe(3);
    expect(await readFile(path.join(home, 's1', 'channel', 'inbox.jsonl'), 'utf8')).toBe('');
    const rows = (
      await (manager as unknown as { sendLedger: (id: string) => Promise<{ all: () => unknown[] }> }).sendLedger('s1')
    ).all() as Array<{ sendId: string; fate: string }>;
    expect(rows).toEqual([expect.objectContaining({ sendId: 'idle-uncertain', fate: 'accepted' })]);
    await (
      manager as unknown as {
        deliverToIdlePrompt: (
          id: string,
          view: SessionView,
          request: { message: string; requestId: string },
        ) => Promise<unknown>;
      }
    ).deliverToIdlePrompt(
      's1',
      {
        directory: path.join(home, 's1'),
        config,
        state: { id: 's1', status: 'running', turn: 3 },
      } as unknown as SessionView,
      { message: 'must be atomic', requestId: 'idle-uncertain' },
    );
    expect(sends).toBe(1);
  });

  test('a post-submit composer rejection never auto-falls back or retypes', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-fallback-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
    const typed: string[] = [];
    let state: Record<string, unknown> = { id: 's1', status: 'running', turn: 3, promptReady: false };
    const { manager } = sendManager({ status: 'running', paneAlive: true, promptReady: false });
    manager.paths = createPaths(home);
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
        throw new Error('the message left the composer without queue evidence');
      },
    };
    manager.emit = async () => ({});
    manager.monitors = new Map();
    manager.launching = new Map();
    await expect(
      (
        manager as unknown as {
          send: (id: string, request: { message: string; requestId: string }) => Promise<unknown>;
        }
      ).send('s1', { message: 'fallback payload', requestId: 'post-submit' }),
    ).rejects.toThrow(/will not be retried automatically/);
    expect(typed).toEqual(['fallback payload']);
    const pending = state.pendingNativeSends as Array<{ message: string; queueText?: string; payloadFile?: string }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.message).toBe('fallback payload');
    expect(pending[0]!.queueText).toBeUndefined();
    expect(pending[0]!.payloadFile).toBeUndefined();
  });

  test('a multi-kilobyte busy send uses a short file instruction and rejects traversal-shaped request ids', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-long-fallback-'));
    temporaryDirectories.push(home);
    await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
    const long = `LONG SPEC\n${'x'.repeat(4_300)}`;
    const typed: string[] = [];
    let state: Record<string, unknown> = { id: 's1', status: 'running', turn: 3, promptReady: false };
    const { manager } = sendManager({ status: 'running', paneAlive: true, promptReady: false });
    manager.paths = createPaths(home);
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
        send: (id: string, request: { message: string; requestId: string }) => Promise<{ disposition: string }>;
      }
    ).send('s1', { message: long, requestId: '../../etc/passwd' });
    expect(queued.disposition).toBe('queued');
    expect(typed).toHaveLength(1);
    expect(typed[0]!.length).toBeLessThan(1_000);
    expect(typed[0]).toContain('Read the queued message file');
    expect(typed[0]).not.toContain('x'.repeat(500));
    const pending = state.pendingNativeSends as Array<{ message: string; queueText?: string; payloadFile?: string }>;
    expect(pending[0]!.message).toBe(long);
    expect(pending[0]!.queueText).toBe(typed[0]);
    expect(await readFile(pending[0]!.payloadFile!, 'utf8')).toBe(`${long}\n`);
    expect(path.dirname(pending[0]!.payloadFile!)).toBe(path.join(home, 's1', 'channel'));
    expect(path.basename(pending[0]!.payloadFile!)).toMatch(/^queued-[0-9a-f-]{36}\.md$/);
    const ledger = await (
      manager as unknown as { sendLedger: (id: string) => Promise<{ all: () => Array<{ sendId: string }> }> }
    ).sendLedger('s1');
    expect(ledger.all()[0]!.sendId).not.toBe('../../etc/passwd');
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
    const cgroupConfig = {
      enabled: false,
      fleet: { cpuPercent: 90, memoryPercent: 90 },
      perAgent: { cpuPercent: 25, memoryPercent: 25 },
    };
    manager.cgroups = {
      config: cgroupConfig,
      daemonOutsideFleet: async () => true,
      apply: async () => {
        ran.push('cgroups');
        return {
          config: cgroupConfig,
          restartRequiredSessions: [],
        };
      },
    };
    manager.liveCgroupTargets = async () => [];
    manager.startWarden = async () => {
      ran.push('warden');
    };
    manager.sweepScratch = async () => {
      ran.push('scratch-gc');
    };
    await (manager as unknown as { bootstrap: () => Promise<void> }).bootstrap();
    // warden ALWAYS armed, and scratch gc runs after it
    expect(ran).toEqual(['import', 'recover', 'cgroups', 'warden', 'scratch-gc']);
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
        anomalyKind: 'abandoned_wreckage',
        verdict: 'needs_human',
        explicitNeedsHuman: true,
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
    expect(state.needsHumanReportPath).toBe('/r.md');
    expect(transient).toEqual(['fleet.needs_human']);
    // Second reconcile with the flag already set: no re-flag, no re-emit.
    await (manager as unknown as { reconcileNeedsHuman: (sessions: unknown[]) => Promise<void> }).reconcileNeedsHuman([
      { config: { id: 's1', teammate: 'lacey' }, state, directory: '/x/s1' },
    ]);
    expect(transient).toHaveLength(1);
  });

  test('clearNeedsHuman resets the flag and retained reports cannot recreate it', async () => {
    let writes = 0;
    let state: Record<string, unknown> = {
      id: 's1',
      needsHuman: 'why',
      needsHumanKind: 'abandoned_wreckage',
      needsHumanReportPath: '/r.md',
      needsHumanRequests: [
        {
          reason: 'why',
          anomalyKind: 'abandoned_wreckage',
          reportPath: '/r.md',
          at: '2026-07-28T12:34:56.789Z',
        },
      ],
    };
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
    expect(state.needsHumanReportPath).toBeUndefined();
    expect(state.needsHumanRequests).toBeUndefined();
    expect(state.needsHumanAcknowledgedRequests).toEqual([{ reportPath: '/r.md', anomalyKind: 'abandoned_wreckage' }]);
    expect(writes).toBe(1);

    manager.wardenVerdicts = async () => [
      {
        at: '2026-07-28T12:34:56.789Z',
        targetSession: 's1',
        anomalyKind: 'abandoned_wreckage',
        verdict: 'needs_human',
        reason: 'old retained report',
        reportPath: '/r.md',
      },
    ];
    manager.listeners = new Set();
    manager.transientSequence = 0;
    const sessions = [{ config: { id: 's1', teammate: 'lacey' }, state, directory: '/x/s1' }];
    await (manager as unknown as { reconcileNeedsHuman: (views: unknown[]) => Promise<void> }).reconcileNeedsHuman(
      sessions,
    );
    expect(state.needsHuman).toBeUndefined();
    expect(state.needsHumanRequests).toBeUndefined();
    expect(writes).toBe(1);

    manager.wardenVerdicts = async () => [
      {
        at: '2026-07-28T12:00:00.000Z',
        targetSession: 's1',
        anomalyKind: 'abandoned_wreckage',
        verdict: 'needs_human',
        explicitNeedsHuman: true,
        reason: 'a later-written report with an older sweep title',
        reportPath: '/new-report.md',
      },
    ];
    await (manager as unknown as { reconcileNeedsHuman: (views: unknown[]) => Promise<void> }).reconcileNeedsHuman(
      sessions,
    );
    expect(state.needsHuman).toBe('a later-written report with an older sweep title');
    expect(state.needsHumanReportPath).toBe('/new-report.md');
    expect(writes).toBe(2);
  });

  test('heuristic needs-human prose stays quiet without an explicit verdict marker', async () => {
    const transient: string[] = [];
    let state: Record<string, unknown> = { id: 's1', status: 'running', turn: 9 };
    const manager = bareManager();
    manager.wardenVerdicts = async () => [
      {
        at: 'now',
        targetSession: 's1',
        anomalyKind: 'sus_thinking',
        verdict: 'needs_human',
        reason: 'legacy prose says a human may be needed',
        reportPath: '/heuristic.md',
      },
    ];
    manager.store = {
      updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.emitTransient = (type: string) => transient.push(type);
    await (manager as unknown as { reconcileNeedsHuman: (sessions: unknown[]) => Promise<void> }).reconcileNeedsHuman([
      { config: { id: 's1' }, state, directory: '/x/s1' },
    ]);
    expect(state.needsHuman).toBeUndefined();
    expect(transient).toEqual([]);
  });
});

describe('durable send evidence reconciliation (B4)', () => {
  async function evidenceHarness(
    records: SendRecord[],
    options: {
      status?: string;
      pending?: Array<Record<string, unknown>>;
      turn?: number;
      finishedAt?: string;
    } = {},
  ) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-evidence-'));
    temporaryDirectories.push(home);
    await Promise.all(
      ['channel', 'markers', 'turns'].map(directory => mkdir(path.join(home, 's1', directory), { recursive: true })),
    );
    const turn = options.turn ?? 3;
    const config: Record<string, unknown> = {
      id: 's1',
      harness: 'claude',
      tmuxSession: 'kteam-s1-agent',
      turn,
    };
    let state: Record<string, unknown> = {
      id: 's1',
      status: options.status ?? 'running',
      health: 'healthy',
      turn,
      ...(options.finishedAt ? { finishedAt: options.finishedAt } : {}),
      pendingNativeSends:
        options.pending ??
        records.map(record => ({
          id: record.sendId,
          at: record.acceptedAt,
          message: record.message,
          ...(record.matchText && record.matchText !== record.message ? { queueText: record.matchText } : {}),
          ...(record.payloadFile ? { payloadFile: record.payloadFile } : {}),
          attachmentIds: record.attachmentIds,
        })),
    };
    const events: Array<{ type: string; data: Record<string, unknown>; turn?: number }> = [];
    const manager = bareManager();
    manager.paths = createPaths(home);
    manager.reconciledSendLedgers = new Set(['s1']);
    manager.get = async () => ({ directory: path.join(home, 's1'), config, state });
    manager.store = {
      updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.indexChatRecords = () => undefined;
    manager.broadcastChat = () => undefined;
    manager.emit = async (
      _id: string,
      type: string,
      data: Record<string, unknown>,
      _source: string,
      eventTurn?: number,
    ) => {
      events.push({ type, data, turn: eventTurn });
      return {};
    };
    const ledger = await (
      manager as unknown as {
        sendLedger: (id: string) => Promise<{ accept: (record: SendRecord) => Promise<unknown> }>;
      }
    ).sendLedger('s1');
    for (const record of records) await ledger.accept(record);
    return {
      manager,
      home,
      events,
      config: () => config,
      state: () => state,
      ledger: ledger as unknown as {
        get: (id: string) => SendRecord | undefined;
        all: (options?: { includeWithdrawn?: boolean }) => SendRecord[];
        persist: (record: SendRecord) => Promise<SendRecord>;
      },
    };
  }

  function accepted(id: string, text: string, index = 0, overrides: Partial<SendRecord> = {}): SendRecord {
    return newAcceptedSend({
      sendId: id,
      acceptedAt: new Date(Date.parse('2026-07-27T02:00:32.000Z') + index * 1_000).toISOString(),
      acceptedTurn: 3,
      path: 'native-inline',
      message: text,
      matchText: text,
      attachmentIds: [],
      ...overrides,
    });
  }

  function proof(id: string, text: string, index = 0, harness: 'claude' | 'codex' = 'claude'): ObservedHumanInput {
    return {
      harness,
      text,
      proof: harness === 'claude' ? 'native-queue-drain' : 'normal-user-record',
      observedAt: new Date(Date.parse('2026-07-27T02:00:40.000Z') + index * 1_000).toISOString(),
      proofKey: `proof-${id}`,
      shapeVersion: 1,
    };
  }

  async function legacyMigrationHarness(withHistoricalProof: boolean) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-send-legacy-'));
    temporaryDirectories.push(home);
    await Promise.all(
      ['channel', 'markers', 'turns'].map(directory => mkdir(path.join(home, 's1', directory), { recursive: true })),
    );
    const acceptedAt = ['2026-07-27T02:00:32.000Z', '2026-07-27T02:00:33.000Z', '2026-07-27T02:00:34.000Z'];
    const attachmentBlock = '[Image attachment image-1]';
    const payloadFile = path.join(home, 's1', 'channel', 'queued-legacy-file.md');
    const fileInstruction = `Read the queued message file at ${payloadFile} completely now, then follow every instruction inside it.`;
    const inboxRows = [
      {
        at: acceptedAt[0],
        type: 'message',
        queued: true,
        queueId: 'legacy-attachment',
        message: 'inspect the attachment',
        attachmentIds: ['image-1'],
        from: 'peer-session',
        fromName: 'peer-name',
        replyExpected: true,
      },
      {
        at: acceptedAt[1],
        type: 'message',
        queued: true,
        queueId: 'legacy-file',
        message: 'the full file-backed payload',
        attachmentIds: [],
      },
      {
        at: acceptedAt[2],
        type: 'message',
        queued: true,
        queueId: 'legacy-inline',
        message: 'ordinary inline payload',
        attachmentIds: [],
      },
    ];
    await writeFile(
      path.join(home, 's1', 'channel', 'inbox.jsonl'),
      `${inboxRows.map(row => JSON.stringify(row)).join('\n')}\n`,
    );
    await writeFile(payloadFile, 'the full file-backed payload\n', { mode: 0o600 });

    const config: Record<string, unknown> = {
      id: 's1',
      harness: 'claude',
      tmuxSession: 'kteam-s1-agent',
      turn: 3,
    };
    let state: Record<string, unknown> = {
      id: 's1',
      status: 'stalled',
      health: 'stalled',
      turn: 3,
      finishedAt: '2026-07-27T02:10:00.000Z',
      // Evan's real legacy specimen had already lost its mechanics rows. The
      // durable migration source here is therefore inbox.jsonl alone.
      pendingNativeSends: [],
    };
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    let historicalReads = 0;
    const manager = bareManager();
    manager.paths = createPaths(home);
    manager.reconciledSendLedgers = new Set<string>();
    manager.attachments = {
      buildImageReferenceBlock: async (_id: string, attachmentIds: string[]) => {
        expect(attachmentIds).toEqual(['image-1']);
        return attachmentBlock;
      },
    };
    manager.get = async () => ({ directory: path.join(home, 's1'), config, state });
    manager.store = {
      updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
    };
    manager.indexChatRecords = () => undefined;
    manager.broadcastChat = () => undefined;
    manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
      events.push({ type, data });
      return {};
    };
    manager.historicalObservedInputs = async () => {
      historicalReads++;
      if (!withHistoricalProof) return [];
      return [
        proof('legacy-attachment', `inspect the attachment\n\n${attachmentBlock}`),
        proof('legacy-file', fileInstruction, 1),
        proof('legacy-inline', 'ordinary inline payload', 2),
      ];
    };

    await (
      manager as unknown as { ensureSendLedgerReconciledUnlocked: (view: SessionView) => Promise<void> }
    ).ensureSendLedgerReconciledUnlocked(await (manager.get as () => Promise<SessionView>)());
    const ledger = await (
      manager as unknown as {
        sendLedger: (id: string) => Promise<{
          get: (id: string) => SendRecord | undefined;
          all: (options?: { includeWithdrawn?: boolean }) => SendRecord[];
        }>;
      }
    ).sendLedger('s1');
    return {
      acceptedAt,
      attachmentBlock,
      events,
      fileInstruction,
      historicalReads: () => historicalReads,
      ledger,
      payloadFile,
      state: () => state,
    };
  }

  test('generic chat.user remains render-only and cannot settle fate', async () => {
    const harness = await evidenceHarness([accepted('q1', 'quoted text')]);
    await (
      harness.manager as unknown as {
        handleClaudeEvents: (id: string, events: unknown[], cursor: unknown) => Promise<void>;
      }
    ).handleClaudeEvents('s1', [{ type: 'chat.user', data: { text: 'quoted text' } }], {
      file: '/tmp/transcript.jsonl',
      startOffset: 0,
      endOffset: 10,
    });
    expect(harness.ledger.get('q1')?.fate).toBe('accepted');
    expect(harness.events.filter(event => event.type.startsWith('control.send_'))).toEqual([]);
  });

  test('an Evan-style three-item drain settles all rows without advancing turns or clearing markers', async () => {
    const records = [accepted('q1', 'first'), accepted('q2', 'second', 1), accepted('q3', 'third', 2)];
    const harness = await evidenceHarness(records);
    const doneFile = path.join(harness.home, 's1', 'markers', 'done.json');
    const helpFile = path.join(harness.home, 's1', 'markers', 'needs-help.json');
    await writeFile(doneFile, '{"type":"done","turn":3}\n');
    await writeFile(helpFile, '{"type":"question"}\n');
    const inputs = [proof('q1', 'first'), proof('q2', 'second', 1), proof('q3', 'third', 2)];

    await (
      harness.manager as unknown as {
        handleObservedInputs: (id: string, inputs: ObservedHumanInput[]) => Promise<void>;
      }
    ).handleObservedInputs('s1', inputs);
    expect(harness.ledger.all().map(record => record.fate)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(harness.config().turn).toBe(3);
    expect(harness.state().turn).toBe(3);
    expect(harness.state().pendingNativeSends).toHaveLength(0);
    expect(harness.state().sendEvidenceKeys).toHaveLength(3);
    expect(await readFile(doneFile, 'utf8')).toContain('"turn":3');
    expect(await readFile(helpFile, 'utf8')).toContain('question');
    expect(await readFile(path.join(harness.home, 's1', 'turns', 'turn-004.md'), 'utf8').catch(() => 'absent')).toBe(
      'absent',
    );
    expect(harness.events.filter(event => event.type === 'control.send_delivered')).toHaveLength(3);
    expect(harness.events.filter(event => event.type === 'control.send_consumed')).toHaveLength(3);

    const eventCount = harness.events.length;
    await (
      harness.manager as unknown as {
        handleObservedInputs: (id: string, inputs: ObservedHumanInput[]) => Promise<void>;
      }
    ).handleObservedInputs('s1', inputs);
    expect(harness.events).toHaveLength(eventCount);
    expect(harness.config().turn).toBe(3);
  });

  test('legacy Evan migration backfills three inbox-only rows and reconciles historical proof', async () => {
    const harness = await legacyMigrationHarness(true);
    expect(harness.historicalReads()).toBe(1);
    expect(harness.ledger.all().map(record => record.fate)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(harness.ledger.get('legacy-attachment')).toMatchObject({
      path: 'native-inline',
      message: 'inspect the attachment',
      matchText: `inspect the attachment\n\n${harness.attachmentBlock}`,
      attachmentIds: ['image-1'],
      from: 'peer-session',
      fromName: 'peer-name',
      replyExpected: true,
      fate: 'delivered',
    });
    expect(harness.ledger.get('legacy-file')).toMatchObject({
      path: 'native-file',
      message: 'the full file-backed payload',
      matchText: harness.fileInstruction,
      payloadFile: harness.payloadFile,
      fate: 'delivered',
    });
    expect(harness.ledger.get('legacy-inline')).toMatchObject({
      path: 'native-inline',
      message: 'ordinary inline payload',
      matchText: 'ordinary inline payload',
      fate: 'delivered',
    });
    expect(harness.state().pendingNativeSends).toEqual([]);
    expect(harness.state().sendEvidenceKeys).toHaveLength(3);
    expect(harness.events.filter(event => event.type === 'control.send_accepted')).toHaveLength(3);
    expect(harness.events.filter(event => event.type === 'control.send_delivered')).toHaveLength(3);
    expect(harness.events.filter(event => event.type === 'control.send_unaccounted')).toHaveLength(0);
  });

  test('legacy terminal migration without historical proof keeps all three rows visible as unaccounted', async () => {
    const harness = await legacyMigrationHarness(false);
    expect(harness.historicalReads()).toBe(1);
    expect(harness.ledger.all()).toHaveLength(3);
    const acceptedAtById = new Map([
      ['legacy-attachment', harness.acceptedAt[0]],
      ['legacy-file', harness.acceptedAt[1]],
      ['legacy-inline', harness.acceptedAt[2]],
    ]);
    for (const record of harness.ledger.all()) {
      expect(record).toMatchObject({
        acceptedAt: acceptedAtById.get(record.sendId),
        fate: 'unaccounted',
        unaccountedReason: 'session_ended',
      });
    }
    expect(harness.state().pendingNativeSends).toEqual([]);
    expect(String(harness.state().reason)).toContain('3 send(s) unconfirmed');
    expect(harness.events.filter(event => event.type === 'control.send_unaccounted')).toHaveLength(3);
    expect(harness.events.some(event => event.type === 'control.send_lost')).toBe(false);
  });

  test('startup repair settles accepted rows newer than an old terminal finishedAt', async () => {
    const proofed = accepted('proofed-after-finish', 'historically visible', 0, {
      acceptedAt: '2026-07-27T02:00:32.000Z',
    });
    const unproven = accepted('unproven-after-finish', 'never observed', 1, {
      acceptedAt: '2026-07-27T02:00:33.000Z',
    });
    const harness = await evidenceHarness([proofed, unproven], {
      status: 'stopped',
      finishedAt: '2026-07-27T02:00:00.000Z',
    });
    harness.manager.reconciledSendLedgers = new Set<string>();
    harness.manager.historicalObservedInputs = async () => [proof('proofed-after-finish', 'historically visible')];

    await (
      harness.manager as unknown as {
        ensureSendLedgerReconciledUnlocked: (view: SessionView) => Promise<void>;
      }
    ).ensureSendLedgerReconciledUnlocked(await (harness.manager.get as () => Promise<SessionView>)());

    expect(harness.ledger.get('proofed-after-finish')).toMatchObject({ fate: 'delivered' });
    expect(harness.ledger.get('unproven-after-finish')).toMatchObject({
      fate: 'unaccounted',
      unaccountedReason: 'session_ended',
    });
    expect(harness.events.filter(event => event.type === 'control.send_delivered')).toHaveLength(1);
    expect(harness.events.filter(event => event.type === 'control.send_unaccounted')).toHaveLength(1);
  });

  test('default send projection carries a withdrawn tombstone so clients can fold away stale acceptance', async () => {
    const live = accepted('live', 'still pending');
    const withdrawn = accepted('withdrawn', 'never typed', 1);
    const harness = await evidenceHarness([live, withdrawn]);
    await harness.ledger.persist({
      ...withdrawn,
      withdrawn: true,
      fateAt: '2026-07-27T02:00:40.000Z',
    });
    harness.manager.resolveRef = (id: string) => id;
    harness.manager.serialized = async (_id: string, operation: () => Promise<unknown>) => await operation();

    const projected = await (
      harness.manager as unknown as {
        listSends: (id: string, options?: { all?: boolean }) => Promise<SendRecord[]>;
      }
    ).listSends('s1');
    expect(projected).toEqual([
      expect.objectContaining({ sendId: 'withdrawn', withdrawn: true }),
      expect.objectContaining({ sendId: 'live', fate: 'accepted' }),
    ]);
  });

  test('Codex canonical proof settles a native-file instruction by safe file id', async () => {
    const id = 'request_file_1';
    const payloadFile = `/tmp/channel/queued-${id}.md`;
    const instruction = `Read the queued message file at ${payloadFile} completely now, then follow every instruction inside it.`;
    const harness = await evidenceHarness([
      accepted(id, 'full logical payload', 0, {
        path: 'native-file',
        matchText: instruction,
        payloadFile,
      }),
    ]);
    await (
      harness.manager as unknown as {
        handleObservedInputs: (id: string, inputs: ObservedHumanInput[]) => Promise<void>;
      }
    ).handleObservedInputs('s1', [proof(id, instruction, 0, 'codex')]);
    expect(harness.ledger.get(id)).toMatchObject({
      fate: 'delivered',
      evidence: { kind: 'response_item', tier: 'queue-file-id', proof: 'normal-user-record' },
    });
    expect(harness.config().turn).toBe(3);
  });

  test('terminal UNACCOUNTED remains visible and late in-window proof promotes it', async () => {
    const record = accepted('q1', 'terminal input');
    const harness = await evidenceHarness([record], { status: 'stopped' });
    await (
      harness.manager as unknown as {
        transitionUnaccountedUnlocked: (
          id: string,
          view: SessionView,
          reason: string,
          acceptedThrough?: string,
        ) => Promise<number>;
      }
    ).transitionUnaccountedUnlocked(
      's1',
      await (harness.manager.get as () => Promise<SessionView>)(),
      'session_ended',
      '2026-07-27T02:01:00.000Z',
    );
    expect(harness.ledger.get('q1')).toMatchObject({ fate: 'unaccounted', unaccountedReason: 'session_ended' });
    expect(String(harness.state().reason)).toContain('unconfirmed');
    expect(harness.events.some(event => event.type === 'control.send_lost')).toBe(false);

    await (
      harness.manager as unknown as {
        handleObservedInputs: (id: string, inputs: ObservedHumanInput[]) => Promise<void>;
      }
    ).handleObservedInputs('s1', [proof('q1', 'terminal input')]);
    expect(harness.ledger.get('q1')?.fate).toBe('delivered');
    expect(harness.config().turn).toBe(3);
  });

  test('timeout fate removes native mechanics while late proof still promotes from the ledger', async () => {
    const record = accepted('q1', 'eventually observed');
    const harness = await evidenceHarness([record]);
    await (
      harness.manager as unknown as {
        sweepSendFatesUnlocked: (
          id: string,
          view: SessionView,
          context: { at: string; promptReady: boolean; frozen: boolean },
        ) => Promise<number>;
      }
    ).sweepSendFatesUnlocked('s1', await (harness.manager.get as () => Promise<SessionView>)(), {
      at: '2026-07-27T03:00:32.001Z',
      promptReady: true,
      frozen: false,
    });
    expect(harness.ledger.get('q1')).toMatchObject({ fate: 'unaccounted', unaccountedReason: 'timeout' });
    expect(harness.state().pendingNativeSends).toEqual([]);

    await (
      harness.manager as unknown as {
        handleObservedInputs: (id: string, inputs: ObservedHumanInput[]) => Promise<void>;
      }
    ).handleObservedInputs('s1', [proof('q1', 'eventually observed')]);
    expect(harness.ledger.get('q1')).toMatchObject({ fate: 'delivered', evidence: { key: 'proof-q1' } });
    expect(harness.state().pendingNativeSends).toEqual([]);
  });

  test('the first post-resume proof persists the freeze shift before evidence matching', async () => {
    const record = accepted('q1', 'quota-delayed input', 0, {
      acceptedAt: '2026-07-27T00:00:00.000Z',
    });
    const harness = await evidenceHarness([record]);
    await harness.ledger.persist({ ...record, timeoutFrozenAt: '2026-07-27T00:30:00.000Z' });
    await (
      harness.manager as unknown as {
        handleObservedInputs: (id: string, inputs: ObservedHumanInput[]) => Promise<void>;
      }
    ).handleObservedInputs('s1', [{ ...proof('q1', 'quota-delayed input'), observedAt: '2026-07-27T02:30:01.000Z' }]);
    expect(harness.ledger.get('q1')).toMatchObject({
      acceptedAt: '2026-07-27T00:00:00.000Z',
      unaccountedDeadline: '2026-07-27T03:00:01.000Z',
      hardDeadline: '2026-07-27T04:00:00.000Z',
      fate: 'delivered',
    });
    expect(harness.ledger.get('q1')?.timeoutFrozenAt).toBeUndefined();
  });

  test('terminal finalization awaits watcher flush before classifying the remainder', async () => {
    const harness = await evidenceHarness([accepted('q1', 'final bytes')], { status: 'stopped' });
    let flushed = 0;
    harness.manager.monitors = new Map([
      [
        's1',
        {
          abort: new AbortController(),
          transcript: {
            snapshot: () => ({ running: true }),
            flush: async () => {
              flushed++;
              await (
                harness.manager as unknown as {
                  handleObservedInputs: (id: string, inputs: ObservedHumanInput[]) => Promise<void>;
                }
              ).handleObservedInputs('s1', [proof('q1', 'final bytes')]);
            },
          },
        },
      ],
    ]);
    await (
      harness.manager as unknown as { finalizeTerminalSends: (id: string, acceptedThrough: string) => Promise<void> }
    ).finalizeTerminalSends('s1', '2026-07-27T02:01:00.000Z');
    expect(flushed).toBe(1);
    expect(harness.ledger.get('q1')?.fate).toBe('delivered');
    expect(harness.events.filter(event => event.type === 'control.send_unaccounted')).toHaveLength(0);
  });

  test('terminal finalization replays proof when its captured watcher detaches during flush', async () => {
    const harness = await evidenceHarness([accepted('q1', 'last detached bytes')], { status: 'stopped' });
    let historicalReads = 0;
    let watcherStops = 0;
    harness.manager.historicalObservedInputs = async () => {
      historicalReads++;
      return [proof('q1', 'last detached bytes')];
    };
    harness.manager.monitors = new Map([
      [
        's1',
        {
          abort: new AbortController(),
          transcript: {
            snapshot: () => ({ running: true }),
            flush: async () => {
              await (harness.manager as unknown as { stopMonitor: (id: string) => Promise<void> }).stopMonitor('s1');
            },
            stop: async () => {
              watcherStops++;
            },
          },
        },
      ],
    ]);

    await (
      harness.manager as unknown as { finalizeTerminalSends: (id: string, acceptedThrough: string) => Promise<void> }
    ).finalizeTerminalSends('s1', '2026-07-27T02:01:00.000Z');
    await Promise.resolve();
    expect(historicalReads).toBe(1);
    expect(watcherStops).toBe(1);
    expect(harness.ledger.get('q1')?.fate).toBe('delivered');
    expect(harness.events.filter(event => event.type === 'control.send_unaccounted')).toHaveLength(0);
  });

  test('terminal finalization replays when monitor cleanup stops its captured watcher', async () => {
    const harness = await evidenceHarness([accepted('q1', 'proof after cleanup stop')], { status: 'stopped' });
    let historicalReads = 0;
    harness.manager.historicalObservedInputs = async () => {
      historicalReads++;
      return [proof('q1', 'proof after cleanup stop')];
    };
    let running = true;
    let flushRequested: () => void = () => undefined;
    const flushRequest = new Promise<void>(resolve => {
      flushRequested = resolve;
    });
    let releaseFlush: () => void = () => undefined;
    const flushBarrier = new Promise<void>(resolve => {
      releaseFlush = resolve;
    });
    const transcript = {
      snapshot: () => ({ running }),
      flush: async () => {
        flushRequested();
        await flushBarrier;
      },
      // Real watcher.stop() marks running=false before releasing barriers that
      // no later pass can satisfy. Keep the monitor mapped and un-aborted here
      // to reproduce monitorLoop's normal-finally ordering exactly.
      stop: async () => {
        running = false;
        releaseFlush();
      },
    };
    harness.manager.monitors = new Map([['s1', { abort: new AbortController(), transcript }]]);

    const finalizing = (
      harness.manager as unknown as { finalizeTerminalSends: (id: string, acceptedThrough: string) => Promise<void> }
    ).finalizeTerminalSends('s1', '2026-07-27T02:01:00.000Z');
    await flushRequest;
    await transcript.stop();
    await finalizing;

    expect((harness.manager.monitors as Map<string, unknown>).has('s1')).toBe(true);
    expect(historicalReads).toBe(1);
    expect(harness.ledger.get('q1')?.fate).toBe('delivered');
    expect(harness.events.filter(event => event.type === 'control.send_unaccounted')).toHaveLength(0);
  });

  test('terminal finalization rechecks a watcher that detaches mid-settle before classification', async () => {
    const harness = await evidenceHarness([accepted('q1', 'proof after bounded flush')], { status: 'stopped' });
    let historicalReads = 0;
    harness.manager.historicalObservedInputs = async () => {
      historicalReads++;
      return [proof('q1', 'proof after bounded flush')];
    };
    harness.manager.monitors = new Map([
      [
        's1',
        {
          abort: new AbortController(),
          transcript: {
            snapshot: () => ({ running: true }),
            flush: async () => undefined,
            stop: async () => undefined,
          },
        },
      ],
    ]);

    let enteredFirstGet: () => void = () => undefined;
    const firstGetEntered = new Promise<void>(resolve => {
      enteredFirstGet = resolve;
    });
    let releaseFirstGet: () => void = () => undefined;
    const firstGetGate = new Promise<void>(resolve => {
      releaseFirstGet = resolve;
    });
    const originalGet = harness.manager.get as (id: string) => Promise<SessionView>;
    let getCalls = 0;
    harness.manager.get = async (id: string) => {
      getCalls++;
      if (getCalls === 1) {
        enteredFirstGet();
        await firstGetGate;
      }
      return await originalGet(id);
    };

    const finalizing = (
      harness.manager as unknown as { finalizeTerminalSends: (id: string, acceptedThrough: string) => Promise<void> }
    ).finalizeTerminalSends('s1', '2026-07-27T02:01:00.000Z');
    await firstGetEntered;
    await (harness.manager as unknown as { stopMonitor: (id: string) => Promise<void> }).stopMonitor('s1');
    releaseFirstGet();
    await finalizing;

    expect(historicalReads).toBe(1);
    expect(harness.ledger.get('q1')?.fate).toBe('delivered');
    expect(harness.events.filter(event => event.type === 'control.send_unaccounted')).toHaveLength(0);
  });

  test('terminal finalization with a detached watcher and no replay proof reaches unaccounted', async () => {
    const harness = await evidenceHarness([accepted('q1', 'never reached transcript')], { status: 'stopped' });
    let historicalReads = 0;
    harness.manager.historicalObservedInputs = async () => {
      historicalReads++;
      return [];
    };
    harness.manager.monitors = new Map([
      [
        's1',
        {
          abort: new AbortController(),
          transcript: {
            snapshot: () => ({ running: true }),
            flush: async () => {
              await (harness.manager as unknown as { stopMonitor: (id: string) => Promise<void> }).stopMonitor('s1');
            },
            stop: async () => undefined,
          },
        },
      ],
    ]);

    const result = await Promise.race([
      (
        harness.manager as unknown as {
          finalizeTerminalSends: (id: string, acceptedThrough: string) => Promise<void>;
        }
      )
        .finalizeTerminalSends('s1', '2026-07-27T02:01:00.000Z')
        .then(() => 'settled'),
      Bun.sleep(250).then(() => 'timed-out'),
    ]);
    expect(result).toBe('settled');
    expect(historicalReads).toBe(1);
    expect(harness.ledger.get('q1')).toMatchObject({
      fate: 'unaccounted',
      unaccountedReason: 'session_ended',
    });
  });

  test('terminal replay read failure defers fate and a later reconciliation recovers', async () => {
    const harness = await evidenceHarness([accepted('q1', 'proof after read recovery')], { status: 'stopped' });
    let historicalReads = 0;
    harness.manager.historicalObservedInputs = async () => {
      historicalReads++;
      if (historicalReads === 1) throw new Error('transcript remained unreadable');
      return [proof('q1', 'proof after read recovery')];
    };
    harness.manager.monitors = new Map([
      [
        's1',
        {
          abort: new AbortController(),
          transcript: {
            snapshot: () => ({ running: true }),
            flush: async () => {
              throw new Error('live watcher flush rejected');
            },
            stop: async () => undefined,
          },
        },
      ],
    ]);

    const firstResult = await Promise.race([
      (
        harness.manager as unknown as {
          finalizeTerminalSends: (id: string, acceptedThrough: string) => Promise<void>;
        }
      )
        .finalizeTerminalSends('s1', '2026-07-27T02:01:00.000Z')
        .then(() => 'settled'),
      Bun.sleep(250).then(() => 'timed-out'),
    ]);
    expect(firstResult).toBe('settled');
    expect(historicalReads).toBe(1);
    expect(harness.ledger.get('q1')?.fate).toBe('accepted');
    expect(harness.events.filter(event => event.type === 'control.send_unaccounted')).toHaveLength(0);
    expect((harness.manager.reconciledSendLedgers as Set<string>).has('s1')).toBe(false);

    // listSends/send/boot all enter this same unlocked reconciliation seam.
    // Once the transcript becomes readable, its authoritative replay settles
    // the preserved acceptance instead of requiring a daemon restart.
    await (
      harness.manager as unknown as {
        ensureSendLedgerReconciledUnlocked: (view: SessionView) => Promise<void>;
      }
    ).ensureSendLedgerReconciledUnlocked(await (harness.manager.get as () => Promise<SessionView>)());
    expect(historicalReads).toBe(2);
    expect(harness.ledger.get('q1')?.fate).toBe('delivered');
    expect((harness.manager.reconciledSendLedgers as Set<string>).has('s1')).toBe(true);
    expect(harness.events.filter(event => event.type === 'control.send_unaccounted')).toHaveLength(0);
  });

  test('startup reconciliation does not latch or classify after historical replay failure', async () => {
    const harness = await evidenceHarness([accepted('q1', 'unread startup proof')], { status: 'stopped' });
    harness.manager.reconciledSendLedgers = new Set<string>();
    harness.manager.historicalObservedInputs = async () => {
      throw new Error('startup transcript read failed');
    };

    await expect(
      (
        harness.manager as unknown as {
          ensureSendLedgerReconciledUnlocked: (view: SessionView) => Promise<void>;
        }
      ).ensureSendLedgerReconciledUnlocked(await (harness.manager.get as () => Promise<SessionView>)()),
    ).rejects.toThrow('startup transcript read failed');
    expect((harness.manager.reconciledSendLedgers as Set<string>).has('s1')).toBe(false);
    expect(harness.ledger.get('q1')?.fate).toBe('accepted');
    expect(harness.events.filter(event => event.type === 'control.send_unaccounted')).toHaveLength(0);
  });

  test('terminal finalizer coalesces an in-flight second terminal epoch to its newest cutoff', async () => {
    const manager = bareManager();
    manager.terminalSendFinalizers = new Map<string, Promise<void>>();
    manager.terminalSendFinalizerCutoffs = new Map<string, string>();
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    manager.finalizeTerminalSends = async (_id: string, acceptedThrough: string) => {
      calls.push(acceptedThrough);
      if (calls.length === 1) await firstGate;
    };
    const schedule = (acceptedThrough: string) =>
      (
        manager as unknown as {
          scheduleTerminalSendFinalization: (id: string, cutoff: string) => void;
        }
      ).scheduleTerminalSendFinalization('s1', acceptedThrough);

    schedule('2026-07-27T02:01:00.000Z');
    expect(calls).toEqual(['2026-07-27T02:01:00.000Z']);
    schedule('2026-07-27T02:03:00.000Z');
    schedule('2026-07-27T02:02:00.000Z');
    releaseFirst();
    await (manager.terminalSendFinalizers as Map<string, Promise<void>>).get('s1');
    expect(calls).toEqual(['2026-07-27T02:01:00.000Z', '2026-07-27T02:03:00.000Z']);
    expect((manager.terminalSendFinalizerCutoffs as Map<string, string>).size).toBe(0);
  });

  test('a stale terminal finalizer never classifies a send after the session has revived', async () => {
    const harness = await evidenceHarness([accepted('q1', 'new live turn')], { status: 'running' });
    harness.manager.monitors = new Map();
    await (
      harness.manager as unknown as { finalizeTerminalSends: (id: string, acceptedThrough: string) => Promise<void> }
    ).finalizeTerminalSends('s1', '2026-07-27T02:01:00.000Z');
    expect(harness.ledger.get('q1')?.fate).toBe('accepted');
    expect(harness.state().pendingNativeSends).toHaveLength(1);
    expect(harness.events.filter(event => event.type === 'control.send_unaccounted')).toHaveLength(0);
  });

  test('composer discard affects native mechanics only and uses unaccounted wording', async () => {
    const native = accepted('native', 'in composer');
    const direct = accepted('direct', 'already submitted', 1, { path: 'direct' });
    const harness = await evidenceHarness([native, direct], { status: 'stopped' });
    await (
      harness.manager as unknown as {
        transitionUnaccountedUnlocked: (id: string, view: SessionView, reason: string) => Promise<number>;
      }
    ).transitionUnaccountedUnlocked(
      's1',
      await (harness.manager.get as () => Promise<SessionView>)(),
      'composer_discarded',
    );
    expect(harness.ledger.get('native')).toMatchObject({
      fate: 'unaccounted',
      unaccountedReason: 'composer_discarded',
    });
    expect(harness.ledger.get('direct')?.fate).toBe('accepted');
    expect(harness.events).toEqual([
      expect.objectContaining({
        type: 'control.send_unaccounted',
        data: expect.objectContaining({ reason: 'composer_discarded' }),
      }),
    ]);
  });

  test('ensure repairs a crash between delivered-ledger fsync and state mechanics cleanup', async () => {
    const record = accepted('q1', 'settled');
    const harness = await evidenceHarness([record]);
    await harness.ledger.persist({
      ...record,
      fate: 'delivered',
      fateAt: '2026-07-27T02:00:41.000Z',
      evidence: {
        key: 'proof-crash-gap',
        harness: 'claude',
        kind: 'queued_command',
        proof: 'native-queue-drain',
        observedAt: '2026-07-27T02:00:40.000Z',
        shapeVersion: 1,
        matchedTurn: 3,
        tier: 'exact-text',
      },
    });
    harness.manager.reconciledSendLedgers = new Set();
    await (
      harness.manager as unknown as { ensureSendLedgerReconciledUnlocked: (view: SessionView) => Promise<void> }
    ).ensureSendLedgerReconciledUnlocked(await (harness.manager.get as () => Promise<SessionView>)());
    expect(harness.state().pendingNativeSends).toHaveLength(0);
    expect(harness.state().sendEvidenceKeys).toContain('proof-crash-gap');
  });

  test('ensure repairs a crash between unaccounted-ledger fsync and state mechanics cleanup', async () => {
    const record = accepted('q1', 'timed out before crash');
    const harness = await evidenceHarness([record]);
    await harness.ledger.persist({
      ...record,
      fate: 'unaccounted',
      fateAt: '2026-07-27T03:00:32.001Z',
      unaccountedReason: 'timeout',
    });
    expect(harness.state().pendingNativeSends).toHaveLength(1);
    harness.manager.reconciledSendLedgers = new Set();
    await (
      harness.manager as unknown as { ensureSendLedgerReconciledUnlocked: (view: SessionView) => Promise<void> }
    ).ensureSendLedgerReconciledUnlocked(await (harness.manager.get as () => Promise<SessionView>)());
    expect(harness.state().pendingNativeSends).toEqual([]);
    expect(harness.ledger.get('q1')).toMatchObject({ fate: 'unaccounted', unaccountedReason: 'timeout' });
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
    async function deliver(message: string): Promise<{
      typed: string;
      turnFile: string;
      config: Record<string, unknown>;
      state: Record<string, unknown>;
      record: SendRecord;
    }> {
      const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-direct-'));
      temporaryDirectories.push(home);
      await mkdir(path.join(home, 's1', 'channel'), { recursive: true });
      await mkdir(path.join(home, 's1', 'turns'), { recursive: true });
      let typed = '';
      let config: Record<string, unknown> = {
        id: 's1',
        tmuxSession: 'kteam-s1-agent',
        turn: 1,
        directSendMaxChars: 500,
      };
      let state: Record<string, unknown> = {
        id: 's1',
        status: 'awaiting_user',
        turn: 1,
        promptReady: true,
      };
      const manager = bareManager();
      manager.resolveRef = (id: string) => id;
      manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
      manager.paths = createPaths(home);
      manager.attachments = { buildImageReferenceBlock: async () => '' };
      manager.autoContinued = new Set();
      manager.doneDeferred = new Set();
      manager.monitors = new Map();
      manager.launching = new Map<string, number>();
      manager.get = async () => ({
        directory: path.join(home, 's1'),
        config,
        state,
      });
      manager.tmux = {
        state: async () => ({ alive: true, dead: false, promptReady: true, visiblePane: '❯ ' }),
        send: async (_config: unknown, text: string) => {
          typed = text;
        },
      };
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
      manager.emit = async () => ({});
      manager.transition = async (_id: string, patch: Record<string, unknown>) => {
        state = { ...state, ...patch };
      };
      const requestId = message.includes('\n') ? 'turn-file-send' : 'direct-send';
      await (
        manager as unknown as {
          send: (id: string, request: { message: string; requestId: string }) => Promise<unknown>;
        }
      ).send('s1', { message, requestId });
      const ledger = await (
        manager as unknown as { sendLedger: (id: string) => Promise<{ all: () => SendRecord[] }> }
      ).sendLedger('s1');
      const acceptedRecord = ledger.all()[0]!;
      await (
        manager as unknown as {
          handleObservedInputs: (id: string, inputs: ObservedHumanInput[]) => Promise<void>;
        }
      ).handleObservedInputs('s1', [
        {
          harness: 'claude',
          text: typed,
          proof: 'normal-user-record',
          observedAt: new Date(Date.parse(acceptedRecord.acceptedAt) + 1_000).toISOString(),
          proofKey: `proof-${requestId}`,
          shapeVersion: 1,
        },
      ]);
      const turnFile = await readFile(path.join(home, 's1', 'turns', 'turn-002.md'), 'utf8').catch(() => '');
      return { typed, turnFile, config, state, record: ledger.all()[0]! };
    }

    const short = await deliver('run the tests again');
    expect(short.typed).toBe('run the tests again'); // typed verbatim
    expect(short.turnFile).toContain('run the tests again'); // bookkeeping file still written
    expect(short.record).toMatchObject({ sendId: 'direct-send', path: 'direct', fate: 'delivered', turn: 2 });
    expect(short.config.turn).toBe(2);
    expect(short.state.turn).toBe(2);

    const long = await deliver(`do these steps:\n1. one\n2. two`);
    expect(long.typed).toContain('Read the file'); // turn-file instruction
    expect(long.turnFile).toContain('do these steps');
    expect(long.record).toMatchObject({ sendId: 'turn-file-send', path: 'turn-file', fate: 'delivered', turn: 2 });
    expect(long.config.turn).toBe(2);
    expect(long.state.turn).toBe(2);
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
    const steps: string[] = [];
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
        steps.push(type);
        return {} as unknown;
      },
      resume: async (_id: string, message?: string) => {
        steps.push('resume');
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
    // Every persisted config that points at the target already carries its
    // target-derived transcript path; there is no half-migrated observation.
    expect(
      configUpdates
        .filter(update => update.binary === 'claude-auto-glm52b')
        .every(update => String(update.transcriptFile).includes('/new/home/projects/')),
    ).toBe(true);

    const migrated = events.find(event => event.type === 'session.migrated');
    expect(migrated?.payload).toMatchObject({ from: 'claude-auto-glm52a', to: 'claude-auto-glm52b' });
    expect(resumedWith).toMatch(/migrated to a different account/);
    expect(steps).toEqual(['session.migrating', 'resume', 'session.migrated']);
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
      'migration to claude-auto-glm52b failed: pane never became ready; session restored to claude-auto-glm52a (pane stopped)',
    );
    // Config rolled back to the original account — never left on the wrapper that
    // never launched.
    expect(current.binary).toBe('claude-auto-glm52a');
    expect(current.harnessHome).toBe('/old/home');
    expect(current.model).toBe('glm-5.2');
    expect(current.migration).toBeUndefined();
    // Intent was journaled BEFORE stopping, then the session was marked failed.
    expect(events).toContain('session.migrating');
    expect(events).not.toContain('session.migrated');
    expect(events).toContain('session.migrate_failed');
    expect(transitions.at(-1)?.status).toBe('failed');
    expect(transitions.at(-1)?.reason).toContain('restored to claude-auto-glm52a');
  });

  test('a pre-stop failure restores the original config without terminalizing the still-live session', async () => {
    const wrapperDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-migrate-pre-stop-failure-'));
    temporaryDirectories.push(wrapperDir);
    await writeFile(
      path.join(wrapperDir, 'claude-auto-glm52b'),
      'export CLAUDE_CONFIG_DIR="/new/home"\nexport KTEAM_MODEL="glm-5.2-air"\n',
      { mode: 0o755 },
    );
    let current = { ...(claudeSession.config as unknown as Loose) };
    let reads = 0;
    const transitions: Array<{ status?: string }> = [];
    const failures: Loose[] = [];
    const manager = migrateManager({
      paths: { kfleetBin: wrapperDir },
      get: async () => {
        reads += 1;
        return reads === 1 ? claudeSession : ({ ...claudeSession, config: current } as unknown as SessionView);
      },
      store: {
        listSessions: () => [],
        updateConfig: async (_id: string, mutate: (c: Loose) => Loose) => {
          current = mutate(current);
          return current;
        },
      },
      tmux: { state: async () => ({ alive: true, dead: false, promptReady: true }) },
      emit: async (_id: string, type: string, payload: Loose) => {
        if (type === 'session.migrating') throw new Error('intent event persistence failed');
        if (type === 'session.migrate_failed') failures.push(payload);
        return {} as unknown;
      },
      transition: async (_id: string, patch: { status?: string }) => {
        transitions.push(patch);
      },
    });

    await expect(callMigrate(manager, 's1', 'claude-auto-glm52b')).rejects.toThrow(/intent event persistence failed/);
    expect(current.binary).toBe('claude-auto-glm52a');
    expect(current.migration).toBeUndefined();
    expect(transitions).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ restoredTo: 'claude-auto-glm52a', status: 'rate_limited' });
  });

  test('an unverified rollback reports the observed target and never claims restoration', async () => {
    const wrapperDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-migrate-rollback-failure-'));
    temporaryDirectories.push(wrapperDir);
    await writeFile(
      path.join(wrapperDir, 'claude-auto-glm52b'),
      'export CLAUDE_CONFIG_DIR="/new/home"\nexport KTEAM_MODEL="glm-5.2-air"\n',
      { mode: 0o755 },
    );
    let current = { ...(claudeSession.config as unknown as Loose) };
    let reads = 0;
    let updates = 0;
    const events: Array<{ type: string; payload: Loose }> = [];
    const manager = migrateManager({
      paths: { kfleetBin: wrapperDir },
      get: async () => {
        reads += 1;
        return reads === 1 ? claudeSession : ({ ...claudeSession, config: current } as unknown as SessionView);
      },
      store: {
        listSessions: () => [],
        updateConfig: async (_id: string, mutate: (c: Loose) => Loose) => {
          updates += 1;
          if (updates === 3) throw new Error('rollback database refresh exploded');
          current = mutate(current);
          return current;
        },
      },
      stopMonitor: async () => undefined,
      tmux: { state: async () => ({ alive: false, dead: true, promptReady: false }) },
      emit: async (_id: string, type: string, payload: Loose) => {
        events.push({ type, payload });
        return {} as unknown;
      },
      transition: async () => undefined,
      resume: async () => {
        throw new Error('pane never became ready');
      },
    });

    await expect(callMigrate(manager, 's1', 'claude-auto-glm52b')).rejects.toThrow(
      /rollback incomplete; observed wrapper claude-auto-glm52b.*rollback write failed: rollback database refresh exploded/,
    );
    expect(current.binary).toBe('claude-auto-glm52b');
    expect(current.migration).toBeDefined();
    expect(events.map(event => event.type)).not.toContain('session.migrated');
    const failed = events.find(event => event.type === 'session.migrate_failed')?.payload;
    expect(failed).toMatchObject({
      observedWrapper: 'claude-auto-glm52b',
      rollbackError: 'rollback database refresh exploded',
      status: 'failed',
    });
    expect(failed?.restoredTo).toBeUndefined();
  });

  test('refuses an incoming kill_failed session before journaling migration intent', async () => {
    const wrapperDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-migrate-kill-failed-'));
    temporaryDirectories.push(wrapperDir);
    await writeFile(
      path.join(wrapperDir, 'claude-auto-glm52b'),
      'export CLAUDE_CONFIG_DIR="/new/home"\nexport KTEAM_MODEL="glm-5.2-air"\n',
      { mode: 0o755 },
    );
    let journaled = false;
    const manager = migrateManager({
      paths: { kfleetBin: wrapperDir },
      get: async () => ({
        ...claudeSession,
        state: { ...claudeSession.state, status: 'kill_failed' },
      }),
      store: {
        listSessions: () => [],
        updateConfig: async () => {
          journaled = true;
          throw new Error('must refuse before journaling migration intent');
        },
      },
    });

    await expect(callMigrate(manager, 's1', 'claude-auto-glm52b')).rejects.toThrow(/previous tmux kill failed/);
    expect(journaled).toBe(false);
  });

  test('a relaunch failure preserves a kill_failed quarantine', async () => {
    const wrapperDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-migrate-preserve-kill-failed-'));
    temporaryDirectories.push(wrapperDir);
    await writeFile(
      path.join(wrapperDir, 'claude-auto-glm52b'),
      'export CLAUDE_CONFIG_DIR="/new/home"\nexport KTEAM_MODEL="glm-5.2-air"\n',
      { mode: 0o755 },
    );
    let current = { ...(claudeSession.config as unknown as Loose) };
    let reads = 0;
    const transitions: Array<{ status?: string }> = [];
    const events: string[] = [];
    const manager = migrateManager({
      paths: { kfleetBin: wrapperDir },
      get: async () => {
        reads++;
        return reads === 1
          ? claudeSession
          : ({
              ...claudeSession,
              config: current,
              state: { ...claudeSession.state, status: 'kill_failed' },
            } as unknown as SessionView);
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
      emit: async (_id: string, type: string) => {
        events.push(type);
        return {} as unknown;
      },
      transition: async (_id: string, patch: { status?: string }) => {
        transitions.push(patch);
      },
      resume: async () => {
        throw new Error('failed resume cleanup could not kill pane');
      },
    });

    await expect(callMigrate(manager, 's1', 'claude-auto-glm52b')).rejects.toThrow(/kill_failed/);
    expect(current.binary).toBe('claude-auto-glm52a');
    expect(current.migration).toBeUndefined();
    expect(transitions).toEqual([]);
    expect(events).not.toContain('session.migrated');
    expect(events).toContain('session.migrate_failed');
  });

  test('a failed pane stop clears migration intent and re-arms the old monitor', async () => {
    const wrapperDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-migrate-stop-failure-'));
    temporaryDirectories.push(wrapperDir);
    await writeFile(
      path.join(wrapperDir, 'claude-auto-glm52b'),
      'export CLAUDE_CONFIG_DIR="/new/home"\nexport KTEAM_MODEL="glm-5.2-air"\n',
      { mode: 0o755 },
    );
    let current = { ...(claudeSession.config as unknown as Loose) };
    let monitorsStarted = 0;
    const events: string[] = [];
    const manager = migrateManager({
      paths: { kfleetBin: wrapperDir },
      get: async () => ({ ...claudeSession, config: current }) as unknown as SessionView,
      store: {
        listSessions: () => [],
        updateConfig: async (_id: string, mutate: (c: Loose) => Loose) => {
          current = mutate(current);
          return current;
        },
      },
      stopMonitor: async () => undefined,
      stopTmuxWithEvidence: async () => {
        throw new Error('kill timed out');
      },
      startMonitor: async () => {
        monitorsStarted++;
      },
      tmux: { state: async () => ({ alive: true, dead: false, promptReady: false }) },
      emit: async (_id: string, type: string) => {
        events.push(type);
        return {} as unknown;
      },
      transition: async () => undefined,
    });

    await expect(callMigrate(manager, 's1', 'claude-auto-glm52b')).rejects.toThrow(/kill timed out/);
    expect(current.binary).toBe('claude-auto-glm52a');
    expect(current.migration).toBeUndefined();
    expect(monitorsStarted).toBe(1);
    expect(events).not.toContain('session.migrated');
    expect(events).toContain('session.migrate_failed');
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

describe('cgroup config transition ordering', () => {
  test('a live pane with an unreadable PID stays visible while a confirmed queued bootstrap is omitted', async () => {
    const manager = bareManager();
    manager.list = async () => [
      { config: { id: 'known', tmuxSession: 'tmux-known' }, state: { status: 'running' } },
      { config: { id: 'uncertain', tmuxSession: 'tmux-uncertain' }, state: { status: 'running' } },
      { config: { id: 'queued', tmuxSession: 'tmux-queued' }, state: { status: 'starting' } },
    ];
    manager.tmux = {
      paneProcessId: async (name: string) => (name === 'tmux-known' ? 123 : undefined),
      alive: async (name: string) => name === 'tmux-uncertain',
    };
    const targets = await (
      manager as unknown as { liveCgroupTargets: () => Promise<Array<{ sessionId: string; panePid?: number }>> }
    ).liveCgroupTargets();
    expect(targets).toEqual([
      { sessionId: 'known', panePid: 123 },
      { sessionId: 'uncertain', panePid: undefined },
    ]);
  });

  test('a config PATCH waits for an in-flight pane bootstrap before inspecting live targets', async () => {
    const manager = bareManager();
    const paths = manager.paths as ReturnType<typeof createPaths>;
    await mkdir(paths.daemon, { recursive: true });
    let releaseBootstrap!: () => void;
    manager.bootstrapChain = new Promise<void>(resolve => {
      releaseBootstrap = resolve;
    });
    const initial = {
      enabled: true,
      fleet: { cpuPercent: 90, memoryPercent: 90 },
      perAgent: { cpuPercent: 25, memoryPercent: 25 },
    };
    let inspected = false;
    manager.cgroups = {
      config: initial,
      supported: true,
      apply: async (config: typeof initial) => ({
        config,
        supported: true,
        fleetSlice: 'kteam-fleet.slice',
        effective: {},
        restartRequiredSessions: [],
        warnings: [],
      }),
    };
    manager.liveCgroupTargets = async () => {
      inspected = true;
      return [];
    };
    manager.emitTransient = () => undefined;

    const updating = (
      manager as unknown as {
        updateCgroupConfig: (patch: { enabled: boolean }) => Promise<unknown>;
      }
    ).updateCgroupConfig({ enabled: false });
    await Promise.resolve();
    expect(inspected).toBe(false);

    releaseBootstrap();
    await updating;
    expect(inspected).toBe(true);
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
