import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentBinary, TTY_EXIT_INSTRUCTION } from '../../core/agents';
import { devloopDescribe } from '../../core/devloop';
import { appendEvent, readLog } from '../../core/log';
import { readPlanManifest } from '../../core/manifests';
import { writeStepInit } from '../../core/step-init';
import { logBanner } from '../../util/format';
import { loadPromptTemplate, resolveActivePlans, spawnTTYWithTurnTracking } from '../shared';
import { isRewriteDecision, type Phase2Context, type RewriteDecision } from './types';

const MAX_RESTARTS = 5;

function getSnapshotType(decision: RewriteDecision): 'spec' | 'plans' {
  return decision === 'revisit_spec' ? 'spec' : 'plans';
}

function getResolveReason(sessionId: string, version: number, planName: string): string {
  const lastRunningCompleted = readLog(sessionId)
    .filter(e => e.event === 'running:completed' && e.version === version && e.plan === planName)
    .at(-1);
  const status = lastRunningCompleted?.metadata?.status;
  return status === 'max_situations' || status === 'conflict' ? status : 'conflict';
}

export async function handleResolve(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex, attempt, config } = ctx;

  const planName = `plan-${planIndex + 1}`;
  const reason = getResolveReason(session.id, version, planName);

  // Gather durable loop evidence (spec section 7.4)
  let kloopDescribeOutput = '';
  if (ctx.kloopRunId) {
    kloopDescribeOutput = devloopDescribe(ctx.kloopRunId);
  }

  // Resolve ticket ID for worktree path construction
  const ticketId = session.ticket_id || 'local';

  // Build paths from worktree (NOT artifact snapshots) — these are where the TTY edits
  const worktreeSpecDir = join(session.worktree, 'spec', ticketId, `v${version}`);
  const worktreePlansDir = join(worktreeSpecDir, 'plans');
  const worktreeSpecPath = join(worktreeSpecDir, 'task-spec.md');
  const worktreeFeedbackPath = join(worktreeSpecDir, 'feedback.md');

  // Resolve active plan path (highest rewrite suffix per ordinal)
  const activePlanPaths = resolveActivePlans(worktreePlansDir);
  const activePlanPath = activePlanPaths[planIndex] || '';

  // Gather plan manifest data for completed/incomplete lists
  const planManifest = readPlanManifest(session.id, version);
  const completedPlans = planManifest?.plans.filter(p => p.completed) ?? [];
  const incompletePlans = planManifest?.plans.filter(p => !p.completed) ?? [];
  const completedPlansList = completedPlans.map(p => `- plan-${p.ordinal} (completed)`).join('\n') || '(none)';
  const incompletePlansList = incompletePlans.map(p => `- plan-${p.ordinal}`).join('\n') || '(none)';

  let restartCount = 0;

  while (true) {
    const fenceEvent = restartCount === 0 ? 'resolve:started' : 'resolve:restarted';

    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: fenceEvent,
      version,
      plan: planName,
      attempt,
      metadata: { stepType: 'tty', reason },
    });

    // Build resolve prompt — use worktree paths where the TTY will edit
    const resolvePrompt = loadPromptTemplate('phase2', 'resolve', {
      task_spec_path: worktreeSpecPath,
      plan_path: activePlanPath,
      plans_dir: worktreePlansDir,
      kloop_evidence: kloopDescribeOutput || '(no evidence available)',
      feedback_path: worktreeFeedbackPath,
      plan_name: planName,
      completed_plans_list: completedPlansList,
      incomplete_plans_list: incompletePlansList,
      planTemplate: config.templates.plan,
    });

    // Record step init
    const binary = getAgentBinary('phase2', 'resolve');
    writeStepInit(session.id, version, 'resolve', {
      prompt: resolvePrompt,
      command: `${binary} (TTY handoff)`,
      type: 'tty_handoff',
    });

    logBanner('Resolving Plan', { Plan: planName, Reason: reason });
    console.log(
      `Discuss the issue with Claude. Decide on a rewrite strategy, write the amendment, snapshot, and log the decision.`,
    );

    // TTY handoff
    await spawnTTYWithTurnTracking(session.id, binary, resolvePrompt + TTY_EXIT_INSTRUCTION, {
      cwd: session.worktree,
      worktree: session.worktree,
    });

    // Read events since fence event
    const allEvents = readLog(session.id);
    const fenceIdx = allEvents.findLastIndex(e => e.event === fenceEvent);
    const eventsSince = fenceIdx >= 0 ? allEvents.slice(fenceIdx + 1) : allEvents;

    // Check abandon
    if (eventsSince.some(e => e.event === 'resolve:abandoned')) {
      appendEvent(session.id, {
        ts: new Date().toISOString(),
        event: 'resolve:completed',
        version,
        plan: planName,
        attempt,
        metadata: { reason: 'abandoned' },
      });
      return 'failed';
    }

    // Check decision
    const decisionEvent = eventsSince.findLast(
      e => e.event === 'context:updated' && isRewriteDecision(e.metadata?.rewriteDecision),
    );
    const decision = decisionEvent?.metadata?.rewriteDecision as RewriteDecision | undefined;

    if (!decision) {
      if (restartCount >= MAX_RESTARTS) {
        throw new Error('Resolve TTY restarted too many times without a decision');
      }
      restartCount++;
      console.log(`[resolve] No rewrite decision found — restarting TTY (attempt ${restartCount}/${MAX_RESTARTS})`);
      continue;
    }

    // Check snapshot — must exist and type must match decision
    const expectedSnapshotType = getSnapshotType(decision);
    const matchingSnapshot = eventsSince.find(
      e => e.event === 'snapshot:created' && e.metadata?.type === expectedSnapshotType,
    );
    if (!matchingSnapshot) {
      if (restartCount >= MAX_RESTARTS) {
        throw new Error(`Resolve TTY restarted too many times without a ${expectedSnapshotType} snapshot`);
      }
      restartCount++;
      console.log(
        `[resolve] No ${expectedSnapshotType} snapshot found — restarting TTY (attempt ${restartCount}/${MAX_RESTARTS})`,
      );
      continue;
    }

    // For revisit_spec: check feedback.md exists in worktree
    if (decision === 'revisit_spec') {
      if (!existsSync(worktreeFeedbackPath)) {
        if (restartCount >= MAX_RESTARTS) {
          throw new Error('Resolve TTY restarted too many times without feedback.md');
        }
        restartCount++;
        console.log(
          `[resolve] revisit_spec chosen but no feedback.md — restarting TTY (attempt ${restartCount}/${MAX_RESTARTS})`,
        );
        continue;
      }
    }

    // Store decision on context for rewrite_spec handler
    ctx.rewriteDecision = decision;

    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'resolve:completed',
      version,
      plan: planName,
      attempt,
      metadata: {
        reason,
        rewriteDecision: decision,
      },
    });

    console.log(`[resolve] decision=${decision}, snapshot found — proceeding to rewrite_spec`);
    return 'rewrite_spec';
  }
}
