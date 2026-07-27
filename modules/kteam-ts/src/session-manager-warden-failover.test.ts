import { describe, expect, test } from 'bun:test';
import { SessionManager } from './session-manager';
import type { WardenRunView } from './service';

// Fixture-level tests over prototype instances (same style as
// session-manager-control.test.ts): the real SessionManager wires a daemon,
// tmux, and an event store — these exercise the warden account-failover wiring
// with the collaborators mocked.

type Loose = Record<string, unknown>;

function bareManager(): Loose {
  return Object.create(SessionManager.prototype) as Loose;
}

const sus = (id: string) => ({ kind: 'sus_thinking', sessionId: id, status: 'running', detail: 'x' });
const target = (id: string) => ({
  config: { id, teammate: id, cwd: '/repo' },
  state: { status: 'running' },
  directory: `/x/${id}`,
});

interface FailoverFixture {
  manager: Loose;
  started: Array<{ agent: string; model?: string }>;
  transient: Array<{ type: string; data: Record<string, unknown> }>;
}

function failoverManager(input: {
  accounts?: (string | { wrapper: string; model?: string })[];
  policy?: 'fallback' | 'round_robin';
  usage?: Array<Record<string, unknown>>;
  startError?: (agent: string) => Error | undefined;
  failoverState?: Record<string, unknown>;
  maxAssignedWardens?: number;
}): FailoverFixture {
  const started: Array<{ agent: string; model?: string }> = [];
  const transient: Array<{ type: string; data: Record<string, unknown> }> = [];
  const manager = bareManager();
  manager.options = {
    warden: {
      enabled: true,
      wrapper: 'claude-auto-a',
      ...(input.accounts ? { accounts: input.accounts } : {}),
      failover: { policy: input.policy ?? 'fallback', failureThreshold: 2, cooldownMinutes: 30 },
      intervalMinutes: 5,
      unattendedMinutes: 30,
      minSpawnGapMinutes: 15,
      susThinkingSeconds: 900,
      susSubprocessSeconds: 900,
      maxAssignedWardens: input.maxAssignedWardens ?? 3,
      assignedCooldownMinutes: 30,
      blessMinutes: 15,
    },
  };
  manager.wardenState = { ...(input.failoverState ? { failover: input.failoverState } : {}) };
  manager.paths = { wardenReports: '/tmp/kteam-warden-failover-test-reports', kfleetBin: '/nonexistent-kfleet-bin' };
  manager.saveWardenState = async () => undefined;
  manager.emitTransient = (type: string, data: Record<string, unknown>) => {
    transient.push({ type, data });
  };
  manager.fetchUsageAccounts = async () => input.usage ?? [];
  manager.buildAssignedWardenPrompt = () => 'investigate';
  manager.buildWardenPrompt = async () => 'triage';
  let counter = 0;
  manager.start = async (request: { agent: string; model?: string }) => {
    const error = input.startError?.(request.agent);
    if (error) throw error;
    const id = `warden-${++counter}`;
    started.push({ agent: request.agent, model: request.model });
    return { config: { id, teammate: id }, state: { status: 'running' }, directory: `/x/${id}` };
  };
  return { manager, started, transient };
}

const spawnAssigned = (manager: Loose, anomalies: unknown[], sessions: unknown[]) =>
  (
    manager as unknown as { spawnAssignedWardens: (a: unknown[], s: unknown[], f: boolean) => Promise<string[]> }
  ).spawnAssignedWardens(anomalies, sessions, false);

const escalate = (manager: Loose, anomalies: unknown[], fingerprint: string, sessions: unknown[], force = false) =>
  (
    manager as unknown as {
      maybeEscalate: (
        a: unknown[],
        f: string,
        s: unknown[],
        force: boolean,
      ) => Promise<{ spawned?: string; message?: string }>;
    }
  ).maybeEscalate(anomalies, fingerprint, sessions, force);

describe('assigned-warden account failover', () => {
  test('spawns on the first configured account by default (legacy parity)', async () => {
    const { manager, started } = failoverManager({});
    await spawnAssigned(manager, [sus('t1')], [target('t1')]);
    expect(started).toEqual([{ agent: 'claude-auto-a', model: undefined }]);
  });

  test('a spawn failure strikes the WRAPPER, not just the target, and failover routes the next spawn', async () => {
    const { manager, started, transient } = failoverManager({
      accounts: ['claude-auto-a', 'claude-auto-b'],
      startError: agent => (agent === 'claude-auto-a' ? new Error('tmux new-session exited 1') : undefined),
    });
    // Two consecutive generic failures on account a (threshold 2) demote it.
    await spawnAssigned(manager, [sus('t1')], [target('t1')]);
    await spawnAssigned(manager, [sus('t2')], [target('t2')]);
    const failover = (manager.wardenState as { failover: { strikes: Record<string, { count: number }> } }).failover;
    expect(failover.strikes['claude-auto-a']?.count).toBe(2);
    expect(transient.some(item => item.type === 'fleet.warden_wrapper_demoted')).toBe(true);
    // The next sus target lands on account b.
    await spawnAssigned(manager, [sus('t3')], [target('t3')]);
    expect(started).toEqual([{ agent: 'claude-auto-b', model: undefined }]);
    expect(transient.some(item => item.type === 'fleet.warden_failover')).toBe(true);
  });

  test('quota evidence demotes in ONE strike', async () => {
    const { manager, started } = failoverManager({
      accounts: ['claude-auto-a', 'claude-auto-b'],
      startError: agent =>
        agent === 'claude-auto-a' ? new Error('wrapper claude-auto-a is at its usage limit (resets soon)') : undefined,
    });
    await spawnAssigned(manager, [sus('t1')], [target('t1')]);
    await spawnAssigned(manager, [sus('t2')], [target('t2')]);
    expect(started).toEqual([{ agent: 'claude-auto-b', model: undefined }]);
  });

  test('feed-reported at-limit reroutes without burning a failed spawn', async () => {
    const { manager, started } = failoverManager({
      accounts: [{ wrapper: 'claude-auto-a', model: 'opus' }, 'claude-auto-b'],
      usage: [{ binary: 'claude-auto-a', atLimit: true }],
    });
    await spawnAssigned(manager, [sus('t1')], [target('t1')]);
    expect(started).toEqual([{ agent: 'claude-auto-b', model: undefined }]);
  });

  test('per-account model override rides the selection', async () => {
    const { manager, started } = failoverManager({ accounts: [{ wrapper: 'claude-auto-a', model: 'opus' }] });
    await spawnAssigned(manager, [sus('t1')], [target('t1')]);
    expect(started).toEqual([{ agent: 'claude-auto-a', model: 'opus' }]);
  });

  test('round_robin rotates across accounts per spawn', async () => {
    const { manager, started } = failoverManager({
      accounts: ['claude-auto-a', 'claude-auto-b'],
      policy: 'round_robin',
    });
    await spawnAssigned(manager, [sus('t1'), sus('t2')], [target('t1'), target('t2')]);
    expect(started.map(item => item.agent)).toEqual(['claude-auto-a', 'claude-auto-b']);
  });

  test('exhaustion queues the target instead of spawning or cooling it down', async () => {
    const { manager, started, transient } = failoverManager({
      accounts: ['claude-auto-a'],
      usage: [{ binary: 'claude-auto-a', atLimit: true }],
    });
    await spawnAssigned(manager, [sus('t1')], [target('t1')]);
    expect(started).toEqual([]);
    const state = manager.wardenState as {
      assignedQueue?: Array<{ sessionId: string }>;
      assignedCooldowns?: Record<string, string>;
      failover?: { exhaustedSince?: string };
    };
    expect(state.assignedQueue?.map(item => item.sessionId)).toEqual(['t1']);
    expect(state.assignedCooldowns?.t1).toBeUndefined();
    expect(state.failover?.exhaustedSince).toBeDefined();
    expect(transient.filter(item => item.type === 'fleet.warden_exhausted')).toHaveLength(1);
    // A second exhausted sweep does not re-emit (edge-triggered).
    await spawnAssigned(manager, [sus('t1')], [target('t1')]);
    expect(transient.filter(item => item.type === 'fleet.warden_exhausted')).toHaveLength(1);
  });
});

describe('escalation account failover', () => {
  test('exhaustion skips the spawn WITHOUT consuming the spawn gap or fingerprint', async () => {
    const { manager, started } = failoverManager({
      accounts: ['claude-auto-a'],
      usage: [{ binary: 'claude-auto-a', atLimit: true }],
    });
    manager.list = async () => [];
    const result = await escalate(manager, [sus('t1')], 'fp-1', [target('t1')]);
    expect(result.message).toContain('exhausted');
    expect(started).toEqual([]);
    const state = manager.wardenState as { lastSpawnAt?: string; lastSpawnFingerprint?: string };
    expect(state.lastSpawnAt).toBeUndefined();
    expect(state.lastSpawnFingerprint).toBeUndefined();
    // Recovery: the same anomaly set escalates immediately on the next sweep.
    (manager.fetchUsageAccounts as unknown) = async () => [{ binary: 'claude-auto-a', atLimit: false, authOk: true }];
    const retry = await escalate(manager, [sus('t1')], 'fp-1', [target('t1')]);
    expect(retry.spawned).toBeDefined();
    expect(started).toHaveLength(1);
  });

  test('a failed escalation spawn strikes the wrapper and still consumes the gap', async () => {
    const { manager, transient } = failoverManager({
      accounts: ['claude-auto-a', 'claude-auto-b'],
      startError: agent => (agent === 'claude-auto-a' ? new Error('harness crashed') : undefined),
    });
    manager.list = async () => [];
    const result = await escalate(manager, [sus('t1')], 'fp-1', [target('t1')]);
    expect(result.message).toContain('warden spawn failed');
    const state = manager.wardenState as {
      lastSpawnAt?: string;
      failover?: { strikes?: Record<string, { count: number }> };
    };
    expect(state.lastSpawnAt).toBeDefined();
    expect(state.failover?.strikes?.['claude-auto-a']?.count).toBe(1);
    expect(transient.some(item => item.type === 'fleet.warden_spawn_failed')).toBe(true);
  });

  test('a successful spawn resets the wrapper strike counter', async () => {
    const { manager } = failoverManager({
      accounts: ['claude-auto-a', 'claude-auto-b'],
      failoverState: { strikes: { 'claude-auto-a': { count: 1, lastAt: 'x', lastReason: 'blip' } } },
    });
    manager.list = async () => [];
    const result = await escalate(manager, [sus('t1')], 'fp-1', [target('t1')], true);
    expect(result.spawned).toBeDefined();
    const state = manager.wardenState as { failover?: { strikes?: Record<string, unknown> } };
    expect(state.failover?.strikes?.['claude-auto-a']).toBeUndefined();
  });

  test('positive feed evidence restores a demoted wrapper early and fails back', async () => {
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    const { manager, started, transient } = failoverManager({
      accounts: ['claude-auto-a', 'claude-auto-b'],
      usage: [{ binary: 'claude-auto-a', atLimit: false, authOk: true }],
      failoverState: {
        demotedUntil: { 'claude-auto-a': future },
        lastSelection: { wrapper: 'claude-auto-b', policy: 'fallback', at: 'x', reason: 'failover' },
      },
    });
    manager.list = async () => [];
    const result = await escalate(manager, [sus('t1')], 'fp-1', [target('t1')], true);
    expect(result.spawned).toBeDefined();
    expect(started).toEqual([{ agent: 'claude-auto-a', model: undefined }]);
    expect(transient.some(item => item.type === 'fleet.warden_wrapper_restored' && item.data.how === 'feed')).toBe(
      true,
    );
  });
});

describe('wardenRunView shape (WardenRunView import sanity)', () => {
  test('run view fields stay optional', () => {
    const view: WardenRunView = { sweptAt: 'x', anomalies: [] };
    expect(view.spawned).toBeUndefined();
  });
});
