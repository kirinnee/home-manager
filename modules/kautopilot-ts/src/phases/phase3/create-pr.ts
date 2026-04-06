import type { Phase3Context } from './types';
import { appendEvent } from '../../core/log';
import { ensureStatus } from '../../core/status';
import { isOnMain } from '../../core/git';
import { ghListPrsForBranch, ghRepoInfo, ghFetchMergePolicy, ghPrComment } from '../../core/github';
import { readDeliveryManifest, updateDeliveryManifest } from '../../core/manifests';
import { snapshotPath } from '../../core/artifacts';
import { spawnPrintRaw } from '../../llm/spawn';
import { writeStepInit } from '../../core/step-init';
import { getAgentBinary, getAgentPrompt } from '../../core/agents';

// Mechanical context prepended by handler — NOT part of user-editable prompt
const CREATE_PR_MECHANICS = `## Spec Context

Read the spec at: {spec_path}

The spec contains what was implemented. Use it for PR body context.`;

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

  // Resolve spec path (don't inline content)
  const specPath = snapshotPath(session.id, version, 'task-spec.md');

  // Get user-configurable prompt, then prepend mechanics
  const userPrompt = getAgentPrompt('phase3', 'create_pr', {
    baseBranch,
    ticketId,
    spec_path: specPath,
  });
  const mechanics = CREATE_PR_MECHANICS.replace('{spec_path}', specPath);
  const prompt = `${mechanics}\n\n${userPrompt}`;

  const binary = getAgentBinary('phase3', 'create_pr');
  writeStepInit(session.id, version, 'create_pr', {
    prompt,
    command: `${binary} --print (LLM create PR)`,
    type: 'llm_print',
  });

  console.log(`[create_pr] Creating PR via LLM for ${ticketId}`);
  const rawOutput = await spawnPrintRaw(binary, prompt, {
    cwd: session.worktree,
    timeout: 120,
    sessionId: session.id,
    label: 'create-pr',
  });

  // Parse PR number and URL from LLM output
  let pr: { number: number; url: string };
  try {
    const cleaned = rawOutput
      .replace(/^```(?:json)?\s*\n?/m, '')
      .replace(/\n?```\s*$/m, '')
      .trim();
    pr = JSON.parse(cleaned);
  } catch {
    // Fallback: try to extract from gh pr create output URL pattern
    const urlMatch = rawOutput.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
    if (!urlMatch) {
      throw new Error(`Could not parse PR info from LLM output: ${rawOutput.slice(0, 300)}`);
    }
    pr = { number: parseInt(urlMatch[1], 10), url: urlMatch[0] };
  }

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

  // Post per-cycle PR comment if configured
  if (ctx.config.repo.prComment) {
    try {
      await ghPrComment(pr.number, ctx.config.repo.prComment, session.worktree);
      console.log('[create_pr] Posted PR comment');
    } catch (err) {
      console.warn('[create_pr] Failed to post PR comment:', err);
    }
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
