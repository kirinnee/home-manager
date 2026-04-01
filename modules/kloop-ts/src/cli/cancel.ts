import pc from 'picocolors';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CliDeps } from './index';
import { EVENT_TYPES } from '../types';
import type { KloopEvent } from '../types';
import { paths } from '../deps';

export async function handler(id: string | undefined, deps: CliDeps): Promise<void> {
  try {
    const { tmux, indexDb, eventLog, pidLock, state } = deps;

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

    // Kill tmux sessions (deduplicate — avoid double-killing)
    const sessions = await tmux.listSessions();
    let killed = 0;
    for (const session of sessions) {
      const parsed = tmux.parseSessionName(session);
      if ((parsed && parsed.runId === runId) || session.includes(`kloop-${runId}`)) {
        if (await tmux.killSession(session)) {
          killed++;
        }
      }
    }

    if (killed > 0) {
      console.log(`Killed ${killed} tmux session(s)`);
    }

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
