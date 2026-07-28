import { describe, expect, test } from 'bun:test';
import {
  authFailureRemedy,
  compactUsageQuota,
  providerUnavailableDetail,
  quotaFromUsage,
  USAGE_REFRESH_MS,
  UsageFeed,
  usageAccountView,
  usageEventData,
  usageQuotaLabel,
  usageStateFromQuota,
} from './usage';
import type { SessionState } from './types';

const payload = (weeklyPercent: number) =>
  new Response(
    JSON.stringify({
      accounts: [
        {
          binary: 'claude-auto-kirin',
          ok: true,
          authOk: true,
          usageBased: true,
          fiveHourPercent: 4,
          weeklyPercent,
          fiveHourResetAt: 1_784_971_199_927,
          weeklyResetAt: 1_785_088_800_927,
          atLimit: false,
        },
      ],
    }),
  );

describe('cached kfleet usage feed', () => {
  test('shares one snapshot for the configured 300-second refresh interval', async () => {
    let at = 0;
    let calls = 0;
    const feed = new UsageFeed('http://usage.test/usage', {
      now: () => at,
      fetcher: async () => payload(++calls),
    });

    expect((await feed.accounts())[0]?.weeklyPercent).toBe(1);
    at = USAGE_REFRESH_MS - 1;
    expect((await feed.accounts())[0]?.weeklyPercent).toBe(1);
    expect(calls).toBe(1);

    at = USAGE_REFRESH_MS + 1;
    expect((await feed.accounts())[0]?.weeklyPercent).toBe(2);
    expect(calls).toBe(2);
  });

  test('coalesces concurrent readers and retains the last good snapshot on failure', async () => {
    let at = 0;
    let calls = 0;
    let release!: (response: Response) => void;
    const feed = new UsageFeed('http://usage.test/usage', {
      now: () => at,
      fetcher: async () => {
        calls += 1;
        if (calls === 1) return await new Promise<Response>(resolve => (release = resolve));
        throw new Error('feed unavailable');
      },
    });

    const first = feed.accounts();
    const second = feed.accounts();
    expect(calls).toBe(1);
    release(payload(62));
    expect(await first).toEqual(await second);

    at = USAGE_REFRESH_MS + 1;
    expect((await feed.accounts())[0]?.weeklyPercent).toBe(62);
    expect(calls).toBe(2);
    // Failed refreshes are backed off, so a fleet of readers cannot hammer
    // the endpoint once per session.
    expect((await feed.accounts())[0]?.weeklyPercent).toBe(62);
    expect(calls).toBe(2);
  });

  test('uses one cached CLI fallback when the HTTP feed is unavailable', async () => {
    let at = 0;
    let fallbackCalls = 0;
    const feed = new UsageFeed('http://usage.test/usage', {
      now: () => at,
      fetcher: async () => {
        throw new Error('connection refused');
      },
      fallback: async () => {
        fallbackCalls += 1;
        return [{ binary: 'claude-auto-kirin', weeklyPercent: 62 }];
      },
    });

    expect((await feed.accounts())[0]?.weeklyPercent).toBe(62);
    at = USAGE_REFRESH_MS - 1;
    expect((await feed.accounts())[0]?.weeklyPercent).toBe(62);
    expect(fallbackCalls).toBe(1);
  });
});

describe('session usage projection', () => {
  test('maps percentages, independent reset timestamps, and limit state without conversion', () => {
    const quota = quotaFromUsage({
      binary: 'claude-auto-kirin',
      ok: true,
      authOk: true,
      usageBased: true,
      fiveHourPercent: 0,
      weeklyPercent: 62,
      fiveHourResetAt: 1_784_971_199_927,
      weeklyResetAt: 1_785_088_800_927,
      atLimit: false,
    });
    expect(quota).toEqual({
      usageBased: true,
      atLimit: false,
      authOk: true,
      fiveHourPercent: 0,
      weeklyPercent: 62,
      fiveHourResetAt: 1_784_971_199_927,
      weeklyResetAt: 1_785_088_800_927,
      resetAt: 1_784_971_199_927,
    });
    expect(usageStateFromQuota(quota)).toEqual({
      usage5hPercent: 0,
      usageWeeklyPercent: 62,
      usage5hResetAt: 1_784_971_199_927,
      usageWeeklyResetAt: 1_785_088_800_927,
      usageAtLimit: false,
      usageAuthOk: true,
    });
  });

  test('surfaces auth failure while suppressing placeholder zero percentages', () => {
    const quota = quotaFromUsage({
      binary: 'claude-auto-logged-out',
      ok: false,
      authOk: false,
      fiveHourPercent: 0,
      weeklyPercent: 0,
      atLimit: false,
    });
    expect(quota).toEqual({ authOk: false });
    const state = usageStateFromQuota(quota);
    expect(state).toEqual({
      usage5hPercent: undefined,
      usageWeeklyPercent: undefined,
      usage5hResetAt: undefined,
      usageWeeklyResetAt: undefined,
      usageAtLimit: undefined,
      usageAuthOk: false,
    });
    expect(usageEventData(state as SessionState)).toEqual({ usageAuthOk: false });
  });

  test('keeps a transport/probe failure unknown instead of inventing auth failure', () => {
    expect(
      quotaFromUsage({
        binary: 'claude-auto-atomi',
        provider: 'anthropic',
        usageBased: true,
        ok: false,
        atLimit: false,
      }),
    ).toEqual({ usageBased: true, provider: 'anthropic' });
  });

  test('carries confirmed CLIProxy cooldown without fabricating numerical quota', () => {
    const quota = quotaFromUsage({
      binary: 'claude-auto-loge',
      provider: 'cliproxy',
      usageBased: false,
      ok: true,
      availability: 'unavailable',
      unavailable: true,
      unavailableReason: 'cooldown',
      retryAt: 1_785_259_371_000,
      authOk: true,
      atLimit: true,
      fiveHourPercent: 100,
    });
    expect(quota).toEqual({
      usageBased: false,
      availability: 'unavailable',
      unavailable: true,
      unavailableReason: 'cooldown',
      retryAt: 1_785_259_371_000,
      atLimit: true,
      authOk: true,
      provider: 'cliproxy',
    });
  });

  test('carries generic provider-down independently from atLimit', () => {
    expect(
      quotaFromUsage({
        binary: 'claude-auto-loge',
        provider: 'cliproxy',
        usageBased: false,
        ok: true,
        availability: 'unavailable',
        unavailable: true,
        unavailableReason: 'provider',
        authOk: true,
        atLimit: false,
      }),
    ).toMatchObject({ unavailable: true, unavailableReason: 'provider', atLimit: false, authOk: true });
  });

  test('formats provider-down preflight detail with cause and retry time', () => {
    expect(
      providerUnavailableDetail({ unavailableReason: 'cooldown', retryAt: Date.parse('2026-07-28T08:00:00Z') }),
    ).toBe('all proxy credentials are cooling down; retry after 2026-07-28T08:00:00.000Z');
  });

  test('omits null windows from partially reported account usage', () => {
    expect(
      quotaFromUsage({
        binary: 'codex-auto-atomi',
        ok: true,
        authOk: true,
        usageBased: true,
        fiveHourPercent: 100,
        weeklyPercent: null,
        fiveHourResetAt: 1_785_259_371_000,
        weeklyResetAt: null,
        atLimit: true,
      }),
    ).toEqual({
      usageBased: true,
      atLimit: true,
      authOk: true,
      fiveHourPercent: 100,
      fiveHourResetAt: 1_785_259_371_000,
      resetAt: 1_785_259_371_000,
    });
  });
});

describe('auth-failure remedy is achievable per account kind', () => {
  test('OAuth accounts (anthropic/codex) → run kfleet login', () => {
    expect(authFailureRemedy('anthropic')).toBe('run `kfleet login`');
    expect(authFailureRemedy('codex')).toBe('run `kfleet login`');
  });

  test('minimax API-key account → rotate the key in sops, NEVER kfleet login', () => {
    const remedy = authFailureRemedy('minimax');
    expect(remedy).toContain('$MINIMAX_API_KEY');
    expect(remedy).toContain('sops');
    expect(remedy).not.toContain('kfleet login'); // login skips API-key accounts — impossible advice
  });

  test('z.ai API-key account → rotate the key in sops, NEVER kfleet login', () => {
    const remedy = authFailureRemedy('zai');
    expect(remedy).toContain('z.ai');
    expect(remedy).toContain('sops');
    expect(remedy).not.toContain('kfleet login');
  });

  test('CLIProxy auth failure points to the credential pool, not kfleet OAuth login', () => {
    const remedy = authFailureRemedy('cliproxy');
    expect(remedy).toContain('kloge pull');
    expect(remedy).not.toContain('kfleet login');
  });

  test('unknown/absent provider → names both paths without guessing wrong', () => {
    const remedy = authFailureRemedy(undefined);
    expect(remedy).toContain('kfleet login'); // OAuth path
    expect(remedy).toContain('sops'); // API-key path
  });

  test('quotaFromUsage carries the provider through so the remedy can be chosen', () => {
    const quota = quotaFromUsage({
      binary: 'claude-auto-mm3',
      provider: 'minimax',
      ok: false,
      authOk: false,
      usageBased: true,
      atLimit: false,
    });
    expect(quota.authOk).toBe(false);
    expect(quota.usageBased).toBe(true);
    expect(quota.provider).toBe('minimax');
    expect(authFailureRemedy(quota.provider)).toContain('$MINIMAX_API_KEY');
  });
});

// The /v1/usage wire shape. It must be keyed by the wrapper binary (the join
// key the browser already has on every session config) and must carry through
// the same "unknown is not zero" normalization the session state uses — a
// second, looser projection would let the API contradict `kteam ps`.
describe('usageAccountView (the /v1/usage wire projection)', () => {
  test('keys by binary and keeps both windows plus their resets', () => {
    expect(
      usageAccountView({
        binary: 'claude-auto-atomi',
        ok: true,
        authOk: true,
        usageBased: true,
        fiveHourPercent: 7,
        weeklyPercent: 49,
        fiveHourResetAt: 1_784_964_000_363,
        weeklyResetAt: 1_785_142_800_363,
        atLimit: false,
      }),
    ).toEqual({
      binary: 'claude-auto-atomi',
      usageBased: true,
      atLimit: false,
      authOk: true,
      fiveHourPercent: 7,
      weeklyPercent: 49,
      fiveHourResetAt: 1_784_964_000_363,
      weeklyResetAt: 1_785_142_800_363,
    });
  });

  test('a logged-out wrapper reports authOk:false and NO percentages', () => {
    expect(
      usageAccountView({
        binary: 'claude-auto-dsv4p',
        ok: false,
        authOk: false,
        usageBased: true,
        fiveHourPercent: 0,
        weeklyPercent: 0,
        atLimit: false,
      }),
    ).toEqual({ binary: 'claude-auto-dsv4p', usageBased: true, authOk: false });
  });

  test('an at-limit account keeps atLimit distinct from its percentage', () => {
    const view = usageAccountView({
      binary: 'codex-auto-loai',
      ok: true,
      authOk: true,
      usageBased: true,
      fiveHourPercent: 100,
      weeklyPercent: null,
      fiveHourResetAt: 1_785_259_371_000,
      weeklyResetAt: null,
      atLimit: true,
    });
    expect(view.atLimit).toBe(true);
    expect(view.fiveHourPercent).toBe(100);
    expect(view.weeklyPercent).toBeUndefined();
    // `resetAt` is a CLI-side convenience derived from the two windows; the
    // wire shape carries the windows themselves so the UI can label each.
    expect(view).not.toHaveProperty('resetAt');
  });

  test('preserves raw API-metered evidence without inventing quota or auth data', () => {
    expect(
      usageAccountView({
        binary: 'codex-auto-loge',
        usageBased: false,
        ok: false,
        atLimit: false,
      }),
    ).toEqual({ binary: 'codex-auto-loge', usageBased: false });
  });
});

describe('CLI quota formatting', () => {
  test('renders complete, partial, unknown, limit, and auth states compactly', () => {
    expect(usageQuotaLabel({ usage5hPercent: 4, usageWeeklyPercent: 46 })).toBe('5h 4% · wk 46%');
    expect(compactUsageQuota({ usageWeeklyPercent: 46 })).toBe('—/46%');
    expect(compactUsageQuota({})).toBe('—');
    expect(compactUsageQuota({ usage5hPercent: 100, usageAtLimit: true })).toBe('100%/—!');
    expect(usageQuotaLabel({ usageAuthOk: false })).toBe('AUTH REQUIRED');
    expect(compactUsageQuota({ usageAuthOk: false })).toBe('AUTH!');
  });
});
