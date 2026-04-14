import { appendEvent } from '../../core/log';
import type { Phase3Context } from './types';

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
  const fetchResult = await $`git fetch origin ${baseBranch}`.cwd(session.worktree).quiet().nothrow();
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

  // Branch is behind — let handlePush deal with it via pull --rebase + push
  // (avoids standalone rebase that rewrites history without a matching force-push)
  console.log(`[ensure_branch] Branch is ${behindCount} commits behind ${baseBranch} — deferring to push`);
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'ensure_branch:completed',
    version,
    metadata: { action: 'deferred_to_push', behindCount },
  });
  return 'push';
}
