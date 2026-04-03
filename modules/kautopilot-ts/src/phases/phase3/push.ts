import type { Phase3Context } from './types';
import { appendEvent } from '../../core/log';
import { hasUnmergedPaths, isOnMain } from '../../core/git';
import { withBotSignature } from '../../core/github';

export async function handlePush(ctx: Phase3Context): Promise<string | null> {
  const { session, version, pushCycle, baseBranch } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'push:started',
    version,
    metadata: { stepType: 'code', pushCycle },
  });

  const { $ } = await import('bun');

  // Safety check: never push from main/master
  if (isOnMain(baseBranch, session.worktree)) {
    throw new Error(`Refusing to push from ${baseBranch} — safety check`);
  }

  const branch = await $`git branch --show-current`.cwd(session.worktree).quiet().text();
  const currentBranch = branch.trim();

  try {
    // Check if this is the first push (no upstream tracking)
    const remoteResult = await $`git rev-parse --abbrev-ref @{upstream}`.cwd(session.worktree).quiet().nothrow();
    const hasUpstream = remoteResult.exitCode === 0;

    if (!hasUpstream) {
      // First push: set upstream
      console.log(`[push] First push: git push -u origin ${currentBranch}`);
      const result = await $`git push -u origin ${currentBranch}`.cwd(session.worktree).quiet();
      if (result.exitCode !== 0) {
        throw new Error(`First push failed: ${result.stderr.toString()}`);
      }
    } else {
      // Subsequent push with retry logic
      let pushed = false;

      // After rebase, use force-with-lease (history was rewritten)
      if (ctx.forceWithLease) {
        console.log('[push] Using --force-with-lease (post-rebase)');
        const forceResult = await $`git push --force-with-lease`.cwd(session.worktree).quiet();
        if (forceResult.exitCode === 0) {
          pushed = true;
        }
        ctx.forceWithLease = false; // Reset flag
      }

      // Try 1: direct push
      let result = pushed ? { exitCode: 0 } : await $`git push`.cwd(session.worktree).quiet();
      if (result.exitCode === 0) {
        pushed = true;
      }

      // Try 2: pull --ff-only, then push
      if (!pushed) {
        console.log('[push] Push rejected, trying pull --ff-only...');
        const pullResult = await $`git pull --ff-only`.cwd(session.worktree).quiet();
        if (pullResult.exitCode === 0) {
          result = await $`git push`.cwd(session.worktree).quiet();
          if (result.exitCode === 0) pushed = true;
        }
      }

      // Try 3: pull --rebase, then push
      if (!pushed) {
        console.log('[push] Fast-forward failed, trying pull --rebase...');
        const rebaseResult = await $`git pull --rebase`.cwd(session.worktree).quiet();
        if (rebaseResult.exitCode === 0) {
          result = await $`git push`.cwd(session.worktree).quiet();
          if (result.exitCode === 0) pushed = true;
        } else if (hasUnmergedPaths(session.worktree)) {
          ctx.ttyReason = 'merge_conflict';
          throw new Error('Push rebase hit merge conflicts');
        }
      }

      if (!pushed) {
        throw new Error('Push failed after all retry attempts');
      }
    }

    console.log(`[push] Successfully pushed to origin/${currentBranch}`);
  } catch (err) {
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'push:completed',
      version,
      metadata: {
        pushCycle,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }

  // Execute deferred post-push actions
  let repliesPosted = 0;
  for (const action of ctx.deferredActions) {
    try {
      if (action.type === 'reply_thread' && action.threadId && action.body && ctx.prNumber) {
        const { ghReplyToThread } = await import('../../core/github');
        await ghReplyToThread(ctx.prNumber, action.threadId, withBotSignature(action.body), session.worktree);
        repliesPosted++;
      }
    } catch (err) {
      console.warn('[push] Deferred action failed:', err);
    }
  }
  // Clear deferred actions after execution
  ctx.deferredActions = [];

  const commitSha = await $`git rev-parse HEAD`.cwd(session.worktree).quiet().text();

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'push:completed',
    version,
    metadata: {
      pushCycle,
      success: true,
      commitSha: commitSha.trim(),
      deferredRepliesPosted: repliesPosted,
    },
  });

  return ctx.prNumber ? 'poll' : 'create_pr';
}
