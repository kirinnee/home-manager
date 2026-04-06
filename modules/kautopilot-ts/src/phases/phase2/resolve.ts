import { existsSync, readFileSync } from 'node:fs';
import type { Phase2Context } from './types';
import type { RewriteDecision } from '../../core/types';
import { appendEvent } from '../../core/log';
import { sessionDir } from '../../core/artifacts';
import { devloopDescribe } from '../../core/devloop';
import { loadPromptTemplate, resolveSpec, spawnTTYWithTurnTracking } from '../shared';
import { writeStepInit } from '../../core/step-init';
import { getAgentBinary, TTY_EXIT_INSTRUCTION } from '../../core/agents';
import { logBanner } from '../../util/format';

const VALID_REWRITE_DECISIONS: RewriteDecision[] = ['refine_local', 'regenerate_remaining', 'revisit_spec'];

// Mechanical instructions prepended by handler — NOT part of user-editable prompt
const RESOLVE_MECHANICS = `## Loop Evidence (from kloop describe)
{kloop_evidence}

## Rewrite Decision Required

After analysis, you MUST write your resolution AND your rewrite decision to the resolution file.

At the END of your resolution, add a line exactly like:
\`\`\`
REWRITE_DECISION: <decision>
\`\`\`

Where <decision> is one of:
- refine_local — fix only the current plan procedure
- regenerate_remaining — regenerate all remaining plans from scratch
- revisit_spec — the declarative contract itself is wrong (creates new epoch vN+1)

Resolution file path: {resolution_path}`;

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

  // Read context from session artifacts (active plan = highest rewrite suffix)
  const { resolveActivePlans } = await import('../shared');
  const { snapshotPath: snapPath } = await import('../../core/artifacts');
  const activePlans = resolveActivePlans(snapPath(session.id, version, 'plans'));
  const activePlanPath = activePlans[planIndex];
  const taskSpecPath = snapPath(session.id, version, 'task-spec.md');

  // Get user-configurable prompt with vars
  const resolvePrompt = loadPromptTemplate('phase2', 'resolve', {
    plan: planName,
    spec: activePlanPath || '',
    taskSpec: taskSpecPath,
    reason,
    attempt: String(attempt),
  });

  const resolutionPath = `${sessionDir(session.id)}/tmp/resolution.md`;

  // Prepend mechanical instructions
  const mechanics = RESOLVE_MECHANICS.replace(
    '{kloop_evidence}',
    kloopDescribeOutput || '(no evidence available)',
  ).replace('{resolution_path}', resolutionPath);

  const fullPrompt = `${resolvePrompt}\n\n${mechanics}`;

  // Record step init
  const binary = getAgentBinary('phase2', 'resolve');
  writeStepInit(session.id, version, 'resolve', {
    prompt: fullPrompt,
    command: `${binary} (TTY handoff)`,
    type: 'tty_handoff',
  });

  logBanner('Resolving Plan', { Plan: planName, Reason: reason });
  console.log(`Discuss the issue with Claude. When resolved, write your approach to ${resolutionPath}`);
  console.log(`Include REWRITE_DECISION: <refine_local|regenerate_remaining|revisit_spec>\n`);

  // TTY handoff
  await spawnTTYWithTurnTracking(session.id, binary, fullPrompt + TTY_EXIT_INSTRUCTION, {
    cwd: session.worktree,
    worktree: session.worktree,
  });

  // Read resolution and parse rewrite decision
  let resolution = '';
  let rewriteDecision: RewriteDecision = 'refine_local'; // default
  if (existsSync(resolutionPath)) {
    resolution = readFileSync(resolutionPath, 'utf-8');

    // Parse REWRITE_DECISION from the resolution
    const decisionMatch = resolution.match(/REWRITE_DECISION:\s*(refine_local|regenerate_remaining|revisit_spec)/i);
    if (decisionMatch) {
      rewriteDecision = decisionMatch[1].toLowerCase() as RewriteDecision;
    }
  }

  ctx.lastRewriteDecision = rewriteDecision;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'resolve:completed',
    version,
    plan: planName,
    attempt,
    metadata: {
      kloopDescribeAvailable: !!kloopDescribeOutput,
      rewriteDecision,
      reason,
      resolution,
    },
  });

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: { rewriteDecision },
  });

  // Route based on rewrite decision (spec section 4.3)
  if (rewriteDecision === 'revisit_spec') {
    // revisit_spec creates a new epoch — escalate back to Phase 1
    console.log(`[resolve] Decision: revisit_spec — escalating to new epoch`);
    return 'failed'; // Will trigger re-run with new epoch
  }

  return 'rewrite_spec';
}
