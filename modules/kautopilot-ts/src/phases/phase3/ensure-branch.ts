import type { Phase3Context } from './types';
import { appendEvent } from '../../core/log';
import { hasUnmergedPaths } from '../../core/git';

export async function handleEnsureBranch(ctx: Phase3Context): Promise<string | null> {
  const { session, version, baseBranch } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'ensure_branch:started',
    version,
    metadata: { stepType: 'code' },
  });

  const { $ } = await import('bun');

  // Check if branch is behind base
  const fetchResult = await $`git fetch origin ${baseBranch}`.cwd(session.worktree).quiet();
  if (fetchResult.exitCode !== 0) {
    console.warn('[ensure_branch] Failed to fetch base branch:', fetchResult.stderr.toString());
  }

  // Check if rebase is needed
  const aheadBehind = await $`git rev-list --count HEAD..origin/${baseBranch}`.cwd(session.worktree).quiet().text();
  const behindCount = parseInt(aheadBehind.trim(), 10);

  if (behindCount === 0) {
    console.log('[ensure_branch] Branch is up to date');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'ensure_branch:completed',
      version,
      metadata: { action: 'none' },
    });
    return 'eval';
  }

  console.log(`[ensure_branch] Branch is ${behindCount} commits behind ${baseBranch} — rebasing`);

  // Try rebase
  const rebaseResult = await $`git rebase origin/${baseBranch}`.cwd(session.worktree).quiet();
  if (rebaseResult.exitCode === 0) {
    console.log('[ensure_branch] Rebase succeeded');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'ensure_branch:completed',
      version,
      metadata: { action: 'rebase', success: true },
    });
    ctx.forceWithLease = true;
    return 'push';
  }

  // Rebase failed — check for merge conflicts
  if (hasUnmergedPaths(session.worktree)) {
    console.log('[ensure_branch] Merge conflicts detected — routing to tty_resolve');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'ensure_branch:completed',
      version,
      metadata: { action: 'conflict', success: false },
    });
    ctx.ttyReason = 'merge_conflict';
    return 'tty_resolve';
  }

  // Other rebase failure
  console.error('[ensure_branch] Rebase failed:', rebaseResult.stderr.toString());
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'ensure_branch:completed',
    version,
    metadata: {
      action: 'rebase',
      success: false,
      error: rebaseResult.stderr.toString(),
    },
  });

  // Abort the failed rebase
  await $`git rebase --abort`.cwd(session.worktree).quiet();

  return 'eval';
}
