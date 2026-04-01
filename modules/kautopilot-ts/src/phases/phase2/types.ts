import type { PhaseContext } from '../machine';
import type { DeliveryKind, RewriteDecision } from '../../core/types';

export interface Phase2Context extends PhaseContext {
  ticketId: string;
  deliveryKind: DeliveryKind;
  attempt: number;
  planIndex: number;
  maxPlans: number;
  firstRun: boolean;
  /** kloop run ID for the current plan execution */
  kloopRunId?: string;
  /** Last rewrite decision for audit trail */
  lastRewriteDecision?: RewriteDecision;
  /** Crash retry count for current plan */
  crashRetryCount?: number;
}

export type Phase2StateMap = Record<string, (ctx: Phase2Context) => Promise<string | null>>;
