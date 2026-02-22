import type { Config } from '../types';
import { DEFAULT_CONFIG } from '../types';

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
 * Validate config has required fields
 */
export function validateConfig(config: unknown): Config {
  if (!config || typeof config !== 'object') {
    throw new Error('Config must be an object');
  }

  const c = config as Record<string, unknown>;

  return {
    implementer: validateString(c.implementer, 'implementer', DEFAULT_CONFIG.implementer),
    reviewers: validateStringArray(c.reviewers, 'reviewers', DEFAULT_CONFIG.reviewers),
    conflictChecker: validateOptionalString(c.conflictChecker, 'conflictChecker'),
    maxIterations: validateNumber(c.maxIterations, 1, 100, 'maxIterations', DEFAULT_CONFIG.maxIterations),
    implementerTimeout: validateNumber(
      c.implementerTimeout,
      1,
      120,
      'implementerTimeout',
      DEFAULT_CONFIG.implementerTimeout,
    ),
    reviewerTimeout: validateNumber(c.reviewerTimeout, 1, 120, 'reviewerTimeout', DEFAULT_CONFIG.reviewerTimeout),
    conflictCheckThreshold: validateNumber(
      c.conflictCheckThreshold,
      1,
      100,
      'conflictCheckThreshold',
      DEFAULT_CONFIG.conflictCheckThreshold,
    ),
  };
}

function validateOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

function validateString(value: unknown, field: string, defaultValue: string): string {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return defaultValue;
  }
  return value.trim();
}

function validateStringArray(value: unknown, field: string, defaultValue: string[]): string[] {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (!Array.isArray(value)) {
    return defaultValue;
  }
  const filtered = value.filter(v => typeof v === 'string' && v.trim() !== '');
  if (filtered.length === 0) {
    return defaultValue;
  }
  return filtered.map(s => s.trim());
}

function validateNumber(value: unknown, min: number, max: number, field: string, defaultValue: number): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    return defaultValue;
  }

  return num;
}

/**
 * Merge partial config with defaults
 */
export function mergeConfig(partial: Partial<Config>): Config {
  return {
    implementer: partial.implementer ?? DEFAULT_CONFIG.implementer,
    reviewers: partial.reviewers ?? DEFAULT_CONFIG.reviewers,
    conflictChecker: partial.conflictChecker ?? DEFAULT_CONFIG.conflictChecker,
    maxIterations: partial.maxIterations ?? DEFAULT_CONFIG.maxIterations,
    implementerTimeout: partial.implementerTimeout ?? DEFAULT_CONFIG.implementerTimeout,
    reviewerTimeout: partial.reviewerTimeout ?? DEFAULT_CONFIG.reviewerTimeout,
    conflictCheckThreshold: partial.conflictCheckThreshold ?? DEFAULT_CONFIG.conflictCheckThreshold,
  };
}

/**
 * Create config from CLI options
 */
export function configFromOptions(opts: {
  implementer?: string;
  reviewers?: string[];
  conflictChecker?: string;
  maxIterations?: number;
  implementerTimeout?: number;
  reviewerTimeout?: number;
  conflictCheckThreshold?: number;
}): Config {
  const partial: Partial<Config> = {};
  if (opts.implementer) partial.implementer = opts.implementer;
  if (opts.reviewers && opts.reviewers.length > 0) partial.reviewers = opts.reviewers;
  if (opts.conflictChecker) partial.conflictChecker = opts.conflictChecker;
  if (opts.maxIterations !== undefined) partial.maxIterations = opts.maxIterations;
  if (opts.implementerTimeout !== undefined) partial.implementerTimeout = opts.implementerTimeout;
  if (opts.reviewerTimeout !== undefined) partial.reviewerTimeout = opts.reviewerTimeout;
  if (opts.conflictCheckThreshold !== undefined) partial.conflictCheckThreshold = opts.conflictCheckThreshold;
  return mergeConfig(partial);
}
