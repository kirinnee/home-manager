import type { Phase2Context } from './types';
import { appendEvent } from '../../core/log';

export async function handleCompleted(ctx: Phase2Context): Promise<string | null> {
  const { session, version } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'phase2:completed',
    version,
  });

  console.log('[Phase 2] All plans completed');
  return null; // Terminal state
}
