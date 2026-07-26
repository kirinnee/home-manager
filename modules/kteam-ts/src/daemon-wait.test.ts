import { describe, expect, test } from 'bun:test';
import { DaemonExitedError, DaemonNotReadyError, waitForDaemonReady, type PidLiveness } from './daemon-wait';

/** A fake clock whose `sleep` advances time — so a 90 s wait runs instantly and
 *  deterministically, with no real timers. */
function fakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('waitForDaemonReady (B2)', () => {
  test('happy path returns immediately without probing the pid', async () => {
    const clock = fakeClock();
    let pidProbes = 0;
    const health = await waitForDaemonReady({
      health: async () => ({ ok: true, pid: 42 }),
      pidLiveness: async () => {
        pidProbes++;
        return 'alive';
      },
      sleep: clock.sleep,
      now: clock.now,
      daemonLog: '/tmp/log',
    });
    expect(health.pid).toBe(42);
    // Health answered on the first try, so the death probe never ran.
    expect(pidProbes).toBe(0);
  });

  test('slow bind: succeeds after >10 s and notes progress once', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const progress: number[] = [];
    // Health fails for the first ~12 s of 250 ms ticks, then binds. The pid file
    // is absent the whole pre-bind window (daemon writes it only after listen).
    const health = await waitForDaemonReady(
      {
        health: async () => {
          attempts++;
          // 12 s / 250 ms ≈ 48 failed ticks before success.
          if (clock.now() < 12_000) throw new Error('connection refused');
          return { ok: true, pid: 7 };
        },
        pidLiveness: async () => 'absent',
        sleep: clock.sleep,
        now: clock.now,
        onProgress: seconds => progress.push(seconds),
        daemonLog: '/tmp/log',
      },
      { progressAfterMs: 10_000 },
    );
    expect(health.pid).toBe(7);
    expect(attempts).toBeGreaterThan(40); // well past the old 40-attempt / 10 s cap
    // Exactly one progress note, fired after the 10 s threshold.
    expect(progress.length).toBe(1);
    expect(progress[0]).toBeGreaterThanOrEqual(10);
  });

  test('dead pid: fast-fails with a distinct error once it was alive then died', async () => {
    const clock = fakeClock();
    // The daemon comes up (pid alive) but never serves health, then the process
    // dies — pidLiveness flips alive → dead.
    const liveness: PidLiveness[] = ['alive', 'alive', 'dead'];
    let i = 0;
    const promise = waitForDaemonReady({
      health: async () => {
        throw new Error('connection refused');
      },
      pidLiveness: async () => liveness[Math.min(i++, liveness.length - 1)]!,
      sleep: clock.sleep,
      now: clock.now,
      daemonLog: '/tmp/kteamd.log',
    });
    await expect(promise).rejects.toBeInstanceOf(DaemonExitedError);
    // Bailed almost immediately — nowhere near the 90 s deadline.
    expect(clock.now()).toBeLessThan(2_000);
  });

  test('stale dead pid (never seen alive) is presumed stale — keeps waiting, then times out', async () => {
    const clock = fakeClock();
    // A leftover pid file from a prior crash reads 'dead' from the start, and the
    // freshly-starting daemon never manages to bind in this scenario.
    const promise = waitForDaemonReady(
      {
        health: async () => {
          throw new Error('connection refused');
        },
        pidLiveness: async () => 'dead',
        sleep: clock.sleep,
        now: clock.now,
        daemonLog: '/tmp/log',
      },
      { deadlineMs: 5_000, cadenceMs: 250 },
    );
    // NOT a DaemonExitedError: a first-probe 'dead' is treated as a stale pid, so
    // we wait out the deadline instead of falsely declaring death.
    await expect(promise).rejects.toBeInstanceOf(DaemonNotReadyError);
    expect(clock.now()).toBeGreaterThanOrEqual(5_000);
  });
});
