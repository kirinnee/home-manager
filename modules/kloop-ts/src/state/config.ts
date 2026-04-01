import type { Config } from '../types';
import { parseRawConfig } from '../types';

// ============================================================================
// Pure: Config merge (used by StateService.initConfig)
// ============================================================================

/**
 * Merge partial config with defaults
 */
export function mergeConfig(partial: Record<string, unknown>, existing?: Config): Config {
  const raw: Record<string, unknown> = {};

  // Start from existing config if provided (for re-init)
  if (existing) {
    raw.implementers = existing.implementers;
    raw.reviewPhases = existing.reviewPhases;
    raw.conflictChecker = existing.conflictChecker;
    raw.maxIterations = existing.maxIterations;
    raw.implementerTimeout = existing.implementerTimeout;
    raw.reviewerTimeout = existing.reviewerTimeout;
    raw.conflictCheckThreshold = existing.conflictCheckThreshold;
    raw.reviewerFailureLimit = existing.reviewerFailureLimit;
  }

  // Override with explicit partial values
  if (partial.implementers) raw.implementers = partial.implementers;
  if (partial.implementer) raw.implementer = partial.implementer;

  if (partial.reviewPhases) {
    raw.reviewPhases = partial.reviewPhases;
    delete raw.reviewers; // Ensure reviewers doesn't interfere
  }
  if (partial.reviewers) {
    raw.reviewers = partial.reviewers;
    delete raw.reviewPhases; // Ensure old reviewPhases doesn't interfere
  }

  if (partial.conflictChecker !== undefined) raw.conflictChecker = partial.conflictChecker;
  if (partial.maxIterations !== undefined) raw.maxIterations = partial.maxIterations;
  if (partial.implementerTimeout !== undefined) raw.implementerTimeout = partial.implementerTimeout;
  if (partial.reviewerTimeout !== undefined) raw.reviewerTimeout = partial.reviewerTimeout;
  if (partial.conflictCheckThreshold !== undefined) raw.conflictCheckThreshold = partial.conflictCheckThreshold;
  if (partial.firstLoopFullReview !== undefined) raw.firstLoopFullReview = partial.firstLoopFullReview;
  if (partial.previousReviewPropagation !== undefined)
    raw.previousReviewPropagation = partial.previousReviewPropagation;
  if (partial.reviewerFailureLimit !== undefined) raw.reviewerFailureLimit = partial.reviewerFailureLimit;
  if (partial.prompts) raw.prompts = partial.prompts;

  return parseRawConfig(raw);
}
