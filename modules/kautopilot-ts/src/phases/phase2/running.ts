import { devloopRun } from '../../core/devloop';
import { appendEvent } from '../../core/log';
import type { Phase2Context } from './types';

const MAX_CRASH_RETRIES = 2;

export async function handleRunning(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex, attempt } = ctx;

  const planName = `plan-${planIndex + 1}`;
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'running:started',
    version,
    plan: planName,
    attempt,
    metadata: { stepType: 'code' },
  });

  if (!ctx.kloopRunId) {
    throw new Error('No kloop run ID — setup_run must run first');
  }

  console.log(`[running] Executing kloop run ${ctx.kloopRunId} for ${planName}, attempt ${attempt}`);

  const result = await devloopRun(ctx.kloopRunId);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'running:completed',
    version,
    plan: planName,
    attempt,
    metadata: {
      stepType: 'code',
      exitCode: result.exitCode,
      status: result.status,
      runId: result.runId,
    },
  });

  // Route based on spec-defined outcomes
  switch (result.status) {
    case 'completed':
      return 'commit';

    case 'conflict':
    case 'max_iterations':
      return 'resolve';

    case 'crash':
      // Retry/recover before rewrite (spec section 7.3, invariant 8)
      ctx.crashRetryCount = (ctx.crashRetryCount ?? 0) + 1;
      if (ctx.crashRetryCount <= MAX_CRASH_RETRIES) {
        console.log(`[running] Crash detected — retrying (${ctx.crashRetryCount}/${MAX_CRASH_RETRIES})`);
        appendEvent(session.id, {
          ts: new Date().toISOString(),
          event: 'crash:retry',
          version,
          plan: planName,
          metadata: {
            crashRetryCount: ctx.crashRetryCount,
            maxRetries: MAX_CRASH_RETRIES,
          },
        });
        // Re-setup and retry the same plan
        return 'setup_run';
      }
      // Exhausted retries — now fail
      console.log(`[running] Crash retries exhausted (${MAX_CRASH_RETRIES}) — failing`);
      return 'failed';
  }
}
