import { join } from 'node:path';
import { getAgentBinary } from '../../core/agents';
import { devloopDescribe } from '../../core/devloop';
import { appendEvent, readLog } from '../../core/log';
import { readPlanManifest } from '../../core/manifests';
import { writeStepInit } from '../../core/step-init';
import { logBanner } from '../../util/format';
import { loadPromptTemplate, resolveActivePlans, spawnTTYWithTurnTracking } from '../shared';
import type { Phase2Context, RewriteDecision } from './types';

const MAX_RESTARTS = 5;

/**
 * Non-negotiable mechanics shared across all amend_plans strategies.
 * Always appended so the pipeline contract is never broken by custom prompts.
 */
const AMEND_PLANS_COMMON = `## CRITICAL: Amend Plans Mechanics

### Context Document
Read {resolution_path} first — it contains the decision context from the previous TTY. Do not re-debate the strategy; debate the IMPLEMENTATION of it.

### Snapshot Workflow (COMPULSORY)
After each edit cycle: \`kautopilot snapshot plans\`
The epoch version is auto-detected. This step is COMPULSORY.

### Interaction Protocol — STRICT

1. **You suggest first.** Propose the plan edits based on the resolution doc — do not open with "what do you want to do?"
2. **Debate with the user.** Iterate until you both agree on the final plan content.
3. **Confirm the final decision.** State clearly what you both agreed on so there is no ambiguity.
4. **Wait for explicit approval.** The user must say "approve" (or a clear equivalent like "yes approve this"). Ambiguous acknowledgements like "ok", "sounds good", or "sure" are NOT approval — ask for explicit confirmation.
5. **Only after approval**, save, snapshot, and log:
   \`kautopilot log-event rewrite_plans:approved\`
6. **Only after the event is logged**, tell the user: "All set — type /exit (or Ctrl+C) to continue kautopilot."

**DO NOT mention /exit before step 6.** Mentioning it earlier makes the user think the session is over before the event is committed. If they exit early, this step re-runs from scratch.

**DO NOT log the event before step 4.** Explicit approval is the only gate.
`;

const REFINE_LOCAL_PROMPT =
  `## Strategy: refine_local

Rewrite ONLY {plan_name} at {plan_path}. Do not touch other plans.

Each plan file MUST follow the template:
{planTemplate}

` + AMEND_PLANS_COMMON;

const PATCH_DOWNSTREAM_PROMPT =
  `## Strategy: patch_downstream

Edit ONLY the incomplete plan files. Do not touch completed ones.

Completed (do NOT edit):
{completed_plans_list}

Incomplete (to patch):
{incomplete_plans_list}

Each plan file MUST follow the template:
{planTemplate}

` + AMEND_PLANS_COMMON;

const REGENERATE_REMAINING_PROMPT =
  `## Strategy: regenerate_remaining

Rewrite ALL incomplete plan files FROM SCRATCH based on the current spec plus learnings in the resolution doc.

Completed (do NOT edit):
{completed_plans_list}

Incomplete (to regenerate):
{incomplete_plans_list}

Each plan file MUST follow the template:
{planTemplate}

` + AMEND_PLANS_COMMON;

function getStrategyPrompt(decision: Exclude<RewriteDecision, 'retry' | 'revisit_spec'>): string {
  const prompts: Record<typeof decision, string> = {
    refine_local: REFINE_LOCAL_PROMPT,
    patch_downstream: PATCH_DOWNSTREAM_PROMPT,
    regenerate_remaining: REGENERATE_REMAINING_PROMPT,
  };
  return prompts[decision];
}

function getDecisionTitle(decision: Exclude<RewriteDecision, 'retry' | 'revisit_spec'>): string {
  const titles: Record<typeof decision, string> = {
    refine_local: 'Refine Local Plan',
    patch_downstream: 'Patch Downstream Plans',
    regenerate_remaining: 'Regenerate Remaining Plans',
  };
  return titles[decision];
}

export async function handleAmendPlans(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex, config } = ctx;

  if (!ctx.rewriteDecision) {
    throw new Error('rewriteDecision not set on context — resolve must run first');
  }

  if (ctx.rewriteDecision === 'retry') {
    throw new Error('retry decision should never reach amend_plans — resolve should return clear_loop directly');
  }

  if (ctx.rewriteDecision === 'revisit_spec') {
    throw new Error(
      'revisit_spec decision should never reach amend_plans — resolve should return revisit_spec directly',
    );
  }

  const decision = ctx.rewriteDecision;
  const decisionTitle = getDecisionTitle(decision);

  // Gather kloop evidence
  let kloopDescribeOutput = '';
  if (ctx.kloopRunId) {
    kloopDescribeOutput = devloopDescribe(ctx.kloopRunId);
  }

  // Resolve ticket ID and build worktree paths (where TTY edits live)
  const ticketId = session.ticket_id || 'local';
  const worktreeSpecDir = join(session.worktree, 'spec', ticketId, `v${version}`);
  const worktreePlansDir = join(worktreeSpecDir, 'plans');
  const worktreeSpecPath = join(worktreeSpecDir, 'task-spec.md');
  const worktreeResolutionPath = join(worktreePlansDir, 'resolution.md');
  const planName = `plan-${planIndex + 1}`;

  // Resolve active plan paths from worktree plans directory
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
    const fenceEvent = restartCount === 0 ? 'amend_plans:started' : 'amend_plans:restarted';

    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: fenceEvent,
      version,
      metadata: { rewriteDecision: decision },
    });

    // Build strategy-specific mechanics prompt
    const strategyPrompt = getStrategyPrompt(decision)
      .replace(/\{plan_name\}/g, planName)
      .replace(/\{plan_path\}/g, activePlanPath)
      .replace(/\{planTemplate\}/g, config.templates.plan)
      .replace(/\{completed_plans_list\}/g, completedPlansList)
      .replace(/\{incomplete_plans_list\}/g, incompletePlansList)
      .replace(/\{resolution_path\}/g, worktreeResolutionPath);

    // Build user-editable body from config
    const userPrompt = loadPromptTemplate('phase2', 'amend_plans', {
      resolution_path: worktreeResolutionPath,
      task_spec_path: worktreeSpecPath,
      plans_dir: worktreePlansDir,
      kloop_evidence: kloopDescribeOutput || '(no evidence available)',
    });

    const prompt = strategyPrompt + '\n' + userPrompt;

    // Record step init
    const binary = getAgentBinary('phase2', 'amend_plans');
    writeStepInit(session.id, version, 'amend_plans', {
      prompt,
      command: `${binary} (TTY handoff)`,
      type: 'tty_handoff',
    });

    logBanner('Amending Plans', { Strategy: decisionTitle });

    // TTY handoff
    await spawnTTYWithTurnTracking(session.id, binary, prompt, {
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
    const approved = eventsSince.some(e => e.event === 'rewrite_plans:approved');
    if (!approved) {
      if (restartCount >= MAX_RESTARTS) {
        throw new Error('Amend-plans TTY restarted too many times without approval');
      }
      restartCount++;
      console.log(
        `[amend_plans] No rewrite_plans:approved found — restarting TTY (attempt ${restartCount}/${MAX_RESTARTS})`,
      );
      continue;
    }

    // Check plans snapshot exists
    const snapshotEvents = eventsSince.filter(e => e.event === 'snapshot:created' && e.metadata?.type === 'plans');
    const latestSnapshot = snapshotEvents.findLast(e => e.metadata);
    const latestSnapshotMeta = latestSnapshot?.metadata as Record<string, unknown> | undefined;
    const latestSnapshotPath = latestSnapshotMeta?.path as string | undefined;

    if (!latestSnapshotPath) {
      if (restartCount >= MAX_RESTARTS) {
        throw new Error('Amend-plans TTY restarted too many times without a plans snapshot');
      }
      restartCount++;
      console.log(
        `[amend_plans] No plans snapshot found after approval — restarting TTY (attempt ${restartCount}/${MAX_RESTARTS})`,
      );
      continue;
    }

    // Emit completion
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'amend_plans:completed',
      version,
      metadata: {
        rewriteDecision: decision,
        snapshotPath: latestSnapshotPath,
      },
    });

    // Route based on decision
    switch (decision) {
      case 'refine_local':
        console.log('[amend_plans] refine_local approved — clear_loop at same planIndex');
        return 'clear_loop';

      case 'patch_downstream':
      case 'regenerate_remaining': {
        // Set planIndex to first incomplete plan
        const freshManifest = readPlanManifest(session.id, version);
        const firstIncomplete = freshManifest?.plans.find(p => !p.completed);
        if (firstIncomplete) {
          ctx.planIndex = firstIncomplete.ordinal - 1; // 0-indexed
          console.log(
            `[amend_plans] ${decision} approved — clear_loop at planIndex ${ctx.planIndex} (plan-${firstIncomplete.ordinal})`,
          );
        } else {
          console.log(
            `[amend_plans] ${decision} approved — no incomplete plans found, clear_loop at current planIndex`,
          );
        }
        return 'clear_loop';
      }
    }
  }
}
