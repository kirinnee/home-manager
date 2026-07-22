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

describe('nudgedAt is turn-scoped (A6 fix round)', () => {
  test('every turn-committing transition clears nudgedAt so a new turn is nudged before any kill', async () => {
    // Source-level guard across all five turn-start sites: send, answer,
    // resume/relaunch, session start, and auto-continue. Each transition that
    // sets a fresh startedAt must also reset the nudge episode.
    const source = await Bun.file(path.join(import.meta.dir, 'session-manager.ts')).text();
    const turnStarts = source.split('startedAt: now()').length - 1;
    const nudgeResets = source.split('nudgedAt: undefined').length - 1;
    expect(turnStarts).toBe(5);
    expect(nudgeResets).toBeGreaterThanOrEqual(5);
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

describe('deliverPendingSends (F5)', () => {
  async function sessionDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kteam-f5-'));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, 'channel'), { recursive: true });
    return directory;
  }

  function managerWith(sends: Array<{ message: string; attachmentIds?: string[] }>): Loose {
    const manager = bareManager();
    manager.emit = async () => undefined;
    manager.send = async (_id: string, request: { message: string; attachmentIds?: string[] }) => {
      sends.push(request);
      return {} as SessionView;
    };
    return manager;
  }

  test('queued messages deliver exactly once, combined, and are marked delivered', async () => {
    const directory = await sessionDirectory();
    const pending = path.join(directory, 'channel', 'pending-sends.jsonl');
    await writeFile(
      pending,
      `${JSON.stringify({ id: '1', at: 't', message: 'first steer' })}\n${JSON.stringify({ id: '2', at: 't', message: 'second steer', attachmentIds: ['a1'] })}\n`,
    );
    const sends: Array<{ message: string; attachmentIds?: string[] }> = [];
    const manager = managerWith(sends);
    const call = manager as unknown as { deliverPendingSends: (id: string, dir: string) => Promise<boolean> };

    expect(await call.deliverPendingSends('x', directory)).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.message).toBe('first steer\n\n---\n\nsecond steer');
    expect(sends[0]!.attachmentIds).toEqual(['a1']);
    expect(await readFile(pending, 'utf8')).toBe('');
    const delivered = await readFile(path.join(directory, 'channel', 'delivered-sends.jsonl'), 'utf8');
    expect(delivered.trim().split('\n')).toHaveLength(2);

    // Second sweep: nothing left — at-most-once.
    expect(await call.deliverPendingSends('x', directory)).toBe(false);
    expect(sends).toHaveLength(1);
  });

  test('no queue file means no delivery', async () => {
    const directory = await sessionDirectory();
    const sends: Array<{ message: string }> = [];
    const manager = managerWith(sends);
    const call = manager as unknown as { deliverPendingSends: (id: string, dir: string) => Promise<boolean> };
    expect(await call.deliverPendingSends('x', directory)).toBe(false);
    expect(sends).toEqual([]);
  });
});
