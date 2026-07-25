import { describe, expect, test } from 'bun:test';
import { SessionManager, lifecycleSuspended, reflexSuspended } from './session-manager';
import { detectAnomalies } from './warden-detect';
import { reflexAssess, susFindings, type LivenessLedger } from './liveness';
import type { SessionConfig, SessionState, SessionStatus } from './types';

// IMMORTAL INTERACTIVE.
//
// An interactive kteam session is a plain harness TUI in tmux that a HUMAN drives
// (from the kteam UI's composer/Terminal tab, from the RC surface, or by
// attaching to the pane). Sitting untouched for days is its normal, correct
// state. Every automatic lifecycle reflex must therefore stand down for it:
//   reflex nudge (180 s) · reflex kill (300 s) · turn ceiling (timeoutSeconds) ·
//   lost-prompt reaper (120 s re-inject / 360 s fail) · sus classes · warden
//   sweep · automode auto-continue.
//
// These tests are the regression guard: each one pins ONE exemption and, where
// the same input would fire for an auto session, asserts that too — so the test
// proves the exemption rather than an inert code path.

const config = (extra: Partial<SessionConfig> = {}): SessionConfig =>
  ({
    id: 's1',
    name: 'interactive',
    binary: 'claude-auto-loge',
    harness: 'claude',
    modelHint: 'loge',
    mode: 'interactive',
    cwd: '/tmp',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    turn: 1,
    harnessSessionId: '00000000-0000-4000-8000-000000000000',
    tmuxSession: 'kteam-s1-agent',
    watcherSession: 'kteam-s1-watch',
    intervalSeconds: 30,
    stallSeconds: 900,
    timeoutSeconds: 14_400,
    maxSnapshots: 200,
    systemPromptFile: '/tmp/system.md',
    originalPromptFile: '/tmp/prompt.md',
    ...extra,
  }) as SessionConfig;

const state = (extra: Partial<SessionState> = {}): SessionState =>
  ({ id: 's1', status: 'running', turn: 1, ...extra }) as SessionState;

describe('start(): the prompt is optional for interactive only', () => {
  // Argument validation runs before any wrapper/filesystem probing, so it is
  // testable on a bare prototype: a request that gets PAST validation fails on
  // something else entirely (an unresolvable wrapper), never on the prompt.
  const manager = Object.create(SessionManager.prototype) as {
    start: (request: Record<string, unknown>) => Promise<unknown>;
  };

  test('auto mode still requires a task', async () => {
    await expect(manager.start({ agent: 'claude-auto-nonexistent' })).rejects.toThrow('prompt is required');
    await expect(manager.start({ agent: 'claude-auto-nonexistent', prompt: '   ' })).rejects.toThrow(
      'prompt is required',
    );
  });

  test('interactive mode starts bare', async () => {
    // Not "does not throw" — it throws LATER, for a different reason. That is
    // the assertion: the prompt gate no longer stands in the way.
    await expect(manager.start({ agent: 'claude-auto-nonexistent', mode: 'interactive' })).rejects.not.toThrow(
      'prompt is required',
    );
  });

  test('an invalid mode is still rejected', async () => {
    await expect(manager.start({ agent: 'claude-auto-nonexistent', mode: 'chatty' })).rejects.toThrow(
      'mode must be auto or interactive',
    );
  });
});

describe('reflexSuspended: the single gate every idle-kill path reads', () => {
  // The monitor computes `waiting` once and gates the ceiling, the lost-prompt
  // reaper, the nudge and the kill on it. Interactive is unconditionally
  // suspended there — including while its status still says `running`, which is
  // exactly the case a status-only guard missed: a pane that never reports
  // promptReady (late splash, an open menu, a repainting composer) stayed
  // `running` and got cold-killed after 300 s of "silence".
  test('interactive is suspended in EVERY status, unlike auto', () => {
    const statuses: SessionStatus[] = [
      'starting',
      'running',
      'thinking',
      'tool_running',
      'awaiting_user',
      'awaiting_question',
      'interrupted',
    ];
    for (const status of statuses) {
      expect(reflexSuspended(config(), state({ status }))).toBe(true);
    }
    // Auto keeps today's behavior exactly: only declared waits and waiting
    // statuses suspend it, working states do not.
    for (const status of ['running', 'thinking', 'tool_running', 'starting'] as const) {
      expect(reflexSuspended(config({ mode: 'auto' }), state({ status }))).toBe(false);
    }
    for (const status of ['awaiting_user', 'awaiting_question', 'waiting', 'rate_limited', 'interrupted'] as const) {
      expect(reflexSuspended(config({ mode: 'auto' }), state({ status }))).toBe(true);
    }
  });

  test('it is a superset of lifecycleSuspended (never less protective)', () => {
    const parked = state({ status: 'thinking', waiting: { since: new Date().toISOString() } });
    expect(lifecycleSuspended(parked)).toBe(true);
    expect(reflexSuspended(config({ mode: 'auto' }), parked)).toBe(true);
    expect(reflexSuspended(config(), parked)).toBe(true);
  });
});

describe('the reflex verdicts the gate suppresses', () => {
  // A session with ZERO life-signs for two days: the pure reflex would kill it.
  // Interactive never reaches the verdict because the gate short-circuits first,
  // so this test states what is being suppressed AND that suppression happens.
  const dead: LivenessLedger = {};
  const twoDays = 2 * 24 * 3600_000;
  const assess = () =>
    reflexAssess({
      ledger: dead,
      nowMs: twoDays,
      anchorMs: 0,
      tickSeconds: 30,
      nudgeAfterSeconds: 180,
      killAfterSeconds: 300,
      nudgedAtMs: 1,
    });

  test('two days of total silence IS a kill verdict — and interactive is gated out of it', () => {
    expect(assess().verdict).toBe('kill');
    // The monitor's guard: `if (waiting || verdict === 'alive') { … } else if
    // (verdict === 'nudge') { nudge } else { kill }`.
    const gated = reflexSuspended(config(), state({ status: 'awaiting_user' }));
    expect(gated).toBe(true);
    expect(gated || assess().verdict === 'alive').toBe(true);
    // …while the same silence on an auto teammate still reaches the kill.
    const auto = reflexSuspended(config({ mode: 'auto' }), state({ status: 'running' }));
    expect(auto || assess().verdict === 'alive').toBe(false);
  });

  test('sus classes are computed only for un-suspended sessions', () => {
    // Counters advancing, transcript silent 20m: a real sus_thinking finding…
    const sus: LivenessLedger = {
      lastCounterAdvanceAt: new Date(twoDays).toISOString(),
      lastTranscriptAt: new Date(twoDays - 20 * 60_000).toISOString(),
    };
    const findings = susFindings(sus, twoDays, {
      susThinkingSeconds: 900,
      susSubprocessSeconds: 900,
      tickSeconds: 30,
      anchorMs: twoDays - 30 * 60_000,
    });
    expect(findings.length).toBeGreaterThan(0);
    // …and the monitor's `susNow` is `!waiting && susFindings(...)`, so an
    // interactive session never publishes one.
    expect(!reflexSuspended(config(), state({ status: 'thinking' })) && findings.length > 0).toBe(false);
  });
});

describe('the turn ceiling', () => {
  // `if (!waiting && Date.now() - startedAt >= ceilingMs)` → stop with
  // "exceeded timeout". A human's terminal open for a week is not a timeout.
  test('a week-old interactive turn is not a timeout; an auto one is', () => {
    const week = 7 * 24 * 3600_000;
    const started = state({ status: 'awaiting_user', startedAt: new Date(0).toISOString() });
    const overCeiling = week >= 14_400_000;
    expect(overCeiling).toBe(true);
    expect(!reflexSuspended(config(), started) && overCeiling).toBe(false);
    expect(!reflexSuspended(config({ mode: 'auto' }), state({ status: 'running' })) && overCeiling).toBe(true);
  });
});

describe('the warden sweep', () => {
  const view = (status: SessionStatus, mode: 'auto' | 'interactive', extra: Partial<SessionState> = {}) => ({
    config: config({ mode }),
    state: state({ status, ...extra }),
    hasLiveMonitor: true,
  });
  const OPTIONS = {
    unattendedMs: 30 * 60_000,
    terminalWindowMs: 60 * 60_000,
    susThinkingSeconds: 900,
    susSubprocessSeconds: 900,
  };
  const NOW = Date.parse('2026-07-25T12:00:00.000Z');
  const idle = { lastActivityAt: new Date(NOW - 6 * 3600_000).toISOString() };

  test('six hours idle at a prompt: flagged for auto, never for interactive', () => {
    expect(detectAnomalies([view('awaiting_user', 'interactive', idle)], NOW, OPTIONS).anomalies).toHaveLength(0);
    expect(detectAnomalies([view('awaiting_user', 'auto', idle)], NOW, OPTIONS).anomalies.length).toBeGreaterThan(0);
  });

  test('an unanswered AskUserQuestion in interactive is the human’s to answer, not an anomaly', () => {
    expect(detectAnomalies([view('awaiting_question', 'interactive', idle)], NOW, OPTIONS).anomalies).toHaveLength(0);
  });
});
