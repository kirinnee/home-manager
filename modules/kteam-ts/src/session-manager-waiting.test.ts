import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, lifecycleSuspended, parseDeadline, turnCeilingMs } from './session-manager';
import { detectAnomalies } from './warden-detect';
import type { SessionConfig, SessionState } from './types';

// Declared waits (`kteam signal waiting`). Before this, a parked custodian was
// indistinguishable from a dead one: nudge at 180 s, kill at 300 s, and a 4 h
// turn ceiling that reaped long-suite babysitters (2026-07-23: four cap-kills
// and four park-loops in one night). A declared wait suspends both, stays
// visible through heartbeats, and ENDS by waking the teammate.

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type Loose = Record<string, unknown>;

function bareManager(): Loose {
  return Object.create(SessionManager.prototype) as Loose;
}

interface WaitHarness {
  manager: Loose;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  transitions: Array<{ patch: Partial<SessionState>; event: string }>;
  sent: string[];
  state: () => SessionState;
  directory: string;
}

async function waitingManager(initial: Partial<SessionState> = {}): Promise<WaitHarness> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-waiting-test-'));
  temporaryDirectories.push(home);
  const directory = path.join(home, 's1');
  await mkdir(path.join(directory, 'markers'), { recursive: true });
  await mkdir(path.join(directory, 'checks'), { recursive: true });

  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const transitions: Array<{ patch: Partial<SessionState>; event: string }> = [];
  const sent: string[] = [];
  let state = { id: 's1', status: 'running', turn: 3, ...initial } as SessionState;
  const config = { id: 's1', turn: 3, tmuxSession: 'kteam-s1-agent' } as SessionConfig;

  const manager = bareManager();
  manager.paths = { home, sessions: home };
  manager.waitingHeartbeats = new Map<string, number>();
  manager.get = async () => ({ config, state, directory });
  manager.transition = async (_id: string, patch: Partial<SessionState>, event: string) => {
    transitions.push({ patch, event });
    state = { ...state, ...patch };
  };
  manager.emit = async (_id: string, type: string, data: Record<string, unknown>) => {
    events.push({ type, data });
  };
  manager.tmux = {
    send: async (_config: SessionConfig, message: string) => {
      sent.push(message);
    },
  };
  return { manager, events, transitions, sent, state: () => state, directory };
}

const declare = (harness: WaitHarness, options: { until?: string; condition?: string } = {}, message?: string) =>
  (
    harness.manager as unknown as {
      applyWaitingSignal: (
        view: unknown,
        kind: 'waiting' | 'working',
        message: string | undefined,
        options: { until?: string; condition?: string },
      ) => Promise<unknown>;
    }
  ).applyWaitingSignal(
    { config: { id: 's1', turn: 3 }, state: harness.state(), directory: harness.directory },
    'waiting',
    message,
    options,
  );

const service = (harness: WaitHarness) =>
  (harness.manager as unknown as { serviceWaiting: (view: unknown) => Promise<void> }).serviceWaiting({
    config: { id: 's1', tmuxSession: 'kteam-s1-agent' },
    state: harness.state(),
    directory: harness.directory,
  });

describe('parseDeadline', () => {
  const base = Date.parse('2026-07-23T12:00:00.000Z');

  test('reads durations and ISO timestamps', () => {
    expect(parseDeadline('45m', base)).toBe('2026-07-23T12:45:00.000Z');
    expect(parseDeadline('2h', base)).toBe('2026-07-23T14:00:00.000Z');
    expect(parseDeadline('1h30m', base)).toBe('2026-07-23T13:30:00.000Z');
    expect(parseDeadline('90s', base)).toBe('2026-07-23T12:01:30.000Z');
    expect(parseDeadline('2026-07-23T15:00:00.000Z', base)).toBe('2026-07-23T15:00:00.000Z');
  });

  test('every wait is clamped to the backstop, however far out it was declared', () => {
    // A park must always end within a bounded time of being declared.
    expect(parseDeadline('2026-07-25T00:00:00.000Z', base)).toBe('2026-07-23T16:00:00.000Z');
    expect(parseDeadline('12h', base)).toBe('2026-07-23T16:00:00.000Z');
  });

  test('a bare number is a TYPO, not the year 2045', () => {
    // Date.parse("45") is 2045-01-01: accepting it would park a session,
    // unsupervised, for two decades.
    expect(() => parseDeadline('45', base)).toThrow('could not read');
    expect(() => parseDeadline('2045', base)).toThrow('could not read');
  });

  test('rejects nonsense, zero, and deadlines already behind us', () => {
    expect(() => parseDeadline('', base)).toThrow('requires a duration');
    expect(() => parseDeadline('soonish', base)).toThrow('could not read');
    expect(() => parseDeadline('0m', base)).toThrow('positive duration');
    expect(() => parseDeadline('2026-07-23T11:00:00.000Z', base)).toThrow('already in the past');
  });
});

describe('declaring a wait', () => {
  test('publishes the deadline and moves the session to waiting', async () => {
    const harness = await waitingManager();
    await declare(harness, { until: '30m', condition: 'droplet proof suite' });

    const [transition] = harness.transitions;
    expect(transition?.event).toBe('session.waiting');
    expect(transition?.patch.status).toBe('waiting');
    expect(transition?.patch.reason).toContain('droplet proof suite');
    expect(Date.parse(harness.state().waiting!.until!)).toBeGreaterThan(Date.now());
  });

  test('an open-ended wait is allowed and says so', async () => {
    const harness = await waitingManager();
    await declare(harness, { condition: 'a ruling from the lead' });
    expect(harness.state().waiting?.until).toBeUndefined();
    expect(harness.transitions[0]?.patch.reason).toContain('open-ended');
  });

  test('a terminal session cannot declare a wait', async () => {
    const harness = await waitingManager({ status: 'completed' });
    await expect(declare(harness, { until: '30m' })).rejects.toThrow('resume it before declaring a wait');
  });
});

describe('servicing a declared wait', () => {
  test('heartbeats are rate-limited but keep the park visible', async () => {
    const harness = await waitingManager({
      waiting: { since: new Date(Date.now() - 600_000).toISOString(), condition: 'CI' },
    });
    await service(harness);
    await service(harness); // immediately again: suppressed
    const beats = harness.events.filter(item => item.type === 'session.waiting_heartbeat');
    expect(beats).toHaveLength(1);
    expect(beats[0]!.data.elapsedSeconds as number).toBeGreaterThanOrEqual(600);
    expect(existsSync(path.join(harness.directory, 'checks', 'waiting.json'))).toBe(true);

    // The heartbeat clock is per session: pretending time passed re-arms it.
    (harness.manager.waitingHeartbeats as Map<string, number>).set('s1', Date.now() - 600_000);
    await service(harness);
    expect(harness.events.filter(item => item.type === 'session.waiting_heartbeat')).toHaveLength(2);
  });

  test('a heartbeat reports the remaining time when there is a deadline', async () => {
    const harness = await waitingManager({
      waiting: {
        since: new Date(Date.now() - 60_000).toISOString(),
        until: new Date(Date.now() + 900_000).toISOString(),
      },
    });
    await service(harness);
    const beat = harness.events.find(item => item.type === 'session.waiting_heartbeat');
    expect(beat!.data.remainingSeconds as number).toBeGreaterThan(600);
  });

  test('at the deadline the wait CLEARS and the teammate is woken, never killed', async () => {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const harness = await waitingManager({
      waiting: { since, until: new Date(Date.now() - 1_000).toISOString(), condition: 'the nightly suite' },
    });
    await service(harness);

    expect(harness.events.map(item => item.type)).toContain('session.waiting_expired');
    expect(harness.sent[0]).toContain('wait you declared has elapsed');
    const cleared = harness.transitions.find(item => item.event === 'session.waiting_cleared');
    expect(cleared?.patch.status).toBe('running');
    expect(cleared?.patch.waiting).toBeUndefined();
    // ~1 h parked is credited back against the turn ceiling.
    expect(cleared?.patch.waitingCreditSeconds as number).toBeGreaterThanOrEqual(3_599);
  });

  test('credit accumulates across repeated waits in the same turn', async () => {
    const harness = await waitingManager({
      waitingCreditSeconds: 1_200,
      waiting: { since: new Date(Date.now() - 600_000).toISOString(), until: new Date(Date.now() - 1).toISOString() },
    });
    await service(harness);
    const cleared = harness.transitions.find(item => item.event === 'session.waiting_cleared');
    expect(cleared?.patch.waitingCreditSeconds as number).toBeGreaterThanOrEqual(1_800);
  });
});

describe('the warden reads a declared wait as deliberate', () => {
  const config = {
    id: 's1',
    mode: 'auto',
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  } as SessionConfig;
  const options = {
    unattendedMs: 30 * 60_000,
    terminalWindowMs: 30 * 60_000,
    susThinkingSeconds: 900,
    susSubprocessSeconds: 900,
  };
  const nowMs = Date.parse('2026-07-23T12:00:00.000Z');

  test('a live declared wait is NOT an unattended question', () => {
    const state = {
      id: 's1',
      status: 'waiting',
      turn: 1,
      lastActivityAt: '2026-07-23T09:00:00.000Z',
      waiting: { since: '2026-07-23T09:00:00.000Z', until: '2026-07-23T13:00:00.000Z', condition: 'CI' },
    } as SessionState;
    const result = detectAnomalies([{ config, state, hasLiveMonitor: true, hasDoneMarker: false }], nowMs, options);
    expect(result.anomalies).toEqual([]);
  });

  test('an UNdeclared waiting session is still flagged', () => {
    const state = {
      id: 's1',
      status: 'waiting',
      turn: 1,
      lastActivityAt: '2026-07-23T09:00:00.000Z',
    } as SessionState;
    const result = detectAnomalies([{ config, state, hasLiveMonitor: true, hasDoneMarker: false }], nowMs, options);
    expect(result.anomalies.map(item => item.kind)).toEqual(['unattended_question']);
  });

  test('a wait whose deadline passed without a wake is flagged as overdue', () => {
    const state = {
      id: 's1',
      status: 'waiting',
      turn: 1,
      lastActivityAt: '2026-07-23T09:00:00.000Z',
      waiting: { since: '2026-07-23T08:00:00.000Z', until: '2026-07-23T10:00:00.000Z', condition: 'CI' },
    } as SessionState;
    const result = detectAnomalies([{ config, state, hasLiveMonitor: true, hasDoneMarker: false }], nowMs, options);
    expect(result.anomalies.map(item => item.kind)).toEqual(['declared_wait_overdue']);
  });
});

describe('a declared wait survives the transcript', () => {
  test('the status is re-asserted when transcript records recompute it away', async () => {
    // Every tool_result recomputes status (running/tool_running) — including
    // the result of the `kteam signal waiting` call itself, which used to
    // erase the park and hand the session straight back to the stall reflex.
    const harness = await waitingManager({
      status: 'tool_running',
      waiting: { since: new Date().toISOString(), until: new Date(Date.now() + 900_000).toISOString() },
    });
    await service(harness);
    const held = harness.transitions.find(item => item.event === 'session.waiting_held');
    expect(held?.patch.status).toBe('waiting');
    expect(harness.state().status).toBe('waiting');
  });

  test('a terminal session is never dragged back to waiting', async () => {
    const harness = await waitingManager({
      status: 'completed',
      waiting: { since: new Date().toISOString(), until: new Date(Date.now() + 900_000).toISOString() },
    });
    await service(harness);
    expect(harness.transitions.find(item => item.event === 'session.waiting_held')).toBeUndefined();
  });

  test('an open-ended wait ends at the backstop instead of running forever', async () => {
    const harness = await waitingManager({
      // Declared five hours ago with no deadline: past the 4 h backstop.
      waiting: { since: new Date(Date.now() - 5 * 60 * 60_000).toISOString(), condition: 'a ruling' },
    });
    await service(harness);
    const expired = harness.events.find(item => item.type === 'session.waiting_expired');
    expect(expired?.data.backstopped).toBe(true);
    expect(harness.sent[0]).toContain('wait you declared has elapsed');
    expect(harness.transitions.find(item => item.event === 'session.waiting_cleared')?.patch.status).toBe('running');
  });

  test('an open-ended wait inside the backstop just heartbeats', async () => {
    const harness = await waitingManager({
      waiting: { since: new Date(Date.now() - 60_000).toISOString(), condition: 'a ruling' },
    });
    await service(harness);
    expect(harness.events.map(item => item.type)).toEqual(['session.waiting_heartbeat']);
    expect(harness.events[0]!.data.until).toBeNull(); // nothing was declared…
    // …but the wake is still dated: the countdown runs to the backstop.
    expect(harness.events[0]!.data.remainingSeconds as number).toBeGreaterThan(4 * 3600 - 120);
  });
});

describe('an overdue open-ended wait still reaches the warden', () => {
  test('a wait past the backstop plus the unattended window is flagged', () => {
    const config = {
      id: 's1',
      mode: 'auto',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    } as SessionConfig;
    const state = {
      id: 's1',
      status: 'waiting',
      turn: 1,
      lastActivityAt: '2026-07-23T00:00:00.000Z',
      // Open-ended, declared 12 hours before "now" — 4 h backstop + 30 min.
      waiting: { since: '2026-07-23T00:00:00.000Z', condition: 'a ruling' },
    } as SessionState;
    const result = detectAnomalies(
      [{ config, state, hasLiveMonitor: true, hasDoneMarker: false }],
      Date.parse('2026-07-23T12:00:00.000Z'),
      {
        unattendedMs: 30 * 60_000,
        terminalWindowMs: 30 * 60_000,
        susThinkingSeconds: 900,
        susSubprocessSeconds: 900,
      },
    );
    expect(result.anomalies.map(item => item.kind)).toEqual(['declared_wait_overdue']);
  });
});

describe('what the monitor actually gates on', () => {
  const state = (extra: Partial<SessionState>) => ({ id: 's1', status: 'running', turn: 1, ...extra }) as SessionState;

  test('a declared wait suspends the lifecycle whatever the transcript says the status is', () => {
    const parked = { since: new Date().toISOString() };
    expect(lifecycleSuspended(state({ waiting: parked }))).toBe(true);
    expect(lifecycleSuspended(state({ status: 'tool_running', waiting: parked }))).toBe(true);
    expect(lifecycleSuspended(state({ status: 'thinking', waiting: parked }))).toBe(true);
  });

  test('the pre-existing waiting statuses still suspend it, and working states do not', () => {
    for (const status of ['waiting', 'awaiting_question', 'awaiting_user', 'rate_limited', 'interrupted'] as const) {
      expect(lifecycleSuspended(state({ status }))).toBe(true);
    }
    for (const status of ['running', 'thinking', 'tool_running', 'starting'] as const) {
      expect(lifecycleSuspended(state({ status }))).toBe(false);
    }
  });

  test('parked time is credited back against the turn ceiling', () => {
    const config = { timeoutSeconds: 14_400 };
    expect(turnCeilingMs(config, state({}))).toBe(14_400_000);
    // Three hours parked: the 4 h ceiling now falls at 7 h of wall clock.
    expect(turnCeilingMs(config, state({ waitingCreditSeconds: 10_800 }))).toBe(25_200_000);
  });
});
