import { devloopRun } from '../../core/devloop';
import { appendEvent } from '../../core/log';
import type { Phase3Context } from './types';

export async function handleRunFix(ctx: Phase3Context): Promise<string | null> {
  const { session, version, pushCycle } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'run_fix:started',
    version,
    metadata: { stepType: 'code', pushCycle },
  });

  if (!ctx.kloopRunId) {
    throw new Error('No kloop run ID — write_fix must run first');
  }

  console.log(`[run_fix] Starting kloop run ${ctx.kloopRunId} for fixes (push cycle ${pushCycle})`);

  const result = await devloopRun(ctx.kloopRunId);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'run_fix:completed',
    version,
    metadata: {
      pushCycle,
      exitCode: result.exitCode,
      status: result.status,
      kloopRunId: result.runId,
    },
  });

  // Route based on result
  if (result.status === 'completed') {
    ctx.pushCycle++;
    return 'push';
  }

  if (result.status === 'conflict' || result.status === 'max_situations') {
    ctx.ttyReason = 'run_fix_failure';
    return 'tty_resolve';
  }

  // error or agent_failure
  return 'failed';
}
