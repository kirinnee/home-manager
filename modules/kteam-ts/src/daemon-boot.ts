// Daemon startup guards (G1). The pid-file check in the old daemon-entry was
// TOCTOU (check → write pid → bind): concurrent starters (systemd Restart=always
// + a manual start + a watchdog) all passed the check and then fought over the
// port in an EADDRINUSE loop that killed live sessions. The port itself is the
// only real lock, so startup now (1) probes the configured address for a live
// daemon and refuses to start over one, and (2) binds with a bounded retry that
// rides out a dying predecessor still holding the port.

/** Exit status for "a healthy daemon already owns the port". The systemd unit
 *  lists this in RestartPreventExitStatus: with Restart=always and RestartSec=2
 *  a plain exit 1 would re-spawn against the healthy owner forever, flooding
 *  logs with a failed invocation every two seconds. */
export const EXIT_ALREADY_RUNNING = 78; // sysexits EX_CONFIG: "should not be retried"

export interface ProbeOptions {
  /** Base URL of the configured bind address, e.g. http://127.0.0.1:7337. */
  url: string;
  /** Bearer token for /v1/health when the token file is readable. A probe
   *  without it still proves a live responder (401 is an answer too). */
  token?: string;
  timeoutMs?: number;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** True when SOMETHING answers HTTP on the configured address. Any response —
 *  healthy, 401, even a foreign service — means the port is taken by a live
 *  process and this daemon must not race it for the bind. Only a connection
 *  failure (nothing listening) clears the way. */
export async function probeExistingDaemon(options: ProbeOptions): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(`${options.url.replace(/\/$/, '')}/v1/health`, {
      headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
    return response instanceof Response;
  } catch {
    return false;
  }
}

export interface BindRetryOptions {
  backoffMs?: number;
  totalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

const isAddressInUse = (error: unknown): boolean =>
  (error as { code?: string })?.code === 'EADDRINUSE' || /EADDRINUSE|address already in use/i.test(String(error));

/** Bind, retrying only EADDRINUSE: a predecessor killed by a service manager
 *  can hold the port for a few seconds while it drains. Any other error — and
 *  EADDRINUSE persisting past the deadline — is rethrown. */
export async function bindWithRetry<T>(bind: () => T | Promise<T>, options: BindRetryOptions = {}): Promise<T> {
  const backoffMs = options.backoffMs ?? 500;
  const totalMs = options.totalMs ?? 30_000;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const clock = options.clock ?? Date.now;
  const deadline = clock() + totalMs;
  while (true) {
    try {
      return await bind();
    } catch (error) {
      if (!isAddressInUse(error) || clock() + backoffMs > deadline) throw error;
      await sleep(backoffMs);
    }
  }
}
