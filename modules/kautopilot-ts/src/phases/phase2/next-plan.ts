import type { Phase2Context } from './types';
import { appendEvent } from '../../core/log';

export async function handleNextPlan(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex, maxPlans } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'next_plan:started',
    version,
    metadata: { stepType: 'code' },
  });

  const fromPlan = `plan-${planIndex + 1}`;

  // Increment plan index
  ctx.planIndex += 1;
  const toPlan = ctx.planIndex < maxPlans ? `plan-${ctx.planIndex + 1}` : 'done';

  // Persist plan index to WAL for status materialization
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    metadata: { planIndex: ctx.planIndex, maxPlans },
  });

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'next_plan:completed',
    version,
    metadata: { from: fromPlan, to: toPlan },
  });

  if (ctx.planIndex < maxPlans) {
    // More plans - go back to clear_loop
    ctx.firstRun = false;
    ctx.attempt = 1;
    return 'clear_loop';
  }

  // All plans done
  return 'completed';
}
