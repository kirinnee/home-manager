import { describe, expect, test } from 'bun:test';
import { detectAnomalies, fingerprintAnomalies, WARDEN_LABEL, type WardenSessionView } from './warden-detect';
import type { SessionConfig, SessionState, SessionStatus } from './types';

const NOW = Date.parse('2026-07-22T12:00:00.000Z');
const OPTIONS = { unattendedMs: 30 * 60_000, terminalWindowMs: 30 * 60_000 };

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: overrides.id ?? 'sess-1',
    name: 'task',
    binary: 'claude-auto-loge',
    harness: 'claude',
    modelHint: 'model',
    mode: 'auto',
    cwd: '/repo',
    createdAt: iso(60 * 60_000),
    updatedAt: iso(60 * 60_000),
    turn: 1,
    harnessSessionId: 'h-1',
    tmuxSession: 'kteam-sess-1-agent',
    watcherSession: 'kteam-sess-1-watch',
    intervalSeconds: 5,
    stallSeconds: 900,
    timeoutSeconds: 14_400,
    maxSnapshots: 200,
    systemPromptFile: '/x/system.md',
    originalPromptFile: '/x/prompt.md',
    ...overrides,
  };
}

function state(status: SessionStatus, overrides: Partial<SessionState> = {}): SessionState {
  return { id: overrides.id ?? 'sess-1', status, turn: 1, ...overrides };
}

function view(
  status: SessionStatus,
  opts: {
    hasLiveMonitor?: boolean;
    hasDoneMarker?: boolean;
    config?: Partial<SessionConfig>;
    state?: Partial<SessionState>;
  } = {},
): WardenSessionView {
  const cfg = config({ id: opts.config?.id ?? 'sess-1', ...opts.config });
  return {
    config: cfg,
    state: state(status, { id: cfg.id, ...opts.state }),
    hasLiveMonitor: opts.hasLiveMonitor ?? true,
    ...(opts.hasDoneMarker !== undefined ? { hasDoneMarker: opts.hasDoneMarker } : {}),
  };
}

describe('warden anomaly detection', () => {
  test('flags an active session with no live monitor handle', () => {
    const result = detectAnomalies([view('running', { hasLiveMonitor: false })], NOW, OPTIONS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]!.kind).toBe('dead_monitor');
  });

  test('does NOT flag an active session that has a live monitor', () => {
    const result = detectAnomalies([view('tool_running', { hasLiveMonitor: true })], NOW, OPTIONS);
    expect(result.anomalies).toHaveLength(0);
  });

  for (const status of ['awaiting_question', 'awaiting_user', 'waiting'] as SessionStatus[]) {
    test(`flags ${status} idle beyond the unattended window`, () => {
      const result = detectAnomalies([view(status, { state: { lastActivityAt: iso(45 * 60_000) } })], NOW, OPTIONS);
      expect(result.anomalies).toHaveLength(1);
      expect(result.anomalies[0]!.kind).toBe('unattended_question');
      expect(result.anomalies[0]!.idleMinutes).toBe(45);
    });
  }

  test('does NOT flag a recently-active waiting session', () => {
    const result = detectAnomalies(
      [view('awaiting_user', { state: { lastActivityAt: iso(5 * 60_000) } })],
      NOW,
      OPTIONS,
    );
    expect(result.anomalies).toHaveLength(0);
  });

  test('uses the most recent activity signal to measure idleness', () => {
    // Old lastActivityAt but a fresh pane frame => not idle.
    const result = detectAnomalies(
      [view('waiting', { state: { lastActivityAt: iso(90 * 60_000), lastPaneAt: iso(2 * 60_000) } })],
      NOW,
      OPTIONS,
    );
    expect(result.anomalies).toHaveLength(0);
  });

  test('flags fresh failed wreckage inside the window', () => {
    const result = detectAnomalies(
      [view('failed', { state: { finishedAt: iso(10 * 60_000), reason: 'crashed' } })],
      NOW,
      OPTIONS,
    );
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]!.kind).toBe('abandoned_wreckage');
    expect(result.anomalies[0]!.detail).toContain('crashed');
  });

  test('flags stalled wreckage inside the window', () => {
    const result = detectAnomalies([view('stalled', { state: { finishedAt: iso(1 * 60_000) } })], NOW, OPTIONS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]!.kind).toBe('abandoned_wreckage');
  });

  test('does NOT flag failed wreckage whose current-turn done marker exists (finished work)', () => {
    const result = detectAnomalies(
      [view('failed', { hasDoneMarker: true, state: { finishedAt: iso(10 * 60_000), reason: 'daemon restarted' } })],
      NOW,
      OPTIONS,
    );
    expect(result.anomalies).toHaveLength(0);
  });

  test('still flags failed wreckage when hasDoneMarker is explicitly false or omitted', () => {
    const explicit = detectAnomalies(
      [view('failed', { hasDoneMarker: false, state: { finishedAt: iso(10 * 60_000) } })],
      NOW,
      OPTIONS,
    );
    expect(explicit.anomalies).toHaveLength(1);
    const omitted = detectAnomalies([view('stalled', { state: { finishedAt: iso(10 * 60_000) } })], NOW, OPTIONS);
    expect(omitted.anomalies).toHaveLength(1);
  });

  test('a done marker does not suppress OTHER anomaly classes', () => {
    const result = detectAnomalies([view('running', { hasDoneMarker: true, hasLiveMonitor: false })], NOW, OPTIONS);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]!.kind).toBe('dead_monitor');
  });

  test('does NOT flag terminal wreckage older than the window', () => {
    const result = detectAnomalies([view('failed', { state: { finishedAt: iso(120 * 60_000) } })], NOW, OPTIONS);
    expect(result.anomalies).toHaveLength(0);
  });

  test('does NOT flag completed or stopped sessions', () => {
    const result = detectAnomalies(
      [
        view('completed', { state: { finishedAt: iso(1 * 60_000) } }),
        view('stopped', { state: { finishedAt: iso(1 * 60_000) } }),
      ],
      NOW,
      OPTIONS,
    );
    expect(result.anomalies).toHaveLength(0);
  });

  test('flags a rate_limited session whose reset has passed', () => {
    const result = detectAnomalies(
      [view('rate_limited', { state: { quota: { resetAt: NOW - 60_000 } } })],
      NOW,
      OPTIONS,
    );
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]!.kind).toBe('quota_reset_passed');
  });

  test('does NOT flag a rate_limited session whose reset is still in the future', () => {
    const result = detectAnomalies(
      [view('rate_limited', { state: { quota: { resetAt: NOW + 60_000 } } })],
      NOW,
      OPTIONS,
    );
    expect(result.anomalies).toHaveLength(0);
  });

  test('does NOT flag a rate_limited session with no known reset time', () => {
    const result = detectAnomalies([view('rate_limited', { state: { quota: {} } })], NOW, OPTIONS);
    expect(result.anomalies).toHaveLength(0);
  });

  test('no-recursion: warden-labeled sessions are never flagged', () => {
    const warden = view('failed', {
      config: { id: 'w-1', label: WARDEN_LABEL },
      state: { id: 'w-1', finishedAt: iso(1 * 60_000) },
      hasLiveMonitor: false,
    });
    // Also give it a dead monitor + running status to be sure every class skips it.
    const wardenActive = view('running', {
      config: { id: 'w-2', label: WARDEN_LABEL },
      state: { id: 'w-2' },
      hasLiveMonitor: false,
    });
    const result = detectAnomalies([warden, wardenActive], NOW, OPTIONS);
    expect(result.anomalies).toHaveLength(0);
  });

  test('no-recursion: descendants of a warden are excluded by ancestry, not just the label', () => {
    const warden = view('running', {
      config: { id: 'w-1', label: WARDEN_LABEL },
      state: { id: 'w-1' },
      hasLiveMonitor: true,
    });
    // Child carries NO warden label but its parent is a warden → still excluded.
    const child = view('running', {
      config: { id: 'c-1', parent: 'w-1' },
      state: { id: 'c-1' },
      hasLiveMonitor: false,
    });
    const grandchild = view('failed', {
      config: { id: 'g-1', parent: 'c-1' },
      state: { id: 'g-1', finishedAt: iso(1 * 60_000) },
    });
    const result = detectAnomalies([warden, child, grandchild], NOW, OPTIONS);
    expect(result.anomalies).toHaveLength(0);
  });

  test('interactive sessions flag only an explicit unanswered question, not a parked prompt', () => {
    const parkedUser = detectAnomalies(
      [view('awaiting_user', { config: { mode: 'interactive' }, state: { lastActivityAt: iso(45 * 60_000) } })],
      NOW,
      OPTIONS,
    );
    expect(parkedUser.anomalies).toHaveLength(0);
    const parkedWaiting = detectAnomalies(
      [view('waiting', { config: { mode: 'interactive' }, state: { lastActivityAt: iso(45 * 60_000) } })],
      NOW,
      OPTIONS,
    );
    expect(parkedWaiting.anomalies).toHaveLength(0);
    const question = detectAnomalies(
      [view('awaiting_question', { config: { mode: 'interactive' }, state: { lastActivityAt: iso(45 * 60_000) } })],
      NOW,
      OPTIONS,
    );
    expect(question.anomalies).toHaveLength(1);
    expect(question.anomalies[0]!.kind).toBe('unattended_question');
  });
});

describe('warden fingerprint', () => {
  test('is order-independent over the anomaly set', () => {
    const a = view('running', { config: { id: 'a' }, state: { id: 'a' }, hasLiveMonitor: false });
    const b = view('failed', { config: { id: 'b' }, state: { id: 'b', finishedAt: iso(60_000) } });
    const forward = detectAnomalies([a, b], NOW, OPTIONS).fingerprint;
    const reverse = detectAnomalies([b, a], NOW, OPTIONS).fingerprint;
    expect(forward).toBe(reverse);
    expect(forward.length).toBeGreaterThan(0);
  });

  test('ignores volatile detail/timestamp changes for an unchanged set', () => {
    const first = detectAnomalies(
      [view('failed', { state: { finishedAt: iso(5 * 60_000), reason: 'a' } })],
      NOW,
      OPTIONS,
    );
    const second = detectAnomalies(
      [view('failed', { state: { finishedAt: iso(6 * 60_000), reason: 'b' } })],
      NOW,
      OPTIONS,
    );
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  test('changes when a new anomalous session appears', () => {
    const before = detectAnomalies(
      [view('running', { config: { id: 'a' }, state: { id: 'a' }, hasLiveMonitor: false })],
      NOW,
      OPTIONS,
    );
    const after = detectAnomalies(
      [
        view('running', { config: { id: 'a' }, state: { id: 'a' }, hasLiveMonitor: false }),
        view('running', { config: { id: 'c' }, state: { id: 'c' }, hasLiveMonitor: false }),
      ],
      NOW,
      OPTIONS,
    );
    expect(before.fingerprint).not.toBe(after.fingerprint);
  });

  test('empty anomaly set fingerprints to the empty string', () => {
    expect(fingerprintAnomalies([])).toBe('');
    expect(detectAnomalies([view('running', { hasLiveMonitor: true })], NOW, OPTIONS).fingerprint).toBe('');
  });
});
