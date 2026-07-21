import pc from 'picocolors';
import type { CliDeps } from './index';
import { paths } from '../deps';
import { reapDeadRun } from '../index-db';

export async function handler(ids: string[], opts: { force: boolean }, deps: CliDeps): Promise<void> {
  try {
    const { indexDb, eventLog, pidLock, state } = deps;

    // If no args, resolve from CWD
    if (ids.length === 0) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(pc.yellow('No run found for this workspace.'));
        return;
      }
      ids = [row.id];
    }

    // Resolve each id: exact match, or prefix match (only if exactly one)
    const allRuns = await indexDb.listRuns();
    const resolvedIds: string[] = [];

    for (const rawId of ids) {
      // Exact match first
      const exact = allRuns.find(r => r.id === rawId);
      if (exact) {
        resolvedIds.push(exact.id);
        continue;
      }

      // Prefix match
      const matches = allRuns.filter(r => r.id.startsWith(rawId));
      if (matches.length === 1) {
        resolvedIds.push(matches[0].id);
        continue;
      }
      if (matches.length > 1) {
        console.log(
          pc.yellow(`Ambiguous prefix "${rawId}" matches ${matches.length} runs: ${matches.map(m => m.id).join(', ')}`),
        );
        continue;
      }

      console.log(pc.red(`Run not found: ${rawId}`));
    }

    if (resolvedIds.length === 0) {
      console.log(pc.yellow('Nothing to remove.'));
      return;
    }

    // Remove each run
    let removed = 0;
    for (const runId of resolvedIds) {
      // Check if run is active (pass PID for crash detection)
      const lock = await pidLock.read(runId);
      const runState = await eventLog.deriveStatus(runId, lock?.pid);

      // If crashed, reap it first (write crashed event, release lock)
      if (runState?.status === 'crashed') {
        await reapDeadRun(runId, eventLog, pidLock);
        // Re-derive status after reaping
        const updatedState = await eventLog.deriveStatus(runId);
        if (updatedState && !eventLog.isTerminal(updatedState.status) && !opts.force) {
          console.log(pc.yellow(`Run ${runId} is still ${updatedState.status}. Use --force to remove.`));
          continue;
        }
      } else if (runState && !eventLog.isTerminal(runState.status) && !opts.force) {
        console.log(pc.yellow(`Run ${runId} is still ${runState.status}. Use --force to remove.`));
        continue;
      }

      // Delete run directory
      const runDir = paths.runPath(runId);
      if (await state.fs.exists(runDir)) {
        await state.fs.rm(runDir, { recursive: true });
      }

      // Remove lock file
      await pidLock.release(runId);

      // Remove from index.db
      await indexDb.removeRun(runId);

      console.log(pc.green(`Removed ${runId}`));
      removed++;
    }

    if (removed > 0) {
      console.log(pc.dim(`Removed ${removed} run(s).`));
    }
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
