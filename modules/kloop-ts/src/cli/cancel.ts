import pc from 'picocolors';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CliDeps } from './index';
import { EVENT_TYPES } from '../types';
import type { KloopEvent } from '../types';
import { stopRunSessions } from '../kteam';

export async function handler(id: string | undefined, deps: CliDeps): Promise<void> {
  try {
    const { indexDb, eventLog, pidLock } = deps;

    // Resolve run ID: use explicit ID if provided, otherwise find current workspace's run
    let runId: string;
    if (id) {
      const row = await indexDb.getRun(id);
      if (!row) {
        console.log(`Run not found: ${id}`);
        return;
      }
      runId = row.id;
    } else {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log('No active run for this workspace.');
        return;
      }
      runId = row.id;
    }
    const lock = await pidLock.read(runId);
    const runState = await eventLog.deriveStatus(runId, lock?.pid);
    if (!runState) {
      console.log(`Run ${runId} not found.`);
      return;
    }

    if (eventLog.isTerminal(runState.status)) {
      console.log(`Run ${runId} is already ${runState.status}.`);
      return;
    }

    console.log(`Cancelling run ${runId}...`);

    // Write cancel event
    await eventLog.append(runId, {
      type: EVENT_TYPES.CANCEL,
      timestamp: new Date().toISOString(),
      reason: 'user requested',
    } as KloopEvent);

    // Stop this run's kteam agent sessions (label kloop-<runId>).
    stopRunSessions(runId);

    // Release lock
    await pidLock.release(runId);

    // Unlink local .kloop/ if it exists (symlinks created by `kloop link`)
    const localKloop = path.join(process.cwd(), '.kloop');
    try {
      const stat = await fs.lstat(localKloop);
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        await fs.rm(localKloop, { recursive: true, force: true });
        console.log(pc.dim(`Removed .kloop/`));
      }
    } catch {
      // No .kloop/ directory, nothing to unlink
    }

    console.log('Run cancelled.');
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
