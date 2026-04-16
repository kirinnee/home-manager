import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentBinary } from '../../core/agents';
import { devloopDescribe } from '../../core/devloop';
import { appendEvent, readLog } from '../../core/log';
import { writeStepInit } from '../../core/step-init';
import { logBanner } from '../../util/format';
import { loadPromptTemplate, resolveActivePlans, spawnTTYWithTurnTracking } from '../shared';
import { isRewriteDecision, type Phase2Context, type RewriteDecision } from './types';

const MAX_RESTARTS = 5;

/**
 * Non-negotiable mechanics injected by the runner — NOT part of the user-editable prompt.
 * Resolve decides the strategy + writes a context document; it does NOT edit plans directly.
 */
const RESOLVE_MECHANICS = `## CRITICAL: Resolve Mechanics

### Step 1: Propose a Strategy

You MUST suggest one of these strategies based on the kloop evidence:

1. **refine_local** — Current plan needs targeted fixes. Choose when kloop was close to passing.
2. **patch_downstream** — Completed plans are fine, but downstream plans need updates. Choose when earlier plans changed the approach.
3. **regenerate_remaining** — Fundamental shift; remaining plans should be rewritten from scratch.
4. **revisit_spec** — The SPEC itself is the problem (contradiction/impossibility). Escalates to a full replan.
5. **retry** — Transient/environmental failure; just re-run the loop.

### Step 2: Write the Context Document

This TTY does NOT edit plans directly. You write a CONTEXT DOCUMENT that the next TTY will use to do the actual editing.

- For **retry**: no document needed, skip to the Interaction Protocol.
- For **revisit_spec**: write feedback to {feedback_path} explaining what is wrong with the spec and what the next epoch needs to address. This file will be consumed by phase 1's write_spec TTY.
- For **refine_local** / **patch_downstream** / **regenerate_remaining**: write a resolution document to {resolution_path} explaining:
  - What went wrong (cite kloop evidence)
  - What needs to change in plans
  - Which plans are affected
  - Any constraints the next TTY must respect
  The resolution doc will be consumed by the amend_plans TTY.

### Step 3: Snapshot

- For **revisit_spec**: \`kautopilot snapshot spec\` (captures feedback.md)
- For **refine_local** / **patch_downstream** / **regenerate_remaining**: \`kautopilot snapshot plans\` (captures resolution.md placed under plans/)
- For **retry**: no snapshot needed.

### Interaction Protocol — STRICT

Follow this loop:

1. **You suggest first.** Propose a strategy + draft the context doc content. Do not open with "what do you want to do?"
2. **Debate with the user.** Iterate until you both agree on the strategy and document content.
3. **Confirm the final decision.** State clearly what you both agreed on so there is no ambiguity.
4. **Wait for explicit approval.** The user must say "approve" (or a clear equivalent like "yes approve this"). Ambiguous acknowledgements like "ok", "sounds good", or "sure" are NOT approval — ask for explicit confirmation.
5. **Only after approval**, write the document (Step 2), snapshot (Step 3), then log the decision:
   \`kautopilot log-event context:updated --metadata '{"rewriteDecision": "<choice>"}'\`
6. **Only after the event is logged**, tell the user: "All set — type /exit (or Ctrl+C) to continue kautopilot."

**DO NOT mention /exit before step 6.** Mentioning it earlier makes the user think the session is over before the event is committed. If they exit early, this step re-runs from scratch.

**DO NOT log the event before step 4.** Explicit approval is the only gate.

### Abandon

If unsalvageable: \`kautopilot log-event resolve:abandoned\` then tell user to /exit.
`;

function getSnapshotType(decision: RewriteDecision): 'spec' | 'plans' {
  return decision === 'revisit_spec' ? 'spec' : 'plans';
}

function getResolveReason(sessionId: string, version: number, planName: string): string {
  const lastRunningCompleted = readLog(sessionId)
    .filter(e => e.event === 'running:completed' && e.version === version && e.plan === planName)
    .at(-1);
  const status = lastRunningCompleted?.metadata?.status;
  return status === 'max_iterations' || status === 'conflict' ? status : 'conflict';
}

export async function handleResolve(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex, attempt } = ctx;

  const planName = `plan-${planIndex + 1}`;
  const reason = getResolveReason(session.id, version, planName);

  // Gather durable loop evidence
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
  const worktreeResolutionPath = join(worktreePlansDir, 'resolution.md');

  // Resolve active plan path (highest rewrite suffix per ordinal)
  const activePlanPaths = resolveActivePlans(worktreePlansDir);
  const activePlanPath = activePlanPaths[planIndex] || '';

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

    // Build resolve prompt — mechanics + user-editable body
    const userPrompt = loadPromptTemplate('phase2', 'resolve', {
      task_spec_path: worktreeSpecPath,
      plan_path: activePlanPath,
      plans_dir: worktreePlansDir,
      kloop_evidence: kloopDescribeOutput || '(no evidence available)',
      plan_name: planName,
      reason,
      attempt: String(attempt),
    });

    const mechanics = RESOLVE_MECHANICS.replace(/\{feedback_path\}/g, worktreeFeedbackPath).replace(
      /\{resolution_path\}/g,
      worktreeResolutionPath,
    );

    const resolvePrompt = `${mechanics}\n${userPrompt}`;

    // Record step init
    const binary = getAgentBinary('phase2', 'resolve');
    writeStepInit(session.id, version, 'resolve', {
      prompt: resolvePrompt,
      command: `${binary} (TTY handoff)`,
      type: 'tty_handoff',
    });

    logBanner('Resolving Plan', { Plan: planName, Reason: reason });
    console.log(`Discuss the issue with Claude. Decide on a strategy, write the context document, and approve.`);

    // TTY handoff
    await spawnTTYWithTurnTracking(session.id, binary, resolvePrompt, {
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

    // 'retry' — skip snapshot validation, no second TTY needed
    if (decision === 'retry') {
      ctx.rewriteDecision = decision;
      appendEvent(session.id, {
        ts: new Date().toISOString(),
        event: 'resolve:completed',
        version,
        plan: planName,
        attempt,
        metadata: { reason, rewriteDecision: decision },
      });
      console.log(`[resolve] decision=retry — proceeding to clear_loop`);
      return 'clear_loop';
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

    // For plan amendment strategies: check resolution.md exists in worktree
    if (decision !== 'revisit_spec') {
      if (!existsSync(worktreeResolutionPath)) {
        if (restartCount >= MAX_RESTARTS) {
          throw new Error('Resolve TTY restarted too many times without resolution.md');
        }
        restartCount++;
        console.log(
          `[resolve] ${decision} chosen but no resolution.md — restarting TTY (attempt ${restartCount}/${MAX_RESTARTS})`,
        );
        continue;
      }
    }

    // Store decision on context for amend_plans handler
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

    // Route based on decision
    if (decision === 'revisit_spec') {
      console.log(`[resolve] decision=revisit_spec — escalating directly to phase 1`);
      return 'revisit_spec';
    }

    console.log(`[resolve] decision=${decision} — proceeding to amend_plans`);
    return 'amend_plans';
  }
}
