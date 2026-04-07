import type { MergePolicyInfo } from '../../core/github';
import type { DeliveryKind, PollThread } from '../../core/types';
import type { PhaseContext } from '../machine';

export type { PollThread };

// ============================================================================
// Phase 3 Context
// ============================================================================

export interface Phase3Context extends PhaseContext {
  ticketId: string;
  deliveryKind: DeliveryKind;
  prNumber: number | null;
  prUrl: string | null;
  baseBranch: string;
  pushCycle: number;
  mergePolicy: MergePolicyInfo | null;
  /** Items deferred until after push (e.g., replies referencing commit SHA) */
  deferredActions: DeferredAction[];
  /** Whether push should use --force-with-lease (e.g., after rebase) */
  forceWithLease: boolean;
  /** Reason for tty_resolve invocation */
  ttyReason?: 'ambiguous_eval' | 'run_fix_failure' | 'merge_conflict';
  /** Eval results stored by eval handler for act handler to consume */
  evalResults?: EvalResult[];
  /** TTY resolve items for tty_resolve handler */
  ttyResolveItems?: TtyResolveItem[];
  /** kloop run ID for the current fix execution */
  kloopRunId?: string;
}

// ============================================================================
// Deferred actions (post-push replies)
// ============================================================================

export interface DeferredAction {
  type: 'reply_thread' | 'reply_comment' | 'resolve' | 'react';
  threadId?: string;
  commentId?: string;
  body?: string;
  reaction?: string;
}

// ============================================================================
// State map
// ============================================================================

export type Phase3StateMap = Record<string, (ctx: Phase3Context) => Promise<string | null>>;

// ============================================================================
// Eval result (from LLM fan-out)
// ============================================================================

export interface EvalResult {
  unitId: string;
  unitType: 'ci_failure' | 'thread' | 'pr_comment';
  verdict: 'reply' | 'resolve' | 'code_fix';
  reply?: string;
  codeFix?: string;
  resolveThread?: boolean;
  reactThumbsUp?: boolean;
  ambiguous?: boolean;
  ambiguousReason?: string;
}

// ============================================================================
// Eval unit (input to LLM eval)
// ============================================================================

export interface EvalUnit {
  id: string;
  type: 'ci_failure' | 'thread' | 'pr_comment';
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Pre-filter categories
// ============================================================================

export type PreFilterCategory = 'outdated' | 'ghosted' | 'pending' | 'needs_eval';

export interface PreFilterResult {
  category: PreFilterCategory;
  threadId: string;
  reason: string;
  templateReply?: string;
}

// ============================================================================
// Poll signals
// ============================================================================

export interface PollSignals {
  prState: string;
  mergeable: boolean;
  mergeStateStatus: string;
  checks: Array<{ name: string; status: string }>;
  threads: number;
  unresolvedThreads: number;
  reviews: Array<{ author: string; state: string }>;
  crStatus?: 'passing' | 'failing' | 'running' | 'none';
  prComments: number;
  changesRequested: boolean;
  approvals: number;
  prAge?: number; // age in hours
}

// ============================================================================
// PR Rollover
// ============================================================================

export interface RolloverRecommendation {
  shouldRollover: boolean;
  reason?: string;
  signals: {
    unresolvedThreads: number;
    totalComments: number;
    pushCycles: number;
    prAgeHours: number;
  };
}

// ============================================================================
// TTY resolve input
// ============================================================================

export interface TtyResolveItem {
  id: string;
  type: string;
  title: string;
  reasoning: string;
  ambiguityReason?: string;
}
