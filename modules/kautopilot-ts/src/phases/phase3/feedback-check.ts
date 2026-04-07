import { existsSync } from 'node:fs';
import { getAgentBinary, TTY_EXIT_INSTRUCTION } from '../../core/agents';
import { findLatestPlansPath, findLatestSpecPath } from '../../core/artifact-versioning';
import { snapshotPath } from '../../core/artifacts';
import { ghPrChecks, ghReviewThreads } from '../../core/github';
import { appendEvent } from '../../core/log';
import { runScript } from '../../core/scripts';
import { writeStepInit } from '../../core/step-init';
import { selectOption } from '../../llm/inquirer';
import { logBanner } from '../../util/format';
import { loadPromptTemplate, spawnTTYWithTurnTracking } from '../shared';
import type { Phase3Context } from './types';

export async function handleFeedbackCheck(ctx: Phase3Context): Promise<string | null> {
  const { session, version, prNumber, prUrl, pushCycle } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'feedback_check:started',
    version,
    metadata: { stepType: 'code' },
  });

  logBanner('Phase 3 Complete — PR is merge-ready', {
    PR: prUrl || `#${prNumber}`,
    'Push cycles': String(pushCycle),
    Approvals: ctx.mergePolicy?.requiresApprovingReviews
      ? `Requires ${ctx.mergePolicy.requiredApprovingReviewCount} approval(s)`
      : 'No approval required',
  });

  const choice = await selectOption<'done' | 'feedback'>('The PR is merge-ready. What would you like to do?', [
    {
      value: 'done',
      label: 'Done',
      hint: 'Mark this task as complete',
    },
    {
      value: 'feedback',
      label: 'I have feedback',
      hint: 'Go back to Phase 1 with feedback to improve the implementation',
    },
  ]);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'feedback_check:completed',
    version,
    metadata: {
      choice,
      prNumber,
      pushCycles: pushCycle,
    },
  });

  if (choice === 'done') {
    // Transition ticket: in-progress → review
    if (ctx.ticketId) {
      runScript(ctx.session.id, 'to-review', [ctx.ticketId]);
      appendEvent(ctx.session.id, {
        ts: new Date().toISOString(),
        event: 'transition:in_progress_to_review',
        metadata: { ticketId: ctx.ticketId },
      });
    }
    return 'completed';
  }

  // Transition ticket: review → in-progress (user has feedback)
  if (ctx.ticketId) {
    runScript(ctx.session.id, 'revert-to-inprogress', [ctx.ticketId]);
    appendEvent(ctx.session.id, {
      ts: new Date().toISOString(),
      event: 'transition:review_to_in_progress',
      metadata: { ticketId: ctx.ticketId },
    });
  }

  // Transition to feedback TTY
  return 'feedback';
}

export async function handleFeedback(ctx: Phase3Context): Promise<string | null> {
  const { session, version, prNumber, prUrl } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'feedback:started',
    version,
    metadata: { stepType: 'tty' },
  });

  // Gather PR state
  let checksStatus = 'unknown';
  let threadCount = 0;
  if (prNumber) {
    try {
      const checks = await ghPrChecks(prNumber, session.worktree);
      const passing = checks.filter((c: { status: string }) => c.status === 'passing').length;
      const failing = checks.filter((c: { status: string }) => c.status === 'failing').length;
      const pending = checks.filter((c: { status: string }) => c.status === 'pending').length;
      checksStatus = `${passing} passing, ${failing} failing, ${pending} pending`;
    } catch {
      checksStatus = 'unable to fetch';
    }
    try {
      const threads = await ghReviewThreads(prNumber, session.worktree);
      threadCount = threads.filter((t: { isOutdated: boolean }) => !t.isOutdated).length;
    } catch {
      threadCount = -1;
    }
  }

  // Find latest artifact paths
  const specPath = findLatestSpecPath(session.id, version);
  const plansDir = findLatestPlansPath(session.id, version);
  const feedbackPath = snapshotPath(session.id, version, 'feedback.md');

  // Build prompt with variable substitution
  const feedbackPrompt = loadPromptTemplate('phase3', 'feedback', {
    task_spec_path: specPath || '(no spec found)',
    plans_dir: plansDir || '(no plans found)',
    pr_url: prUrl || `#${prNumber}`,
    checks_status: checksStatus,
    thread_count: String(threadCount),
    feedback_path: feedbackPath,
  });

  // Record step init
  const binary = getAgentBinary('phase3', 'feedback');
  writeStepInit(session.id, version, 'feedback', {
    prompt: feedbackPrompt,
    command: `${binary} (TTY handoff)`,
    type: 'tty_handoff',
  });

  logBanner('Collecting PR Feedback', {
    PR: prUrl || `#${prNumber}`,
    Checks: checksStatus,
    Threads: String(threadCount),
  });
  console.log(`Discuss the PR with Claude. When ready, write feedback to ${feedbackPath}`);

  // TTY handoff
  await spawnTTYWithTurnTracking(session.id, binary, feedbackPrompt + TTY_EXIT_INSTRUCTION, {
    cwd: session.worktree,
    worktree: session.worktree,
  });

  // Check if feedback.md was written
  const feedbackWritten = existsSync(feedbackPath);

  // Enforce spec contract: feedback.md MUST exist before advancing to new epoch.
  // The TTY prompt instructs the user to write feedback before returning revisit_spec.
  // If feedback.md is missing, the TTY did not complete properly — do NOT proceed.
  if (!feedbackWritten) {
    throw new Error(
      `feedback.md was not written at ${feedbackPath}. ` +
        `The TTY must write actual feedback before returning revisit_spec. ` +
        `Refusing to advance to new epoch without required artifact.`,
    );
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'feedback:completed',
    version,
    metadata: { hasFeedback: feedbackWritten },
  });

  console.log(`[feedback] feedback.md written — returning revisit_spec`);
  return 'revisit_spec';
}
