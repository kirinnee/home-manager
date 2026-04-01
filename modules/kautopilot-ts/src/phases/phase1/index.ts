import type { Phase1Context, Phase1StateMap } from './types';
import type { SessionRow, Config } from '../../core/types';
import { runStateMachine } from '../machine';
import { appendEvent } from '../../core/log';
import { ensureStatus } from '../../core/status';
import { loadSessionAgents } from '../../core/agents';
import { runScript } from '../../core/scripts';
import { handlePullTicket } from './pull-ticket';
import { handleRouteType } from './route-type';
import { handleWriteSpec } from './write-spec';
import { handleFinalizeSpec } from './finalize-spec';
import { handleWritePlans } from './write-plans';
import { handleFinalizePlans } from './finalize-plans';

// Re-export shared utilities for external use
export { discoverPlans } from '../shared';

// State map for Phase 1
const phase1States: Phase1StateMap = {
  pull_ticket: handlePullTicket,
  route_type: handleRouteType,
  write_spec: handleWriteSpec,
  finalize_spec: handleFinalizeSpec,
  write_plans: handleWritePlans,
  finalize_plans: handleFinalizePlans,
};

/**
 * Run Phase 1: Type-driven Planning and Specification.
 *
 * Flow:
 *   [code] pull_ticket     → fetch ticket
 *   [llm]  route_type      → classify ticket type
 *   [tty]  write_spec      → debate + spec writing (agent gathers context via team)
 *   [code] finalize_spec   → snapshot spec to artifacts
 *   [tty]  write_plans     → plan writing with code awareness
 *   [code] finalize_plans  → snapshot plans, git commit (terminal)
 */
export async function runPhase1(
  session: SessionRow,
  config: Config,
  options?: { forceStartState?: string; versionOverride?: number },
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

  // Build initial context — restore typeConfig from status on resume
  const ticketType = status.context.ticketType;
  const ctx: Phase1Context = {
    session,
    config,
    version,
    attempt: 1,
    ticketType,
    typeConfig: ticketType ? config.types[ticketType] : undefined,
  };

  // Use generic state machine runner with resume support
  return runStateMachine('phase1', phase1States, ctx, {
    terminalStates: ['finalize_plans'],
    forceStartState: options?.forceStartState,
  });
}
