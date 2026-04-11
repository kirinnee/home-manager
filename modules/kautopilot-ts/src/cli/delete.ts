import { rmSync } from 'node:fs';
import { Command } from 'commander';
import { sessionDir } from '../core/artifacts';
import { deleteSession, getSessionById, getSessionByWorktree, listSessions } from '../core/db';
import { getGitRoot, getWorktree } from '../core/git';
import { checkLock, releaseLock } from '../core/lock';
import { killZellijSession } from '../core/zellij';
import { confirmAction } from '../llm/inquirer';
import { logError, logOk } from '../util/format';

export function createDeleteCommand(): Command {
  return new Command('delete')
    .alias('rm')
    .argument('[id]', 'Session ID (omit to delete current worktree session)')
    .option('-a, --all', 'Delete all stopped sessions')
    .option('--force', 'Skip confirmation')
    .option('--running', 'Also delete running sessions (stops them first)')
    .action(async (id: string | undefined, opts: { all?: boolean; force?: boolean; running?: boolean }) => {
      try {
        await runDelete(id, opts);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function stopAndCleanup(sessionId: string): Promise<boolean> {
  const lockInfo = checkLock(sessionId);
  if (lockInfo.locked) {
    try {
      process.kill(lockInfo.pid, 'SIGTERM');
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        try {
          process.kill(lockInfo.pid, 0);
        } catch {
          break;
        }
      }
      try {
        process.kill(lockInfo.pid, 'SIGKILL');
      } catch {}
    } catch {}
    releaseLock(sessionId);
  }
  killZellijSession(sessionId);
  return lockInfo.locked;
}

async function deleteSessionDir(sessionId: string): Promise<void> {
  rmSync(sessionDir(sessionId), { recursive: true, force: true });
  deleteSession(sessionId);
}

async function runDelete(
  id: string | undefined,
  opts: { all?: boolean; force?: boolean; running?: boolean },
): Promise<void> {
  if (opts.all) {
    const sessions = listSessions({ includeAll: true });
    const toDelete = sessions.filter(s => opts.running || !checkLock(s.id).locked);

    if (toDelete.length === 0) {
      logOk('No sessions to delete.');
      return;
    }

    if (!opts.force) {
      const confirmed = await confirmAction(`Delete ${toDelete.length} session(s)?`, false);
      if (!confirmed) return;
    }

    for (const s of toDelete) {
      await stopAndCleanup(s.id);
      deleteSessionDir(s.id);
      logOk(`Deleted ${s.id}`);
    }
    return;
  }

  // Single session
  let session: import('../core/types').SessionRow | null;

  if (id) {
    session = getSessionById(id);
    if (!session) {
      logError(`Session ${id} not found.`);
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

  const lockInfo = checkLock(session.id);
  if (lockInfo.locked && !opts.running) {
    logError(`Session ${session.id} is running. Use --running to stop and delete.`);
    process.exit(1);
  }

  if (!opts.force && !id) {
    const confirmed = await confirmAction(`Delete session ${session.id}?`, false);
    if (!confirmed) return;
  }

  const wasRunning = await stopAndCleanup(session.id);
  deleteSessionDir(session.id);
  logOk(`Session ${session.id} deleted${wasRunning ? ' (was running)' : ''}.`);
}
