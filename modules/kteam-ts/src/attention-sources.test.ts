import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createPaths, sessionDir, type KTeamPaths } from './paths';
import type { SessionView } from './service';
import type { KTeamEvent } from './types';
import { MAX_TASK_NOTE_LEN, type ScopedTaskSummary, type SessionTaskListResponse } from './tasks-types';
import { AttentionService } from './attention-service';
import { AttentionSources } from './attention-sources';
import type { AttentionSnapshot } from './attention-types';
import type { WardenAnomaly } from './warden-detect';

const SID = 'ms3g6a8p-71542ce1';
const LEAD = 'ms2bkdxy-c845508e';
let home: string;
let paths: KTeamPaths;

function view(question = true): SessionView {
  return {
    config: {
      id: SID,
      name: 'Attention Test',
      teammate: 'zoe',
      binary: 'codex-auto-loge',
      harness: 'codex',
      modelHint: '',
      mode: 'auto',
      cwd: '/tmp',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
      turn: 1,
      harnessSessionId: 'h',
      tmuxSession: 't',
      watcherSession: 'w',
      intervalSeconds: 1,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 3,
      systemPromptFile: '/tmp/system',
      originalPromptFile: '/tmp/prompt',
    },
    state: {
      id: SID,
      status: question ? 'awaiting_question' : 'running',
      turn: 1,
      lastActivityAt: '2026-07-28T00:01:00.000Z',
      ...(question
        ? {
            pendingQuestion: {
              toolUseId: 'q1',
              questions: [{ question: 'Ship the release?', options: [] }],
            },
          }
        : {}),
    },
    directory: `/tmp/${SID}`,
  };
}

function task(status: 'blocked' | 'in_progress'): ScopedTaskSummary {
  return {
    v: 1,
    id: 'F31',
    kind: 'feature',
    title: 'Ship release',
    status,
    statusReason: status === 'blocked' ? 'Need the region.' : null,
    assignee: SID,
    repo: '/tmp',
    links: { prs: [], branch: null, commits: [], docs: [] },
    order: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    createdBy: SID,
    updatedAt: '2026-07-28T00:02:00.000Z',
    live: {
      assigneeStatus: 'running',
      assigneeHealth: 'active',
      assigneeDoneMarker: false,
      assigneeLastActivityAt: '2026-07-28T00:02:00.000Z',
      staleness: null,
    },
    descriptionChars: 0,
    sessionId: SID,
  } as unknown as ScopedTaskSummary;
}

const taskSnapshot = (status: 'blocked' | 'in_progress'): SessionTaskListResponse => ({
  v: 1,
  sessionId: SID,
  tasks: [task(status)],
  parseErrors: 0,
  updatedAt: '2026-07-28T00:02:00.000Z',
});

const taskV2Snapshot = (blockedBy: string[]): SessionTaskListResponse => ({
  ...taskSnapshot('in_progress'),
  tasks: [
    {
      ...task('in_progress'),
      blocked: true,
      blockedReason: blockedBy.length === 0 ? 'Need design approval.' : 'Waiting for dependencies.',
      blockedSince: '2026-07-28T00:01:30.000Z',
      blockedBy,
    } as ScopedTaskSummary,
  ],
});

class Sessions {
  current = view();
  anomalies: WardenAnomaly[] = [];
  listeners = new Set<(event: KTeamEvent) => void>();
  list = async () => [this.current];
  get = async () => this.current;
  wardenAnomalies = async () => this.anomalies;
  subscribe = (listener: (event: KTeamEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(type: string, data: Record<string, unknown>, source: KTeamEvent['source'] = 'client', sessionId = SID): void {
    const event: KTeamEvent = {
      sequence: 1,
      time: '2026-07-28T00:03:00.000Z',
      sessionId,
      turn: 1,
      type,
      source,
      data,
    };
    for (const listener of this.listeners) listener(event);
  }
}

class Tasks {
  current = taskSnapshot('blocked');
  listeners = new Set<(event: KTeamEvent) => void>();
  sessionTaskList = async () => this.current;
  subscribe = (listener: (event: KTeamEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(status: 'blocked' | 'in_progress', source: KTeamEvent['source']): void {
    this.emitSnapshot(taskSnapshot(status), source);
  }
  emitSnapshot(snapshot: SessionTaskListResponse, source: KTeamEvent['source']): void {
    this.current = snapshot;
    const event: KTeamEvent = {
      sequence: 0,
      time: '2026-07-28T00:04:00.000Z',
      sessionId: SID,
      turn: 0,
      type: 'tasks.updated',
      source,
      data: this.current,
    };
    for (const listener of this.listeners) listener(event);
  }
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kteam-attention-sources-'));
  paths = createPaths(home);
  await mkdir(sessionDir(paths, SID), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function harness(initialTasks?: SessionTaskListResponse) {
  const sessions = new Sessions();
  const tasks = new Tasks();
  if (initialTasks) tasks.current = initialTasks;
  const service = new AttentionService(
    paths,
    {
      resolve: async ref =>
        ref === SID ? { id: SID, name: 'zoe' } : ref === LEAD ? { id: LEAD, name: 'zelda' } : null,
    },
    { role: 'daemon' },
  );
  const errors: string[] = [];
  const sources = new AttentionSources(service, sessions, tasks, message => errors.push(message));
  await sources.start();
  return { sessions, tasks, service, sources, errors };
}

const providerAnomaly = (sessionId = SID): WardenAnomaly => ({
  kind: 'provider_unavailable',
  fleetKey: 'provider:claude',
  generation: 1,
  provider: 'claude',
  affectedSessionIds: [sessionId, 'other-session'],
  failureClasses: ['cooling_down'],
  models: ['claude-fable-5'],
  sessionId,
  teammate: 'zoe',
  status: 'running',
  detail: 'provider claude is unavailable in 2 active auto sessions after two deterministic sweeps',
  since: '2026-07-28T00:00:00.000Z',
});

async function boardWhen(
  service: AttentionService,
  accepts: (snapshot: AttentionSnapshot) => boolean,
  timeoutMs = 2_000,
): Promise<AttentionSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await service.list(SID);
  while (!accepts(snapshot) && Date.now() < deadline) {
    await Bun.sleep(10);
    snapshot = await service.list(SID);
  }
  if (!accepts(snapshot)) throw new Error('timed out waiting for attention source dispatch');
  return snapshot;
}

describe('AttentionSources', () => {
  test('a fleet provider anomaly raises one idempotent Attention item on its anchor', async () => {
    const h = await harness();
    const anomaly = providerAnomaly();
    h.sessions.emit('fleet.anomaly', { anomalies: [anomaly] }, 'daemon', 'fleet');
    h.sessions.emit('fleet.anomaly', { anomalies: [anomaly] }, 'daemon', 'fleet');
    const snapshot = await boardWhen(h.service, value =>
      value.items.some(item => item.sourceRef === 'provider-unavailable:provider:claude:1'),
    );
    const providerItems = snapshot.items.filter(item => item.sourceRef === 'provider-unavailable:provider:claude:1');
    expect(providerItems).toHaveLength(1);
    expect(providerItems[0]).toMatchObject({
      source: 'agent-raised',
      subject: 'Provider claude is unavailable (2 sessions)',
      raisedBy: 'daemon',
    });
    h.sources.close();
  });

  test('startup baselines a provider anomaly that fired before Attention subscribed', async () => {
    const sessions = new Sessions();
    sessions.anomalies = [providerAnomaly()];
    const tasks = new Tasks();
    tasks.current = taskSnapshot('in_progress');
    const service = new AttentionService(
      paths,
      { resolve: async ref => (ref === SID ? { id: SID, name: 'zoe' } : null) },
      { role: 'daemon' },
    );
    const sources = new AttentionSources(service, sessions, tasks);
    await sources.start();
    expect((await service.list(SID)).items).toContainEqual(
      expect.objectContaining({ sourceRef: 'provider-unavailable:provider:claude:1' }),
    );
    sources.close();
  });

  test('a recovered provider can raise a fresh Attention generation', async () => {
    const h = await harness();
    h.sessions.emit('fleet.anomaly', { anomalies: [providerAnomaly()] }, 'daemon', 'fleet');
    await boardWhen(h.service, value =>
      value.items.some(item => item.sourceRef === 'provider-unavailable:provider:claude:1'),
    );
    await h.service.resolveFromSource(
      SID,
      'agent-raised',
      'provider-unavailable:provider:claude:1',
      'Provider recovered.',
      { actor: 'user' },
    );
    h.sessions.emit('fleet.anomaly', { anomalies: [{ ...providerAnomaly(), generation: 2 }] }, 'daemon', 'fleet');
    const snapshot = await boardWhen(h.service, value =>
      value.items.some(item => item.sourceRef === 'provider-unavailable:provider:claude:2'),
    );
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({ sourceRef: 'provider-unavailable:provider:claude:2' }),
    );
    h.sources.close();
  });

  test('startup baselines a pending question and blocked task without conflating them', async () => {
    const h = await harness();
    const snapshot = await h.service.list(SID);
    expect(snapshot.items.map(item => item.source)).toEqual(['question', 'task']);
    expect(snapshot.items[0]).toMatchObject({ sourceRef: 'q1', subject: 'Ship the release?' });
    expect(snapshot.items[1]).toMatchObject({ sourceRef: 'F31', why: 'Need the region.' });
    expect(h.errors).toEqual([]);
    h.sources.close();
  });

  test('restart keeps same-report warden blocks distinct without duplicating either', async () => {
    const sessions = new Sessions();
    sessions.current = view(false);
    const tasks = new Tasks();
    tasks.current = taskSnapshot('in_progress');
    const firstService = new AttentionService(
      paths,
      { resolve: async ref => (ref === SID ? { id: SID, name: 'zoe' } : null) },
      { role: 'daemon' },
    );
    const firstSources = new AttentionSources(firstService, sessions, tasks);
    await firstSources.start();
    sessions.emit(
      'fleet.needs_human',
      {
        reason: 'Only the human can choose the rollout path.',
        reportPath: '/reports/needs-human.md',
        anomalyKind: 'sus_subprocess',
      },
      'daemon',
    );
    sessions.emit(
      'fleet.needs_human',
      {
        reason: 'Only the human can decide whether thinking should continue.',
        reportPath: '/reports/needs-human.md',
        anomalyKind: 'sus_thinking',
      },
      'daemon',
    );
    await boardWhen(
      firstService,
      snapshot =>
        snapshot.items.filter(item => item.sourceRef?.startsWith('warden:/reports/needs-human.md#')).length === 2,
    );
    firstSources.close();

    const restartedSessions = new Sessions();
    restartedSessions.current = view(false);
    restartedSessions.current.state.needsHuman = 'Only the human can choose the rollout path.';
    restartedSessions.current.state.needsHumanKind = 'sus_subprocess';
    restartedSessions.current.state.needsHumanReportPath = '/reports/needs-human.md';
    restartedSessions.current.state.needsHumanRequests = [
      {
        reason: 'Only the human can choose the rollout path.',
        anomalyKind: 'sus_subprocess',
        reportPath: '/reports/needs-human.md',
        at: '2026-07-28T00:03:00.000Z',
      },
      {
        reason: 'Only the human can decide whether thinking should continue.',
        anomalyKind: 'sus_thinking',
        reportPath: '/reports/needs-human.md',
        at: '2026-07-28T00:03:00.000Z',
      },
    ];
    const restartedService = new AttentionService(
      paths,
      { resolve: async ref => (ref === SID ? { id: SID, name: 'zoe' } : null) },
      { role: 'daemon' },
    );
    const restartedSources = new AttentionSources(restartedService, restartedSessions, tasks);
    await restartedSources.start();

    const wardenItems = (await restartedService.list(SID)).items.filter(
      item => item.source === 'agent-raised' && item.sourceRef?.startsWith('warden:'),
    );
    expect(wardenItems).toHaveLength(2);
    expect(wardenItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRef: 'warden:/reports/needs-human.md#sus_subprocess',
          why: 'Only the human can choose the rollout path.',
        }),
        expect.objectContaining({
          sourceRef: 'warden:/reports/needs-human.md#sus_thinking',
          why: 'Only the human can decide whether thinking should continue.',
        }),
      ]),
    );
    restartedSources.close();
  });

  test('repeated blocked-task edits refresh one reasoned item and leaving blocked resolves it', async () => {
    const h = await harness();
    const changed: SessionTaskListResponse = {
      ...taskSnapshot('blocked'),
      tasks: [{ ...task('blocked'), statusReason: 'Need the deployment region.' } as ScopedTaskSummary],
    };
    h.tasks.emitSnapshot(changed, `peer:${SID}`);
    h.tasks.emitSnapshot(changed, `peer:${SID}`);
    let snapshot = await boardWhen(
      h.service,
      value => value.items.find(item => item.sourceRef === 'F31')?.why === 'Need the deployment region.',
    );
    expect(snapshot.items.filter(item => item.source === 'task')).toEqual([
      expect.objectContaining({ sourceRef: 'F31', why: 'Need the deployment region.' }),
    ]);

    h.tasks.emit('in_progress', `peer:${SID}`);
    snapshot = await boardWhen(h.service, value => value.resolved.some(item => item.source === 'task'));
    expect(snapshot.items.some(item => item.source === 'task')).toBe(false);
    expect(snapshot.resolved.filter(item => item.source === 'task')).toHaveLength(1);
    h.sources.close();
  });

  test('an immediate blocked then unblocked snapshot cannot leave a late stale item', async () => {
    const h = await harness(taskSnapshot('in_progress'));
    let releaseTaskAdd!: () => void;
    const taskAddGate = new Promise<void>(resolve => {
      releaseTaskAdd = resolve;
    });
    const addFromSource = h.service.addFromSource.bind(h.service);
    h.service.addFromSource = async (sessionId, input) => {
      if (input.source === 'task') await taskAddGate;
      return addFromSource(sessionId, input);
    };

    // No delay between authoritative states: the first add stays in flight
    // while the second event is dispatched.
    h.tasks.emit('blocked', `peer:${SID}`);
    h.tasks.emit('in_progress', `peer:${SID}`);
    releaseTaskAdd();

    const snapshot = await boardWhen(
      h.service,
      value => value.items.every(item => item.source !== 'task') && value.resolved.some(item => item.source === 'task'),
    );
    expect(snapshot.items.some(item => item.source === 'task')).toBe(false);
    expect(snapshot.resolved.filter(item => item.source === 'task')).toHaveLength(1);
    expect(h.errors).toEqual([]);
    h.sources.close();
  });

  test('a maximum-length valid task reason still reaches Attention intact', async () => {
    const reason = 'r'.repeat(MAX_TASK_NOTE_LEN);
    const initial: SessionTaskListResponse = {
      ...taskSnapshot('blocked'),
      tasks: [{ ...task('blocked'), statusReason: reason } as ScopedTaskSummary],
    };
    const h = await harness(initial);
    expect((await h.service.list(SID)).items.find(item => item.source === 'task')?.why).toBe(reason);
    expect(h.errors).toEqual([]);
    h.sources.close();
  });

  test('Task v2 raises direct human blockers but not dependency-only blockers', async () => {
    const h = await harness(taskV2Snapshot([]));
    let snapshot = await h.service.list(SID);
    expect(snapshot.items.find(item => item.source === 'task')).toMatchObject({
      subject: '#F31: Ship release',
      why: 'Need design approval.',
      waitingSince: '2026-07-28T00:01:30.000Z',
    });
    h.tasks.emitSnapshot(taskV2Snapshot(['F30']), `peer:${SID}`);
    snapshot = await boardWhen(h.service, value => value.resolved.some(item => item.source === 'task'));
    expect(snapshot.items.some(item => item.source === 'task')).toBe(false);
    h.sources.close();
  });

  test('an explicit task status change resolves with the action actor', async () => {
    const h = await harness();
    h.tasks.emit('in_progress', `peer:${SID}`);
    const snapshot = await boardWhen(h.service, value => value.resolved.some(item => item.source === 'task'));
    const resolution = snapshot.resolved.find(item => item.source === 'task');
    expect(resolution).toMatchObject({ resolvedBy: 'agent', resolvedBySession: SID });
    expect(snapshot.items.some(item => item.source === 'question')).toBe(true);
    h.sources.close();
  });

  test('successful answer resolves the question; answer_failed never self-clears it', async () => {
    const h = await harness();
    h.sessions.emit('interaction.answer_failed', { toolUseId: 'q1' });
    expect((await h.service.list(SID)).items.some(item => item.source === 'question')).toBe(true);
    h.sessions.emit('interaction.answer', { toolUseId: 'q1' });
    const snapshot = await boardWhen(h.service, value => value.resolved.some(item => item.source === 'question'));
    expect(snapshot.items.some(item => item.source === 'question')).toBe(false);
    expect(snapshot.resolved.find(item => item.source === 'question')).toMatchObject({ resolvedBy: 'human' });
    h.sources.close();
  });

  test("a lead's explicit answer resolves the teammate item and records the lead", async () => {
    const h = await harness();
    h.sessions.emit('interaction.answer', { toolUseId: 'q1' }, `peer:${LEAD}`);
    const snapshot = await boardWhen(h.service, value => value.resolved.some(item => item.source === 'question'));
    expect(snapshot.resolved.find(item => item.source === 'question')).toMatchObject({
      resolvedBy: 'agent',
      resolvedBySession: LEAD,
      resolvedByName: 'zelda',
    });
    h.sources.close();
  });

  test('permission request and explicit grant create/resolve through the durable board', async () => {
    const h = await harness();
    h.sessions.emit('interaction.permission_requested', {
      requestId: 'p1',
      subject: 'Allow production deploy?',
      reason: 'Release is ready.',
    });
    const requested = await boardWhen(h.service, value => value.items.some(item => item.source === 'permission'));
    expect(requested.items.find(item => item.source === 'permission')).toMatchObject({
      sourceRef: 'p1',
    });
    h.sessions.emit('interaction.permission_granted', { requestId: 'p1' });
    const granted = await boardWhen(h.service, value => value.resolved.some(item => item.source === 'permission'));
    expect(granted.resolved.find(item => item.source === 'permission')).toMatchObject({
      resolvedBy: 'human',
    });
    h.sources.close();
  });

  test('startup reconciles explicit task/question actions completed while the daemon was down', async () => {
    const first = await harness();
    expect((await first.service.list(SID)).count).toBe(2);
    first.sources.close();

    const sessions = new Sessions();
    sessions.current = view(false);
    const tasks = new Tasks();
    tasks.current = taskSnapshot('in_progress');
    const restarted = new AttentionService(
      paths,
      { resolve: async ref => (ref === SID ? { id: SID, name: 'zoe' } : null) },
      { role: 'daemon' },
    );
    const errors: string[] = [];
    const sources = new AttentionSources(restarted, sessions, tasks, message => errors.push(message));
    await sources.start();

    const snapshot = await restarted.list(SID);
    expect(snapshot.count).toBe(0);
    expect(snapshot.resolved.map(item => item.source).sort()).toEqual(['question', 'task']);
    expect(snapshot.resolved.every(item => item.resolvedBy === 'daemon')).toBe(true);
    expect(errors).toEqual([]);
    sources.close();
  });
});
