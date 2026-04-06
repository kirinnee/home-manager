import type { Config, SessionRow, Phase } from '../core/types';
import { appendEvent } from '../core/log';
import { runPhase1 } from './phase1';
import { runPhase2 } from './phase2';
import { runPhase3 } from './phase3';

const PHASE_TO_MACHINE_NAME: Record<string, string> = {
  plan: 'phase1',
  implementation: 'phase2',
  polish: 'phase3',
};

export async function runPhase(
  phase: Phase,
  session: SessionRow,
  config: Config,
  options?: { forceStartState?: string; versionOverride?: number },
): Promise<boolean | 'amend_spec'> {
  try {
    switch (phase) {
      case 'plan':
        return await runPhase1(session, config, options);
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
