import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { createPaths } from './paths';
import { SessionManager } from './session-manager';
import { WARDEN_LABEL } from './warden-detect';

// Warden invariants (kteam-prob 2026-07-28 "three warden invariants") and the
// model-fallback consumption (2026-10-08), over prototype instances with the
// collaborators mocked — same style as session-manager-warden-failover.test.ts.

type Loose = Record<string, unknown>;

const bareManager = (): Loose => Object.create(SessionManager.prototype) as Loose;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('assigned targets keep their scratch (hasLiveWarden)', () => {
  const DAY = 86_400_000;

  async function scratchFixture(wardenStatus: string, assigned: boolean) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-warden-scratch-'));
    homes.push(home);
    const paths = createPaths(home);
    // A long-finished target with old scratch: GC-eligible on its own merits.
    const scratch = path.join(home, 't1', 'build-output.bin');
    await mkdir(path.dirname(scratch), { recursive: true });
    await writeFile(scratch, 'x'.repeat(64));
    const old = new Date(Date.now() - 30 * DAY);
    await utimes(scratch, old, old);
    await utimes(path.dirname(scratch), old, old);
    const sessions = [
      {
        id: 't1',
        directory: path.join(home, 't1'),
        config: { id: 't1', teammate: 'gloria', tmuxSession: 'kteam-t1' },
        state: { status: 'completed', finishedAt: old.toISOString() },
      },
      {
        // An ASSIGNED warden: spawned without a parent — its target link is
        // only in wardenState.assignments.
        id: 'w1',
        directory: path.join(home, 'w1'),
        config: { id: 'w1', teammate: 'miranda', label: WARDEN_LABEL, tmuxSession: 'kteam-w1' },
        state: { status: wardenStatus },
      },
    ];
    const manager = bareManager();
    manager.paths = paths;
    manager.options = {};
    manager.monitors = new Map();
    manager.launching = new Map();
    manager.wardenState = assigned
      ? { assignments: { t1: { wardenId: 'w1', spawnedAt: old.toISOString(), capability: 'cap' } } }
      : {};
    manager.store = {
      listSessions: () => sessions,
      getSession: (id: string) => sessions.find(session => session.id === id),
    };
    manager.tmux = { state: async () => ({ alive: false, dead: true }) };
    return manager;
  }

  const plan = (manager: Loose) =>
    (
      manager as unknown as { planScratchSweep: () => Promise<Array<{ sessionId: string; eligible: boolean }>> }
    ).planScratchSweep();

  test('an assigned target with a live warden is skipped by the scratch sweep', async () => {
    const plans = await plan(await scratchFixture('running', true));
    expect(plans.filter(item => item.sessionId === 't1' && item.eligible)).toEqual([]);
  });

  test('the target becomes reclaimable once its assigned warden is terminal', async () => {
    const plans = await plan(await scratchFixture('completed', true));
    expect(plans.find(item => item.sessionId === 't1')?.eligible).toBe(true);
  });

  test('without an assignment the same session is reclaimable (control)', async () => {
    const plans = await plan(await scratchFixture('running', false));
    expect(plans.find(item => item.sessionId === 't1')?.eligible).toBe(true);
  });
});

describe('one sweep with both anomaly classes respects the shared warden cap', () => {
  test('cap 1: the assigned warden spawns and fleet escalation is refused in the same sweep', async () => {
    const started: string[] = [];
    const sessions: Array<Record<string, unknown>> = [
      { config: { id: 't1', teammate: 't1', cwd: '/repo' }, state: { status: 'running' }, directory: '/x/t1' },
      { config: { id: 't2', teammate: 't2', cwd: '/repo' }, state: { status: 'failed' }, directory: '/x/t2' },
    ];
    const reportsDir = await mkdtemp(path.join(os.tmpdir(), 'kteam-warden-cap-'));
    homes.push(reportsDir);
    const manager = bareManager();
    manager.options = {
      warden: {
        enabled: true,
        wrapper: 'claude-auto-a',
        failover: { policy: 'fallback', failureThreshold: 2, cooldownMinutes: 30 },
        intervalMinutes: 5,
        unattendedMinutes: 30,
        minSpawnGapMinutes: 15,
        susThinkingSeconds: 900,
        susSubprocessSeconds: 900,
        maxAssignedWardens: 1,
        assignedCooldownMinutes: 30,
        blessMinutes: 15,
      },
    };
    manager.wardenState = {};
    manager.paths = {
      home: '/tmp',
      wardenAnomalies: path.join(reportsDir, 'anomalies.json'),
      wardenReports: reportsDir,
      kfleetBin: '/nonexistent-kfleet-bin',
    };
    manager.saveWardenState = async () => undefined;
    manager.emitTransient = () => undefined;
    manager.fetchUsageAccounts = async () => [];
    manager.buildAssignedWardenPrompt = () => 'investigate';
    manager.buildWardenPrompt = async () => 'triage';
    manager.start = async (request: { name: string; label: string }) => {
      const id = `warden-${started.length + 1}`;
      started.push(request.name);
      const view = {
        config: { id, teammate: id, label: request.label, binary: 'claude-auto-a', harness: 'claude' },
        state: { status: 'running' },
        directory: `/x/${id}`,
      };
      // The daemon persists a started session, so a fresh list() sees it.
      sessions.push(view);
      return view;
    };
    manager.list = async () => [...sessions];
    const anomalies = [
      { kind: 'sus_thinking', sessionId: 't1', status: 'running', detail: 'x', assignedWarden: true },
      { kind: 'terminal_failure', sessionId: 't2', status: 'failed', detail: 'y' },
    ];
    const result = await (
      manager as unknown as {
        dispatchWardens: (
          a: unknown[],
          f: string,
          s: unknown[],
          force: boolean,
        ) => Promise<{ assigned: string[]; escalation: { spawned?: string; message?: string } }>;
      }
    ).dispatchWardens(anomalies, 'fp-1', [...sessions], false);
    expect(started).toEqual(['warden:t1']);
    expect(result.assigned).toEqual(['warden-1']);
    expect(result.escalation.spawned).toBeUndefined();
    expect(result.escalation.message).toMatch(/concurrency cap reached \(1\/1 live\)/);
  });
});

describe('model fallback consumption (session.model_fallback)', () => {
  test('a fallback event flips health to degraded, records it stickily, and says why', async () => {
    let state: Record<string, unknown> = { id: 's1', status: 'running', health: 'healthy', turn: 1 };
    const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
    const manager = bareManager();
    manager.queues = new Map();
    manager.deleting = new Set();
    manager.options = {};
    manager.serialized = async (_id: string, work: () => Promise<unknown>) => await work();
    manager.get = async () => ({
      config: { id: 's1', mode: 'auto', binary: 'claude-auto-loge3', model: 'fable', turn: 1 },
      state,
      directory: '/x/s1',
    });
    manager.store = {
      updateState: async (_id: string, mutate: (current: Record<string, unknown>) => Record<string, unknown>) => {
        state = mutate(state);
        return state;
      },
      readState: async () => state,
      readConfig: async () => ({ id: 's1' }),
    };
    manager.indexChatRecords = () => undefined;
    manager.broadcastChat = () => undefined;
    manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
      emitted.push({ type, data });
      return {};
    };
    const handle = (events: unknown[]) =>
      (
        manager as unknown as {
          handleClaudeEvents: (id: string, events: unknown[], cursor: unknown) => Promise<void>;
        }
      ).handleClaudeEvents('s1', events, { file: '/tmp/t.jsonl', startOffset: 0, endOffset: 10 });

    await handle([
      {
        type: 'session.model_fallback',
        data: { fromModel: 'claude-fable-5-1', toModel: 'claude-sonnet-5-5[1m]', fromModelName: 'Fable 5.1' },
      },
    ]);
    expect(emitted.map(event => event.type)).toContain('session.model_fallback');
    expect(state.health).toBe('degraded');
    expect(state.reason).toBe('model fell back: claude-fable-5-1 → claude-sonnet-5-5[1m]');
    expect(state.modelFallback).toMatchObject({ fromModel: 'claude-fable-5-1', toModel: 'claude-sonnet-5-5[1m]' });

    // Later ordinary progress keeps the session degraded (sticky).
    await handle([{ type: 'chat.assistant.thinking', data: { text: 'hmm' } }]);
    expect(state.health).toBe('degraded');

    // Any writer that resets health to 'healthy' is overlaid on read.
    state = { ...state, health: 'healthy' };
    manager.paths = { sessions: '/x' };
    manager.resolveRef = (id: string) => id;
    delete manager.get;
    const view = await (manager as unknown as { get: (id: string) => Promise<{ state: Record<string, unknown> }> }).get(
      's1',
    );
    expect(view.state.health).toBe('degraded');
  });
});
