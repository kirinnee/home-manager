import type { Config } from '../types';
import { DEFAULT_CONFIG, parseRawConfig, getImplementerBinaries, getAllReviewers } from '../types';

// ============================================================================
// Pure: Config schema/defaults
// ============================================================================

/**
 * Default configuration values
 */
export function getDefaultConfig(): Config {
  return { ...DEFAULT_CONFIG };
}

/**
 * Validate config has required fields with backwards compatibility
 */
export function validateConfig(config: unknown): Config {
  if (!config || typeof config !== 'object') {
    throw new Error('Config must be an object');
  }

  return parseRawConfig(config);
}

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

  return parseRawConfig(raw);
}

/**
 * Create config from CLI options
 * Returns a partial raw object (only explicitly-provided fields)
 */
export function configFromOptions(opts: {
  implementer?: string;
  implementers?: string; // "a:8,b:2" format
  reviewers?: string[];
  reviewPhases?: string; // "a,b|c" format
  conflictChecker?: string;
  maxIterations?: number;
  implementerTimeout?: number;
  reviewerTimeout?: number;
  conflictCheckThreshold?: number;
  firstLoopFullReview?: boolean;
  previousReviewPropagation?: number;
  reviewerFailureLimit?: number;
}): Record<string, unknown> {
  const partial: Record<string, unknown> = {};

  // Handle implementers option: "claude-impl-zai:8,claude-impl-kimi:2"
  if (opts.implementers) {
    const entries = opts.implementers
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    const implementers: Record<string, number> = {};
    for (const entry of entries) {
      const colonIndex = entry.indexOf(':');
      if (colonIndex > 0) {
        const name = entry.slice(0, colonIndex).trim();
        const weight = parseInt(entry.slice(colonIndex + 1), 10);
        if (name && weight > 0) {
          implementers[name] = weight;
        }
      } else {
        implementers[entry] = 1;
      }
    }
    if (Object.keys(implementers).length > 0) {
      partial.implementers = implementers;
    }
  }

  // Handle singular implementer option — convert to implementers directly
  if (opts.implementer) {
    if (!partial.implementers) {
      partial.implementers = { [opts.implementer]: 1 };
    } else if (!(opts.implementer in partial.implementers)) {
      partial.implementers[opts.implementer] = 1;
    }
  }

  // Handle review phases option: "a,b|c" → [["a","b"],["c"]]
  if (opts.reviewPhases) {
    const phases = opts.reviewPhases
      .split('|')
      .map(phase => {
        return phase
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0);
      })
      .filter(phase => phase.length > 0);
    if (phases.length > 0) {
      partial.reviewPhases = phases;
    }
  }

  // Handle flat reviewers option
  if (opts.reviewers && opts.reviewers.length > 0) {
    partial.reviewers = opts.reviewers;
  }

  if (opts.conflictChecker) partial.conflictChecker = opts.conflictChecker;
  if (opts.maxIterations !== undefined) partial.maxIterations = opts.maxIterations;
  if (opts.implementerTimeout !== undefined) partial.implementerTimeout = opts.implementerTimeout;
  if (opts.reviewerTimeout !== undefined) partial.reviewerTimeout = opts.reviewerTimeout;
  if (opts.conflictCheckThreshold !== undefined) partial.conflictCheckThreshold = opts.conflictCheckThreshold;
  if (opts.firstLoopFullReview !== undefined) partial.firstLoopFullReview = opts.firstLoopFullReview;
  if (opts.previousReviewPropagation !== undefined) partial.previousReviewPropagation = opts.previousReviewPropagation;
  if (opts.reviewerFailureLimit !== undefined) partial.reviewerFailureLimit = opts.reviewerFailureLimit;

  return partial;
}

// Helper: format config for display
export function formatConfigDisplay(config: Config): string {
  const lines: string[] = [];
  // Implementers
  const implEntries = Object.entries(config.implementers);
  if (implEntries.length === 1) {
    lines.push(
      `  Implementer: ${implEntries[0][0]}${implEntries[0][1] !== 1 ? ` (weight: ${implEntries[0][1]})` : ''}`,
    );
  } else {
    lines.push(`  Implementers:`);
    for (const [binary, weight] of implEntries) {
      lines.push(`    ${binary} (weight: ${weight})`);
    }
  }

  // Review phases
  if (config.reviewPhases.length === 1) {
    lines.push(`  Reviewers: ${config.reviewPhases[0].join(', ')}`);
  } else {
    lines.push(`  Review Phases:`);
    for (let i = 0; i < config.reviewPhases.length; i++) {
      lines.push(`    Phase ${i}: ${config.reviewPhases[i].join(', ')}`);
    }
  }

  if (config.conflictChecker) {
    lines.push(`  Conflict checker: ${config.conflictChecker}`);
  }
  lines.push(`  Max iterations: ${config.maxIterations}`);
  lines.push(`  Implementer timeout: ${config.implementerTimeout}m`);
  lines.push(`  Reviewer timeout: ${config.reviewerTimeout}m`);
  lines.push(`  Conflict check threshold: ${config.conflictCheckThreshold} failures`);
  if (config.firstLoopFullReview) {
    lines.push(`  First loop full review: yes (all phases run, no short-circuit)`);
  }
  lines.push(`  Previous review propagation: ${(config.previousReviewPropagation * 100).toFixed(0)}%`);
  lines.push(`  Reviewer failure limit: ${config.reviewerFailureLimit} consecutive failures per reviewer`);
  return lines.join('\n');
}
