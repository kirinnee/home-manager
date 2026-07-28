import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WardenConfigCard, accountHealthLabel, editableAccounts, pickableWardenWrappers } from './WardenConfigCard';
import type { WardenConfigView, WardenFailoverStatus, WrapperInfo } from '../types';

const view: WardenConfigView = {
  config: {
    enabled: true,
    wrapper: 'claude-auto-a',
    accounts: ['claude-auto-a', { wrapper: 'claude-auto-b', model: 'opus' }],
    failover: { policy: 'fallback', failureThreshold: 2, cooldownMinutes: 30 },
    intervalMinutes: 5,
  },
  accounts: [{ wrapper: 'claude-auto-a' }, { wrapper: 'claude-auto-b', model: 'opus' }],
  warnings: [],
};

const failover: WardenFailoverStatus = {
  policy: 'fallback',
  failureThreshold: 2,
  cooldownMinutes: 30,
  accounts: [
    { wrapper: 'claude-auto-a', eligible: true, quota: { fiveHourPercent: 12, weeklyPercent: 40 } },
    {
      wrapper: 'claude-auto-b',
      eligible: false,
      reason: 'demoted until 2026-07-27T12:00:00Z',
      demotedUntil: '2026-07-27T12:00:00Z',
      strikes: 2,
    },
  ],
  lastSelection: { wrapper: 'claude-auto-a', policy: 'fallback', at: '2026-07-27T10:00:00Z', reason: 'preferred' },
};

describe('editableAccounts', () => {
  test('copies the normalized account list for editing (null-safe)', () => {
    expect(editableAccounts(null)).toEqual([]);
    const accounts = editableAccounts(view);
    expect(accounts).toEqual([{ wrapper: 'claude-auto-a' }, { wrapper: 'claude-auto-b', model: 'opus' }]);
    // A copy, not the same references — editing must not mutate the fetched view.
    expect(accounts[0]).not.toBe(view.accounts[0]);
  });
});

describe('pickableWardenWrappers', () => {
  test('offers launchable Claude and Codex auto wrappers only once', () => {
    const wrappers: WrapperInfo[] = [
      {
        name: 'claude-auto-a',
        harness: 'claude',
        mode: 'auto',
        launchable: true,
        modelHint: 'claude',
      },
      {
        name: 'codex-auto-a',
        harness: 'codex',
        mode: 'auto',
        launchable: true,
        modelHint: 'codex',
      },
      {
        name: 'codex-a',
        harness: 'codex',
        mode: 'interactive',
        launchable: true,
        modelHint: 'codex',
      },
      {
        name: 'codex-auto-unavailable',
        harness: 'codex',
        mode: 'auto',
        launchable: false,
        modelHint: 'codex',
      },
    ];

    expect(pickableWardenWrappers(wrappers, [{ wrapper: 'claude-auto-a' }])).toEqual(['codex-auto-a']);
  });
});

describe('accountHealthLabel', () => {
  test('healthy account shows quota percentages', () => {
    const health = accountHealthLabel('claude-auto-a', failover);
    expect(health.tone).toBe('ok');
    expect(health.label).toContain('healthy');
    expect(health.label).toContain('5h 12%');
    expect(health.label).toContain('wk 40%');
  });

  test('demoted account reads as cooling down', () => {
    const health = accountHealthLabel('claude-auto-b', failover);
    expect(health.tone).toBe('warn');
    expect(health.label).toContain('cooling down');
  });

  test('an account the status has never scored is unknown, not unhealthy', () => {
    const health = accountHealthLabel('claude-auto-new', failover);
    expect(health.tone).toBe('muted');
    expect(health.label).toBe('health unknown');
    expect(accountHealthLabel('claude-auto-x', undefined).tone).toBe('muted');
  });
});

describe('WardenConfigCard', () => {
  test('renders nothing before the config loads (and on daemons without the route)', () => {
    // Static render never runs effects, so the card is in its pre-fetch state —
    // exactly the shape it holds against an older daemon: hidden, not broken.
    expect(renderToStaticMarkup(<WardenConfigCard />)).toBe('');
  });
});
