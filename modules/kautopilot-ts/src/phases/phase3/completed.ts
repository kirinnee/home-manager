import type { Phase3Context } from './types';
import { appendEvent } from '../../core/log';

export async function handleCompleted(ctx: Phase3Context): Promise<string | null> {
  const { session, version, prNumber, prUrl } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'phase3:completed',
    version,
    metadata: { prNumber, prUrl },
  });

  console.log(`\nPhase 3 completed successfully`);
  if (prUrl) {
    console.log(`PR: ${prUrl}`);
  } else if (prNumber) {
    console.log(`PR: #${prNumber}`);
  }
  console.log(`The PR is merge-ready. Please review and merge manually.\n`);

  return null;
}
