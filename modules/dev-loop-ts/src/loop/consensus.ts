import type { Verdict } from '../types';

// ============================================================================
// Pure: check reviewer agreement
// ============================================================================

export interface VerdictResult {
  reviewerIndex: number;
  verdict: Verdict;
  binary?: string;
}

export interface ConsensusResult {
  approved: boolean;
  rejected: boolean;
  incomplete: boolean;
  approvedCount: number;
  rejectedCount: number;
  totalReviewers: number;
}

/**
 * Check if all reviewers approve (consensus)
 */
export function checkConsensus(verdicts: VerdictResult[]): ConsensusResult {
  const approved = verdicts.filter(v => v.verdict === 'approved');
  const rejected = verdicts.filter(v => v.verdict === 'rejected');
  const incomplete = verdicts.filter(v => v.verdict !== 'approved' && v.verdict !== 'rejected');

  return {
    approved: approved.length === verdicts.length && incomplete.length === 0,
    rejected: rejected.length > 0,
    incomplete: incomplete.length > 0,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
    totalReviewers: verdicts.length,
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
  return `Approved: ${result.approvedCount}/${result.totalReviewers}, Rejected: ${result.rejectedCount}/${result.totalReviewers}`;
}
