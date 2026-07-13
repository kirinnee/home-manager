import * as fsSync from 'fs';
import pc from 'picocolors';
import { reapDeadRun } from '../index-db';
import { paths } from '../deps';
import type { MaterializedStatus } from '../types';
import type { CliDeps } from './index';

/**
 * kloop wait [id] [--json] [--interval <sec>]
 *
 * Blocks until a run reaches a TERMINAL state, emitting one line per
 * status/phase CHANGE — a poll→stream conversion so a watcher (Claude's
 * `Monitor`, or a cheap Codex subagent) can park on this instead of the model
 * polling `kloop status` in a loop. Each stdout line is a discrete event; the
 * process exits 0 the moment the run is terminal.
 *
 * Terminal = anything that is not `running`/`pending` (completed, cancelled,
 * failed, conflict, crashed) — see materialize. Crash is detected via the same
 * PID-liveness check `kloop status` uses, so a hard crash still ends the wait
 * (silence is never mistaken for "still running").
 *
 * Low latency without busy-polling: it sleeps on `fs.watch` of the run's
 * `events.jsonl` (wakes on the next real event) with `--interval` (default 10s)
 * as a crash-detection safety net.
 */

const TERMINAL = (s: string): boolean => s !== 'running' && s !== 'pending';

/** Compact, defensive progress descriptor — only touches known-safe fields. */
function describe(s: MaterializedStatus): string {
  const n = s.loops.length;
  if (n === 0) return 'starting';
  const last = s.loops[n - 1];
  let phase: string;
  if (last.implementer && last.implementer.status === 'running') phase = 'impl';
  else if (last.completedAt) phase = 'loop-done';
  else phase = 'review';
  // Stall is part of the descriptor so a stall begin/end CHANGES the line and
  // streams as an event — external monitors park on `wait`; a silent stall
  // would be indistinguishable from progress.
  const stall = s.stalled ? ` STALLED (${s.stallReason ?? 'idle'})` : '';
  return `loop ${last.loop} ${phase}${stall}`;
}

/** Resolve once: wakes on the next fs change to `target`, or after `timeoutMs`. */
function waitForChangeOrTimeout(target: string, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    let watcher: fsSync.FSWatcher | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      // Watch the events file if it exists, else its parent dir (catches creation).
      const watchPath = fsSync.existsSync(target) ? target : paths.kloopHome;
      watcher = fsSync.watch(watchPath, () => finish());
    } catch {
      /* no watcher — the timeout still drives progress */
    }
  });
}

export async function handler(
  id: string | undefined,
  opts: { json?: boolean; interval?: string },
  deps: CliDeps,
): Promise<void> {
  const { indexDb, eventLog, pidLock } = deps;

  let runId = id;
  if (!runId) {
    const row = await indexDb.getRunByWorkspace(process.cwd());
    if (!row) {
      console.error(pc.yellow('No run found for this workspace. Pass a run id.'));
      process.exit(1);
    }
    runId = row.id;
  }

  const evFile = paths.runEvents(runId);
  // Guard against an unknown / never-started run: without an event log,
  // materialize returns a non-terminal default and we would wait forever.
  if (!fsSync.existsSync(evFile)) {
    console.error(pc.yellow(`No event log for run ${runId} — unknown or not yet started.`));
    process.exit(1);
  }
  const intervalMs = Math.max(1, Number(opts.interval ?? '10')) * 1000;
  let prev = '';
  let errStreak = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let s: MaterializedStatus;
    try {
      const lock = await pidLock.read(runId);
      s = await eventLog.materializeStatus(runId, lock?.pid);
      errStreak = 0;
    } catch (err) {
      // Transient FS race — don't die on a single bad read; give up after a streak.
      if (++errStreak >= 5) {
        console.error(pc.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }
      await waitForChangeOrTimeout(evFile, intervalMs);
      continue;
    }

    const st = s.status;
    const terminal = TERMINAL(st);
    const line = `${st} ${describe(s)}`;
    if (line !== prev) {
      prev = line;
      if (opts.json) {
        console.log(
          JSON.stringify({
            runId,
            status: st,
            phase: describe(s),
            terminal,
            exitCode: s.exitCode,
            exitReason: s.exitReason,
            // Stall surfacing: emitted on every change line so the begin/end
            // transitions stream as discrete events.
            ...(s.stalled ? { stalled: true, stalledSinceMs: s.stalledSinceMs, stallReason: s.stallReason } : {}),
          }),
        );
      } else {
        const tail = terminal ? ` (exit ${s.exitCode ?? '?'}${s.exitReason ? ` — ${s.exitReason}` : ''})` : '';
        console.log(`${runId}: ${line}${tail}`);
      }
    }

    if (terminal) {
      if (st === 'crashed') {
        try {
          await reapDeadRun(runId, deps.eventLog, deps.pidLock, deps.tmux);
        } catch {
          /* best-effort */
        }
      }
      process.exit(0);
    }

    await waitForChangeOrTimeout(evFile, intervalMs);
  }
}
