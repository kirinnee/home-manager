import { describe, expect, test } from 'bun:test';
import { type UsageAccount, UsageGate } from './gate';

function acct(p: Partial<UsageAccount> & { binary: string }): UsageAccount {
  return { provider: 'anthropic', usageBased: true, ok: true, atLimit: false, ...p };
}

/** A fetch stub returning successive payloads from `queue` (last one repeats). */
function fakeFetch(queue: UsageAccount[][]): typeof fetch {
  let i = 0;
  return (async () => {
    const accounts = queue[Math.min(i, queue.length - 1)]!;
    i++;
    return new Response(JSON.stringify({ at: 1, accounts }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('UsageGate.weight', () => {
  test('unknown / untracked / failed-probe ⇒ weight 1 (never penalize the unmeasurable)', async () => {
    const gate = new UsageGate({
      enabled: true,
      fetchImpl: fakeFetch([
        [
          acct({ binary: 'tracked', fiveHourPercent: 0, weeklyPercent: 0 }),
          acct({ binary: 'untracked', usageBased: false }),
          acct({ binary: 'failed', ok: false }),
        ],
      ]),
    });
    await gate.refresh(true);
    expect(gate.weight('not-in-snapshot')).toBe(1);
    expect(gate.weight('untracked')).toBe(1);
    expect(gate.weight('failed')).toBe(1);
    expect(gate.weight('tracked')).toBe(1);
  });

  test('not logged in / missing key ⇒ weight 0', async () => {
    const gate = new UsageGate({
      enabled: true,
      fetchImpl: fakeFetch([
        [acct({ binary: 'loggedout', authOk: false }), acct({ binary: 'nokey', unavailable: true })],
      ]),
    });
    await gate.refresh(true);
    expect(gate.weight('loggedout')).toBe(0);
    expect(gate.weight('nokey')).toBe(0);
  });

  test('5h hard gate: under the floor% left ⇒ weight 0', async () => {
    const gate = new UsageGate({
      enabled: true,
      fiveHourFloorPercent: 3,
      fetchImpl: fakeFetch([
        [
          acct({ binary: 'near5h', fiveHourPercent: 98, weeklyPercent: 10 }), // 2% left < 3 → gated
          acct({ binary: 'ok5h', fiveHourPercent: 90, weeklyPercent: 10 }), // 10% left → fine
        ],
      ]),
    });
    await gate.refresh(true);
    expect(gate.weight('near5h')).toBe(0);
    expect(gate.weight('ok5h')).toBeGreaterThan(0);
  });

  test('weekly soft weight = fraction of weekly quota remaining', async () => {
    const gate = new UsageGate({
      enabled: true,
      fetchImpl: fakeFetch([
        [
          acct({ binary: 'fresh', fiveHourPercent: 0, weeklyPercent: 0 }), // 1.0
          acct({ binary: 'mid', fiveHourPercent: 0, weeklyPercent: 73 }), // 0.27
          acct({ binary: 'maxed', fiveHourPercent: 0, weeklyPercent: 100 }), // 0
        ],
      ]),
    });
    await gate.refresh(true);
    expect(gate.weight('fresh')).toBeCloseTo(1, 5);
    expect(gate.weight('mid')).toBeCloseTo(0.27, 5);
    expect(gate.weight('maxed')).toBe(0);
  });

  test('isAvailable = weight > 0', async () => {
    const gate = new UsageGate({
      enabled: true,
      fetchImpl: fakeFetch([
        [acct({ binary: 'maxed', weeklyPercent: 100 }), acct({ binary: 'fine', weeklyPercent: 10 })],
      ]),
    });
    await gate.refresh(true);
    expect(gate.isAvailable('maxed')).toBe(false);
    expect(gate.isAvailable('fine')).toBe(true);
  });

  test('disabled gate ⇒ weight 1, never fetches', async () => {
    let called = 0;
    const f = (async () => {
      called++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const gate = new UsageGate({ enabled: false, fetchImpl: f });
    await gate.refresh(true);
    await gate.awaitCapacity(['x']);
    expect(called).toBe(0);
    expect(gate.weight('x')).toBe(1);
  });
});

describe('UsageGate.refresh', () => {
  test('a failed fetch clears the snapshot and fails open (weight 1)', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) {
        return new Response(JSON.stringify({ accounts: [acct({ binary: 'maxed', weeklyPercent: 100 })] }), {
          status: 200,
        });
      }
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const gate = new UsageGate({ enabled: true, fetchImpl: f, log: m => logs.push(m) });
    await gate.refresh(true);
    expect(gate.weight('maxed')).toBe(0);
    await gate.refresh(true); // fails → snapshot cleared → fail open
    expect(gate.weight('maxed')).toBe(1);
    expect(logs.some(l => l.includes('unavailable'))).toBe(true);
  });
});

describe('UsageGate.awaitCapacity', () => {
  test('returns immediately when one candidate is usable', async () => {
    let slept = 0;
    const gate = new UsageGate({
      enabled: true,
      fetchImpl: fakeFetch([[acct({ binary: 'ok', weeklyPercent: 10 })]]),
      sleep: async () => {
        slept++;
      },
    });
    await gate.awaitCapacity(['ok']);
    expect(slept).toBe(0);
  });

  test('blocks until a 5h reset frees a gated account', async () => {
    let clock = 1_000_000;
    const resetAt = clock + 60_000;
    const sleeps: number[] = [];
    const gate = new UsageGate({
      enabled: true,
      now: () => clock,
      sleep: async ms => {
        sleeps.push(ms);
        clock += ms;
      },
      fetchImpl: fakeFetch([
        [acct({ binary: 'a', fiveHourPercent: 99, fiveHourResetAt: resetAt })], // 1% left → gated
        [acct({ binary: 'a', fiveHourPercent: 10 })], // freed after reset
      ]),
    });
    await gate.awaitCapacity(['a']);
    expect(sleeps.length).toBe(1);
    expect(gate.isAvailable('a')).toBe(true);
  });

  test('empty candidate list is a no-op', async () => {
    let called = 0;
    const f = (async () => {
      called++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const gate = new UsageGate({ enabled: true, fetchImpl: f });
    await gate.awaitCapacity([]);
    expect(called).toBe(0);
  });
});
