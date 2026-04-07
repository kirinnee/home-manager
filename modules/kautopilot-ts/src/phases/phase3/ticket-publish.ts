import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDir, snapshotPath } from '../../core/artifacts';
import { appendEvent } from '../../core/log';
import { updateDeliveryManifest } from '../../core/manifests';
import { runScriptFromDir } from '../../core/scripts';
import { logDim, logOk, logWarn } from '../../util/format';
import { markdownToPdf } from '../../util/markdown';
import type { Phase3Context } from './types';

/**
 * [code] Publish ticket artifacts after user approval.
 * Spec section 11.3: Publish happens only after approval.
 *
 * Performs irreversible ticket-side actions:
 * - Update current ticket
 * - Add comments
 * - Attach/link artifacts
 * - Create downstream tickets
 * - Move ticket to appropriate state
 */
export async function handleTicketPublish(ctx: Phase3Context): Promise<string | null> {
  const { session, version, ticketId } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'ticket_publish:started',
    version,
    metadata: { stepType: 'code', deliveryKind: 'ticket' },
  });

  const publishedArtifacts: string[] = [];
  const actions: string[] = [];

  // Find draft artifacts
  const epochDir = snapshotPath(session.id, version, '.');
  const artifactFiles: string[] = [];
  try {
    const files = readdirSync(epochDir);
    for (const f of files) {
      if (/^(tickets-\d+|report-[a-z])\.md$/.test(f)) {
        artifactFiles.push(f);
      }
    }
  } catch {
    // No artifacts
  }

  // Process ticket update artifacts
  const scriptsDir = join(sessionDir(session.id), 'scripts');
  for (const f of artifactFiles.sort()) {
    const content = readFileSync(snapshotPath(session.id, version, f), 'utf-8');

    if (f.startsWith('tickets-1')) {
      // Primary ticket update — use update-ticket script
      const result = runScriptFromDir(scriptsDir, 'update-ticket', [ticketId, content]);
      if (result.ok) {
        logOk(`Updated ticket ${ticketId}`);
        actions.push('update_ticket');
      } else {
        // Fallback: add as comment
        const commentResult = runScriptFromDir(scriptsDir, 'add-comment', [ticketId, content]);
        if (commentResult.ok) {
          logOk(`Added comment to ${ticketId}`);
          actions.push('add_comment');
        } else {
          logWarn(`Could not update ticket ${ticketId} — scripts may not be configured`);
        }
      }
      publishedArtifacts.push(f);
    } else if (f.startsWith('tickets-')) {
      // Downstream ticket creation
      const result = runScriptFromDir(scriptsDir, 'create-downstream-ticket', [ticketId, content]);
      if (result.ok) {
        logOk(`Created downstream ticket from ${f}`);
        actions.push('create_downstream');
      }
      publishedArtifacts.push(f);
    } else if (f.startsWith('report-')) {
      // Report artifact — convert to PDF if possible, then attach
      const mdPath = snapshotPath(session.id, version, f);
      let artifactPath = mdPath;

      // Try PDF conversion (spec section 11.4)
      const pdfPath = join(epochDir, f.replace(/\.md$/, '.pdf'));
      const pdfResult = markdownToPdf(readFileSync(mdPath, 'utf-8'), pdfPath, f.replace(/\.md$/, ''));
      if (pdfResult) {
        artifactPath = pdfResult;
        logOk(`Converted ${f} to PDF`);
      } else {
        logDim(`PDF conversion not available for ${f}, attaching markdown`);
      }

      const result = runScriptFromDir(scriptsDir, 'attach-artifact', [ticketId, artifactPath]);
      if (result.ok) {
        logOk(`Attached ${artifactPath} to ${ticketId}`);
        actions.push('attach_artifact');
      }
      publishedArtifacts.push(f);
      if (pdfResult) {
        publishedArtifacts.push(f.replace(/\.md$/, '.pdf'));
      }
    }
  }

  // Move ticket to review state
  if (ticketId) {
    runScriptFromDir(scriptsDir, 'to-review', [ticketId]);
    actions.push('move_to_review');
  }

  // Update delivery manifest
  updateDeliveryManifest(session.id, version, {
    ticketArtifacts: publishedArtifacts,
    publishedAt: new Date().toISOString(),
  });

  console.log(`[ticket_publish] Published ${publishedArtifacts.length} artifact(s), ${actions.length} action(s)`);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'ticket_publish:completed',
    version,
    metadata: {
      publishedArtifacts,
      actions,
    },
  });

  return 'completed';
}
