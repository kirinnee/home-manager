import { describe, expect, test } from 'bun:test';
import type { AgentUsage } from './core';
import { defaultWardenConfig, defaultWardenFailoverConfig, type WardenConfig } from './daemon-config';
import {
  classifyWardenFailure,
  ineligibilityReason,
  isDemoted,
  normalizeWardenAccounts,
  reconcileDemotions,
  recordWardenFailure,
  recordWardenSuccess,
  selectWardenAccount,
  type WardenFailoverState,
} from './warden-failover';

const NOW = Date.parse('2026-07-27T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const config = (over: Partial<WardenConfig> = {}): WardenConfig => ({
  ...defaultWardenConfig(),
  wrapper: 'claude-auto-a',
  accounts: ['claude-auto-a', 'claude-auto-b', 'claude-auto-c'],
  failover: defaultWardenFailoverConfig(),
  ...over,
});

const INSTALLED = ['claude-auto-a', 'claude-auto-b', 'claude-auto-c'];

const usage = (over: Partial<AgentUsage> & { binary: string }): AgentUsage => ({
  atLimit: false,
  authOk: true,
  ...over,
});

describe('normalizeWardenAccounts', () => {
  test('legacy wrapper+model becomes the single account', () => {
    const accounts = normalizeWardenAccounts(config({ accounts: undefined, model: 'opus' }));
    expect(accounts).toEqual([{ wrapper: 'claude-auto-a', model: 'opus' }]);
  });

  test('legacy model stays absent when unset (never resurrect a raw model field)', () => {
    const accounts = normalizeWardenAccounts(config({ accounts: undefined }));
    expect(accounts).toEqual([{ wrapper: 'claude-auto-a' }]);
    expect('model' in accounts[0]!).toBe(false);
  });

  test('accounts wins over the legacy pair and accepts string shorthand', () => {
    const accounts = normalizeWardenAccounts(
      config({ accounts: ['claude-auto-x', { wrapper: 'claude-auto-y', model: 'opus' }], model: 'ignored' }),
    );
    expect(accounts).toEqual([{ wrapper: 'claude-auto-x' }, { wrapper: 'claude-auto-y', model: 'opus' }]);
  });

  test('empty accounts falls back to the legacy pair', () => {
    expect(normalizeWardenAccounts(config({ accounts: [] }))).toEqual([{ wrapper: 'claude-auto-a' }]);
  });

  test('dedupes by wrapper keeping the first occurrence and its model', () => {
    const accounts = normalizeWardenAccounts(
      config({ accounts: [{ wrapper: 'claude-auto-a', model: 'first' }, 'claude-auto-a', 'claude-auto-b'] }),
    );
    expect(accounts).toEqual([{ wrapper: 'claude-auto-a', model: 'first' }, { wrapper: 'claude-auto-b' }]);
  });

  test('blank wrapper entries are dropped', () => {
    expect(normalizeWardenAccounts(config({ accounts: ['', '  ', 'claude-auto-b'] }))).toEqual([
      { wrapper: 'claude-auto-b' },
    ]);
  });
});

describe('eligibility', () => {
  test('a wrapper missing from the bin is skipped, not fatal', () => {
    const reason = ineligibilityReason(
      { wrapper: 'claude-auto-gone' },
      { installedAgents: INSTALLED, usage: [], state: {}, nowMs: NOW },
    );
    expect(reason).toContain('not installed');
  });

  test('unknown feed data passes (usableAgent semantics)', () => {
    const reason = ineligibilityReason(
      { wrapper: 'claude-auto-a' },
      { installedAgents: INSTALLED, usage: [], state: {}, nowMs: NOW },
    );
    expect(reason).toBeUndefined();
  });

  test('at-limit and auth-failed accounts are ineligible', () => {
    const base = { installedAgents: INSTALLED, state: {}, nowMs: NOW };
    expect(
      ineligibilityReason(
        { wrapper: 'claude-auto-a' },
        { ...base, usage: [usage({ binary: 'claude-auto-a', atLimit: true })] },
      ),
    ).toContain('usage limit');
    expect(
      ineligibilityReason(
        { wrapper: 'claude-auto-a' },
        { ...base, usage: [usage({ binary: 'claude-auto-a', authOk: false })] },
      ),
    ).toContain('credentials');
  });

  test('provider-down is ineligible with cause/retry while transport unknown stays eligible', () => {
    const base = { installedAgents: INSTALLED, state: {}, nowMs: NOW };
    const retryAt = NOW + 60_000;
    expect(
      ineligibilityReason(
        { wrapper: 'claude-auto-a' },
        {
          ...base,
          usage: [
            usage({
              binary: 'claude-auto-a',
              ok: true,
              unavailable: true,
              unavailableReason: 'cooldown',
              retryAt,
            }),
          ],
        },
      ),
    ).toContain('cooldown');
    expect(
      ineligibilityReason(
        { wrapper: 'claude-auto-a' },
        { ...base, usage: [usage({ binary: 'claude-auto-a', ok: false, atLimit: false })] },
      ),
    ).toBeUndefined();
  });

  test('a demoted wrapper is ineligible until the cooldown elapses', () => {
    const state: WardenFailoverState = { demotedUntil: { 'claude-auto-a': iso(NOW + 60_000) } };
    expect(isDemoted(state, 'claude-auto-a', NOW)).toBe(true);
    expect(isDemoted(state, 'claude-auto-a', NOW + 61_000)).toBe(false);
    expect(
      ineligibilityReason({ wrapper: 'claude-auto-a' }, { installedAgents: INSTALLED, usage: [], state, nowMs: NOW }),
    ).toContain('demoted');
  });
});

describe('fallback policy', () => {
  test('picks the first eligible account in configured order', () => {
    const selection = selectWardenAccount({
      config: config(),
      installedAgents: INSTALLED,
      usage: [],
      state: {},
      nowMs: NOW,
    });
    if (selection.exhausted) throw new Error('unexpected exhaustion');
    expect(selection.account.wrapper).toBe('claude-auto-a');
    expect(selection.reason).toBe('preferred');
    expect(selection.state.lastSelection?.wrapper).toBe('claude-auto-a');
  });

  test('skips ineligible entries and reports failover', () => {
    const selection = selectWardenAccount({
      config: config(),
      installedAgents: INSTALLED,
      usage: [usage({ binary: 'claude-auto-a', atLimit: true })],
      state: {},
      nowMs: NOW,
    });
    if (selection.exhausted) throw new Error('unexpected exhaustion');
    expect(selection.account.wrapper).toBe('claude-auto-b');
    expect(selection.reason).toBe('failover');
  });

  test('fails BACK to the preferred account after its cooldown expires', () => {
    const state: WardenFailoverState = { demotedUntil: { 'claude-auto-a': iso(NOW - 1) } };
    const selection = selectWardenAccount({
      config: config(),
      installedAgents: INSTALLED,
      usage: [],
      state,
      nowMs: NOW,
    });
    if (selection.exhausted) throw new Error('unexpected exhaustion');
    expect(selection.account.wrapper).toBe('claude-auto-a');
  });

  test('fails back early when the feed positively confirms recovery', () => {
    const state: WardenFailoverState = {
      demotedUntil: { 'claude-auto-a': iso(NOW + 20 * 60_000) },
      strikes: { 'claude-auto-a': { count: 2, lastAt: iso(NOW - 60_000), lastReason: 'x' } },
    };
    const feed = [usage({ binary: 'claude-auto-a', atLimit: false, authOk: true })];
    const { state: reconciled, restored } = reconcileDemotions(state, feed, NOW);
    expect(restored).toEqual([{ wrapper: 'claude-auto-a', how: 'feed' }]);
    expect(reconciled.strikes?.['claude-auto-a']).toBeUndefined();
    const selection = selectWardenAccount({
      config: config(),
      installedAgents: INSTALLED,
      usage: feed,
      state: reconciled,
      nowMs: NOW,
    });
    if (selection.exhausted) throw new Error('unexpected exhaustion');
    expect(selection.account.wrapper).toBe('claude-auto-a');
  });

  test('selection carries the per-account model override', () => {
    const selection = selectWardenAccount({
      config: config({ accounts: [{ wrapper: 'claude-auto-a', model: 'opus' }] }),
      installedAgents: INSTALLED,
      usage: [],
      state: {},
      nowMs: NOW,
    });
    if (selection.exhausted) throw new Error('unexpected exhaustion');
    expect(selection.account.model).toBe('opus');
  });
});

describe('round_robin policy', () => {
  const rrConfig = config({ failover: { ...defaultWardenFailoverConfig(), policy: 'round_robin' } });

  test('rotates per spawn over the configured list, persisting the cursor', () => {
    let state: WardenFailoverState = {};
    const picks: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const selection = selectWardenAccount({
        config: rrConfig,
        installedAgents: INSTALLED,
        usage: [],
        state,
        nowMs: NOW,
      });
      if (selection.exhausted) throw new Error('unexpected exhaustion');
      picks.push(selection.account.wrapper);
      state = selection.state;
      expect(selection.reason).toBe('rotation');
    }
    expect(picks).toEqual(['claude-auto-a', 'claude-auto-b', 'claude-auto-c', 'claude-auto-a']);
  });

  test('skips an ineligible account without disturbing the others’ turn order', () => {
    let state: WardenFailoverState = { rrCursor: 0 }; // last pick was a
    const feed = [usage({ binary: 'claude-auto-b', atLimit: true })];
    const first = selectWardenAccount({ config: rrConfig, installedAgents: INSTALLED, usage: feed, state, nowMs: NOW });
    if (first.exhausted) throw new Error('unexpected exhaustion');
    expect(first.account.wrapper).toBe('claude-auto-c'); // b skipped
    state = first.state;
    // b recovers: the cursor sits at c (index 2), so the next turn wraps to a —
    // b's recovery does not reshuffle anyone.
    const second = selectWardenAccount({ config: rrConfig, installedAgents: INSTALLED, usage: [], state, nowMs: NOW });
    if (second.exhausted) throw new Error('unexpected exhaustion');
    expect(second.account.wrapper).toBe('claude-auto-a');
  });

  test('cursor round-trips through persisted state', () => {
    const selection = selectWardenAccount({
      config: rrConfig,
      installedAgents: INSTALLED,
      usage: [],
      state: { rrCursor: 1 },
      nowMs: NOW,
    });
    if (selection.exhausted) throw new Error('unexpected exhaustion');
    expect(selection.account.wrapper).toBe('claude-auto-c');
    expect(selection.state.rrCursor).toBe(2);
  });
});

describe('strikes and demotion', () => {
  const knobs = { failureThreshold: 2, cooldownMinutes: 30 };

  test('generic failures need failureThreshold consecutive strikes', () => {
    const first = recordWardenFailure({}, 'claude-auto-a', 'generic', 'tmux died', NOW, knobs);
    expect(first.demoted).toBe(false);
    expect(first.strikes).toBe(1);
    expect(isDemoted(first.state, 'claude-auto-a', NOW)).toBe(false);
    const second = recordWardenFailure(first.state, 'claude-auto-a', 'generic', 'tmux died again', NOW + 1000, knobs);
    expect(second.demoted).toBe(true);
    expect(isDemoted(second.state, 'claude-auto-a', NOW + 1000)).toBe(true);
    // Cooldown length honored.
    expect(isDemoted(second.state, 'claude-auto-a', NOW + 1000 + 30 * 60_000 + 1)).toBe(false);
  });

  test('a success resets the consecutive counter', () => {
    const first = recordWardenFailure({}, 'claude-auto-a', 'generic', 'blip', NOW, knobs);
    const reset = recordWardenSuccess(first.state, 'claude-auto-a');
    expect(reset.strikes?.['claude-auto-a']).toBeUndefined();
    const again = recordWardenFailure(reset, 'claude-auto-a', 'generic', 'blip', NOW + 1000, knobs);
    expect(again.demoted).toBe(false); // back to strike 1, not 2
  });

  test('quota, auth, and provider evidence demote in ONE strike (corroborated at source)', () => {
    for (const kind of ['quota', 'auth', 'provider'] as const) {
      const result = recordWardenFailure({}, 'claude-auto-a', kind, `${kind} says no`, NOW, knobs);
      expect(result.demoted).toBe(true);
    }
  });

  test('classifyWardenFailure matches the preflight error wording', () => {
    expect(classifyWardenFailure('wrapper claude-auto-a is at its usage limit (resets 2026-07-27T12:00:00Z)')).toBe(
      'quota',
    );
    expect(
      classifyWardenFailure(
        "wrapper claude-auto-a's credentials were rejected (kfleet usage reports auth failure); run `kfleet login`",
      ),
    ).toBe('auth');
    expect(classifyWardenFailure('wrapper claude-auto-a CLI/provider is unavailable: cooldown')).toBe('provider');
    expect(classifyWardenFailure('tmux new-session exited 1')).toBe('generic');
  });

  test('unknown feed data never un-demotes (only POSITIVE evidence does)', () => {
    const state: WardenFailoverState = { demotedUntil: { 'claude-auto-a': iso(NOW + 60_000) } };
    // No record at all, and a record with unknown atLimit: both keep the demotion.
    expect(reconcileDemotions(state, [], NOW).restored).toEqual([]);
    expect(reconcileDemotions(state, [{ binary: 'claude-auto-a' }], NOW).restored).toEqual([]);
  });

  test('expired demotions are pruned as cooldown restores', () => {
    const state: WardenFailoverState = { demotedUntil: { 'claude-auto-a': iso(NOW - 1) } };
    const { state: next, restored } = reconcileDemotions(state, [], NOW);
    expect(restored).toEqual([{ wrapper: 'claude-auto-a', how: 'cooldown' }]);
    expect(next.demotedUntil?.['claude-auto-a']).toBeUndefined();
    // Strikes survive a cooldown restore: a genuinely dead account re-demotes
    // after ONE more failure instead of getting a fresh threshold budget.
    const again = recordWardenFailure(
      { ...next, strikes: { 'claude-auto-a': { count: 2, lastAt: iso(NOW - 60_000), lastReason: 'x' } } },
      'claude-auto-a',
      'generic',
      'still dead',
      NOW,
      { failureThreshold: 2, cooldownMinutes: 30 },
    );
    expect(again.demoted).toBe(true);
  });
});

describe('exhaustion', () => {
  test('empty eligible list returns exhausted with per-wrapper reasons', () => {
    const feed = [usage({ binary: 'claude-auto-a', atLimit: true }), usage({ binary: 'claude-auto-b', authOk: false })];
    const selection = selectWardenAccount({
      config: config({ accounts: ['claude-auto-a', 'claude-auto-b', 'claude-auto-gone'] }),
      installedAgents: INSTALLED,
      usage: feed,
      state: {},
      nowMs: NOW,
    });
    expect(selection.exhausted).toBe(true);
    if (!selection.exhausted) throw new Error('expected exhaustion');
    expect(Object.keys(selection.reasons).sort()).toEqual(['claude-auto-a', 'claude-auto-b', 'claude-auto-gone']);
    expect(selection.state.exhaustedSince).toBe(iso(NOW));
  });

  test('exhaustedSince is edge-triggered (kept, not re-stamped) and cleared on recovery', () => {
    const earlier = iso(NOW - 10 * 60_000);
    const stillExhausted = selectWardenAccount({
      config: config({ accounts: ['claude-auto-gone'] }),
      installedAgents: INSTALLED,
      usage: [],
      state: { exhaustedSince: earlier },
      nowMs: NOW,
    });
    if (!stillExhausted.exhausted) throw new Error('expected exhaustion');
    expect(stillExhausted.state.exhaustedSince).toBe(earlier);
    const recovered = selectWardenAccount({
      config: config(),
      installedAgents: INSTALLED,
      usage: [],
      state: { exhaustedSince: earlier },
      nowMs: NOW,
    });
    if (recovered.exhausted) throw new Error('unexpected exhaustion');
    expect(recovered.state.exhaustedSince).toBeUndefined();
  });
});
