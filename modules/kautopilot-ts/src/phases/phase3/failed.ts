import type { Phase3Context } from './types';
import { appendEvent } from '../../core/log';
import { confirmAction } from '../../llm/inquirer';

export async function handleFailed(ctx: Phase3Context): Promise<string | null> {
  const { session, version } = ctx;

  // Find the error from recent events
  const { readLog } = await import('../../core/log');
  const log = readLog(session.id);
  const errorEvent = [...log].reverse().find(e => e.event.includes(':error') || (e.metadata?.error as string));

  const errorMsg = (errorEvent?.metadata?.error as string) || 'Unknown error';

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'phase3:failed',
    version,
    metadata: { error: errorMsg },
  });

  console.error(`\nPhase 3 failed: ${errorMsg}`);

  const retry = await confirmAction('Would you like to retry?', false);

  if (retry) {
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'phase3:retry',
      version,
    });
    // Find the last incomplete state and resume
    return 'commit_pending';
  }

  console.log('\nPhase 3 aborted. Use "kautopilot start --phase polish" to retry.\n');
  return null;
}
