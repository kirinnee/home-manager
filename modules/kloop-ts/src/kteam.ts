import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Thin helpers around the `kteam` CLI. All agent execution now runs through
 * kteamd sessions, so kloop needs to (a) confirm the daemon is up before a run,
 * (b) validate configured agents against installed kfleet wrappers, and (c) stop
 * a run's sessions on cancel. Kept dependency-free (spawnSync + fs) so they work
 * from any CLI command.
 */

/**
 * The single line `kloop status --json` prints to stdout (exit 0) when a run is
 * non-terminal but kteamd is unreachable. It is deliberately NOT valid JSON:
 * kautopilot's `devloopVerify` does `JSON.parse(stdout)` and, on failure with a
 * zero exit, returns 'unavailable' (infra problem) rather than 'crash'. Shared so
 * the status command and its test can't drift.
 */
export const DAEMON_UNAVAILABLE_STATUS_LINE =
  'kloop: kteam daemon unavailable — run `kteam daemon start` (run status cannot be determined)';

/** Path to the kfleet wrapper bin dir (`~/.kfleet/bin`). */
function kfleetBinDir(): string {
  return path.join(os.homedir(), '.kfleet', 'bin');
}

/**
 * Installed kfleet auto-wrapper names (`claude-auto-*`, `codex-auto-*`), or an
 * empty list when the dir is absent (dev/test env) — callers skip wrapper
 * validation when empty rather than failing spuriously.
 */
export function installedWrappers(): string[] {
  try {
    return fs
      .readdirSync(kfleetBinDir())
      .filter(name => /^(claude|codex)-auto-/.test(name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * True when the kteamd HTTP API is reachable. Probes via `kteam ps --json` (which
 * hits the API and exits 0 on success, non-zero with a "daemon is unavailable"
 * message otherwise). NOT `kteam daemon status` — that checks the systemd service
 * manager and reports "stopped" even when the daemon is up and serving requests.
 */
export function daemonReachable(): boolean {
  try {
    const proc = Bun.spawnSync(['kteam', 'ps', '--json'], { stdout: 'ignore', stderr: 'ignore' });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/** The kteam web UI base URL (deep-link target for a run's agent sessions). */
export const KTEAM_UI_BASE = process.env.KTEAM_UI_BASE ?? 'http://127.0.0.1:7337';

/** One kteam session belonging to a kloop run, shaped for the UI deep-link. */
export interface RunSession {
  /** kteam session id — deep-links to `${KTEAM_UI_BASE}/session/${id}`. */
  id: string;
  /** teammate/session name, e.g. `kloop-<runId>-<iter>-impl` / `-rev-<idx>`. */
  name: string;
  binary?: string;
  /** live kteam status (running/completed/failed/stalled/…). */
  status?: string;
  model?: string;
  updatedAt?: string;
}

/**
 * List the kteam sessions for a run (label `kloop-<runId>`) so the UI can show a
 * teammate name + live status per agent and deep-link into the kteam chat view.
 * Best-effort: returns [] when the daemon is down / unparseable. Read-only.
 */
export function listRunSessions(runId: string): RunSession[] {
  try {
    const proc = Bun.spawnSync(['kteam', 'ps', '--all', '--label', `kloop-${runId}`, '--json'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (proc.exitCode !== 0) return [];
    const views = JSON.parse(proc.stdout.toString().trim() || '[]') as Array<{
      config?: { id?: string; name?: string; binary?: string; model?: string };
      state?: { status?: string; updatedAt?: string };
    }>;
    const out: RunSession[] = [];
    for (const v of views) {
      const id = v.config?.id;
      if (!id) continue;
      out.push({
        id,
        name: v.config?.name ?? id,
        binary: v.config?.binary,
        status: v.state?.status,
        model: v.config?.model,
        updatedAt: v.state?.updatedAt,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Best-effort: stop every kteam session labeled for this run (used on cancel). */
export function stopRunSessions(runId: string): void {
  try {
    const proc = Bun.spawnSync(['kteam', 'ps', '--all', '--label', `kloop-${runId}`, '--json'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (proc.exitCode !== 0) return;
    const views = JSON.parse(proc.stdout.toString().trim() || '[]') as Array<{ config?: { id?: string } }>;
    for (const view of views) {
      const id = view.config?.id;
      if (id)
        Bun.spawnSync(['kteam', 'stop', id, '--reason', 'kloop run cancelled'], { stdout: 'ignore', stderr: 'ignore' });
    }
  } catch {
    // Daemon down or unparseable — nothing to stop.
  }
}
