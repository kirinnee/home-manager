/** Daemon-blip tolerance for `kteam wait`.
 *
 *  `wait` polls `api.get(id)` once a second for as long as a teammate runs.
 *  api-client only rides out ~750 ms of socket errors, so a daemon restart
 *  used to end the wait with "daemon is unavailable" — and an unknown outcome
 *  must never look like a finished session. This keeps retrying a TRANSPORT
 *  failure (backoff 1 s → 10 s) for a bounded window, then gives up with a
 *  distinct result the CLI maps to its own exit code. Daemon answers that are
 *  errors (unknown session, 401) are rethrown at once. */

/** Exit code for "outcome unknown, daemon unreachable" (0/1 = session outcome,
 *  2 = bad usage, 124 = --timeout). */
export const WAIT_DAEMON_UNREACHABLE_EXIT = 3;

export const WAIT_RETRY_WINDOW_MS = 120_000;

export type WaitGetResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unreachable'; error: string }
  | { kind: 'timed_out'; error: string };

export interface WaitRetryDeps {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Called once per outage, on its first failure. */
  onUnreachable?: (message: string) => void;
}

export interface WaitRetryOptions {
  /** The wait's own --timeout deadline (epoch ms); it bounds the retries too. */
  deadline?: number;
  windowMs?: number;
}

/** Same classifier as api-client's start recovery: these two messages are the
 *  only ones it raises when no response arrived. */
export const isDaemonTransportError = (error: unknown): error is Error =>
  error instanceof Error && /did not answer|is unavailable/.test(error.message);

export async function getWithRetry<T>(
  get: () => Promise<T>,
  deps: WaitRetryDeps,
  options: WaitRetryOptions = {},
): Promise<WaitGetResult<T>> {
  const windowMs = options.windowMs ?? WAIT_RETRY_WINDOW_MS;
  let firstFailure: number | undefined;
  let backoffMs = 1000;
  while (true) {
    try {
      return { kind: 'ok', value: await get() };
    } catch (error) {
      if (!isDaemonTransportError(error)) throw error;
      const at = deps.now();
      if (firstFailure === undefined) {
        firstFailure = at;
        deps.onUnreachable?.(error.message);
      }
      if (options.deadline !== undefined && at >= options.deadline) return { kind: 'timed_out', error: error.message };
      if (at - firstFailure >= windowMs) return { kind: 'unreachable', error: error.message };
      let pause = Math.min(backoffMs, firstFailure + windowMs - at);
      if (options.deadline !== undefined) pause = Math.min(pause, options.deadline - at);
      await deps.sleep(Math.max(pause, 0));
      backoffMs = Math.min(backoffMs * 2, 10_000);
    }
  }
}
