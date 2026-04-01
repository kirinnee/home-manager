import type { Phase3Context } from './types';
import { appendEvent } from '../../core/log';
import { selectOption } from '../../llm/inquirer';
import { runScript } from '../../core/scripts';

export async function handleFeedbackCheck(ctx: Phase3Context): Promise<string | null> {
  const { session, version, prNumber, prUrl, pushCycle } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'feedback_check:started',
    version,
    metadata: { stepType: 'code' },
  });

  // Build summary
  const summary = [
    `PR: ${prUrl || `#${prNumber}`}`,
    `Push cycles: ${pushCycle}`,
    ctx.mergePolicy?.requiresApprovingReviews
      ? `Requires ${ctx.mergePolicy.requiredApprovingReviewCount} approval(s)`
      : 'No approval required',
  ].join('\n');

  console.log(`\n${'='.repeat(60)}`);
  console.log('Phase 3 Complete — PR is merge-ready');
  console.log(`${'='.repeat(60)}`);
  console.log(summary);
  console.log(`${'='.repeat(60)}\n`);

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

  // Transition to Phase 1 feedback
  return 'feedback';
}

export async function handleFeedback(ctx: Phase3Context): Promise<string | null> {
  const { session, version } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'feedback:started',
    version,
    metadata: { stepType: 'code' },
  });

  // Collect feedback from user
  const { textInput } = await import('../../llm/inquirer');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { snapshotPath, ensureArtifactDir } = await import('../../core/artifacts');

  const feedback = await textInput('What feedback do you have? (This will be used to improve the next iteration)', '');

  if (feedback.trim()) {
    // Write feedback to artifacts for Phase 1 v2+ to consume
    const feedbackPath = snapshotPath(session.id, version, 'feedback.md');
    ensureArtifactDir(feedbackPath);
    writeFileSync(feedbackPath, feedback);
    console.log('[feedback] Feedback saved. Run `kautopilot start --phase plan` to re-run Phase 1.');
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'feedback:completed',
    version,
    metadata: { hasFeedback: !!feedback.trim() },
  });

  return 'completed';
}
