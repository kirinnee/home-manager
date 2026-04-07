import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentBinary } from '../../core/agents';
import { ensureArtifactDir, snapshotPath } from '../../core/artifacts';
import { appendEvent } from '../../core/log';
import { spawnPrintRaw } from '../../llm/spawn';
import { resolveSpec } from '../shared';
import type { Phase3Context } from './types';

/**
 * [llm] Generate draft ticket/report artifacts before any irreversible publish actions.
 * Spec section 11.1: Draft artifacts before publish.
 */
export async function handleTicketDraft(ctx: Phase3Context): Promise<string | null> {
  const { session, version, ticketId } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'ticket_draft:started',
    version,
    metadata: { stepType: 'llm', deliveryKind: 'ticket' },
  });

  // Read the spec and plan content for context
  const specContent = resolveSpec(session.id, version);

  // Read ticket content if available
  const ticketPath = join(`${process.env.HOME}/.kautopilot/${session.id}/artifacts`, 'ticket.md');
  const ticketContent = existsSync(ticketPath) ? readFileSync(ticketPath, 'utf-8') : '';

  const binary = getAgentBinary('phase3', 'ticket_draft');

  const draftPrompt = `Generate ticket delivery artifacts based on the completed implementation.

## Task Spec
${specContent}

## Original Ticket
${ticketContent || '(no ticket content available)'}

## Instructions
Based on the completed work, generate:
1. A summary ticket update (markdown) describing what was implemented
2. Any downstream ticket proposals if the spec implies them
3. A report artifact if the spec requires one

Output each artifact as a separate markdown section with a clear filename header:
### tickets-1.md
(content for the main ticket update)

### tickets-2.md
(optional: downstream ticket proposal)

### report-a.md
(optional: detailed report)

Only include artifacts that are actually needed. Output clean markdown.`;

  const draftOutput = await spawnPrintRaw(binary, draftPrompt, {
    cwd: session.worktree,
    timeout: 120,
    sessionId: session.id,
    label: 'ticket-draft',
  });

  // Parse and write draft artifacts to the epoch directory
  const artifactsWritten: string[] = [];
  if (draftOutput) {
    // Parse sections by ### filename.md headers
    const sections = draftOutput.split(/^### /m).filter(s => s.trim());
    for (const section of sections) {
      const firstLine = section.split('\n')[0].trim();
      const filename = `${firstLine.replace(/\.md$/, '').trim()}.md`;
      if (/^(tickets-\d+|report-[a-z])\.md$/.test(filename)) {
        const content = section.slice(firstLine.length).trim();
        const artifactPath = snapshotPath(session.id, version, filename);
        ensureArtifactDir(artifactPath);
        writeFileSync(artifactPath, content);
        artifactsWritten.push(filename);
      }
    }
  }

  // If no artifacts were parsed, write a default summary
  if (artifactsWritten.length === 0) {
    const defaultArtifact = `# Ticket Update: ${ticketId}\n\n${draftOutput || specContent.slice(0, 2000)}`;
    const defaultPath = snapshotPath(session.id, version, 'tickets-1.md');
    ensureArtifactDir(defaultPath);
    writeFileSync(defaultPath, defaultArtifact);
    artifactsWritten.push('tickets-1.md');
  }

  console.log(`[ticket_draft] Generated ${artifactsWritten.length} draft artifact(s): ${artifactsWritten.join(', ')}`);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'ticket_draft:completed',
    version,
    metadata: { artifacts: artifactsWritten },
  });

  return 'ticket_review';
}
