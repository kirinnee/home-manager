import { existsSync } from 'node:fs';
import { getAgentBinary, TTY_EXIT_INSTRUCTION } from '../../core/agents';
import { findLatestPlansPath, findLatestSpecPath } from '../../core/artifact-versioning';
import { snapshotPath } from '../../core/artifacts';
import { devloopDescribe } from '../../core/devloop';
import { appendEvent } from '../../core/log';
import { writeStepInit } from '../../core/step-init';
import { logBanner } from '../../util/format';
import { loadPromptTemplate, resolveActivePlans, spawnTTYWithTurnTracking } from '../shared';
import type { Phase2Context } from './types';

export async function handleResolve(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex, attempt } = ctx;

  const planName = `plan-${planIndex + 1}`;
  const reason = attempt > 1 ? 'retry' : 'conflict';

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'resolve:started',
    version,
    plan: planName,
    attempt,
    metadata: { stepType: 'tty', reason },
  });

  // Gather durable loop evidence (spec section 7.4)
  let kloopDescribeOutput = '';
  if (ctx.kloopRunId) {
    kloopDescribeOutput = devloopDescribe(ctx.kloopRunId);
  }

  // Find context paths — use versioned-first with fallback for backward compat
  const plansDir = findLatestPlansPath(session.id, version) || snapshotPath(session.id, version, 'plans');
  const activePlans = resolveActivePlans(plansDir);
  const activePlanPath = activePlans[planIndex];
  const taskSpecPath = findLatestSpecPath(session.id, version) || snapshotPath(session.id, version, 'task-spec.md');
  const feedbackPath = snapshotPath(session.id, version, 'feedback.md');

  // Build prompt with variable substitution
  const resolvePrompt = loadPromptTemplate('phase2', 'resolve', {
    task_spec_path: taskSpecPath,
    plan_path: activePlanPath || '',
    plans_dir: plansDir,
    kloop_evidence: kloopDescribeOutput || '(no evidence available)',
    feedback_path: feedbackPath,
  });

  // Record step init
  const binary = getAgentBinary('phase2', 'resolve');
  writeStepInit(session.id, version, 'resolve', {
    prompt: resolvePrompt,
    command: `${binary} (TTY handoff)`,
    type: 'tty_handoff',
  });

  logBanner('Resolving Plan', { Plan: planName, Reason: reason });
  console.log(`Discuss the issue with Claude. When resolved, write feedback to ${feedbackPath}`);

  // TTY handoff
  await spawnTTYWithTurnTracking(session.id, binary, resolvePrompt + TTY_EXIT_INSTRUCTION, {
    cwd: session.worktree,
    worktree: session.worktree,
  });

  // Check if feedback.md was written
  const feedbackWritten = existsSync(feedbackPath);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'resolve:completed',
    version,
    plan: planName,
    attempt,
    metadata: {
      kloopDescribeAvailable: !!kloopDescribeOutput,
      feedbackWritten,
      reason,
    },
  });

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

  console.log(`[resolve] feedback.md written — returning revisit_spec`);
  return 'revisit_spec';
}
