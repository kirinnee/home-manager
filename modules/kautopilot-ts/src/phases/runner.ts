import { appendEvent } from '../core/log';
import type { Config, Phase, SessionRow } from '../core/types';
import { runPhase1 } from './phase1';
import { runPhase2 } from './phase2';
import { runPhase3 } from './phase3';

const PHASE_TO_MACHINE_NAME: Record<string, string> = {
  plan: 'phase1',
  implementation: 'phase2',
  polish: 'phase3',
};

export type PhaseResult = boolean | 'amend_spec' | 'revisit_spec';

export async function runPhase(
  phase: Phase,
  session: SessionRow,
  config: Config,
  options?: {
    forceStartState?: string;
    versionOverride?: number;
    suppressPhaseStarted?: boolean;
  },
): Promise<PhaseResult> {
  try {
    switch (phase) {
      case 'plan':
        return await runPhase1(session, config, {
          forceStartState: options?.forceStartState,
          versionOverride: options?.versionOverride,
          suppressPhaseStarted: options?.suppressPhaseStarted,
        });
      case 'implementation':
        return await runPhase2(session, config, options);
      case 'polish':
        return await runPhase3(session, config, options);
    }
  } catch (err) {
    const machineName = PHASE_TO_MACHINE_NAME[phase];
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: `${machineName}:error`,
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
