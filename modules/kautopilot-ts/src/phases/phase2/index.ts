import type { Phase2Context, Phase2StateMap } from './types';
import type { SessionRow, Config } from '../../core/types';
import { runStateMachine } from '../machine';
import { ensureStatus } from '../../core/status';
import { resolvePlans } from '../shared';
import { loadSessionAgents } from '../../core/agents';
import { handleClearLoop } from './clear-loop';
import { handleSetupRun } from './setup-run';
import { handleRunning } from './running';
import { handleResolve } from './resolve';
import { handleRewriteSpec } from './rewrite-spec';
import { handleCommit } from './commit';
import { handleNextPlan } from './next-plan';
import { handleCompleted } from './completed';
import { handleFailed } from './failed';

// State map for Phase 2
const phase2States: Phase2StateMap = {
  clear_loop: handleClearLoop,
  setup_run: handleSetupRun,
  running: handleRunning,
  resolve: handleResolve,
  rewrite_spec: handleRewriteSpec,
  commit: handleCommit,
  next_plan: handleNextPlan,
  completed: handleCompleted,
  failed: handleFailed,
};

/**
 * Run Phase 2: Implementation.
 *
 * Executes each sub-plan through dev-loop. For each plan:
 * prepare spec, run dev-loop, handle conflicts/iterations, commit.
 */
export async function runPhase2(
  session: SessionRow,
  config: Config,
  options?: { forceStartState?: string },
): Promise<boolean | 'amend_spec'> {
  // Initialize agent resolution from session config
  loadSessionAgents(session.id);

  const status = ensureStatus(session.id);
  const version = status.version;

  // Discover plan files from session artifacts
  const planFiles = resolvePlans(session.id, version);
  const maxPlans = planFiles.length;

  if (maxPlans === 0) {
    throw new Error('No plan files found. Run Phase 1 first.');
  }

  // Determine plan progress from status
  const planIndex = status.context.planIndex ?? 0;
  const firstRun = status.completedPlans.length === 0 && status.completedSteps.length === 0;

  // Build initial context
  const ctx: Phase2Context = {
    session,
    config,
    version,
    attempt: status.context.attempt ?? 1,
    ticketId: session.ticket_id || 'unknown',
    deliveryKind: (status.context.deliveryKind as 'pr' | 'ticket') ?? 'pr',
    planIndex,
    maxPlans,
    firstRun,
  };

  // Use generic state machine runner with resume support
  return runStateMachine(
    'phase2',
    phase2States as unknown as Record<string, (ctx: import('../machine').PhaseContext) => Promise<string | null>>,
    ctx,
    {
      terminalStates: ['completed', 'failed'],
      forceStartState: options?.forceStartState,
    },
  );
}
