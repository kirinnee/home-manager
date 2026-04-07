import type { DeliveryKind } from '../../core/types';
import type { PhaseContext } from '../machine';

export interface Phase2Context extends PhaseContext {
  ticketId: string;
  deliveryKind: DeliveryKind;
  attempt: number;
  planIndex: number;
  maxPlans: number;
  firstRun: boolean;
  /** kloop run ID for the current plan execution */
  kloopRunId?: string;
  /** Crash retry count for current plan */
  crashRetryCount?: number;
}

export type Phase2StateMap = Record<string, (ctx: Phase2Context) => Promise<string | null>>;
