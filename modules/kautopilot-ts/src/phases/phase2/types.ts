import type { DeliveryKind } from '../../core/types';
import type { PhaseContext } from '../machine';

export const REWRITE_DECISIONS = [
  'refine_local',
  'patch_downstream',
  'regenerate_remaining',
  'revisit_spec',
  'retry',
] as const;

export type RewriteDecision = (typeof REWRITE_DECISIONS)[number];

export function isRewriteDecision(value: unknown): value is RewriteDecision {
  return typeof value === 'string' && REWRITE_DECISIONS.includes(value as RewriteDecision);
}

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
  /** Rewrite decision from resolve step, persisted for amend_plans handler */
  rewriteDecision?: RewriteDecision;
}

export type Phase2StateMap = Record<string, (ctx: Phase2Context) => Promise<string | null>>;
