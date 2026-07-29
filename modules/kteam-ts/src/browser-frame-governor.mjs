export const MIN_FRAME_INTERVAL_MS = 66;
export const MAX_HELD_FRAME_ACKS = 3;

const systemClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
};

/**
 * Keep the screencast's timing, acknowledgement, and stdout-pressure policy
 * separate from Playwright. The worker binds one CDP session at a time; all
 * retained bytes stay associated with that session until they are emitted or
 * discarded on a rebind.
 */
export function createBrowserFrameGovernor({
  clock = systemClock,
  minIntervalMs = MIN_FRAME_INTERVAL_MS,
  maxHeldAcks = MAX_HELD_FRAME_ACKS,
  writeFrame,
  watchDrain,
  onAckRejected,
} = {}) {
  if (typeof writeFrame !== 'function') throw new TypeError('writeFrame is required');

  const acknowledgementLimit = Math.max(1, Math.floor(maxHeldAcks));
  let activeSession;
  let pending;
  let heldAcks = [];
  let timer;
  let removeDrain;
  let outputWritable = true;
  let lastOutputAt = Number.NEGATIVE_INFINITY;
  let lastCycleAt = Number.NEGATIVE_INFINITY;
  let recoverySession;

  function clearTimer() {
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    timer = undefined;
  }

  function resetSession() {
    clearTimer();
    pending = undefined;
    heldAcks = [];
    activeSession = undefined;
    lastOutputAt = Number.NEGATIVE_INFINITY;
    lastCycleAt = Number.NEGATIVE_INFINITY;
    recoverySession = undefined;
  }

  function reportAckFailure(session) {
    if (session !== activeSession || recoverySession === session) return;
    recoverySession = session;
    try {
      onAckRejected?.(session);
    } catch {
      // The worker's recovery hook is deliberately best effort. A later
      // lifecycle rebind still clears this session's retained state.
    }
  }

  function acknowledge(record) {
    let result;
    try {
      result = record.acknowledge();
    } catch {
      reportAckFailure(record.session);
      return;
    }
    void Promise.resolve(result).catch(() => reportAckFailure(record.session));
  }

  function releaseHeldAcks(session) {
    const acknowledgements = heldAcks;
    heldAcks = [];
    for (const record of acknowledgements) {
      if (record.session === session && session === activeSession) acknowledge(record);
    }
  }

  function armDrain() {
    if (removeDrain || typeof watchDrain !== 'function') return;
    let listening = true;
    const onDrain = () => {
      if (!listening) return;
      listening = false;
      removeDrain = undefined;
      outputWritable = true;
      if (!activeSession) return;
      if (pending) schedule();
      else releaseHeldAcks(activeSession);
    };
    const dispose = watchDrain(onDrain);
    if (!listening) dispose?.();
    else
      removeDrain = () => {
        listening = false;
        dispose?.();
      };
  }

  function flush() {
    const session = activeSession;
    const record = pending;
    if (!session || !record || record.session !== session) return;

    const now = clock.now();
    if (
      (outputWritable && Number.isFinite(lastOutputAt) && now - lastOutputAt < minIntervalMs) ||
      (!outputWritable && Number.isFinite(lastCycleAt) && now - lastCycleAt < minIntervalMs)
    ) {
      schedule();
      return;
    }

    lastCycleAt = now;
    if (outputWritable) {
      // `false` from stdout.write means this frame itself was accepted, but
      // the next frame must wait for drain. Never retain/replay this one.
      pending = undefined;
      outputWritable = writeFrame(record.frame) !== false;
      lastOutputAt = now;
      if (!outputWritable) armDrain();
    }
    // Acks deliberately stay outside the worker's serial command queue. Do
    // not release them while stdout is blocked: Chrome then keeps its proven
    // three-frame window bounded and the drain edge emits the freshest frame
    // before capture resumes.
    if (outputWritable) releaseHeldAcks(session);
  }

  function schedule() {
    if (!activeSession || !pending || timer !== undefined) return;
    const now = clock.now();
    const prior = outputWritable ? lastOutputAt : lastCycleAt;
    const dueAt = Number.isFinite(prior) ? prior + minIntervalMs : now;
    if (dueAt <= now) {
      flush();
      return;
    }
    const expectedSession = activeSession;
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (expectedSession !== activeSession) return;
      flush();
    }, dueAt - now);
  }

  return {
    bind(session) {
      // stdout belongs to the worker process rather than a CDP session. Keep
      // its blocked/drain state across a rebind so a new page cannot enqueue a
      // frame behind the old page and then lose the only recovery wakeup.
      resetSession();
      activeSession = session;
    },

    capture(session, frame, acknowledgeFrame) {
      if (session !== activeSession || typeof acknowledgeFrame !== 'function') return;
      pending = { session, frame };
      if (heldAcks.length >= acknowledgementLimit) {
        // The real CDP probe caps this window at three. If a future Chrome
        // violates that contract, rebind instead of growing memory or leaking
        // an acknowledgement under stdout pressure.
        reportAckFailure(session);
        return;
      }
      heldAcks.push({ session, acknowledge: acknowledgeFrame });
      schedule();
    },

    stop() {
      // Retained frame bytes, acks, and timers are session-scoped. A pending
      // stdout drain is process-scoped and must survive so a later bind can
      // flush its own newest frame after the original backpressure clears.
      resetSession();
    },

    snapshot() {
      return {
        activeSession,
        hasPendingFrame: pending !== undefined,
        pendingFrame: pending?.frame,
        heldAckCount: heldAcks.length,
        hasTimer: timer !== undefined,
        outputWritable,
        lastOutputAt: Number.isFinite(lastOutputAt) ? lastOutputAt : undefined,
        lastCycleAt: Number.isFinite(lastCycleAt) ? lastCycleAt : undefined,
      };
    },
  };
}
