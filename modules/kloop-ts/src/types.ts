import { z } from 'zod';

// ============================================================================
// Zod Schemas (for validation and type inference)
// ============================================================================

// Metric sample recorded after each segment
export const metricSampleSchema = z.object({
  labels: z.record(z.string(), z.string()),
  durationMs: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

export type MetricSample = z.infer<typeof metricSampleSchema>;

// Implementer retry config
const implementerRetrySchema = z.object({
  maxRetries: z.number().min(0).max(10).default(2),
  backoffBaseMs: z.number().min(0).default(5000),
});

// Backward compat: old nested shapes accepted as input aliases
const legacyReReviewSchema = z.object({
  enabled: z.boolean().optional(),
  phases: z.array(z.array(z.string().min(1)).min(1)).optional(),
  timeout: z.number().min(0.001).max(120).optional(),
});
const legacySynthesisSchema = z.object({
  enabled: z.boolean().optional(),
});

const configSchema = z
  .object({
    // Binary names — new format: weighted implementers
    implementers: z.record(z.string(), z.number().int().positive()).optional(),
    // Backwards compat: singular implementer
    implementer: z.string().min(1).optional(),
    // Review phases — new format: array of arrays
    reviewPhases: z.array(z.array(z.string().min(1)).min(1)).optional(),
    // Backwards compat: flat reviewers array
    reviewers: z.array(z.string().min(1)).optional(),
    conflictChecker: z.string().min(1).optional(), // defaults to implementer binary
    synthesizer: z.string().min(1).optional(), // defaults to first implementer binary
    // Counts and limits
    maxIterations: z.number().min(1).max(100).default(7),
    implementerTimeout: z.number().min(0.001).max(120).default(30),
    reviewerTimeout: z.number().min(0.001).max(120).default(15),
    // Conflict detection
    conflictCheckThreshold: z.number().min(1).max(100).default(3),
    // Checkpoint behavior
    compressSpec: z.boolean().default(false),
    // Review behavior
    firstLoopFullReview: z.boolean().default(true),
    previousReviewPropagation: z.number().min(0).max(1).default(0.7),
    // Synthesis and verify (flat booleans + timeouts)
    synthesis: z.union([z.boolean(), legacySynthesisSchema]).default(true),
    synthesisTimeout: z.number().min(0.001).max(120).optional(),
    verify: z.boolean().optional(),
    verifyPhases: z.array(z.array(z.string().min(1)).min(1)).optional(),
    verifyTimeout: z.number().min(0.001).max(120).optional(),
    rerankAfterCheckpoint: z.boolean().default(true),
    snapshot: z.boolean().default(false),
    implementerRetry: implementerRetrySchema.optional(),
    firstIterationWeightMultiplier: z.number().min(1).max(1000).default(2),
    // Backward compat: old nested reReview shape
    reReview: legacyReReviewSchema.optional(),
    // Agent prompt overrides
    prompts: z
      .object({
        implementer: z.string().optional(),
        reviewer: z.string().optional(),
        checkpointer: z.string().optional(),
        checkpointerFull: z.string().optional(),
        synthesizer: z.string().optional(),
        verifier: z.string().optional(),
        reReviewer: z.string().optional(), // backward compat alias
        reSynthesizer: z.string().optional(),
      })
      .optional(),
  })
  .transform(data => {
    // Backwards compatibility: implementer (string) → implementers (Record)
    let implementers = data.implementers;
    if (!implementers && data.implementer) {
      implementers = { [data.implementer]: 1 };
    } else if (data.implementer && implementers && !(data.implementer in implementers)) {
      // If both present, merge implementer into implementers if not already there
      implementers = { ...implementers, [data.implementer]: 1 };
    }
    if (!implementers) {
      implementers = { claude: 1 };
    }

    // Backwards compatibility: reviewers (flat array) → reviewPhases (array of arrays)
    let reviewPhases = data.reviewPhases;
    if (!reviewPhases && data.reviewers && data.reviewers.length > 0) {
      reviewPhases = [data.reviewers];
    }
    if (!reviewPhases) {
      reviewPhases = [['claude:claude']];
    }

    // Resolve synthesis: accept bool or old { enabled } shape
    const synthRaw = data.synthesis;
    const synthesis = typeof synthRaw === 'boolean' ? synthRaw : (synthRaw?.enabled ?? true);

    // Resolve verify: accept flat fields or old reReview shape
    const verify = data.verify ?? data.reReview?.enabled ?? true;
    const verifyPhases = data.verifyPhases ?? data.reReview?.phases ?? [['claude:claude']];
    const verifyTimeout = data.verifyTimeout ?? data.reReview?.timeout ?? 5;
    const synthesisTimeout = data.synthesisTimeout ?? 15;

    // Resolve prompts: accept verifier or old reReviewer alias
    const prompts = data.prompts
      ? {
          ...data.prompts,
          verifier: data.prompts.verifier ?? data.prompts.reReviewer,
        }
      : data.prompts;

    return {
      implementers,
      reviewPhases,
      conflictChecker: data.conflictChecker,
      synthesizer: data.synthesizer ?? Object.keys(implementers)[0],
      maxIterations: data.maxIterations,
      implementerTimeout: data.implementerTimeout,
      reviewerTimeout: data.reviewerTimeout,
      synthesisTimeout,
      conflictCheckThreshold: data.conflictCheckThreshold,
      compressSpec: data.compressSpec,
      firstLoopFullReview: data.firstLoopFullReview,
      previousReviewPropagation: data.previousReviewPropagation,
      synthesis,
      verify,
      verifyPhases,
      verifyTimeout,
      rerankAfterCheckpoint: data.rerankAfterCheckpoint ?? true,
      snapshot: data.snapshot ?? false,
      implementerRetry: data.implementerRetry ?? { maxRetries: 2, backoffBaseMs: 5000 },
      firstIterationWeightMultiplier: data.firstIterationWeightMultiplier ?? 2,
      prompts,
    };
  });

export const resolvedConfigSchema = z.object({
  implementers: z.record(z.string(), z.number().int().positive()),
  reviewPhases: z.array(z.array(z.string().min(1))).min(1),
  conflictChecker: z.string().min(1).optional(),
  synthesizer: z.string().min(1).optional(),
  maxIterations: z.number().min(1).max(100),
  implementerTimeout: z.number().min(0.001).max(120),
  reviewerTimeout: z.number().min(0.001).max(120),
  synthesisTimeout: z.number().min(0.001).max(120),
  verifyTimeout: z.number().min(0.001).max(120),
  conflictCheckThreshold: z.number().min(1).max(100),
  compressSpec: z.boolean(),
  firstLoopFullReview: z.boolean(),
  previousReviewPropagation: z.number().min(0).max(1),
  synthesis: z.boolean(),
  verify: z.boolean(),
  verifyPhases: z.array(z.array(z.string().min(1)).min(1)),
  rerankAfterCheckpoint: z.boolean(),
  snapshot: z.boolean(),
  implementerRetry: z.object({
    maxRetries: z.number().min(0).max(10),
    backoffBaseMs: z.number().min(0),
  }),
  firstIterationWeightMultiplier: z.number().min(1).max(1000),
  prompts: z
    .object({
      implementer: z.string().optional(),
      reviewer: z.string().optional(),
      checkpointer: z.string().optional(),
      checkpointerFull: z.string().optional(),
      synthesizer: z.string().optional(),
      verifier: z.string().optional(),
      reSynthesizer: z.string().optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof resolvedConfigSchema>;

const runStatusSchema = z.enum(['running', 'completed', 'cancelled', 'failed', 'conflict']);
export const phaseSchema = z.enum(['implementing', 'reviewing', 'done']);
const agentRoleSchema = z.enum(['implementer', 'reviewer', 'checkpointer']);
export const verdictSchema = z.enum(['approved', 'rejected']);

// Run state stored in .kagent/current/run.json
export const runSchema = z.object({
  id: z.string().min(1), // run ID (short UUID)
  spec: z.string(), // spec file path
  status: runStatusSchema,
  iteration: z.number().int().nonnegative(), // starts at 0
  phase: phaseSchema,
  startedAt: z.string().datetime(), // ISO date
  learnings: z.array(z.string()).default([]),
  consecutiveFailures: z.number().int().nonnegative().default(0),
});

export type Phase = z.infer<typeof phaseSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type Run = z.infer<typeof runSchema>;

// Verdict file: loop-{L}/reviewer-{R}/verdict.json
export const verdictFileSchema = z.object({
  approved: z.boolean(),
  reasoning: z.string(),
  completionEstimate: z.number().int().min(0).max(100).optional(),
});

export type VerdictFile = z.infer<typeof verdictFileSchema>;

// History entry stored in .kagent/history/{id}.json
const sessionSummarySchema = z.object({
  role: agentRoleSchema,
  reviewerIndex: z.number().int().nonnegative().optional(),
});

const iterationSummarySchema = z.object({
  iteration: z.number().int().positive(),
  implementerDuration: z.number().nonnegative().optional(),
  reviewerVerdicts: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      verdict: verdictSchema,
      binary: z.string().optional(), // Which binary was used (e.g., "claude-reviewer-zai")
    }),
  ),
  learnings: z.array(z.string()),
  sessions: z.array(sessionSummarySchema),
  checkpointInfo: z
    .object({
      outcome: z.enum(['conflict_found', 'spec_auto_fixed', 'spec_compressed', 'no_action']),
      summary: z.string(),
      progressPercent: z.number().optional(),
    })
    .optional(),
});

const metricsSummarySchema = z.object({
  totalDurationMs: z.number().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
});

export const historyEntrySchema = z.object({
  id: z.string().min(1), // run ID (short UUID)
  spec: z.string(),
  config: resolvedConfigSchema,
  status: runStatusSchema,
  iterations: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  summary: z.array(iterationSummarySchema),
  checkpointRan: z.boolean().optional(), // Whether checkpointer ran during this run
  metricsSummary: metricsSummarySchema.optional(),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

// Checkpoint result type - outcome of running the checkpointer agent
export const checkpointResultSchema = z.object({
  outcome: z.enum(['conflict_found', 'spec_auto_fixed', 'spec_compressed', 'no_action']),
  summary: z.string(),
  progressPercent: z.number().int().min(0).max(100).optional(),
  completedCriteria: z.array(z.string()).optional(),
  remainingCriteria: z.array(z.string()).optional(),
});

export type CheckpointResult = z.infer<typeof checkpointResultSchema>;

// ============================================================================
// Harness Types (Claude vs Gemini)
// ============================================================================

export type HarnessType = 'claude' | 'gemini' | 'codex';

/**
 * Parsed binary config for implementers and conflict checker.
 * Format: binary:harness (e.g., "gemini-auto:gemini")
 * Optional ::i suffix marks as preferred for loop 1.
 */
export interface ParsedBinary {
  binary: string;
  harness: HarnessType;
  firstIterationPreferred: boolean;
}

/**
 * Parsed binary config for reviewers (which have an additional noVerdictAsFailure flag).
 * Format: binary:harness:flag (e.g., "gemini-auto:gemini:0" or "gemini-auto:gemini:1")
 */
export interface ReviewerBinary extends ParsedBinary {
  noVerdictAsFailure: boolean;
}

/**
 * Validate a harness type string.
 * @throws if the harness value is not 'claude', 'gemini', or 'codex'
 */
function parseHarness(value: string, fallback = false): HarnessType {
  if (value === 'claude' || value === 'gemini' || value === 'codex') {
    return value;
  }
  if (fallback) return 'claude';
  throw new Error(`Invalid harness type: "${value}". Must be "claude", "gemini", or "codex".`);
}

/**
 * Parse an implementer or conflictChecker config entry.
 * Supports both legacy format (bare binary name) and new format (binary:harness).
 * Optional ::i suffix marks as preferred for loop 1.
 *
 * Legacy: "claude-auto-zai" -> { binary: "claude-auto-zai", harness: "claude", firstIterationPreferred: false }
 * New: "gemini-auto:gemini" -> { binary: "gemini-auto", harness: "gemini", firstIterationPreferred: false }
 * Preferred: "claude-auto-opus::i" -> { binary: "claude-auto-opus", harness: "claude", firstIterationPreferred: true }
 */
export function parseImplementerConfig(entry: string): ParsedBinary {
  const trimmed = entry.trim();
  if (!trimmed) {
    throw new Error('Implementer config cannot be empty.');
  }

  // Check for ::i suffix (first iteration preferred)
  let firstIterationPreferred = false;
  let working = trimmed;
  if (working.endsWith('::i')) {
    firstIterationPreferred = true;
    working = working.slice(0, -3);
  }

  const colonCount = (working.match(/:/g) || []).length;
  if (colonCount > 1) {
    throw new Error(`Invalid implementer config "${entry}": too many colons. Expected format: binary:harness[:i]`);
  }

  const colonIndex = working.indexOf(':');
  if (colonIndex === -1) {
    // No explicit harness — guess from first segment of binary name
    const prefix = working.split('-')[0] ?? '';
    const harness = parseHarness(prefix, true);
    return { binary: working, harness, firstIterationPreferred };
  }

  if (colonIndex === 0) {
    throw new Error(`Invalid implementer config "${entry}": binary name cannot be empty.`);
  }

  const binary = working.slice(0, colonIndex);
  const harnessValue = working.slice(colonIndex + 1);

  if (!harnessValue) {
    throw new Error(`Invalid implementer config "${entry}": harness cannot be empty.`);
  }

  return {
    binary,
    harness: parseHarness(harnessValue),
    firstIterationPreferred,
  };
}

/**
 * Parse a reviewer config entry.
 * Supports legacy format (binary:flag), new format (binary:harness:flag), and bare binary.
 *
 * Legacy: "claude-auto-zai:1" -> { binary: "claude-auto-zai", harness: "claude", noVerdictAsFailure: true }
 * New: "gemini-auto:gemini:0" -> { binary: "gemini-auto", harness: "gemini", noVerdictAsFailure: false }
 * Bare: "claude-reviewer-zai" -> { binary: "claude-reviewer-zai", harness: "claude", noVerdictAsFailure: true }
 */
export function parseReviewerConfig(entry: string): ReviewerBinary {
  const trimmed = entry.trim();
  if (!trimmed) {
    throw new Error('Reviewer config cannot be empty.');
  }

  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount > 2) {
    throw new Error(
      `Invalid reviewer config "${entry}": too many colons. Expected format: binary:harness:flag or binary:flag`,
    );
  }

  // Find the last colon (separates the flag if present)
  const lastColonIndex = trimmed.lastIndexOf(':');

  if (lastColonIndex === -1) {
    // No flag: "binary" or "binary:harness" (no flag defaults to noVerdictAsFailure: true)
    return { ...parseImplementerConfig(trimmed), noVerdictAsFailure: true };
  }

  // Check if the part after last colon is a valid flag (0 or 1)
  const potentialFlag = trimmed.slice(lastColonIndex + 1);

  // If the flag segment looks numeric but isn't 0 or 1, reject explicitly
  if (potentialFlag.length > 0 && /^\d+$/.test(potentialFlag) && potentialFlag !== '0' && potentialFlag !== '1') {
    throw new Error(`Invalid reviewer config "${entry}": reviewer flag must be 0 or 1, got "${potentialFlag}".`);
  }

  if (potentialFlag === '0' || potentialFlag === '1') {
    // There is a flag: parse the binary:harness part and apply the flag
    const binaryPart = trimmed.slice(0, lastColonIndex);
    if (!binaryPart) {
      throw new Error(`Invalid reviewer config "${entry}": binary name cannot be empty.`);
    }
    const parsed = parseImplementerConfig(binaryPart);
    return {
      ...parsed,
      noVerdictAsFailure: potentialFlag === '1',
    };
  }

  // Not a valid flag (0 or 1), so it's binary:harness with no flag
  return { ...parseImplementerConfig(trimmed), noVerdictAsFailure: true };
}

/**
 * Parse a conflictChecker config entry (same as implementer, no flag).
 */
export function parseConflictCheckerConfig(entry: string): ParsedBinary {
  return parseImplementerConfig(entry);
}

// ============================================================================
// Default Config Values
// ============================================================================

export const DEFAULT_CONFIG: Config = {
  implementers: { claude: 1 },
  reviewPhases: [['claude']],
  conflictChecker: 'claude',
  maxIterations: 7,
  implementerTimeout: 30,
  reviewerTimeout: 15,
  synthesisTimeout: 15,
  verifyTimeout: 5,
  conflictCheckThreshold: 3,
  compressSpec: false,
  firstLoopFullReview: true,
  previousReviewPropagation: 0.7,
  synthesis: true,
  verify: true,
  verifyPhases: [['claude:claude']],
  rerankAfterCheckpoint: true,
  snapshot: false,
  implementerRetry: { maxRetries: 2, backoffBaseMs: 5000 },
  firstIterationWeightMultiplier: 2,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the first implementer binary (for backwards compat)
 */
export function getPrimaryImplementer(config: Config): string {
  return Object.keys(config.implementers)[0];
}

/**
 * Select an implementer using weighted random selection.
 * On loop 1, models with firstIterationPreferred get 2x weight.
 *
 * NOTE: This uses Math.random() and is non-deterministic — different runs
 * will select different binaries even with the same weights and config.
 * This is documented as random per the spec's Definition of Done:
 * "Weighted implementer selection is deterministic with a seed for
 * reproducibility (or documented as random)"
 */
export function selectImplementer(config: Config, loopNum?: number): string {
  const entries = Object.entries(config.implementers);
  const effectiveLoop = loopNum ?? 1;

  // Build effective weights: on loop 1, firstIterationPreferred models get multiplied weight
  const multiplier = config.firstIterationWeightMultiplier ?? 2;
  const effectiveWeights = entries.map(([binary, weight]) => {
    if (effectiveLoop === 1) {
      const parsed = parseImplementerConfig(binary);
      if (parsed.firstIterationPreferred) return weight * multiplier;
    }
    return weight;
  });

  const totalWeight = effectiveWeights.reduce((sum, w) => sum + w, 0);
  let rand = Math.random() * totalWeight;
  for (let i = 0; i < entries.length; i++) {
    rand -= effectiveWeights[i];
    if (rand <= 0) return entries[i][0];
  }
  return entries[entries.length - 1][0]; // fallback to last
}

export function parseRawConfig(data: unknown): Config {
  // Parse with the schema that handles backwards compat transform
  const result = configSchema.safeParse(data);
  if (!result.success) {
    // Fallback: try the resolved schema directly
    return resolvedConfigSchema.parse(data);
  }
  return resolvedConfigSchema.parse(result.data);
}

export function parseRun(data: unknown): Run {
  return runSchema.parse(data);
}

export function parseHistoryEntry(data: unknown): HistoryEntry {
  return historyEntrySchema.parse(data);
}

// ============================================================================
// Event-Sourced State Types (for kloop global storage)
// ============================================================================

// Event types for events.jsonl
export const EVENT_TYPES = {
  // Run lifecycle
  RUN_START: 'run_start',
  CANCEL: 'cancel',
  STOP: 'stop',
  COMPLETED: 'completed',
  ERROR: 'error',
  CONFLICT: 'conflict',
  AGENT_FAILURE: 'agent_failure',
  CRASHED: 'crashed',

  // Loop lifecycle
  LOOP_START: 'loop_start',
  IMPLEMENTER_START: 'implementer_start',
  IMPLEMENTER_END: 'implementer_end',
  IMPLEMENTER_RETRY: 'implementer_retry',

  // Review phase lifecycle
  REVIEW_PHASE_START: 'review_phase_start',
  REVIEWER_START: 'reviewer_start',
  REVIEWER_END: 'reviewer_end',
  REVIEW_PHASE_END: 'review_phase_end',

  // Verify phase lifecycle
  VERIFY_PHASE_START: 'verify_phase_start',
  VERIFIER_START: 'verifier_start',
  VERIFIER_END: 'verifier_end',
  VERIFY_PHASE_END: 'verify_phase_end',

  // Synthesis
  SYNTHESIS_START: 'synthesis_start',
  SYNTHESIS_END: 'synthesis_end',

  // Checkpoint
  CHECKPOINT: 'checkpoint', // legacy alias for CHECKPOINT_END
  CHECKPOINT_START: 'checkpoint_start',
  CHECKPOINT_END: 'checkpoint_end',

  // Loop end
  LOOP_END: 'loop_end',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

// Base event interface
export interface BaseEvent {
  type: EventType;
  timestamp: string;
}

// Run lifecycle events
export interface RunStartEvent extends BaseEvent {
  type: typeof EVENT_TYPES.RUN_START;
  config: Config;
}

export interface CancelEvent extends BaseEvent {
  type: typeof EVENT_TYPES.CANCEL;
  reason: string;
}

export interface StopEvent extends BaseEvent {
  type: typeof EVENT_TYPES.STOP;
  reason: string;
}

export interface CompletedEvent extends BaseEvent {
  type: typeof EVENT_TYPES.COMPLETED;
  exitCode: number;
  reason: string;
}

export interface ErrorEvent extends BaseEvent {
  type: typeof EVENT_TYPES.ERROR;
  exitCode: number;
  message: string;
}

export interface ConflictEvent extends BaseEvent {
  type: typeof EVENT_TYPES.CONFLICT;
  exitCode: number;
  summary: string;
}

export interface AgentFailureEvent extends BaseEvent {
  type: typeof EVENT_TYPES.AGENT_FAILURE;
  exitCode: number;
  agent: string;
  message: string;
}

export interface CrashedEvent extends BaseEvent {
  type: typeof EVENT_TYPES.CRASHED;
  exitCode: number;
  signal: string;
  message: string;
}

// Loop lifecycle events
export interface LoopStartEvent extends BaseEvent {
  type: typeof EVENT_TYPES.LOOP_START;
  loop: number;
  implementer: string;
}

export interface ImplementerStartEvent extends BaseEvent {
  type: typeof EVENT_TYPES.IMPLEMENTER_START;
  loop: number;
  binary: string;
  harness: HarnessType;
}

export interface ImplementerEndEvent extends BaseEvent {
  type: typeof EVENT_TYPES.IMPLEMENTER_END;
  loop: number;
  binary: string;
  harness: HarnessType;
  exitCode: number;
  durationMs: number;
  error?: string; // 'timeout' | 'exit_code_N'
  retryAttempt?: number; // 0-indexed: 0 = first try
  maxRetries?: number;
}

export interface ImplementerRetryEvent extends BaseEvent {
  type: typeof EVENT_TYPES.IMPLEMENTER_RETRY;
  loop: number;
  attempt: number; // 0-indexed attempt that just failed
  maxRetries: number;
  previousBinary: string;
  newBinary: string;
  backoffMs: number;
}

// Review phase lifecycle events
export interface ReviewPhaseStartEvent extends BaseEvent {
  type: typeof EVENT_TYPES.REVIEW_PHASE_START;
  loop: number;
  phase: number;
  reviewers: string[];
}

export interface ReviewerStartEvent extends BaseEvent {
  type: typeof EVENT_TYPES.REVIEWER_START;
  loop: number;
  phase: number;
  reviewer: string;
  harness?: HarnessType;
}

export interface ReviewerEndEvent extends BaseEvent {
  type: typeof EVENT_TYPES.REVIEWER_END;
  loop: number;
  phase: number;
  reviewer: string;
  harness?: HarnessType;
  exitCode: number;
  durationMs: number;
  error?: string; // 'timeout' | 'no_verdict' | 'exit_code_N'
  verdict?: string; // 'approved' | 'rejected'
  completionEstimate?: number;
  propagated?: boolean; // true if this reviewer received previous loop reviews
}

export interface ReviewPhaseEndEvent extends BaseEvent {
  type: typeof EVENT_TYPES.REVIEW_PHASE_END;
  loop: number;
  phase: number;
  shortCircuited: boolean;
}

// Checkpoint events
export interface CheckpointEvent extends BaseEvent {
  type: typeof EVENT_TYPES.CHECKPOINT;
  loop: number;
  outcome: 'conflict_found' | 'spec_auto_fixed' | 'spec_compressed' | 'no_action';
  summary: string;
}

export interface CheckpointStartEvent extends BaseEvent {
  type: typeof EVENT_TYPES.CHECKPOINT_START;
  loop: number;
  binary: string;
  harness?: HarnessType;
}

export interface CheckpointEndEvent extends BaseEvent {
  type: typeof EVENT_TYPES.CHECKPOINT_END;
  loop: number;
  outcome: 'conflict_found' | 'spec_auto_fixed' | 'spec_compressed' | 'no_action';
  summary: string;
  progressPercent?: number;
  durationMs: number;
  exitCode: number;
}

// Verify phase events
export interface VerifyPhaseStartEvent extends BaseEvent {
  type: typeof EVENT_TYPES.VERIFY_PHASE_START;
  loop: number;
  phase: number;
  reviewers: string[];
}

export interface VerifierStartEvent extends BaseEvent {
  type: typeof EVENT_TYPES.VERIFIER_START;
  loop: number;
  phase: number;
  reviewer: string;
  harness?: HarnessType;
}

export interface VerifierEndEvent extends BaseEvent {
  type: typeof EVENT_TYPES.VERIFIER_END;
  loop: number;
  phase: number;
  reviewer: string;
  harness?: HarnessType;
  exitCode: number;
  durationMs: number;
  error?: string;
  verdict?: string;
}

export interface VerifyPhaseEndEvent extends BaseEvent {
  type: typeof EVENT_TYPES.VERIFY_PHASE_END;
  loop: number;
  phase: number;
  shortCircuited: boolean;
}

// Synthesis events
export interface SynthesisStartEvent extends BaseEvent {
  type: typeof EVENT_TYPES.SYNTHESIS_START;
  loop: number;
  binary: string;
  harness?: HarnessType;
}

export interface SynthesisEndEvent extends BaseEvent {
  type: typeof EVENT_TYPES.SYNTHESIS_END;
  loop: number;
  binary: string;
  harness?: HarnessType;
  exitCode: number;
  durationMs: number;
  error?: string;
  summaryPath?: string;
}

// Loop end event
export interface LoopEndEvent extends BaseEvent {
  type: typeof EVENT_TYPES.LOOP_END;
  loop: number;
  durationMs: number;
}

// Union type for all events
export type KloopEvent =
  | RunStartEvent
  | CancelEvent
  | StopEvent
  | CompletedEvent
  | ErrorEvent
  | ConflictEvent
  | AgentFailureEvent
  | CrashedEvent
  | LoopStartEvent
  | ImplementerStartEvent
  | ImplementerEndEvent
  | ImplementerRetryEvent
  | ReviewPhaseStartEvent
  | ReviewerStartEvent
  | ReviewerEndEvent
  | ReviewPhaseEndEvent
  | VerifyPhaseStartEvent
  | VerifierStartEvent
  | VerifierEndEvent
  | VerifyPhaseEndEvent
  | SynthesisStartEvent
  | SynthesisEndEvent
  | CheckpointEvent
  | CheckpointStartEvent
  | CheckpointEndEvent
  | LoopEndEvent;

// Run status derived from events
export type KloopRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'conflict'
  | 'agent_failure'
  | 'crashed';

// Derived run state from events
export interface KloopRunState {
  runId: string;
  workspace: string;
  status: KloopRunStatus;
  exitCode?: number;
  exitReason?: string;
  currentLoop: number;
  currentPhase?: string;
  startedAt: string;
  lastEventAt: string;
  config?: Config;
}

// Index db row (stored in SQLite)
export interface RunIndexRow {
  id: string;
  workspace: string;
  started_at: string;
}

// ============================================================================
// Materialized Status (WAL-derived, persisted as status.yaml)
// ============================================================================

export type MaterializedAgentStatus = 'pending' | 'running' | 'completed' | 'error' | 'timeout';

export interface MaterializedAgentState {
  binary: string;
  harness?: HarnessType;
  status: MaterializedAgentStatus;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  durationMs?: number;
  error?: string; // 'timeout', 'no_verdict', 'exit_code_N'
  // Enrichment (from verdict/summary files, not from events)
  verdict?: string;
  completionEstimate?: number;
  inputTokens?: number;
  outputTokens?: number;
  propagated?: boolean; // true if this reviewer received previous loop reviews
  // Implementer retry tracking
  retryAttempt?: number; // 0-indexed: 0 = first try
  retryMax?: number;
}

export interface MaterializedReviewPhase {
  phase: number;
  startedAt: string;
  completedAt?: string;
  shortCircuited?: boolean;
  reviewers: MaterializedAgentState[];
}

export interface MaterializedVerifyPhase {
  phase: number;
  startedAt: string;
  completedAt?: string;
  shortCircuited?: boolean;
  reviewers: MaterializedAgentState[];
}

export interface MaterializedSynthesis {
  status: 'pending' | 'running' | 'completed' | 'error';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number;
  error?: string;
  summaryPath?: string;
  binary?: string;
}

export interface MaterializedCheckpoint {
  binary?: string;
  status: 'running' | 'completed';
  startedAt?: string;
  completedAt?: string;
  outcome?: 'conflict_found' | 'spec_auto_fixed' | 'spec_compressed' | 'no_action';
  summary?: string;
  progressPercent?: number;
  durationMs?: number;
  exitCode?: number;
}

export interface MaterializedLoop {
  loop: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  implementer?: MaterializedAgentState;
  verifyPhases?: MaterializedVerifyPhase[];
  reviewPhases: MaterializedReviewPhase[];
  synthesis?: MaterializedSynthesis;
  checkpoint?: MaterializedCheckpoint;
}

export interface MaterializedStatus {
  // Schema version — bumped to invalidate old status.yaml files
  schemaVersion?: number;

  // WAL cursor — event count when last materialized
  lastEventIndex: number;

  // Run-level
  runId: string;
  workspace: string;
  status: KloopRunStatus;
  exitCode?: number;
  exitReason?: string;
  startedAt: string;
  lastEventAt: string;
  config?: Config;
  consecutiveFailures: number;
  failureThreshold: number;

  // Per-loop state
  loops: MaterializedLoop[];
}

// ============================================================================
// Loop Summary (written per-loop by runner)
// ============================================================================

// Loop summary JSON (machine-readable)
export interface LoopSummary {
  loop: number;
  durationMs: number;
  implementerRetryAttempts?: number;
  implementer: {
    binary: string;
    harness?: HarnessType;
    exitCode: number;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  verifyPhases?: Array<{
    phase: number;
    reviewers: Array<{
      reviewerIndex: number;
      binary: string;
      harness?: HarnessType;
      exitCode: number;
      durationMs: number;
      verdict?: 'approved' | 'rejected';
      error?: string;
      issuesFixed?: string[];
      issuesRemaining?: string[];
    }>;
    shortCircuited: boolean;
  }>;
  reviewPhases: Array<{
    phase: number;
    reviewers: Array<{
      reviewerIndex: number;
      binary: string;
      harness?: HarnessType;
      exitCode: number;
      durationMs: number;
      timedOut?: boolean;
      verdict?: 'approved' | 'rejected';
      reasoning?: string;
      completionEstimate?: number;
      inputTokens?: number;
      outputTokens?: number;
      error?: string;
    }>;
    shortCircuited: boolean;
  }>;
  synthesis?: {
    binary?: string;
    exitCode: number;
    durationMs: number;
    error?: string;
    summaryPath?: string;
  };
  checkpoint?: {
    outcome: string;
    summary: string;
    progressPercent?: number;
  };
}
