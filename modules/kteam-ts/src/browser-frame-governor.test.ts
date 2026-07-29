import { describe, expect, test } from 'bun:test';
// @ts-ignore The worker-compatible governor is intentionally plain ESM.
import { MAX_HELD_FRAME_ACKS, MIN_FRAME_INTERVAL_MS, createBrowserFrameGovernor } from './browser-frame-governor.mjs';

class Clock {
  private time = 0;
  private nextTimer = 0;
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

  now = () => this.time;

  setTimeout = (callback: () => void, delayMs: number) => {
    this.nextTimer += 1;
    this.timers.set(this.nextTimer, { dueAt: this.time + delayMs, callback });
    return this.nextTimer;
  };

  clearTimeout = (timer: number) => {
    this.timers.delete(timer);
  };

  advance(delayMs: number): void {
    const deadline = this.time + delayMs;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= deadline)
        .sort(([leftId, left], [rightId, right]) => left.dueAt - right.dueAt || leftId - rightId)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.time = timer.dueAt;
      timer.callback();
    }
    this.time = deadline;
  }
}

const frame = (label: string, pageId = 'page-1') => ({ label, pageId });

describe('browser frame governor', () => {
  test('caps output at 66ms and delivers a trailing final frame', () => {
    const clock = new Clock();
    const writes: Array<{ at: number; label: string }> = [];
    const acknowledgements: string[] = [];
    const session = { id: 'session-a' };
    const governor = createBrowserFrameGovernor({
      clock,
      writeFrame: (value: { label: string }) => {
        writes.push({ at: clock.now(), label: value.label });
        return true;
      },
    });

    governor.bind(session);
    governor.capture(session, frame('initial'), () => acknowledgements.push('initial'));
    clock.advance(10);
    governor.capture(session, frame('final'), () => acknowledgements.push('final'));
    clock.advance(MIN_FRAME_INTERVAL_MS - 11);
    expect(writes).toEqual([{ at: 0, label: 'initial' }]);
    clock.advance(1);
    expect(writes).toEqual([
      { at: 0, label: 'initial' },
      { at: MIN_FRAME_INTERVAL_MS, label: 'final' },
    ]);
    expect(acknowledgements).toEqual(['initial', 'final']);

    const rateClock = new Clock();
    const outputAt: number[] = [];
    const rateGovernor = createBrowserFrameGovernor({
      clock: rateClock,
      writeFrame: () => {
        outputAt.push(rateClock.now());
        return true;
      },
    });
    rateGovernor.bind(session);
    for (let elapsed = 0; elapsed < 2_000; elapsed += 10) {
      rateGovernor.capture(session, frame(`frame-${elapsed}`), () => undefined);
      rateClock.advance(10);
    }
    expect(outputAt).toHaveLength(Math.floor(2_000 / MIN_FRAME_INTERVAL_MS) + 1);
    for (let index = 1; index < outputAt.length; index += 1) {
      expect(outputAt[index]! - outputAt[index - 1]!).toBeGreaterThanOrEqual(MIN_FRAME_INTERVAL_MS);
    }
  });

  test('retains only the newest frame and no more than three held acknowledgements', () => {
    const clock = new Clock();
    const writes: string[] = [];
    const acknowledgements: string[] = [];
    const session = { id: 'session-a' };
    const governor = createBrowserFrameGovernor({
      clock,
      writeFrame: (value: { label: string }) => {
        writes.push(value.label);
        return true;
      },
    });

    governor.bind(session);
    governor.capture(session, frame('initial'), () => acknowledgements.push('initial'));
    clock.advance(1);
    for (const label of ['one', 'two', 'newest']) {
      governor.capture(session, frame(label), () => acknowledgements.push(label));
    }
    expect(governor.snapshot()).toMatchObject({
      hasPendingFrame: true,
      pendingFrame: frame('newest'),
      heldAckCount: MAX_HELD_FRAME_ACKS,
    });
    clock.advance(MIN_FRAME_INTERVAL_MS - 1);
    expect(writes).toEqual(['initial', 'newest']);
    expect(acknowledgements).toEqual(['initial', 'one', 'two', 'newest']);
  });

  test('drops pending bytes when a page session is superseded', () => {
    const clock = new Clock();
    const writes: Array<{ label: string; pageId: string }> = [];
    let drain: (() => void) | undefined;
    const firstSession = { id: 'session-a' };
    const secondSession = { id: 'session-b' };
    const governor = createBrowserFrameGovernor({
      clock,
      writeFrame: (value: { label: string; pageId: string }) => {
        writes.push(value);
        return writes.length !== 1;
      },
      watchDrain: (callback: () => void) => {
        drain = callback;
        return () => {
          if (drain === callback) drain = undefined;
        };
      },
    });

    governor.bind(firstSession);
    governor.capture(firstSession, frame('first-a', 'page-a'), () => undefined);
    clock.advance(10);
    governor.capture(firstSession, frame('pending-a', 'page-a'), () => undefined);
    governor.bind(secondSession);
    let staleAcknowledged = false;
    governor.capture(firstSession, frame('late-a', 'page-a'), () => {
      staleAcknowledged = true;
    });
    expect(governor.snapshot()).toMatchObject({ hasPendingFrame: false, heldAckCount: 0 });
    expect(staleAcknowledged).toBeFalse();
    governor.capture(secondSession, frame('first-b', 'page-b'), () => undefined);
    clock.advance(100);
    expect(writes).toEqual([{ label: 'first-a', pageId: 'page-a' }]);
    expect(governor.snapshot()).toMatchObject({
      hasPendingFrame: true,
      pendingFrame: frame('first-b', 'page-b'),
      outputWritable: false,
    });
    drain?.();

    expect(writes).toEqual([
      { label: 'first-a', pageId: 'page-a' },
      { label: 'first-b', pageId: 'page-b' },
    ]);
    expect(writes.some(value => value.label === 'pending-a')).toBeFalse();
  });

  test('clears timer, pending frame, and held acknowledgements on stop', () => {
    const clock = new Clock();
    const writes: string[] = [];
    const acknowledgements: string[] = [];
    const session = { id: 'session-a' };
    const governor = createBrowserFrameGovernor({
      clock,
      writeFrame: (value: { label: string }) => {
        writes.push(value.label);
        return true;
      },
    });

    governor.bind(session);
    governor.capture(session, frame('initial'), () => acknowledgements.push('initial'));
    clock.advance(10);
    governor.capture(session, frame('must-not-flush'), () => acknowledgements.push('must-not-flush'));
    expect(governor.snapshot()).toMatchObject({ hasTimer: true, hasPendingFrame: true, heldAckCount: 1 });
    governor.stop();
    expect(governor.snapshot()).toMatchObject({ hasTimer: false, hasPendingFrame: false, heldAckCount: 0 });
    clock.advance(1_000);
    expect(writes).toEqual(['initial']);
    expect(acknowledgements).toEqual(['initial']);
  });

  test('runs the recovery hook once when an acknowledgement rejects for the current session', async () => {
    const clock = new Clock();
    const session = { id: 'session-a' };
    const recoveries: unknown[] = [];
    const governor = createBrowserFrameGovernor({
      clock,
      writeFrame: () => true,
      onAckRejected: (failedSession: unknown) => recoveries.push(failedSession),
    });

    governor.bind(session);
    governor.capture(session, frame('initial'), () => Promise.reject(new Error('ack failed')));
    await Promise.resolve();
    await Promise.resolve();
    expect(recoveries).toEqual([session]);

    governor.stop();
    let rejectStaleAck: ((error: Error) => void) | undefined;
    governor.bind(session);
    governor.capture(
      session,
      frame('stale'),
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStaleAck = reject;
        }),
    );
    governor.stop();
    rejectStaleAck?.(new Error('stale ack failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(recoveries).toEqual([session]);
  });

  test('flushes the newest stdout-held frame on drain', () => {
    const clock = new Clock();
    const writes: string[] = [];
    const acknowledgements: string[] = [];
    let drain: (() => void) | undefined;
    let drainWatchers = 0;
    const session = { id: 'session-a' };
    const governor = createBrowserFrameGovernor({
      clock,
      writeFrame: (value: { label: string }) => {
        writes.push(value.label);
        return writes.length !== 1;
      },
      watchDrain: (callback: () => void) => {
        drainWatchers += 1;
        drain = callback;
        return () => {
          if (drain === callback) drain = undefined;
        };
      },
    });

    governor.bind(session);
    governor.capture(session, frame('already-written'), () => acknowledgements.push('already-written'));
    clock.advance(10);
    governor.capture(session, frame('stale-pending'), () => acknowledgements.push('stale-pending'));
    clock.advance(10);
    governor.capture(session, frame('newest-pending'), () => acknowledgements.push('newest-pending'));
    clock.advance(MIN_FRAME_INTERVAL_MS - 20);
    expect(governor.snapshot()).toMatchObject({
      hasPendingFrame: true,
      pendingFrame: frame('newest-pending'),
      heldAckCount: MAX_HELD_FRAME_ACKS,
      outputWritable: false,
    });
    expect(acknowledgements).toEqual([]);
    expect(drainWatchers).toBe(1);

    drain?.();
    expect(writes).toEqual(['already-written', 'newest-pending']);
    expect(acknowledgements).toEqual(['already-written', 'stale-pending', 'newest-pending']);
    expect(drainWatchers).toBe(1);
    expect(governor.snapshot()).toMatchObject({ hasPendingFrame: false, outputWritable: true });
  });
});
