import { appendEvent } from '../../core/log';
import { confirmAction } from '../../llm/inquirer';
import { logErrorBanner } from '../../util/format';
import type { Phase2Context } from './types';

export async function handleFailed(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex, attempt } = ctx;

  const planName = `plan-${planIndex + 1}`;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'phase2:failed',
    version,
    plan: planName,
    attempt,
  });

  logErrorBanner('Phase 2 Failed', {
    Plan: planName,
    Attempt: String(attempt),
  });

  const retry = await confirmAction('Retry from current plan?');
  if (retry) {
    ctx.attempt = 1;
    return 'clear_loop';
  }

  logErrorBanner('Phase 2 Aborted', {
    Retry: 'kautopilot start --phase impl:clear_loop',
  });
  return null; // Terminal state
}
