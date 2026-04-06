import type { Phase3Context, Phase3StateMap } from './types';
import type { SessionRow, Config } from '../../core/types';
import type { PhaseContext } from '../machine';
import { runStateMachine } from '../machine';
import { ensureStatus } from '../../core/status';
import { loadSessionAgents } from '../../core/agents';
import { handleCommitPending } from './commit-pending';
import { handlePrereview } from './prereview';
import { handlePush } from './push';
import { handleCreatePr } from './create-pr';
import { handlePoll } from './poll';
import { handleEnsureBranch } from './ensure-branch';
import { handleEval } from './eval';
import { handleAct } from './act';
import { handleTtyResolve } from './tty-resolve';
import { handleWriteFix } from './write-fix';
import { handleRunFix } from './run-fix';
import { handleFeedbackCheck, handleFeedback } from './feedback-check';
import { handleTicketDraft } from './ticket-draft';
import { handleTicketReview } from './ticket-review';
import { handleTicketPublish } from './ticket-publish';
import { handleCompleted } from './completed';
import { handleFailed } from './failed';

// State map for Phase 3 — PR delivery path
const prStates: Phase3StateMap = {
  // Part A: Ship It
  commit_pending: handleCommitPending,
  prereview: handlePrereview,
  push: handlePush,
  create_pr: handleCreatePr,

  // Part B: Poll + Fix Loop
  poll: handlePoll,
  ensure_branch: handleEnsureBranch,
  eval: handleEval,
  act: handleAct,
  tty_resolve: handleTtyResolve,
  write_fix: handleWriteFix,
  run_fix: handleRunFix,

  // Terminal states
  feedback_check: handleFeedbackCheck,
  feedback: handleFeedback,
  completed: handleCompleted,
  failed: handleFailed,
};

// State map for Phase 3 — Ticket delivery path
const ticketStates: Phase3StateMap = {
  // Commit any pending work
  commit_pending: handleCommitPending,

  // Ticket delivery flow (spec section 11)
  ticket_draft: handleTicketDraft,
  ticket_review: handleTicketReview,
  ticket_publish: handleTicketPublish,

  // Terminal states
  completed: handleCompleted,
  failed: handleFailed,
};

/**
 * Run Phase 3: Delivery and Babysitting.
 *
 * Routes based on deliveryKind:
 * - 'pr': PR-native flow (push → create_pr → poll → eval → act → fix loop)
 * - 'ticket': Ticket delivery flow (draft → review → publish)
 */
export async function runPhase3(
  session: SessionRow,
  config: Config,
  options?: { forceStartState?: string },
): Promise<boolean | 'amend_spec'> {
  // Initialize agent resolution from session config
  loadSessionAgents(session.id);

  const status = ensureStatus(session.id);
  const version = status.version;
  const deliveryKind = (status.context.deliveryKind as 'pr' | 'ticket') ?? 'pr';

  const ctx: Phase3Context = {
    session,
    config,
    version,
    attempt: status.context.attempt ?? 1,
    ticketId: session.ticket_id || 'unknown',
    deliveryKind,
    prNumber: (status.context.prNumber as number) ?? null,
    prUrl: (status.context.prUrl as string) ?? null,
    baseBranch: config.repo.baseBranch,
    pushCycle: (status.context.pushCycle as number) ?? 0,
    mergePolicy: null,
    deferredActions: [],
    forceWithLease: false,
  };

  // Select state map based on delivery kind
  const states = deliveryKind === 'ticket' ? ticketStates : prStates;

  // Use generic state machine runner with resume support
  return runStateMachine(
    'phase3',
    states as unknown as Record<string, (ctx: PhaseContext) => Promise<string | null>>,
    ctx,
    {
      terminalStates: ['completed', 'failed'],
      forceStartState: options?.forceStartState,
    },
  );
}
