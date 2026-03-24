import type { Verdict } from '../types';

// ============================================================================
// Pure: check reviewer agreement
// ============================================================================

export interface VerdictResult {
  reviewerIndex: number;
  verdict: Verdict;
  binary?: string;
  phase?: number; // 0-indexed review phase
  error?: string; // "timeout", "no_verdict", "exit_code_N"
}

export interface ConsensusResult {
  approved: boolean;
  rejected: boolean;
  incomplete: boolean;
  partial: boolean; // early phases rejected, later phases not run
  approvedCount: number;
  rejectedCount: number;
  totalReviewers: number;
  totalPhases: number;
  completedPhases: number;
}

/**
 * Check if all reviewers approve (consensus)
 * @param verdicts - flat list of verdict results from all completed phases
 * @param totalPhases - total number of review phases configured
 * @param completedPhases - number of phases that actually ran (may be fewer if short-circuited)
 */
export function checkConsensus(
  verdicts: VerdictResult[],
  totalPhases: number = 1,
  completedPhases: number = 1,
): ConsensusResult {
  const approved = verdicts.filter(v => v.verdict === 'approved');
  const rejected = verdicts.filter(v => v.verdict === 'rejected');
  const incomplete = verdicts.filter(v => v.verdict !== 'approved' && v.verdict !== 'rejected');

  return {
    approved: approved.length === verdicts.length && incomplete.length === 0,
    rejected: rejected.length > 0,
    incomplete: incomplete.length > 0,
    partial: completedPhases < totalPhases && rejected.length > 0,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
    totalReviewers: verdicts.length,
    totalPhases,
    completedPhases,
  };
}

/**
 * Check if consensus is reached (all approve)
 */
export function isConsensusReached(verdicts: VerdictResult[]): boolean {
  const result = checkConsensus(verdicts);
  return result.approved;
}

/**
 * Check if iteration should continue (not unanimous approval)
 */
export function shouldContinue(verdicts: VerdictResult[]): boolean {
  return !isConsensusReached(verdicts);
}

/**
 * Get verdict summary for display
 */
export function formatConsensusResult(result: ConsensusResult): string {
  let msg = `Approved: ${result.approvedCount}/${result.totalReviewers}, Rejected: ${result.rejectedCount}/${result.totalReviewers}`;
  if (result.totalPhases > 1) {
    msg += ` (phases ${result.completedPhases}/${result.totalPhases})`;
  }
  if (result.partial) {
    msg += ' [short-circuited]';
  }
  return msg;
}
