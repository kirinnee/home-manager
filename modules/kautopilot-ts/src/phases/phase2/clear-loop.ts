import type { Phase2Context } from './types';
import { appendEvent } from '../../core/log';
import { devloopStatus, devloopCancel } from '../../core/devloop';

export async function handleClearLoop(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex } = ctx;

  const planName = `plan-${planIndex + 1}`;
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'clear_loop:started',
    version,
    plan: planName,
    metadata: { stepType: 'code', planIndex },
  });

  // Cancel previous kloop run if one exists and is running
  let runWasActive = false;

  if (ctx.kloopRunId) {
    const status = devloopStatus(ctx.kloopRunId);
    if (status.running) {
      console.log(`[clear_loop] kloop run ${ctx.kloopRunId} is active, canceling...`);
      devloopCancel(ctx.kloopRunId);
      runWasActive = true;
    }
    ctx.kloopRunId = undefined;
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'clear_loop:completed',
    version,
    plan: planName,
    metadata: { runWasActive },
  });

  return 'setup_run';
}
