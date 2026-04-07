import { appendEvent } from '../../core/log';
import { logBanner } from '../../util/format';
import type { Phase2Context } from './types';

export async function handleCompleted(ctx: Phase2Context): Promise<string | null> {
  const { session, version } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'phase2:completed',
    version,
  });

  logBanner('Phase 2 Complete — All plans implemented');
  return null; // Terminal state
}
