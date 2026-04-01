import { existsSync, readFileSync } from 'node:fs';
import type { Phase2Context } from './types';
import { appendEvent } from '../../core/log';
import { devloopInit, writeKloopSpec, writeKloopConfig } from '../../core/devloop';
import { resolvePlans, resolveActivePlans } from '../shared';
import { snapshotPath } from '../../core/artifacts';

export async function handleSetupRun(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex, firstRun } = ctx;

  const planName = `plan-${planIndex + 1}`;
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'setup_run:started',
    version,
    plan: planName,
    metadata: { stepType: 'code', firstRun },
  });

  // Resolve active plans from session artifacts (highest rewrite suffix per ordinal)
  const sessionPlansDir = snapshotPath(session.id, version, 'plans');
  const plans = resolveActivePlans(sessionPlansDir);

  if (plans.length === 0) {
    throw new Error(`No plan files found for ${ctx.ticketId}`);
  }

  const planPath = plans[planIndex];
  if (!planPath || !existsSync(planPath)) {
    throw new Error(`Plan file not found for plan index ${planIndex}`);
  }

  const planContent = readFileSync(planPath, 'utf-8');

  // Write spec to temp file for kloop init
  const specPath = writeKloopSpec(session.id, planContent, `plan-${planIndex + 1}-spec.md`);

  // Write kloop config from kautopilot settings
  const configPath = writeKloopConfig(session.id, {
    maxIterations: ctx.config.kloop.maxIterations,
    implementerTimeout: ctx.config.kloop.implementerTimeout,
    reviewerTimeout: ctx.config.kloop.reviewerTimeout,
  });

  // Initialize kloop run with spec + config
  console.log(`[setup_run] Initializing kloop run for ${planName}...`);
  const kloopRunId = devloopInit(session.worktree, specPath, configPath);
  ctx.kloopRunId = kloopRunId;
  console.log(`[setup_run] kloop run initialized: ${kloopRunId}`);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'setup_run:completed',
    version,
    plan: planName,
    metadata: { kloopRunId },
  });

  return 'running';
}
