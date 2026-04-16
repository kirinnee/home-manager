import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSessionAgents } from '../../core/agents';
import { appendEvent, readLog } from '../../core/log';
import { supersedEpoch } from '../../core/manifests';
import { runScript } from '../../core/scripts';
import { ensureStatus } from '../../core/status';
import type { Config, SessionRow } from '../../core/types';
import { runStateMachine } from '../machine';
import { handleFinalizePlans } from './finalize-plans';
import { handleFinalizeSpec } from './finalize-spec';
import { handlePullTicket } from './pull-ticket';
import { handleTriage } from './triage';
import type { Phase1Context, Phase1StateMap } from './types';
import { handleWritePlans } from './write-plans';
import { handleWriteSpec } from './write-spec';

// discoverPlans removed from export — now private to ../shared

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
    suppressPhaseStarted?: boolean;
  },
): Promise<boolean | 'revisit_spec'> {
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
    suppressPhaseStarted: options?.suppressPhaseStarted,
  });

  // Handle spec amendment escalation
  if (result === 'amend_spec') {
    const nextVersion = version + 1;
    supersedEpoch(session.id, version, nextVersion);

    // Copy triage.md to new version dir so it carries forward
    const ticketId = session.ticket_id || 'local';
    copyTriageToNewVersion(session.worktree, ticketId, version, nextVersion);

    // Find previous spec path and amendment reason for context
    // Use path reference, not inlined content (per spec: paths, not inlined content)
    const previousSpecPath = join(session.worktree, 'spec', ticketId, `v${version}`, 'task-spec.md');
    const amendmentEvents = readLog(session.id).filter(e => e.event === 'spec_amendment:requested');
    const amendmentReason =
      amendmentEvents.length > 0
        ? (amendmentEvents[amendmentEvents.length - 1].metadata?.reason as string) ||
          'Plan writing discovered spec drift'
        : 'Plan writing discovered spec drift';

    // Emit phase1:started with required metadata for new epoch
    // (machine.ts won't emit because hasCompletedWork=false with forceStartState)
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'phase1:started',
      version: nextVersion,
      metadata: {
        previousVersion: version,
        reason: amendmentReason,
      },
    });

    // Re-run phase 1 starting from write_spec with new version and amendment context
    return runPhase1(session, config, {
      versionOverride: nextVersion,
      forceStartState: 'write_spec',
      suppressPhaseStarted: true,
      specAmendmentContext: existsSync(previousSpecPath)
        ? {
            previousSpecPath,
            reason: amendmentReason,
            previousVersion: version,
          }
        : undefined,
    });
  }

  return result;
}
