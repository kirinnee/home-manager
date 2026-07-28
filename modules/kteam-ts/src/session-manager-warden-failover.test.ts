import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { atomicJson } from './io';
import { needsHumanCoversAnomaly, needsHumanStateCoversAnomaly, SessionManager } from './session-manager';
import type { WardenRunView } from './service';
import { provenancePath, type WardenSpawnProvenance } from './warden-provenance';
import type { WardenVerdictSpawn } from './warden-verdicts';

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

const reportDirs: string[] = [];
afterEach(async () => {
  await Promise.all(reportDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

interface FailoverFixture {
  manager: Loose;
  started: Array<{ agent: string; model?: string }>;
  transient: Array<{ type: string; data: Record<string, unknown> }>;
  reportsDir: string;
}

function failoverManager(input: {
  accounts?: (string | { wrapper: string; model?: string })[];
  policy?: 'fallback' | 'round_robin';
  usage?: Array<Record<string, unknown>>;
  startError?: (agent: string) => Error | undefined;
  failoverState?: Record<string, unknown>;
  maxAssignedWardens?: number;
  returnedView?: {
    binary?: string;
    model?: string;
    harness?: 'claude' | 'codex';
    observedModel?: string;
    createdAt?: string;
  };
  beforeFirstTurn?: (reportsDir: string) => void | Promise<void>;
  afterStart?: (reportsDir: string) => void | Promise<void>;
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
  const reportsDir = `/tmp/kteam-warden-failover-test-${crypto.randomUUID()}`;
  reportDirs.push(reportsDir);
  manager.paths = {
    home: '/tmp',
    wardenAnomalies: path.join(reportsDir, 'anomalies.json'),
    wardenReports: reportsDir,
    kfleetBin: '/nonexistent-kfleet-bin',
  };
  manager.saveWardenState = async () => undefined;
  manager.emitTransient = (type: string, data: Record<string, unknown>) => {
    transient.push({ type, data });
  };
  manager.fetchUsageAccounts = async () => input.usage ?? [];
  manager.buildAssignedWardenPrompt = () => 'investigate';
  manager.buildWardenPrompt = async () => 'triage';
  let counter = 0;
  manager.start = async (
    request: { agent: string; model?: string },
    hooks?: {
      beforeFirstTurn?: (view: Record<string, unknown>) => Promise<void>;
      onBootstrapFailure?: () => Promise<void>;
    },
  ) => {
    const error = input.startError?.(request.agent);
    if (error) throw error;
    const id = `warden-${++counter}`;
    started.push({ agent: request.agent, model: request.model });
    const returned = input.returnedView ?? {};
    const view = {
      config: {
        id,
        teammate: id,
        binary: returned.binary ?? request.agent,
        harness: returned.harness ?? (request.agent.startsWith('codex-') ? 'codex' : 'claude'),
        model: Object.hasOwn(returned, 'model') ? returned.model : request.model,
        createdAt: returned.createdAt ?? `2026-07-28T12:34:56.00${counter}Z`,
      },
      state: { status: 'running', observedModel: returned.observedModel },
      directory: `/x/${id}`,
    };
    try {
      await input.beforeFirstTurn?.(reportsDir);
      await hooks?.beforeFirstTurn?.(view);
      // Test boundary standing in for prompt delivery: mandatory provenance
      // must already exist when this callback runs.
      await input.afterStart?.(reportsDir);
      return view;
    } catch (error) {
      await hooks?.onBootstrapFailure?.().catch(() => undefined);
      throw error;
    }
  };
  return { manager, started, transient, reportsDir };
}

const readOnlySidecar = async (reportsDir: string): Promise<WardenSpawnProvenance> => {
  const names = (await readdir(reportsDir)).filter(name => name.endsWith('.md.meta.json'));
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(path.join(reportsDir, names[0]!), 'utf8')) as WardenSpawnProvenance;
};

const spawnMeta = (over: Partial<WardenSpawnProvenance> = {}): WardenSpawnProvenance => ({
  v: 1,
  at: '2026-07-28T12:34:56.789Z',
  wardenSessionId: 'warden-1',
  wrapper: 'claude-auto-b',
  model: 'claude-opus-4-8',
  modelSource: 'harness',
  harness: 'claude',
  policy: 'fallback',
  selection: 'failover',
  configuredFirst: 'claude-auto-a',
  skipped: { 'claude-auto-a': 'at its usage limit (kfleet feed)' },
  failedOver: true,
  ...over,
});

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
  test('reconciles a dead assignment even when no suspect remains', async () => {
    const { manager } = failoverManager({});
    manager.wardenState = {
      assignments: {
        t1: {
          wardenId: 'warden-gone',
          spawnedAt: '2026-07-28T10:00:00.000Z',
          capability: 'capability',
        },
      },
    };
    expect(await spawnAssigned(manager, [], [target('t1')])).toEqual([]);
    const state = manager.wardenState as {
      assignments?: Record<string, unknown>;
      assignedCooldowns?: Record<string, string>;
    };
    expect(state.assignments).toEqual({});
    expect(state.assignedCooldowns?.t1).toBeDefined();
  });

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

  test('successful assigned spawn writes returned SessionView facts and exact failover evidence', async () => {
    const { manager, reportsDir } = failoverManager({
      accounts: ['claude-auto-a', 'claude-auto-b'],
      usage: [{ binary: 'claude-auto-a', atLimit: true }],
      returnedView: {
        binary: 'codex-auto-returned',
        harness: 'codex',
        model: 'configured-returned',
        observedModel: 'gpt-5.6-sol-observed',
        createdAt: '2026-07-28T14:15:16.123Z',
      },
    });
    await spawnAssigned(manager, [sus('t1')], [target('t1')]);
    expect(await readOnlySidecar(reportsDir)).toEqual({
      v: 1,
      at: '2026-07-28T14:15:16.123Z',
      wardenSessionId: 'warden-1',
      target: 't1',
      wrapper: 'codex-auto-returned',
      model: 'gpt-5.6-sol-observed',
      modelSource: 'harness',
      harness: 'codex',
      policy: 'fallback',
      selection: 'failover',
      configuredFirst: 'claude-auto-a',
      skipped: { 'claude-auto-a': 'at its usage limit (kfleet feed)' },
      failedOver: true,
    });
  });

  test('assigned provenance exists before the first-turn delivery boundary', async () => {
    let presentBeforePrompt = false;
    const { manager } = failoverManager({
      afterStart: async reportsDir => {
        presentBeforePrompt = (await readdir(reportsDir)).some(name => name.endsWith('.md.meta.json'));
      },
    });
    await spawnAssigned(manager, [sus('t1')], [target('t1')]);
    expect(presentBeforePrompt).toBe(true);
  });

  test('failed assigned spawn leaves no provenance sidecar', async () => {
    const { manager, reportsDir } = failoverManager({
      startError: () => new Error('launch failed'),
    });
    await spawnAssigned(manager, [sus('t1')], [target('t1')]);
    expect((await readdir(reportsDir)).filter(name => name.endsWith('.meta.json'))).toEqual([]);
  });

  test('a pre-prompt provenance failure is not blamed on the wrapper', async () => {
    const { manager, reportsDir, transient } = failoverManager({
      beforeFirstTurn: async dir => {
        await rm(dir, { recursive: true, force: true });
        await writeFile(dir, 'not a directory');
      },
    });
    expect(await spawnAssigned(manager, [sus('t1')], [target('t1')])).toEqual([]);
    const state = manager.wardenState as { failover?: { strikes?: Record<string, unknown> } };
    expect(state.failover?.strikes?.['claude-auto-a']).toBeUndefined();
    expect(transient.some(item => item.type === 'fleet.warden_provenance_failed')).toBe(true);
    expect(transient.some(item => item.type === 'fleet.warden_spawn_failed')).toBe(false);
    expect(await readFile(reportsDir, 'utf8')).toBe('not a directory');
  });

  test('sidecar write failure never strikes or loses an already-live assigned warden', async () => {
    const { manager, reportsDir, transient } = failoverManager({
      afterStart: async dir => {
        await rm(dir, { recursive: true, force: true });
        await writeFile(dir, 'not a directory');
      },
    });
    expect(await spawnAssigned(manager, [sus('t1')], [target('t1')])).toEqual(['warden-1']);
    const state = manager.wardenState as {
      assignments?: Record<string, { wardenId: string }>;
      assignedCooldowns?: Record<string, string>;
      failover?: { strikes?: Record<string, unknown> };
    };
    expect(state.assignments?.t1?.wardenId).toBe('warden-1');
    expect(state.assignedCooldowns?.t1).toBeUndefined();
    expect(state.failover?.strikes?.['claude-auto-a']).toBeUndefined();
    expect(transient.some(item => item.type === 'fleet.warden_provenance_failed')).toBe(true);
    expect(await readFile(reportsDir, 'utf8')).toBe('not a directory');
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

  test('a queued target keeps its exact kind when it becomes a live assignment', async () => {
    const { manager } = failoverManager({});
    manager.wardenState = {
      assignedQueue: [{ ...sus('t1'), kind: 'sus_subprocess' }],
    };
    expect(await spawnAssigned(manager, [], [target('t1')])).toEqual(['warden-1']);
    const state = manager.wardenState as {
      assignments?: Record<string, { kinds?: string[] }>;
    };
    expect(state.assignments?.t1?.kinds).toEqual(['sus_subprocess']);
  });

  test('one assigned prompt marks only its selected same-session kind pending', async () => {
    const { manager } = failoverManager({});
    const promptedKinds: string[] = [];
    manager.buildAssignedWardenPrompt = (anomaly: { kind: string }) => {
      promptedKinds.push(anomaly.kind);
      return 'investigate';
    };
    await spawnAssigned(manager, [sus('t1'), { ...sus('t1'), kind: 'sus_subprocess' }], [target('t1')]);
    const state = manager.wardenState as {
      assignments?: Record<string, { kinds?: string[] }>;
    };
    expect(promptedKinds).toEqual(['sus_subprocess']);
    expect(state.assignments?.t1?.kinds).toEqual(['sus_subprocess']);
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
    const { manager, reportsDir, transient } = failoverManager({
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
    expect((await readdir(reportsDir)).filter(name => name.endsWith('.meta.json'))).toEqual([]);
  });

  test('a fleet pre-prompt provenance failure is not a wrapper strike', async () => {
    const { manager, transient } = failoverManager({
      beforeFirstTurn: async dir => {
        await rm(dir, { recursive: true, force: true });
        await writeFile(dir, 'not a directory');
      },
    });
    manager.list = async () => [];
    const result = await escalate(manager, [sus('t1')], 'fp-1', [target('t1')], true);
    expect(result.message).toContain('mandatory warden provenance');
    const state = manager.wardenState as { failover?: { strikes?: Record<string, unknown> } };
    expect(state.failover?.strikes?.['claude-auto-a']).toBeUndefined();
    expect(transient.some(item => item.type === 'fleet.warden_provenance_failed')).toBe(true);
    expect(transient.some(item => item.type === 'fleet.warden_spawn_failed')).toBe(false);
  });

  test('successful fleet sweep writes returned SessionView provenance', async () => {
    const { manager, reportsDir } = failoverManager({
      returnedView: {
        binary: 'claude-auto-glm52a',
        harness: 'claude',
        model: 'opus',
        createdAt: '2026-07-28T15:16:17.456Z',
      },
    });
    manager.list = async () => [];
    const result = await escalate(manager, [sus('t1')], 'fp-1', [target('t1')], true);
    expect(result.spawned).toBe('warden-1');
    expect(await readOnlySidecar(reportsDir)).toEqual({
      v: 1,
      at: '2026-07-28T15:16:17.456Z',
      wardenSessionId: 'warden-1',
      wrapper: 'claude-auto-glm52a',
      model: 'glm-5.2',
      modelSource: 'wrapper',
      harness: 'claude',
      policy: 'fallback',
      selection: 'preferred',
      configuredFirst: 'claude-auto-a',
      skipped: {},
      failedOver: false,
    });
  });

  test('fleet provenance exists before the first-turn delivery boundary', async () => {
    let presentBeforePrompt = false;
    const { manager } = failoverManager({
      afterStart: async reportsDir => {
        presentBeforePrompt = (await readdir(reportsDir)).some(name => name.endsWith('.md.meta.json'));
      },
    });
    manager.list = async () => [];
    await escalate(manager, [sus('t1')], 'fp-1', [target('t1')], true);
    expect(presentBeforePrompt).toBe(true);
  });

  test('sidecar write failure never turns a successful sweep launch into a wrapper failure', async () => {
    const { manager, reportsDir, transient } = failoverManager({
      afterStart: async dir => {
        await rm(dir, { recursive: true, force: true });
        await writeFile(dir, 'not a directory');
      },
    });
    manager.list = async () => [];
    const result = await escalate(manager, [sus('t1')], 'fp-1', [target('t1')], true);
    expect(result.spawned).toBe('warden-1');
    const state = manager.wardenState as {
      lastSpawnFingerprint?: string;
      failover?: { strikes?: Record<string, unknown> };
    };
    expect(state.lastSpawnFingerprint).toBe('0:fp-1');
    expect(state.failover?.strikes?.['claude-auto-a']).toBeUndefined();
    expect(transient.some(item => item.type === 'fleet.warden_provenance_failed')).toBe(true);
    expect(transient.some(item => item.type === 'fleet.warden_spawn_failed')).toBe(false);
    expect(await readFile(reportsDir, 'utf8')).toBe('not a directory');
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

describe('warden report serving and prompts', () => {
  test('legacy needs-human state suppresses no anomaly without an exact known kind', () => {
    expect(needsHumanCoversAnomaly(undefined, 'sus_subprocess')).toBe(false);
    expect(needsHumanCoversAnomaly('not-a-warden-kind', 'sus_subprocess')).toBe(false);
    expect(needsHumanCoversAnomaly('sus_thinking', 'sus_subprocess')).toBe(false);
    expect(needsHumanCoversAnomaly('sus_subprocess', 'sus_subprocess')).toBe(true);
    const plural = {
      needsHumanRequests: [
        { reason: 'one', anomalyKind: 'sus_thinking', reportPath: '/r.md', at: 'now' },
        { reason: 'two', anomalyKind: 'sus_subprocess', reportPath: '/r.md', at: 'now' },
      ],
    };
    expect(needsHumanStateCoversAnomaly(plural, 'sus_thinking')).toBe(true);
    expect(needsHumanStateCoversAnomaly(plural, 'sus_subprocess')).toBe(true);
    expect(needsHumanStateCoversAnomaly(plural, 'unattended_question')).toBe(false);
  });

  test('serves old markdown byte-for-byte, then merges and attaches a valid sidecar', async () => {
    const { manager, reportsDir } = failoverManager({});
    await mkdir(reportsDir, { recursive: true });
    const report = path.join(reportsDir, '2026-07-28T12-34-56-789Z-target-12345678.md');
    const content = 'Verdict: LEAVE\n\n# Warden report — target-12345678\n\n## Summary\n- **Outcome:** Fine.\n';
    await writeFile(report, content);
    const service = manager as unknown as {
      wardenReport: (reportPath: string) => Promise<string>;
      wardenVerdicts: (limit?: number) => Promise<Array<{ spawn?: WardenVerdictSpawn }>>;
      latestReport: () => Promise<{ path: string; head: string } | undefined>;
    };
    expect(await service.wardenReport(report)).toBe(content);

    const meta = spawnMeta({ target: 'target-12345678' });
    await atomicJson(provenancePath(report), meta);
    const merged = await service.wardenReport(report);
    expect(merged).toStartWith('## Who ran this check\n');
    expect(merged).toEndWith(content);
    expect((await service.wardenVerdicts())[0]?.spawn).toEqual({
      ...meta,
      failoverReason: 'at its usage limit (kfleet feed)',
    });
    expect((await service.latestReport())?.head).toStartWith('## Who ran this check\n');

    await writeFile(provenancePath(report), '{ invalid json');
    await expect(service.wardenReport(report)).rejects.toThrow('invalid warden provenance sidecar');
    await expect(service.wardenReport(report)).rejects.not.toThrow('report not found');
    await expect(service.latestReport()).rejects.toThrow('invalid warden provenance sidecar');
  });

  test('needs-human reconciliation targets the session event used by AttentionSources', async () => {
    const manager = bareManager();
    const events: Array<{ sessionId: string; type: string; data: unknown }> = [];
    manager.transientSequence = 0;
    manager.listeners = new Set([(event: { sessionId: string; type: string; data: unknown }) => events.push(event)]);
    manager.lastSweep = {
      at: '2026-07-28T12:34:55.000Z',
      fingerprint: 'sus_thinking:target-1|sus_subprocess:target-1',
      anomalies: [sus('target-1'), { ...sus('target-1'), kind: 'sus_subprocess' }],
    };
    manager.wardenVerdicts = async () => [
      {
        at: '2026-07-28T12:34:56.789Z',
        targetSession: 'target-1',
        anomalyKind: 'sus_subprocess',
        verdict: 'needs_human',
        reason: 'Only the human can choose the rollout path.',
        reportPath: '/reports/needs-human.md',
      },
    ];
    manager.store = {
      updateState: async (_id: string, update: (state: Record<string, unknown>) => Record<string, unknown>) =>
        update({ status: 'running' }),
    };
    const view = target('target-1');
    await (manager as unknown as { reconcileNeedsHuman: (sessions: unknown[]) => Promise<void> }).reconcileNeedsHuman([
      view,
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 'target-1',
      type: 'fleet.needs_human',
      data: {
        sessionId: 'target-1',
        reason: 'Only the human can choose the rollout path.',
        reportPath: '/reports/needs-human.md',
      },
    });
    expect((view.state as { needsHumanKind?: string }).needsHumanKind).toBe('sus_subprocess');
    expect((view.state as { needsHumanReportPath?: string }).needsHumanReportPath).toBe('/reports/needs-human.md');
    expect((view.state as { needsHumanRequests?: unknown[] }).needsHumanRequests).toEqual([
      {
        reason: 'Only the human can choose the rollout path.',
        anomalyKind: 'sus_subprocess',
        reportPath: '/reports/needs-human.md',
        at: '2026-07-28T12:34:56.789Z',
      },
    ]);
  });

  test('two needs-human blocks in one report stay durable and kind-distinct', async () => {
    const manager = bareManager();
    const events: Array<{ data: { anomalyKind?: string } }> = [];
    manager.transientSequence = 0;
    manager.listeners = new Set([(event: { data: { anomalyKind?: string } }) => events.push(event)]);
    manager.wardenVerdicts = async () => [
      {
        at: '2026-07-28T12:34:56.789Z',
        targetSession: 'target-1',
        anomalyKind: 'sus_subprocess',
        verdict: 'needs_human',
        reason: 'Choose whether to interrupt the subprocess.',
        reportPath: '/reports/two-blocks.md',
      },
      {
        at: '2026-07-28T12:34:56.789Z',
        targetSession: 'target-1',
        anomalyKind: 'sus_thinking',
        verdict: 'needs_human',
        reason: 'Choose whether thinking should continue.',
        reportPath: '/reports/two-blocks.md',
      },
    ];
    let persisted: Record<string, unknown> = { status: 'running' };
    manager.store = {
      updateState: async (_id: string, update: (state: Record<string, unknown>) => Record<string, unknown>) => {
        persisted = update(persisted);
        return persisted;
      },
    };
    const view = target('target-1');

    await (manager as unknown as { reconcileNeedsHuman: (sessions: unknown[]) => Promise<void> }).reconcileNeedsHuman([
      view,
    ]);

    expect(persisted.needsHumanRequests).toEqual([
      expect.objectContaining({ reportPath: '/reports/two-blocks.md', anomalyKind: 'sus_subprocess' }),
      expect.objectContaining({ reportPath: '/reports/two-blocks.md', anomalyKind: 'sus_thinking' }),
    ]);
    expect(events.map(event => event.data.anomalyKind)).toEqual(['sus_subprocess', 'sus_thinking']);

    await (manager as unknown as { reconcileNeedsHuman: (sessions: unknown[]) => Promise<void> }).reconcileNeedsHuman([
      view,
    ]);
    expect(events).toHaveLength(2);
  });

  test('an exact verdict upgrades legacy kindless and unparsed needs-human flags', async () => {
    for (const legacyKind of [undefined, 'legacy_unknown']) {
      const manager = bareManager();
      manager.transientSequence = 0;
      manager.listeners = new Set();
      manager.wardenVerdicts = async () => [
        {
          at: '2026-07-28T12:34:56.789Z',
          targetSession: 'target-1',
          anomalyKind: 'sus_subprocess',
          verdict: 'needs_human',
          reason: 'Only the human can choose the rollout path.',
          reportPath: '/reports/needs-human.md',
        },
      ];
      let persisted: Record<string, unknown> = {
        status: 'running',
        needsHuman: 'Legacy request without exact identity.',
        needsHumanKind: legacyKind,
      };
      manager.store = {
        updateState: async (_id: string, update: (state: Record<string, unknown>) => Record<string, unknown>) => {
          persisted = update(persisted);
          return persisted;
        },
      };
      const view = target('target-1');
      Object.assign(view.state, persisted);

      await (manager as unknown as { reconcileNeedsHuman: (sessions: unknown[]) => Promise<void> }).reconcileNeedsHuman(
        [view],
      );

      expect(persisted).toMatchObject({
        needsHuman: 'Only the human can choose the rollout path.',
        needsHumanKind: 'sus_subprocess',
        needsHumanReportPath: '/reports/needs-human.md',
        needsHumanRequests: [
          expect.objectContaining({
            anomalyKind: 'sus_subprocess',
            reportPath: '/reports/needs-human.md',
          }),
        ],
      });
    }
  });

  test('a cleared legacy report acknowledgement covers its newly parsed exact kind', async () => {
    const manager = bareManager();
    let writes = 0;
    let persisted: Record<string, unknown> = {
      status: 'running',
      needsHuman: 'Legacy request.',
      needsHumanReportPath: '/reports/legacy.md',
    };
    manager.store = {
      updateState: async (_id: string, update: (state: Record<string, unknown>) => Record<string, unknown>) => {
        writes++;
        persisted = update(persisted);
        return persisted;
      },
    };
    await (manager as unknown as { clearNeedsHuman: (id: string) => Promise<void> }).clearNeedsHuman('target-1');
    expect(persisted.needsHumanAcknowledgedRequests).toEqual([{ reportPath: '/reports/legacy.md' }]);
    manager.wardenVerdicts = async () => [
      {
        at: '2026-07-28T12:34:56.789Z',
        targetSession: 'target-1',
        anomalyKind: 'sus_subprocess',
        verdict: 'needs_human',
        reason: 'Now parsed exactly.',
        reportPath: '/reports/legacy.md',
      },
    ];
    manager.listeners = new Set();
    manager.transientSequence = 0;
    const view = target('target-1');
    Object.assign(view.state, persisted);
    await (manager as unknown as { reconcileNeedsHuman: (sessions: unknown[]) => Promise<void> }).reconcileNeedsHuman([
      view,
    ]);
    expect(persisted.needsHuman).toBeUndefined();
    expect(persisted.needsHumanRequests).toBeUndefined();
    expect(writes).toBe(1);
  });

  test('corrupt anomaly state rejects instead of becoming an empty clean sweep', async () => {
    const { manager, reportsDir } = failoverManager({});
    await mkdir(reportsDir, { recursive: true });
    await writeFile(path.join(reportsDir, 'anomalies.json'), '{ not json');
    expect((manager as unknown as { wardenAnomalies: () => Promise<unknown[]> }).wardenAnomalies()).rejects.toThrow();
  });

  test('an unreadable reports path does not masquerade as no latest report', async () => {
    const { manager, reportsDir } = failoverManager({});
    await writeFile(reportsDir, 'not a directory');
    expect((manager as unknown as { latestReport: () => Promise<unknown> }).latestReport()).rejects.toThrow();
  });

  test('both report prompts require point form and complete provenance', async () => {
    const manager = bareManager();
    manager.paths = { wardenAnomalies: '/tmp/warden-anomalies.json', kfleetBin: '/nonexistent-kfleet-bin' };
    manager.fetchUsageAccounts = async () => [];
    const assignedReport = '/tmp/assigned.md';
    const sweepReport = '/tmp/sweep.md';
    const assigned = (
      manager as unknown as {
        buildAssignedWardenPrompt: (anomaly: unknown, target: unknown, reportPath: string) => string;
      }
    ).buildAssignedWardenPrompt(sus('t1'), target('t1'), assignedReport);
    const sweep = await (
      manager as unknown as {
        buildWardenPrompt: (
          anomalies: unknown[],
          sessions: unknown[],
          reportPath: string,
          at: string,
        ) => Promise<string>;
      }
    ).buildWardenPrompt([sus('t1')], [target('t1')], sweepReport, '2026-07-28T12:34:56.789Z');

    for (const [prompt, report] of [
      [assigned, assignedReport],
      [sweep, sweepReport],
    ]) {
      expect(prompt).toContain('- Lead with the outcome.');
      expect(prompt).toContain('- Use point form only.');
      expect(prompt).toContain('- Bold one key value per bullet.');
      expect(prompt).toContain('- Include the exact CLI, resolved model, and harness.');
      expect(prompt).toContain('- Include whether failover happened.');
      expect(prompt).toContain('- If failover happened, include the original CLI and exact daemon reason.');
      expect(prompt).toContain(provenancePath(report));
      expect(prompt).toContain('NEEDS_HUMAN');
    }
    expect(sweep).toContain('section per anomaly record');
    expect(sweep).toContain('repeat a session in separate sections when it has multiple anomaly kinds');
    expect(sweep).toContain('inside EVERY anomaly section');
    expect(sweep).toContain('Never use one fleet-wide verdict');
    expect(assigned).toContain('- **Anomaly kind:** sus_thinking');
    expect(sweep).toContain('- **Anomaly kind:** <kind>');
  });
});

describe('wardenRunView shape (WardenRunView import sanity)', () => {
  test('run view fields stay optional', () => {
    const view: WardenRunView = { sweptAt: 'x', anomalies: [] };
    expect(view.spawned).toBeUndefined();
  });
});
