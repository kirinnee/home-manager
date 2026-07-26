// The `kteam start` session KILL timer, and the naming footgun around it.
//
// `timeoutSeconds` bounds ONE turn of work: the daemon terminates the session
// when a turn runs longer than it (see session-manager turnCeilingMs). The
// legacy `--timeout` flag reads like a readiness wait ("wait up to N seconds
// for it to come up"), and that misread killed a healthy session (B5 log
// entry). `--kill-after-seconds` is the preferred, self-describing alias.
//
// Kept in its own module (no daemon/commander imports) so the merge + warning
// are unit-testable without booting the CLI, whose top-level construction is
// not import-safe under `bun test`.

/** Help text for the legacy `--timeout` flag — states plainly that it KILLS. */
export const TIMEOUT_KILL_HELP =
  'kill the session after N seconds — a hard timer that ends a turn overrunning it, NOT a readiness wait (preferred alias: --kill-after-seconds)';

/** Help text for the preferred `--kill-after-seconds` alias. */
export const KILL_AFTER_SECONDS_HELP = 'preferred alias of --timeout: kill the session after N seconds';

/** A value at or below this many seconds looks like someone reaching for a
 *  readiness wait ("give it a couple minutes to come up") rather than a work
 *  ceiling — the exact misread that killed a healthy session (B5 log entry). */
export const KILL_TIMEOUT_READINESS_HINT_SECONDS = 600;

/** Resolve the session KILL timer from the `start` flags. `--kill-after-seconds`
 *  is the preferred alias of `--timeout`; when both are given the alias wins.
 *  Returns the chosen seconds (undefined = leave the daemon default) plus a
 *  one-line stderr warning when the value is small enough to look like a
 *  readiness wait — a note, never a refusal. */
export function resolveKillTimeout(options: { timeout?: number; killAfterSeconds?: number }): {
  seconds?: number;
  warning?: string;
} {
  const seconds = options.killAfterSeconds ?? options.timeout;
  if (seconds === undefined) return {};
  const warning =
    seconds < KILL_TIMEOUT_READINESS_HINT_SECONDS
      ? `note: --timeout/--kill-after-seconds is a hard KILL timer — the session is terminated when a turn runs longer than ${seconds}s. It is NOT a readiness wait; a value this small will kill healthy work early.`
      : undefined;
  return { seconds, warning };
}
