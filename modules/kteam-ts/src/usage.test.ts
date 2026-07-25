import { describe, expect, test } from 'bun:test';
import {
  compactUsageQuota,
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
      atLimit: true,
      authOk: true,
      fiveHourPercent: 100,
      fiveHourResetAt: 1_785_259_371_000,
      resetAt: 1_785_259_371_000,
    });
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
    ).toEqual({ binary: 'claude-auto-dsv4p', authOk: false });
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
