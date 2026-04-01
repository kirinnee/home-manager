import type { Phase3Context } from './types';
import { appendEvent } from '../../core/log';
import { ensureStatus } from '../../core/status';
import { isOnMain } from '../../core/git';
import { ghCreatePr, ghListPrsForBranch, ghRepoInfo, ghFetchMergePolicy } from '../../core/github';
import { readDeliveryManifest, updateDeliveryManifest } from '../../core/manifests';
import { resolveSpec } from '../shared';

export async function handleCreatePr(ctx: Phase3Context): Promise<string | null> {
  const { session, version, ticketId, baseBranch } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'create_pr:started',
    version,
    metadata: { stepType: 'code' },
  });

  const { $ } = await import('bun');

  // Safety check
  if (isOnMain(baseBranch, session.worktree)) {
    throw new Error(`Refusing to create PR from ${baseBranch} — safety check`);
  }

  const branch = await $`git branch --show-current`.cwd(session.worktree).quiet().text();
  const currentBranch = branch.trim();

  // Check if PR already exists for this branch
  const existingPrs = await ghListPrsForBranch(currentBranch, session.worktree);
  if (existingPrs.length > 0) {
    const existingPr = existingPrs[0];
    console.log(`[create_pr] PR already exists: #${existingPr.number} — reusing`);
    ctx.prNumber = existingPr.number;
    try {
      const repoInfo = await ghRepoInfo(session.worktree);
      ctx.prUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${existingPr.number}`;
    } catch {
      ctx.prUrl = null;
    }

    // Persist to WAL
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'context:updated',
      metadata: { prNumber: ctx.prNumber, prUrl: ctx.prUrl },
    });

    // Fetch merge policy
    try {
      const repoInfo = await ghRepoInfo(session.worktree);
      ctx.mergePolicy = await ghFetchMergePolicy(repoInfo.owner, repoInfo.repo, session.worktree);
    } catch (err) {
      console.warn('[create_pr] Could not fetch merge policy:', err);
    }

    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'create_pr:completed',
      version,
      metadata: {
        prNumber: existingPr.number,
        reused: true,
      },
    });
    return 'poll';
  }

  // Build PR title and body
  const title = `[${ticketId}] Implement task`;

  // Read spec for PR body from session artifacts
  const specContent = resolveSpec(session.id, version);

  const body = `## Summary\n\nImplements ${ticketId}\n\n## Spec\n\n${specContent.slice(0, 2000)}${specContent.length > 2000 ? '\n\n...(truncated)' : ''}`;

  // Create PR
  console.log(`[create_pr] Creating PR: ${title}`);
  const pr = await ghCreatePr(title, baseBranch, body, session.worktree);

  ctx.prNumber = pr.number;
  ctx.prUrl = pr.url;
  console.log(`[create_pr] Created PR: ${pr.url}`);

  // Persist to WAL
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: { prNumber: pr.number, prUrl: pr.url },
  });

  // Fetch merge policy
  try {
    const repoInfo = await ghRepoInfo(session.worktree);
    ctx.mergePolicy = await ghFetchMergePolicy(repoInfo.owner, repoInfo.repo, session.worktree);
  } catch (err) {
    console.warn('[create_pr] Could not fetch merge policy:', err);
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'create_pr:completed',
    version,
    metadata: {
      prNumber: pr.number,
      prUrl: pr.url,
    },
  });

  // If this is a rollover, update the delivery manifest with actual toPr (spec section 1.3)
  const status = ensureStatus(session.id);
  if (status.context.rolloverFromPr) {
    const fromPr = status.context.rolloverFromPr as number;
    const delivery = readDeliveryManifest(session.id, version);
    if (delivery?.prRolloverHistory) {
      // Find the placeholder entry (toPr === 0) and update it
      const lastEntry = delivery.prRolloverHistory.findLast(
        (e: { fromPr: number; toPr: number }) => e.fromPr === fromPr && e.toPr === 0,
      );
      if (lastEntry) {
        lastEntry.toPr = pr.number;
        updateDeliveryManifest(session.id, version, { prRolloverHistory: delivery.prRolloverHistory });
        console.log(`[create_pr] Rollover recorded: PR #${fromPr} → #${pr.number}`);
      }
    }
    // Clear rollover context
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'context:updated',
      metadata: { rolloverFromPr: undefined },
    });
  }

  return 'poll';
}
