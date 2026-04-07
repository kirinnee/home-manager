import { rmSync } from 'node:fs';
import { Command } from 'commander';
import { sessionDir } from '../core/artifacts';
import { deleteSession, getSessionById, getSessionByWorktree } from '../core/db';
import { getGitRoot, getWorktree } from '../core/git';
import { checkLock, releaseLock } from '../core/lock';
import { appendEvent } from '../core/log';
import { confirmAction } from '../llm/inquirer';
import { logError, logOk } from '../util/format';

export function createStopCommand(): Command {
  return new Command('stop')
    .argument('[id]', 'Session ID (optional — defaults to local)')
    .option('--force', 'Skip confirmation')
    .action(async (id: string | undefined, opts: { force?: boolean }) => {
      try {
        await runStop(id, opts);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function runStop(id: string | undefined, opts: { force?: boolean }): Promise<void> {
  let session: import('../core/types').SessionRow | null;
  const isGlobal = !!id;

  if (id) {
    session = getSessionById(id);
    if (!session) {
      logError(`Session ${id} not found in index.`);
      process.exit(1);
    }
  } else {
    try {
      const repoPath = getGitRoot();
      const worktree = getWorktree();
      session = getSessionByWorktree(repoPath, worktree);
    } catch {
      logError('No session found in this worktree.');
      process.exit(1);
    }
    if (!session) {
      logError('No session found in this worktree.');
      process.exit(1);
    }
  }

  // Check lock
  const lockInfo = checkLock(session.id);
  if (!lockInfo.locked) {
    logOk('Session is not running.');
    return;
  }

  // Confirm
  if (!opts.force && !isGlobal) {
    const confirmed = await confirmAction(`Stop session ${session.id}?`, false);
    if (!confirmed) return;
  }

  // Log stop start
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'stop:started',
  });

  // Kill processes
  let processesKilled = 0;
  const pid = lockInfo.pid;

  try {
    process.kill(pid, 'SIGTERM');
    processesKilled++;

    // Wait up to 5 seconds for graceful shutdown
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      try {
        process.kill(pid, 0);
      } catch {
        // Process is dead
        break;
      }
    }

    // Force kill if still alive
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
      processesKilled++;
    } catch {
      // Already dead
    }
  } catch {
    // Kill failed
  }

  // Release lock
  releaseLock(session.id);

  // Log stop completed BEFORE any deletion
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'stop:completed',
    metadata: { processesKilled },
  });

  // Global mode: prompt to delete
  if (isGlobal) {
    const doDelete = opts.force || (await confirmAction(`Delete session directory and index entry?`, false));
    if (doDelete) {
      rmSync(sessionDir(session.id), { recursive: true, force: true });
      deleteSession(session.id);
      logOk(`Session ${session.id} stopped and removed.`);
      return;
    }
  }

  logOk(`Session ${session.id} stopped.`);
}
