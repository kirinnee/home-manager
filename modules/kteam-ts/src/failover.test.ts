import { describe, expect, test } from 'bun:test';
import { routingExclusionReason, type AgentUsage } from './core';
import { rankFailoverCandidates, selectFailoverCandidate } from './failover';

const AGENTS = [
  'claude-auto-loge1',
  'claude-auto-loge2',
  'claude-auto-liftoff',
  'claude-auto-glm52a',
  'claude-auto-glm52b',
  'claude-auto-mm3',
  'claude-auto-dsv4f',
  'claude-auto-dsv4p',
  'claude-auto-kirin',
  'codex-auto-loai',
  'codex-auto-kirin',
];

const usage = (over: Partial<AgentUsage> & { binary: string }): AgentUsage => ({
  atLimit: false,
  authOk: true,
  fiveHourPercent: 0,
  weeklyPercent: 0,
  ...over,
});

describe('failover candidate selection', () => {
  test('picks the least-used Claude 5.5 account', () => {
    const pick = selectFailoverCandidate({
      currentBinary: 'claude-auto-loge1',
      harness: 'claude',
      agents: AGENTS,
      usage: [
        usage({ binary: 'claude-auto-loge2', fiveHourPercent: 40 }),
        usage({ binary: 'claude-auto-liftoff', fiveHourPercent: 10 }),
      ],
    });
    expect(pick).toBe('claude-auto-liftoff');
  });

  test('never returns the current binary', () => {
    const ranked = rankFailoverCandidates({
      currentBinary: 'claude-auto-loge1',
      harness: 'claude',
      agents: AGENTS,
      usage: [],
    });
    expect(ranked).not.toContain('claude-auto-loge1');
  });

  test('never lands on a non-Claude-5.5 model or a daily driver, even with headroom', () => {
    for (const currentBinary of AGENTS.filter(agent => agent.startsWith('claude-'))) {
      for (const requireConfirmedUsage of [false, true]) {
        const ranked = rankFailoverCandidates({
          currentBinary,
          harness: 'claude',
          agents: AGENTS,
          usage: AGENTS.map(binary => usage({ binary })),
          requireConfirmedUsage,
        });
        expect(ranked.every(agent => routingExclusionReason(agent) === undefined)).toBe(true);
        for (const banned of ['glm52', 'mm3', 'dsv4', 'kirin', 'codex-'])
          expect(ranked.some(agent => agent.includes(banned))).toBe(false);
      }
    }
  });

  test('a GLM session fails over onto Claude 5.5, never to its sibling GLM account', () => {
    const pick = selectFailoverCandidate({
      currentBinary: 'claude-auto-glm52a',
      harness: 'claude',
      agents: AGENTS,
      usage: [],
    });
    expect(pick).not.toBe('claude-auto-glm52b');
    expect(routingExclusionReason(pick!)).toBeUndefined();
  });

  test('never crosses harness kind, and a codex session has no target', () => {
    const ranked = rankFailoverCandidates({
      currentBinary: 'codex-auto-loai',
      harness: 'codex',
      agents: AGENTS,
      usage: [],
    });
    expect(ranked).toEqual([]);
  });

  test('excludes at-limit and logged-out accounts', () => {
    const pick = selectFailoverCandidate({
      currentBinary: 'claude-auto-loge1',
      harness: 'claude',
      agents: AGENTS,
      usage: [
        usage({ binary: 'claude-auto-loge2', atLimit: true }),
        usage({ binary: 'claude-auto-liftoff', authOk: false }),
      ],
    });
    // loge2 at limit, liftoff logged out, the rest are not routing targets.
    expect(pick).toBeUndefined();
  });

  test('excludes a positively unavailable proxy even when it is not a numerical limit', () => {
    const pick = selectFailoverCandidate({
      currentBinary: 'claude-auto-loge1',
      harness: 'claude',
      agents: ['claude-auto-loge1', 'claude-auto-loge', 'claude-auto-liftoff'],
      usage: [
        usage({
          binary: 'claude-auto-loge',
          unavailable: true,
          unavailableReason: 'provider',
          atLimit: false,
        }),
      ],
    });
    expect(pick).toBe('claude-auto-liftoff');
  });

  test('returns undefined when nothing usable remains', () => {
    const pick = selectFailoverCandidate({
      currentBinary: 'claude-auto-loge1',
      harness: 'claude',
      agents: ['claude-auto-loge1', 'claude-auto-glm52a', 'claude-auto-kirin'],
      usage: [],
    });
    expect(pick).toBeUndefined();
  });

  test('requireConfirmedUsage excludes accounts with absent/unknown usage', () => {
    const input = {
      currentBinary: 'claude-auto-loge1',
      harness: 'claude' as const,
      agents: ['claude-auto-loge1', 'claude-auto-loge2', 'claude-auto-liftoff'],
      // loge2 positively below its limit; liftoff has NO usage entry (unknown).
      usage: [usage({ binary: 'claude-auto-loge2', atLimit: false })],
    };
    // Strict: only the confirmed-usable account qualifies.
    expect(rankFailoverCandidates({ ...input, requireConfirmedUsage: true })).toEqual(['claude-auto-loge2']);
    // Loose (default): the unscored account is still a candidate.
    expect(rankFailoverCandidates(input)).toContain('claude-auto-liftoff');
  });

  test('requireConfirmedUsage rejects failed probes and unavailable pools', () => {
    const input = {
      currentBinary: 'claude-auto-loge1',
      harness: 'claude' as const,
      agents: ['claude-auto-loge1', 'claude-auto-loge2', 'claude-auto-loge', 'claude-auto-liftoff'],
      usage: [
        usage({ binary: 'claude-auto-loge2', ok: false }),
        usage({ binary: 'claude-auto-loge', unavailable: true }),
        usage({ binary: 'claude-auto-liftoff', ok: true }),
      ],
      requireConfirmedUsage: true,
    };
    expect(rankFailoverCandidates(input)).toEqual(['claude-auto-liftoff']);
  });

  test('tiebreak by usage then name is deterministic', () => {
    const input = {
      currentBinary: 'claude-auto-loge1',
      harness: 'claude' as const,
      agents: ['claude-auto-loge1', 'claude-auto-loge3', 'claude-auto-loge2'],
      usage: [
        usage({ binary: 'claude-auto-loge3', fiveHourPercent: 5 }),
        usage({ binary: 'claude-auto-loge2', fiveHourPercent: 5 }),
      ],
    };
    // Equal usage → alphabetical tiebreak (loge2 before loge3).
    expect(rankFailoverCandidates(input)).toEqual(['claude-auto-loge2', 'claude-auto-loge3']);
  });
});
