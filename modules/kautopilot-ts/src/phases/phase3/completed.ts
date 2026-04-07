import { appendEvent } from '../../core/log';
import { logBanner } from '../../util/format';
import type { Phase3Context } from './types';

export async function handleCompleted(ctx: Phase3Context): Promise<string | null> {
  const { session, version, prNumber, prUrl } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'phase3:completed',
    version,
    metadata: { prNumber, prUrl },
  });

  logBanner('Phase 3 Complete', {
    PR: prUrl || (prNumber ? `#${prNumber}` : 'N/A'),
    Status: 'Merge-ready — please review and merge manually',
  });

  return null;
}
