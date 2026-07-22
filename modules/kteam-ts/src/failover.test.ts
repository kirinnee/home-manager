import { describe, expect, test } from 'bun:test';
import type { AgentUsage } from './core';
import { rankFailoverCandidates, selectFailoverCandidate } from './failover';

const AGENTS = [
  'claude-auto-glm52a',
  'claude-auto-glm52b',
  'claude-auto-mm3',
  'claude-auto-kirin',
  'codex-auto-loge',
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
  test('prefers a usable same-family wrapper over other kinds/families', () => {
    const pick = selectFailoverCandidate({
      currentBinary: 'claude-auto-glm52a',
      harness: 'claude',
      agents: AGENTS,
      usage: [],
    });
    expect(pick).toBe('claude-auto-glm52b');
  });

  test('never returns the current binary', () => {
    const ranked = rankFailoverCandidates({
      currentBinary: 'claude-auto-glm52a',
      harness: 'claude',
      agents: AGENTS,
      usage: [],
    });
    expect(ranked).not.toContain('claude-auto-glm52a');
  });

  test('never crosses harness kind', () => {
    const ranked = rankFailoverCandidates({
      currentBinary: 'codex-auto-loge',
      harness: 'codex',
      agents: AGENTS,
      usage: [],
    });
    expect(ranked).toEqual(['codex-auto-kirin']);
    expect(ranked.every(a => a.startsWith('codex-'))).toBe(true);
  });

  test('excludes at-limit and logged-out accounts', () => {
    const pick = selectFailoverCandidate({
      currentBinary: 'claude-auto-glm52a',
      harness: 'claude',
      agents: AGENTS,
      usage: [
        usage({ binary: 'claude-auto-glm52b', atLimit: true }),
        usage({ binary: 'claude-auto-mm3', authOk: false }),
      ],
    });
    // glm52b at limit, mm3 logged out → falls through to the frontier account.
    expect(pick).toBe('claude-auto-kirin');
  });

  test('falls back across families by least usage when no same-family option remains', () => {
    const pick = selectFailoverCandidate({
      currentBinary: 'claude-auto-glm52a',
      harness: 'claude',
      agents: ['claude-auto-glm52a', 'claude-auto-mm3', 'claude-auto-kirin'],
      usage: [
        usage({ binary: 'claude-auto-mm3', fiveHourPercent: 80 }),
        usage({ binary: 'claude-auto-kirin', fiveHourPercent: 10 }),
      ],
    });
    expect(pick).toBe('claude-auto-kirin');
  });

  test('returns undefined when nothing usable remains', () => {
    const pick = selectFailoverCandidate({
      currentBinary: 'claude-auto-glm52a',
      harness: 'claude',
      agents: ['claude-auto-glm52a'],
      usage: [],
    });
    expect(pick).toBeUndefined();
  });

  test('requireConfirmedUsage excludes accounts with absent/unknown usage', () => {
    const input = {
      currentBinary: 'claude-auto-glm52a',
      harness: 'claude' as const,
      agents: ['claude-auto-glm52a', 'claude-auto-glm52b', 'claude-auto-kirin'],
      // glm52b positively below its limit; kirin has NO usage entry (unknown).
      usage: [usage({ binary: 'claude-auto-glm52b', atLimit: false })],
    };
    // Strict: only the confirmed-usable account qualifies.
    expect(rankFailoverCandidates({ ...input, requireConfirmedUsage: true })).toEqual(['claude-auto-glm52b']);
    // Loose (default): the unscored account is still a candidate.
    expect(rankFailoverCandidates(input)).toContain('claude-auto-kirin');
  });

  test('same-family tiebreak by usage then name is deterministic', () => {
    const input = {
      currentBinary: 'claude-auto-glm52a',
      harness: 'claude' as const,
      agents: ['claude-auto-glm52a', 'claude-auto-glm52b', 'claude-auto-glm52c'],
      usage: [
        usage({ binary: 'claude-auto-glm52c', fiveHourPercent: 5 }),
        usage({ binary: 'claude-auto-glm52b', fiveHourPercent: 5 }),
      ],
    };
    // Equal usage within the same family → alphabetical tiebreak (b before c).
    expect(rankFailoverCandidates(input)).toEqual(['claude-auto-glm52b', 'claude-auto-glm52c']);
  });
});
