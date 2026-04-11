import { existsSync } from 'node:fs';
import { getAgentBinary } from '../../core/agents';
import { findLatestPlansPath, findLatestSpecPath } from '../../core/artifact-versioning';
import { snapshotPath } from '../../core/artifacts';
import { ghPrChecks, ghReviewThreads } from '../../core/github';
import { appendEvent, readLog } from '../../core/log';
import { runScript } from '../../core/scripts';
import { writeStepInit } from '../../core/step-init';
import { selectOption } from '../../llm/inquirer';
import { logBanner } from '../../util/format';
import { loadPromptTemplate, spawnTTYWithTurnTracking } from '../shared';
import type { Phase3Context } from './types';

const MAX_RESTARTS = 5;

/**
 * Non-negotiable mechanics injected by the runner — NOT part of the user-editable prompt.
 * Always prepended so the pipeline contract is never broken by custom prompts.
 */
const FEEDBACK_MECHANICS = `## CRITICAL: Feedback Mechanics

### Output File
Write the feedback to {feedback_path}. This file will be consumed by phase 1's write_spec TTY on the next epoch.

### Interaction Protocol — STRICT

1. **You suggest first.** Based on the PR state, propose what the feedback should say — do not open with "what do you want to do?"
2. **Debate with the user.** Iterate until you both agree on the final feedback content.
3. **Confirm the final decision.** State clearly what you both agreed on so there is no ambiguity.
4. **Wait for explicit approval.** The user must say "approve" (or a clear equivalent like "yes approve this"). Ambiguous acknowledgements like "ok", "sounds good", or "sure" are NOT approval — ask for explicit confirmation.
5. **Only after approval**, save the file and run:
   \`kautopilot log-event feedback:approved\`
6. **Only after the event is logged**, tell the user: "All set — type /exit (or Ctrl+C) to continue kautopilot."

**DO NOT mention /exit before step 6.** Mentioning it earlier makes the user think the session is over before the event is committed. If they exit early, this step re-runs from scratch.

**DO NOT save the file or log the event before step 4.** Explicit approval is the only gate.
`;

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

  let restartCount = 0;

  while (true) {
    const fenceEvent = restartCount === 0 ? 'feedback:started' : 'feedback:restarted';

    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: fenceEvent,
      version,
      metadata: { stepType: 'tty' },
    });

    // Build prompt: mechanics + user-editable body
    const mechanics = FEEDBACK_MECHANICS.replace(/\{feedback_path\}/g, feedbackPath);

    const userPrompt = loadPromptTemplate('phase3', 'feedback', {
      task_spec_path: specPath || '(no spec found)',
      plans_dir: plansDir || '(no plans found)',
      pr_url: prUrl || `#${prNumber}`,
      checks_status: checksStatus,
      thread_count: String(threadCount),
      feedback_path: feedbackPath,
    });

    const feedbackPrompt = mechanics + '\n' + userPrompt;

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

    // TTY handoff
    await spawnTTYWithTurnTracking(session.id, binary, feedbackPrompt, {
      cwd: session.worktree,
      worktree: session.worktree,
    });

    // Read events since fence event
    const allEvents = readLog(session.id);
    const fenceIdx = allEvents.findLastIndex(e => e.event === fenceEvent);
    const eventsSince = fenceIdx >= 0 ? allEvents.slice(fenceIdx + 1) : allEvents;

    // Check approval event
    const approved = eventsSince.some(e => e.event === 'feedback:approved');

    // Check if feedback.md was written
    const feedbackWritten = existsSync(feedbackPath);

    if (!approved || !feedbackWritten) {
      if (restartCount >= MAX_RESTARTS) {
        throw new Error(
          `Feedback TTY restarted too many times without ${!approved ? 'approval' : 'feedback.md'}. ` +
            `Expected feedback:approved event and feedback.md at ${feedbackPath}.`,
        );
      }
      restartCount++;
      const missing = !approved ? 'feedback:approved event' : 'feedback.md';
      console.log(`[feedback] No ${missing} found — restarting TTY (attempt ${restartCount}/${MAX_RESTARTS})`);
      continue;
    }

    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'feedback:completed',
      version,
      metadata: { hasFeedback: true },
    });

    console.log(`[feedback] feedback.md written and approved — returning revisit_spec`);
    return 'revisit_spec';
  }
}
