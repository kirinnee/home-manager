import type { Phase2Context } from './types';
import { appendEvent } from '../../core/log';
import { confirmAction } from '../../llm/inquirer';

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

  console.error(`[Phase 2] Failed on ${planName} (attempt ${attempt})`);

  const retry = await confirmAction('Retry from current plan?');
  if (retry) {
    ctx.attempt = 1;
    return 'clear_loop';
  }

  console.log('[Phase 2] Aborting. Use `kautopilot start --phase impl:clear_loop` to retry.');
  return null; // Terminal state
}
