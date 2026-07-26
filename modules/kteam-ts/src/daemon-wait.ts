/** Readiness wait for `kteam daemon start` / `restart` / `install`.
 *
 *  The old loop was a flat 40×250 ms = 10 s and could not tell "still coming
 *  up" from "died": legitimate pre-bind cliffs exceed 10 s (a schema-generation
 *  rebuild, or bindWithRetry riding out a draining predecessor up to 30 s), so a
 *  perfectly healthy slow boot reported "kteamd did not become ready". This
 *  version polls up to ~90 s, keeps the happy-path cadence fast (250 ms), notes
 *  progress once past 10 s, and — crucially — exits EARLY with a distinct
 *  message when the daemon process is observed to have died. */

export type PidLiveness = 'alive' | 'dead' | 'absent';

export interface DaemonWaitDeps {
  /** Ask the daemon for /v1/health; resolves when it is serving, throws while not. */
  health: () => Promise<Record<string, unknown>>;
  /** Cheap pid-file liveness probe (DaemonService.pidLiveness). */
  pidLiveness: () => Promise<PidLiveness>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Emit the single progress note once the wait passes progressAfterMs. */
  onProgress?: (elapsedSeconds: number) => void;
  /** Where to point the operator on failure. */
  daemonLog: string;
}

export interface DaemonWaitOptions {
  deadlineMs?: number;
  cadenceMs?: number;
  progressAfterMs?: number;
}

export class DaemonExitedError extends Error {}
export class DaemonNotReadyError extends Error {}

export async function waitForDaemonReady(
  deps: DaemonWaitDeps,
  options: DaemonWaitOptions = {},
): Promise<Record<string, unknown>> {
  const deadlineMs = options.deadlineMs ?? 90_000;
  const cadenceMs = options.cadenceMs ?? 250;
  const progressAfterMs = options.progressAfterMs ?? 10_000;
  const start = deps.now();
  // Only fast-fail on a 'dead' pid AFTER we have seen it 'alive' in THIS wait: a
  // 'dead' verdict on the first probe is more likely a stale pid file from a
  // prior crashed run, which the freshly-starting daemon will overwrite once it
  // binds. Presuming death there would turn every start-after-crash into a
  // spurious failure.
  let sawAlive = false;
  let progressNoted = false;
  while (deps.now() - start < deadlineMs) {
    try {
      return await deps.health();
    } catch {
      const liveness = await deps.pidLiveness().catch<PidLiveness>(() => 'absent');
      if (liveness === 'alive') sawAlive = true;
      else if (liveness === 'dead' && sawAlive)
        throw new DaemonExitedError(
          `kteamd started but its process has exited during startup; inspect ${deps.daemonLog}`,
        );
      const elapsed = deps.now() - start;
      if (!progressNoted && elapsed >= progressAfterMs) {
        progressNoted = true;
        deps.onProgress?.(Math.round(elapsed / 1000));
      }
      await deps.sleep(cadenceMs);
    }
  }
  throw new DaemonNotReadyError(
    `kteamd did not become ready within ${Math.round(deadlineMs / 1000)}s; inspect ${deps.daemonLog}`,
  );
}
