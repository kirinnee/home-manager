import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Phase1Context } from './types';
import { appendEvent } from '../../core/log';
import { sessionArtifactPath, ensureArtifactDir } from '../../core/artifacts';
import { runScript } from '../../core/scripts';
import { logOk, logWarn, logDim } from '../../util/format';

/**
 * [code] Fetch ticket content via get-ticket script and write to worktree.
 * Ticket is version-agnostic — lives at spec/ticket.md (not inside v{version}/).
 */
export async function handlePullTicket(ctx: Phase1Context): Promise<string | null> {
  const { session, version } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'pull_ticket:started',
    version,
    metadata: { stepType: 'code' },
  });

  const specDir = join(session.worktree, 'spec');
  mkdirSync(specDir, { recursive: true });
  const ticketPath = join(specDir, 'ticket.md');

  if (session.ticket_id && !session.local) {
    const content = runScript(session.id, 'get-ticket', [session.ticket_id]);
    if (content) {
      writeFileSync(ticketPath, content);
      logOk(`Ticket fetched (${content.split('\n').length} lines)`);
    } else {
      logWarn('No content from get-ticket script');
    }
  } else if (session.local) {
    // Local mode: write a placeholder if no ticket exists
    if (!existsSync(ticketPath)) {
      writeFileSync(ticketPath, '# Local Task\n\nDescribe the task here.\n');
      logDim('Local mode — wrote placeholder ticket.md');
    }
  } else {
    logDim('No ticket ID — skipping ticket fetch');
  }

  // Snapshot ticket to session artifacts (version-agnostic)
  if (existsSync(ticketPath)) {
    const snapshotDest = sessionArtifactPath(session.id, 'ticket.md');
    ensureArtifactDir(snapshotDest);
    copyFileSync(ticketPath, snapshotDest);
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'pull_ticket:completed',
    version,
  });

  return 'write_spec';
}
