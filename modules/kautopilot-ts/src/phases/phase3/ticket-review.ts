import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { Phase3Context } from './types';
import { appendEvent } from '../../core/log';
import { snapshotPath } from '../../core/artifacts';
import { selectOption, textInput } from '../../llm/inquirer';
import { renderMarkdown } from '../../util/markdown';

/**
 * [code] User review gate for ticket delivery artifacts.
 * Spec section 11.2: User review gate.
 *
 * Displays draft artifacts and asks the user to approve or provide feedback.
 * If feedback → new epoch (vN+1), no publish.
 * If approved → proceed to ticket_publish.
 */
export async function handleTicketReview(ctx: Phase3Context): Promise<string | null> {
  const { session, version } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'ticket_review:started',
    version,
    metadata: { stepType: 'code', deliveryKind: 'ticket' },
  });

  // Find all ticket/report draft artifacts in the epoch directory
  const epochDir = snapshotPath(session.id, version, '.');
  const artifactFiles: string[] = [];
  try {
    const files = readdirSync(epochDir);
    for (const f of files) {
      if (/^(tickets-\d+|report-[a-z])\.md$/.test(f)) {
        artifactFiles.push(f);
      }
    }
  } catch {
    // No artifacts found
  }

  if (artifactFiles.length === 0) {
    console.log('[ticket_review] No draft artifacts to review — cannot complete');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'ticket_review:completed',
      version,
      metadata: { approved: false, error: 'no_artifacts' },
    });
    return 'failed';
  }

  // Display each artifact
  console.log(`\n${'='.repeat(60)}`);
  console.log('Ticket Delivery — Review Draft Artifacts');
  console.log(`${'='.repeat(60)}\n`);

  for (const f of artifactFiles.sort()) {
    const content = readFileSync(snapshotPath(session.id, version, f), 'utf-8');
    console.log(`--- ${f} ---`);
    console.log(renderMarkdown(content));
    console.log();
  }

  console.log(`${'='.repeat(60)}\n`);

  // Ask user for approval (spec section 11.2)
  const choice = await selectOption<'approve' | 'feedback'>('Do you approve these ticket artifacts for publishing?', [
    {
      value: 'approve',
      label: 'Approve & publish',
      hint: 'Publish ticket updates, comments, and artifacts',
    },
    {
      value: 'feedback',
      label: 'I have feedback',
      hint: 'Do not publish — provide feedback for a new contract epoch',
    },
  ]);

  if (choice === 'feedback') {
    const feedback = await textInput('What feedback do you have? (This will seed a new contract epoch)', '');

    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'ticket_review:completed',
      version,
      metadata: {
        approved: false,
        hasFeedback: !!feedback.trim(),
      },
    });

    if (feedback.trim()) {
      // Write feedback for next epoch
      const { writeFileSync } = await import('node:fs');
      const feedbackPath = snapshotPath(session.id, version, 'feedback.md');
      const { ensureArtifactDir } = await import('../../core/artifacts');
      ensureArtifactDir(feedbackPath);
      writeFileSync(feedbackPath, feedback);
      console.log('[ticket_review] Feedback saved. A new epoch is needed.');

      // Persist ticket feedback signal so start loop can detect and create vN+1 (spec section 4.2 / 11.2)
      appendEvent(session.id, {
        ts: new Date().toISOString(),
        event: 'context:updated',
        metadata: { ticketFeedback: true },
      });
    }

    // Do not publish — feedback triggers new epoch (spec section 11.2)
    return 'completed';
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'ticket_review:completed',
    version,
    metadata: { approved: true },
  });

  return 'ticket_publish';
}
