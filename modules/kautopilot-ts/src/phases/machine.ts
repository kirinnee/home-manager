import { appendEvent } from '../core/log';
import { ensureStatus } from '../core/status';
import type { Config, LogEntry, SessionRow } from '../core/types';
import { logDim, stateIcon } from '../util/format';

export interface PhaseContext {
  session: SessionRow;
  config: Config;
  version: number;
  attempt: number;
}

export type StateHandler = (ctx: PhaseContext) => Promise<string | null>;
export type StateMap = Record<string, StateHandler>;

/**
 * Find the last event matching a pattern.
 * Kept as helper for callers that still need raw log access.
 */
export function findLastEvent(log: LogEntry[], eventPattern: string): LogEntry | undefined {
  return log.filter(e => e.event.startsWith(eventPattern)).pop();
}

/**
 * Run a state machine for a given phase.
 *
 * Resume logic (via WAL-materialized status.yaml):
 * - If status shows a running state in this phase → resume from there
 * - Otherwise find first state not in completedSteps
 * - Force-start overrides everything
 */
/**
 * Run a state machine for a given phase.
 * Returns true if the phase completed, false if interrupted.
 */
export async function runStateMachine(
  phaseName: string,
  states: StateMap,
  ctx: PhaseContext,
  options?: {
    terminalStates?: string[];
    forceStartState?: string;
    suppressPhaseStarted?: boolean;
  },
): Promise<boolean | 'amend_spec' | 'revisit_spec'> {
  const { session, version } = ctx;
  const terminalStates = options?.terminalStates ?? [];

  // Materialize status from WAL BEFORE emitting phase:started
  // (phase:started resets completedSteps in the reducer — must read first for resume)
  const status = ensureStatus(session.id);

  // Determine starting state
  let currentState: string | null = null;

  if (options?.forceStartState) {
    const stateName = options.forceStartState;
    if (!(stateName in states)) {
      throw new Error(`Invalid force-start state: ${stateName}. Valid states: ${Object.keys(states).join(', ')}`);
    }
    currentState = stateName;
    logDim(`[${phaseName}] Force-starting at state: ${currentState}`);
  } else if (status.stateStatus === 'running' && status.state in states) {
    // Resume from incomplete state (status says it was running when we last checked)
    currentState = status.state;
    logDim(`[${phaseName}] Resuming from incomplete state: ${currentState}`);
  } else {
    // Find first non-completed, non-terminal state
    for (const name of Object.keys(states)) {
      if (terminalStates.includes(name)) continue;
      if (!status.completedSteps.includes(name)) {
        currentState = name;
        break;
      }
    }
  }

  if (!currentState) {
    logDim(`[${phaseName}] All states completed`);
    return true;
  }

  // Only emit phase:started for fresh starts — not resumes.
  // Check if any of THIS phase's states have been completed.
  const hasCompletedWork = Object.keys(states).some(s => status.completedSteps.includes(s));
  // Skip emission if caller already emitted with proper metadata (e.g., revisit_spec or amend_spec)
  if (!hasCompletedWork && !options?.suppressPhaseStarted) {
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: `${phaseName}:started`,
      version,
    });
  }

  // Main state machine loop
  let interrupted = false;
  while (currentState !== null) {
    const handler: StateHandler = states[currentState];
    if (!handler) {
      throw new Error(`No handler for state: ${currentState}`);
    }

    logDim(`${stateIcon(currentState)} [${phaseName}] ${currentState}`);

    // Execute the state handler
    // Note: handlers emit their own :started/:completed events to the WAL.
    const nextState: string | null = await handler(ctx);

    // Handler returned null — interrupted (e.g. spec not approved, user Ctrl+C)
    if (nextState === null) {
      interrupted = true;
      break;
    }

    // Handler returned 'amend_spec' — spec amendment escalation (phase 1 only)
    if (nextState === 'amend_spec') {
      return 'amend_spec';
    }

    // Handler returned 'revisit_spec' — cross-phase reset to phase1 with feedback
    if (nextState === 'revisit_spec') {
      return 'revisit_spec';
    }

    // Check if we're entering a terminal state
    // (handlers can return a non-terminal state to escape a terminal state, e.g. retry)
    if (terminalStates.includes(nextState)) {
      logDim(`[${phaseName}] Reached terminal state: ${nextState}`);
      break;
    }

    // Advance to next state
    currentState = nextState;
  }

  // Only emit phase:completed if we actually finished all states
  if (!interrupted) {
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: `${phaseName}:completed`,
      version,
    });
  }

  return !interrupted;
}
