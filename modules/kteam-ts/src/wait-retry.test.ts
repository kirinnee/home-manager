import { describe, expect, test } from 'bun:test';
import { getWithRetry, isDaemonTransportError, WAIT_DAEMON_UNREACHABLE_EXIT } from './wait-retry';

const DOWN = 'kteam daemon is unavailable at http://127.0.0.1:7337 (Unable to connect.); run `kteam daemon start`';

/** A fake clock whose sleep advances time, so the retry window runs instantly. */
function clock() {
  let at = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: {
      now: () => at,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        at += ms;
      },
    },
  };
}

describe('getWithRetry', () => {
  test('unavailable twice then a terminal view reconnects and returns it', async () => {
    const { deps, sleeps } = clock();
    const notes: string[] = [];
    let calls = 0;
    const result = await getWithRetry(
      async () => {
        calls += 1;
        if (calls <= 2) throw new Error(DOWN);
        return { status: 'completed' };
      },
      { ...deps, onUnreachable: message => notes.push(message) },
    );
    expect(result).toEqual({ kind: 'ok', value: { status: 'completed' } });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(notes).toEqual([DOWN]);
  });

  test('a persistent outage gives up as unreachable after the window', async () => {
    const { deps, sleeps } = clock();
    const result = await getWithRetry(async () => {
      throw new Error(DOWN);
    }, deps);
    expect(result.kind).toBe('unreachable');
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(120_000);
    expect(Math.max(...sleeps)).toBe(10_000);
    expect(WAIT_DAEMON_UNREACHABLE_EXIT).toBe(3);
  });

  test('the wait --timeout deadline cuts the retries short', async () => {
    const { deps, sleeps } = clock();
    const deadline = deps.now() + 5_000;
    const result = await getWithRetry(
      async () => {
        throw new Error('kteam daemon did not answer /v1/sessions/x within 120s');
      },
      deps,
      { deadline },
    );
    expect(result.kind).toBe('timed_out');
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(5_000);
  });

  test('a daemon answer that is an error is rethrown, not retried', async () => {
    const { deps, sleeps } = clock();
    await expect(
      getWithRetry(async () => {
        throw new Error('session not found: x');
      }, deps),
    ).rejects.toThrow('session not found');
    expect(sleeps).toEqual([]);
    expect(isDaemonTransportError(new Error('session not found'))).toBe(false);
  });
});
