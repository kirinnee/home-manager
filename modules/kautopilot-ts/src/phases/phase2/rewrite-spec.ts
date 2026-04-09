import { getAgentBinary, TTY_EXIT_INSTRUCTION } from '../../core/agents';
import { devloopDescribe } from '../../core/devloop';
import { appendEvent, readLog } from '../../core/log';
import { readPlanManifest } from '../../core/manifests';
import { writeStepInit } from '../../core/step-init';
import { logBanner } from '../../util/format';
import { loadPromptTemplate, resolveActivePlans, spawnTTYWithTurnTracking } from '../shared';
import type { Phase2Context, RewriteDecision } from './types';

const MAX_RESTARTS = 5;

function getDecisionTitle(decision: RewriteDecision): string {
  const titles: Record<RewriteDecision, string> = {
    refine_local: 'Refine Local Plan',
    patch_downstream: 'Patch Downstream Plans',
    regenerate_remaining: 'Regenerate Remaining Plans',
    revisit_spec: 'Revisit Spec',
  };
  return titles[decision];
}

function getDecisionReviewSection(
  decision: RewriteDecision,
  vars: {
    planName: string;
    planPath: string;
    feedbackPath: string;
  },
): string {
  switch (decision) {
    case 'refine_local':
      return `The plan ${vars.planName} (${vars.planPath}) was rewritten to fix issues from the kloop run.
Review the changes with the user. Iterate until satisfied.

If further changes are needed:
- Edit the plan file
- Snapshot after each edit
- Continue discussing with the user

When approved, log the approval event and /exit.`;

    case 'patch_downstream':
      return `The incomplete plan files were patched to account for what was learned during execution.
Review the changes with the user. Iterate until satisfied.

If further changes are needed:
- Edit the plan files
- Snapshot after each edit
- Continue discussing with the user

When approved, log the approval event and /exit.`;

    case 'regenerate_remaining':
      return `The incomplete plan files were regenerated from scratch based on the current spec
and what the completed plans produced.
Review the new plans with the user. Iterate until satisfied.

If further changes are needed:
- Edit the plan files
- Snapshot after each edit
- Continue discussing with the user

When approved, log the approval event and /exit.`;

    case 'revisit_spec':
      return `Feedback was written to ${vars.feedbackPath} explaining what's wrong with the spec and
what changes are needed for the next epoch.
Review the feedback with the user. Iterate until satisfied.

If further changes are needed:
- Edit feedback.md
- Snapshot after each edit
- Continue discussing with the user

When approved, log the approval event and /exit.
The session will escalate to a full replan with the feedback guiding the new epoch.`;
  }
}

function getSnapshotType(decision: RewriteDecision): 'spec' | 'plans' {
  return decision === 'revisit_spec' ? 'spec' : 'plans';
}

function getApprovalEvent(decision: RewriteDecision): string {
  return decision === 'revisit_spec' ? 'feedback:approved' : 'rewrite_plans:approved';
}

export async function handleRewriteSpec(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex } = ctx;

  if (!ctx.rewriteDecision) {
    throw new Error('rewriteDecision not set on context — resolve must run first');
  }

  const decision = ctx.rewriteDecision;
  const decisionTitle = getDecisionTitle(decision);
  const snapshotType = getSnapshotType(decision);
  const approvalEvent = getApprovalEvent(decision);

  // Gather kloop evidence
  let kloopDescribeOutput = '';
  if (ctx.kloopRunId) {
    kloopDescribeOutput = devloopDescribe(ctx.kloopRunId);
  }

  // Resolve ticket ID and build worktree paths (where TTY edits live)
  const ticketId = session.ticket_id || 'local';
  const worktreeSpecDir = `${session.worktree}/spec/${ticketId}/v${version}`;
  const worktreePlansDir = `${worktreeSpecDir}/plans`;
  const worktreeSpecPath = `${worktreeSpecDir}/task-spec.md`;
  const worktreeFeedbackPath = `${worktreeSpecDir}/feedback.md`;
  const planName = `plan-${planIndex + 1}`;

  // Resolve active plan paths from worktree plans directory
  const activePlanPaths = resolveActivePlans(worktreePlansDir);
  const activePlanPath = activePlanPaths[planIndex] || '';

  let restartCount = 0;

  while (true) {
    const fenceEvent = restartCount === 0 ? 'rewrite_spec:started' : 'rewrite_spec:restarted';

    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: fenceEvent,
      version,
      metadata: { rewriteDecision: decision },
    });

    // Build decision-specific review section
    const reviewSection = getDecisionReviewSection(decision, {
      planName,
      planPath: activePlanPath,
      feedbackPath: worktreeFeedbackPath,
    });

    // Build rewrite-spec prompt — use worktree paths where TTY will iterate
    const prompt = loadPromptTemplate('phase2', 'rewrite_spec', {
      decision_title: decisionTitle,
      decision_specific_review_section: reviewSection,
      kloop_evidence: kloopDescribeOutput || '(no evidence available)',
      task_spec_path: worktreeSpecPath,
      plans_dir: worktreePlansDir,
      snapshot_type: snapshotType,
      approval_event: approvalEvent,
      feedback_path: worktreeFeedbackPath,
    });

    // Record step init
    const binary = getAgentBinary('phase2', 'rewrite_spec');
    writeStepInit(session.id, version, 'rewrite_spec', {
      prompt,
      command: `${binary} (TTY handoff)`,
      type: 'tty_handoff',
    });

    logBanner('Review Amendment', { Decision: decisionTitle });

    // TTY handoff
    await spawnTTYWithTurnTracking(session.id, binary, prompt + TTY_EXIT_INSTRUCTION, {
      cwd: session.worktree,
      worktree: session.worktree,
    });

    // Read events since fence event
    const allEvents = readLog(session.id);
    const fenceIdx = allEvents.findLastIndex(e => e.event === fenceEvent);
    const eventsSince = fenceIdx >= 0 ? allEvents.slice(fenceIdx + 1) : allEvents;

    // Check abandon
    if (eventsSince.some(e => e.event === 'resolve:abandoned')) {
      return 'failed';
    }

    // Check approval
    const approved = eventsSince.some(e => e.event === approvalEvent);
    if (!approved) {
      if (restartCount >= MAX_RESTARTS) {
        throw new Error('Rewrite-spec TTY restarted too many times without approval');
      }
      restartCount++;
      console.log(
        `[rewrite_spec] No ${approvalEvent} found — restarting TTY (attempt ${restartCount}/${MAX_RESTARTS})`,
      );
      continue;
    }

    // Discover the latest snapshot the TTY created — must exist and type must match
    const snapshotEvents = eventsSince.filter(e => e.event === 'snapshot:created' && e.metadata?.type === snapshotType);
    const latestSnapshot = snapshotEvents.findLast(e => e.metadata);
    const latestSnapshotMeta = latestSnapshot?.metadata as Record<string, unknown> | undefined;
    const latestSnapshotPath = latestSnapshotMeta?.path as string | undefined;

    if (!latestSnapshotPath) {
      if (restartCount >= MAX_RESTARTS) {
        throw new Error('Rewrite-spec TTY restarted too many times without a snapshot');
      }
      restartCount++;
      console.log(
        `[rewrite_spec] No ${snapshotType} snapshot found after approval — restarting TTY (attempt ${restartCount}/${MAX_RESTARTS})`,
      );
      continue;
    }

    // Emit completion
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'rewrite_spec:completed',
      version,
      metadata: {
        rewriteDecision: decision,
        snapshotPath: latestSnapshotPath,
      },
    });

    // Route based on decision
    switch (decision) {
      case 'revisit_spec':
        console.log('[rewrite_spec] revisit_spec approved — escalating to phase1');
        return 'revisit_spec';

      case 'refine_local':
        console.log('[rewrite_spec] refine_local approved — clear_loop at same planIndex');
        return 'clear_loop';

      case 'patch_downstream':
      case 'regenerate_remaining': {
        // Set planIndex to first incomplete plan
        const planManifest = readPlanManifest(session.id, version);
        const firstIncomplete = planManifest?.plans.find(p => !p.completed);
        if (firstIncomplete) {
          ctx.planIndex = firstIncomplete.ordinal - 1; // 0-indexed
          console.log(
            `[rewrite_spec] ${decision} approved — clear_loop at planIndex ${ctx.planIndex} (plan-${firstIncomplete.ordinal})`,
          );
        } else {
          console.log(
            `[rewrite_spec] ${decision} approved — no incomplete plans found, clear_loop at current planIndex`,
          );
        }
        return 'clear_loop';
      }
    }
  }
}
