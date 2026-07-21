import pc from 'picocolors';
import Table from 'cli-table3';
import type { IndexDb, EventLog, PidLock } from '../index-db';
import { reapDeadRun } from '../index-db';
import type { CliDeps } from './index';
import { formatDurationHuman, formatAgeHuman } from '../loop/format';

interface RunEntry {
  id: string;
  workspace: string;
  status: string;
  loop: number;
  maxIterations?: number;
  phase?: string;
  exitReason?: string;
  startedAt: string;
  elapsedMs: number;
  endedAt?: string;
  /** Implementer stall detection — present only while stalled. */
  stalled?: boolean;
  stallReason?: string;
}

export async function handler(
  opts: { all: boolean; workspace?: string; json: boolean; limit?: string; order?: string },
  deps: CliDeps,
): Promise<void> {
  try {
    const { indexDb, eventLog, pidLock } = deps;
    const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
    if (opts.limit && Number.isNaN(limit!)) {
      console.error(pc.red('Error: --limit must be a valid integer'));
      process.exit(1);
    }
    if (limit !== undefined && limit < 1) {
      console.error(pc.red('Error: --limit must be a positive integer'));
      process.exit(1);
    }
    const order = opts.order;
    const runs = await listRuns(indexDb, eventLog, pidLock, opts.all, opts.workspace, { limit, order });

    if (opts.json) {
      console.log(JSON.stringify(runs, null, 2));
      return;
    }

    if (runs.length === 0) {
      console.log(pc.yellow('No runs found.'));
      return;
    }

    // Build table using cli-table3 for proper ANSI-aware alignment
    const table = new Table({
      head: ['RUN ID', 'WORKSPACE', 'STATUS', 'LOOP', 'VERDICT', 'AGE', 'DURATION'],
      style: { head: ['bold'], border: ['dim'] },
      chars: {
        top: '',
        'top-mid': '',
        'top-left': '',
        'top-right': '',
        bottom: '',
        'bottom-mid': '',
        'bottom-left': '',
        'bottom-right': '',
        mid: '',
        'left-mid': '',
        'mid-mid': '',
        'right-mid': '',
        left: '',
        right: '',
        middle: '  ',
      },
    }) as { push: (row: string[]) => void; toString: () => string };

    for (const run of runs) {
      const statusColor =
        run.status === 'running'
          ? pc.green
          : run.status === 'pending'
            ? pc.yellow
            : run.status === 'completed'
              ? pc.blue
              : run.status === 'crashed'
                ? pc.magenta
                : run.status === 'cancelled'
                  ? pc.yellow
                  : pc.red;
      const loopStr = run.maxIterations ? `${run.loop}/${run.maxIterations}` : String(run.loop);
      const durationStr = formatDurationHuman(run.elapsedMs);
      const ageStr = formatAgeHuman(new Date(run.startedAt));

      // Verdict column
      let verdictStr = '-';
      if (run.status === 'completed' && run.exitReason === 'consensus') {
        verdictStr = pc.green('approved');
      } else if (run.status === 'completed' && run.exitReason === 'max_iterations') {
        verdictStr = pc.red('max iterations');
      } else if (run.exitReason) {
        verdictStr = run.exitReason.length > 20 ? run.exitReason.slice(0, 17) + '…' : run.exitReason;
      }

      // Truncate workspace if too long
      let workspace = run.workspace;
      const home = process.env.HOME ?? '/home';
      if (workspace.startsWith(home)) {
        workspace = '~' + workspace.slice(home.length);
      }
      if (workspace.length > 20) {
        workspace = '…' + workspace.slice(-19);
      }

      const statusCell = run.stalled ? pc.red(`${run.status} ⚠STALLED`) : statusColor(run.status);
      table.push([run.id, workspace, statusCell, loopStr, verdictStr, ageStr, durationStr]);
    }

    console.log(table.toString());
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

async function listRuns(
  indexDb: IndexDb,
  eventLog: EventLog,
  pidLock: PidLock,
  includeAll: boolean,
  workspace?: string,
  sort?: { limit?: number; order?: string },
): Promise<RunEntry[]> {
  const rows = await indexDb.listRuns(workspace);
  const runs: RunEntry[] = [];

  for (const row of rows) {
    const lock = await pidLock.read(row.id);
    const state = await eventLog.deriveStatus(row.id, lock?.pid);
    if (!state) continue;

    // If we detected a crash, reap the dead run and re-derive status
    let finalStatus = state.status;
    if (state.status === 'crashed') {
      await reapDeadRun(row.id, eventLog, pidLock);
      const updated = await eventLog.deriveStatus(row.id);
      if (updated) finalStatus = updated.status;
    }

    if (!includeAll && finalStatus !== 'running') {
      continue;
    }

    const startedAt = new Date(row.started_at);
    // For terminal runs, duration is from start to last event. For running, elapsed until now.
    const isTerminal = finalStatus !== 'running' && finalStatus !== 'pending';
    const endTime = isTerminal && state.lastEventAt ? new Date(state.lastEventAt).getTime() : Date.now();
    const elapsedMs = endTime - startedAt.getTime();

    runs.push({
      id: row.id,
      workspace: row.workspace,
      status: finalStatus,
      loop: state.currentLoop,
      maxIterations: state.config?.maxIterations,
      phase: state.currentPhase,
      exitReason: state.exitReason,
      startedAt: row.started_at,
      elapsedMs,
      endedAt: isTerminal ? state.lastEventAt : undefined,
      ...(state.stalled ? { stalled: true, stallReason: state.stallReason } : {}),
    });
  }

  const sorted = runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return sort?.limit != null ? sorted.slice(0, sort.limit) : sorted;
}
