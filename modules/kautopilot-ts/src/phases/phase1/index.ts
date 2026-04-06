import type { Phase1Context, Phase1StateMap } from './types';
import type { SessionRow, Config } from '../../core/types';
import { runStateMachine } from '../machine';
import { appendEvent, readLog } from '../../core/log';
import { ensureStatus } from '../../core/status';
import { loadSessionAgents } from '../../core/agents';
import { runScript } from '../../core/scripts';
import { supersedEpoch } from '../../core/manifests';
import { handlePullTicket } from './pull-ticket';
import { handleTriage } from './triage';
import { handleWriteSpec } from './write-spec';
import { handleFinalizeSpec } from './finalize-spec';
import { handleWritePlans } from './write-plans';
import { handleFinalizePlans } from './finalize-plans';
import { copyFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Re-export shared utilities for external use
export { discoverPlans } from '../shared';

/**
 * Copy triage.md from old version to new version directory so it carries forward
 * during spec amendment escalation.
 */
function copyTriageToNewVersion(worktree: string, ticketId: string, oldVersion: number, newVersion: number): void {
  const oldTriagePath = join(worktree, 'spec', ticketId, `v${oldVersion}`, 'triage.md');
  const newVersionDir = join(worktree, 'spec', ticketId, `v${newVersion}`);
  const newTriagePath = join(newVersionDir, 'triage.md');

  if (existsSync(oldTriagePath)) {
    mkdirSync(newVersionDir, { recursive: true });
    copyFileSync(oldTriagePath, newTriagePath);
  }
}

/**
 * Find the latest spec-draft-N.md from the old version directory.
 * Returns the content of the latest draft, or null if none exists.
 */
function findPreviousSpecDraft(worktree: string, ticketId: string, oldVersion: number): string | null {
  const specDir = join(worktree, 'spec', ticketId, `v${oldVersion}`);
  let files: string[];
  try {
    files = readdirSync(specDir);
  } catch {
    return null;
  }

  const drafts = files
    .filter(f => /^spec-draft-\d+\.md$/.test(f))
    .map(f => ({ file: f, ordinal: parseInt(f.match(/spec-draft-(\d+)\.md/)![1]) }))
    .sort((a, b) => b.ordinal - a.ordinal);

  if (drafts.length === 0) return null;

  return readFileSync(join(specDir, drafts[0].file), 'utf-8');
}

// State map for Phase 1
const phase1States: Phase1StateMap = {
  pull_ticket: handlePullTicket,
  triage: handleTriage,
  write_spec: handleWriteSpec,
  finalize_spec: handleFinalizeSpec,
  write_plans: handleWritePlans,
  finalize_plans: handleFinalizePlans,
};

/**
 * Run Phase 1: Type-driven Planning and Specification.
 *
 * Flow:
 *   [code] pull_ticket     → fetch ticket to {worktree}/spec/ticket.md
 *   [tty]  triage          → assess scope, classify delivery, clarify with user
 *   [tty]  write_spec      → write spec informed by triage output
 *   [code] finalize_spec   → snapshot spec draft to task-spec.md
 *   [tty]  write_plans     → write plans from approved spec
 *   [code] finalize_plans  → snapshot plans, git commit (terminal)
 */
export async function runPhase1(
  session: SessionRow,
  config: Config,
  options?: {
    forceStartState?: string;
    versionOverride?: number;
    specAmendmentContext?: import('./types').SpecAmendmentContext;
  },
): Promise<boolean> {
  // Initialize agent resolution from session config
  loadSessionAgents(session.id);

  // Transition ticket to in-progress (best-effort)
  if (session.ticket_id) {
    runScript(session.id, 'start-ticket', [session.ticket_id]);
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'start_ticket:called',
      metadata: { ticketId: session.ticket_id },
    });
  }

  const status = ensureStatus(session.id);

  // Determine version: if explicitly overridden, use that for contract rewrites.
  // Otherwise, if phase1 has prior work (resuming), keep the current version.
  // Only start a new version if phase1 completed previously (re-running from scratch).
  const phase1HasWork =
    Object.keys(phase1States).some(s => status.completedSteps.includes(s)) || status.state in phase1States;
  const version =
    options?.versionOverride ?? (status.version === 0 ? 1 : phase1HasWork ? status.version : status.version + 1);

  const ctx: Phase1Context = {
    session,
    config,
    version,
    attempt: 1,
    specAmendmentContext: options?.specAmendmentContext,
  };

  // Use generic state machine runner with resume support
  const result = await runStateMachine('phase1', phase1States, ctx, {
    terminalStates: ['finalize_plans'],
    forceStartState: options?.forceStartState,
  });

  // Handle spec amendment escalation
  if (result === 'amend_spec') {
    const nextVersion = version + 1;
    supersedEpoch(session.id, version, nextVersion);

    // Copy triage.md to new version dir so it carries forward
    const ticketId = session.ticket_id || 'local';
    copyTriageToNewVersion(session.worktree, ticketId, version, nextVersion);

    // Find previous spec draft and amendment reason for context
    const previousSpec = findPreviousSpecDraft(session.worktree, ticketId, version);
    const amendmentEvents = readLog(session.id).filter(e => e.event === 'spec_amendment:requested');
    const amendmentReason =
      amendmentEvents.length > 0
        ? (amendmentEvents[amendmentEvents.length - 1].metadata?.reason as string) ||
          'Plan writing discovered spec drift'
        : 'Plan writing discovered spec drift';

    // Re-run phase 1 starting from write_spec with new version and amendment context
    return runPhase1(session, config, {
      versionOverride: nextVersion,
      forceStartState: 'write_spec',
      specAmendmentContext: previousSpec
        ? {
            previousSpec,
            reason: amendmentReason,
            previousVersion: version,
          }
        : undefined,
    });
  }

  return result;
}
