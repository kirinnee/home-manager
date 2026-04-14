import { ensureInitStatus, updateInitUserTurn } from '../../core/init-status';
import type { InitState } from '../../core/init-types';
import { appendInitEvent } from '../../core/log';
import { setTurnUpdater } from '../../llm/inquirer';
import { logDim, stateIcon } from '../../util/format';
import type { InitContext } from './states';
import { INIT_STATES, INIT_TERMINAL_STATES } from './states';

/**
 * Run the init state machine.
 *
 * Uses the same WAL/status pattern as the runtime phase machine:
 * - Materializes status from WAL before starting
 * - Resumes from last incomplete state
 * - Each state emits :started/:completed events
 *
 * Returns true if init completed (reached a terminal state), false if interrupted.
 */
export async function runInitStateMachine(ctx: InitContext): Promise<boolean> {
  const { initId } = ctx;

  // Wire turn updater so inquirer prompts set userTurn in init status.yaml
  setTurnUpdater(ut => updateInitUserTurn(initId, ut));

  try {
    // Materialize status from WAL for resume
    const status = ensureInitStatus(initId);

    // Determine starting state
    let currentState: InitState | null = null;

    if (status.stateStatus === 'running' && status.state in INIT_STATES) {
      // Resume from incomplete state
      currentState = status.state;
      logDim(`[init] Resuming from incomplete state: ${currentState}`);
    } else {
      // Find first non-completed, non-terminal state
      const stateNames = Object.keys(INIT_STATES) as InitState[];
      for (const name of stateNames) {
        if (INIT_TERMINAL_STATES.includes(name)) continue;
        if (!status.completedStates.includes(name)) {
          currentState = name;
          break;
        }
      }
    }

    if (!currentState) {
      logDim('[init] All states completed');
      return true;
    }

    // Emit init:started for fresh starts
    const hasCompletedWork = status.completedStates.length > 0;
    if (!hasCompletedWork) {
      appendInitEvent(initId, {
        ts: new Date().toISOString(),
        event: 'init:started',
        metadata: { pid: process.pid },
      });
    }

    // Main state machine loop
    let interrupted = false;
    while (currentState !== null) {
      const handler = INIT_STATES[currentState];
      if (!handler) {
        throw new Error(`No handler for init state: ${currentState}`);
      }

      logDim(`${stateIcon(currentState)} [init] ${currentState}`);

      const nextState = await handler(ctx);

      // Check if we've reached a terminal state
      if (INIT_TERMINAL_STATES.includes(currentState)) {
        logDim(`[init] Reached terminal state: ${currentState}`);
        break;
      }

      // Handler returned null — interrupted
      if (nextState === null) {
        interrupted = true;
        break;
      }

      currentState = nextState as InitState;
    }

    // Emit init:completed if not interrupted and reached terminal
    if (!interrupted) {
      appendInitEvent(initId, {
        ts: new Date().toISOString(),
        event: 'init:completed',
        metadata: { finalState: currentState },
      });
    }

    return !interrupted;
  } finally {
    setTurnUpdater(null);
  }
}
