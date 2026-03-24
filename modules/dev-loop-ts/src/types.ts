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

export const configSchema = z
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
    // Counts and limits
    maxIterations: z.number().min(1).max(100).default(10),
    implementerTimeout: z.number().min(0.001).max(120).default(30),
    reviewerTimeout: z.number().min(0.001).max(120).default(15),
    // Conflict detection
    conflictCheckThreshold: z.number().min(1).max(100).default(3),
    // Review behavior
    firstLoopFullReview: z.boolean().default(false),
    previousReviewPropagation: z.number().min(0).max(1).default(0),
    // Per-reviewer consecutive failure cap (for :1 reviewers)
    reviewerFailureLimit: z.number().min(1).max(20).default(2),
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
      reviewPhases = [['claude-reviewer-zai']];
    }

    return {
      implementers,
      reviewPhases,
      conflictChecker: data.conflictChecker,
      maxIterations: data.maxIterations,
      implementerTimeout: data.implementerTimeout,
      reviewerTimeout: data.reviewerTimeout,
      conflictCheckThreshold: data.conflictCheckThreshold,
      firstLoopFullReview: data.firstLoopFullReview,
      previousReviewPropagation: data.previousReviewPropagation,
      reviewerFailureLimit: data.reviewerFailureLimit,
    };
  });

// Resolved config (after transform — what the rest of the codebase uses)
export const resolvedConfigSchema = z.object({
  implementers: z.record(z.string(), z.number().int().positive()),
  reviewPhases: z.array(z.array(z.string().min(1))).min(1),
  conflictChecker: z.string().min(1).optional(),
  maxIterations: z.number().min(1).max(100),
  implementerTimeout: z.number().min(0.001).max(120),
  reviewerTimeout: z.number().min(0.001).max(120),
  conflictCheckThreshold: z.number().min(1).max(100),
  firstLoopFullReview: z.boolean(),
  previousReviewPropagation: z.number().min(0).max(1),
  reviewerFailureLimit: z.number().min(1).max(20),
});

export type Config = z.infer<typeof resolvedConfigSchema>;

export const runStatusSchema = z.enum(['running', 'completed', 'cancelled', 'failed', 'conflict']);
export const phaseSchema = z.enum(['implementing', 'reviewing', 'done']);
export const agentRoleSchema = z.enum(['implementer', 'reviewer', 'checkpointer']);
export const sessionStatusSchema = z.enum(['running', 'completed', 'error']);
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
  reviewerFailures: z.record(z.string(), z.number().int().nonnegative()).default({}),
});

export type RunStatus = z.infer<typeof runStatusSchema>;
export type Phase = z.infer<typeof phaseSchema>;
export type AgentRole = z.infer<typeof agentRoleSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type Run = z.infer<typeof runSchema>;

// Verdict enum for convenience (matches verdictSchema)
export const VERDICT = {
  APPROVED: 'approved' as const,
  REJECTED: 'rejected' as const,
} as const;

// Run status enum
export const RUN_STATUS = {
  RUNNING: 'running' as const,
  COMPLETED: 'completed' as const,
  CANCELLED: 'cancelled' as const,
  FAILED: 'failed' as const,
  CONFLICT: 'conflict' as const,
} as const;

// Agent status enum
export const AGENT_STATUS = {
  NOT_STARTED: 'not_started' as const,
  RUNNING: 'running' as const,
  COMPLETED: 'completed' as const,
  ERROR: 'error' as const,
} as const;

// Agent role enum
export const AGENT_ROLE = {
  IMPLEMENTER: 'implementer' as const,
  REVIEWER: 'reviewer' as const,
  CHECKPOINTER: 'checkpointer' as const,
} as const;

// Phase enum
export const PHASE = {
  IMPLEMENTING: 'implementing' as const,
  REVIEWING: 'reviewing' as const,
  DONE: 'done' as const,
} as const;

// Session stored in .kagent/current/sessions/{id}.json
export const sessionSchema = z.object({
  id: z.string().min(1), // session ID (full or short UUID)
  iteration: z.number().int().positive(), // 1-based for sessions
  role: agentRoleSchema,
  reviewerIndex: z.number().int().nonnegative().optional(),
  binary: z.string().optional(), // Which binary was used (e.g., "claude" or "claude-reviewer-zai")
  tmuxSession: z.string(),
  status: sessionStatusSchema,
  verdict: verdictSchema.optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export type Session = z.infer<typeof sessionSchema>;

// Verdict file content: .kagent/current/verdicts/{iteration}-{reviewerIndex}.json
export const verdictFileSchema = z.object({
  verdict: verdictSchema,
  reasoning: z.string(),
  completionEstimate: z.number().int().min(0).max(100).optional(),
});

export type VerdictFile = z.infer<typeof verdictFileSchema>;

// History entry stored in .kagent/history/{id}.json
export const sessionSummarySchema = z.object({
  role: agentRoleSchema,
  reviewerIndex: z.number().int().nonnegative().optional(),
});

export const iterationSummarySchema = z.object({
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

export const metricsSummarySchema = z.object({
  totalDurationMs: z.number().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
});

export type MetricsSummary = z.infer<typeof metricsSummarySchema>;

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

export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type IterationSummary = z.infer<typeof iterationSummarySchema>;
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

// Checkpointer outcome enum
export const CHECKPOINT_OUTCOME = {
  CONFLICT_FOUND: 'conflict_found' as const,
  SPEC_AUTO_FIXED: 'spec_auto_fixed' as const,
  SPEC_COMPRESSED: 'spec_compressed' as const,
  NO_ACTION: 'no_action' as const,
} as const;

// Additional types for state management
export interface Learning {
  iteration: number;
  content: string;
}

export interface AgentState extends Session {
  name: string;
}

// ============================================================================
// Default Config Values
// ============================================================================

export const DEFAULT_CONFIG: Config = {
  implementers: { claude: 1 },
  reviewPhases: [['claude-auto-zai']],
  conflictChecker: undefined,
  maxIterations: 10,
  implementerTimeout: 30,
  reviewerTimeout: 15,
  conflictCheckThreshold: 3,
  firstLoopFullReview: false,
  previousReviewPropagation: 0,
  reviewerFailureLimit: 2,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse a reviewer config string like "binary-name:1" or "binary-name:0" or "binary-name".
 * Returns the binary name and whether no-verdict counts as failure.
 *
 * Format: "name" or "name:1" (no verdict/timeout/non-zero exit = rejection)
 *        or "name:0" (no verdict/timeout/non-zero exit = approval)
 * Default is noVerdictAsFailure = true for backwards compatibility.
 */
export interface ReviewerConfig {
  binary: string;
  noVerdictAsFailure: boolean;
}

export function parseReviewerConfig(entry: string): ReviewerConfig {
  const colonIndex = entry.lastIndexOf(':');
  if (colonIndex > 0) {
    const name = entry.slice(0, colonIndex).trim();
    const flag = entry.slice(colonIndex + 1).trim();
    if (name && (flag === '0' || flag === '1')) {
      return { binary: name, noVerdictAsFailure: flag === '1' };
    }
  }
  return { binary: entry.trim(), noVerdictAsFailure: true };
}

/**
 * Get all implementer binary names from config
 */
export function getImplementerBinaries(config: Config): string[] {
  return Object.keys(config.implementers);
}

/**
 * Get the first implementer binary (for backwards compat)
 */
export function getPrimaryImplementer(config: Config): string {
  return Object.keys(config.implementers)[0];
}

/**
 * Get all reviewer binaries flattened from phases
 */
export function getAllReviewers(config: Config): string[] {
  return config.reviewPhases.flat();
}

/**
 * Get total reviewers across all phases
 */
export function getTotalReviewers(config: Config): number {
  return config.reviewPhases.reduce((sum, phase) => sum + phase.length, 0);
}

/**
 * Select an implementer using weighted random selection.
 *
 * NOTE: This uses Math.random() and is non-deterministic — different runs
 * will select different binaries even with the same weights and config.
 * This is documented as random per the spec's Definition of Done:
 * "Weighted implementer selection is deterministic with a seed for
 * reproducibility (or documented as random)"
 */
export function selectImplementer(config: Config): string {
  const entries = Object.entries(config.implementers);
  const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let rand = Math.random() * totalWeight;
  for (const [binary, weight] of entries) {
    rand -= weight;
    if (rand <= 0) return binary;
  }
  return entries[entries.length - 1][0]; // fallback to last
}

export function parseConfig(data: unknown): Config {
  return resolvedConfigSchema.parse(configSchema.parse(data));
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

export function parseSession(data: unknown): Session {
  return sessionSchema.parse(data);
}

export function parseVerdictFile(data: unknown): VerdictFile {
  return verdictFileSchema.parse(data);
}

export function parseHistoryEntry(data: unknown): HistoryEntry {
  return historyEntrySchema.parse(data);
}

export function safeParseConfig(data: unknown): Config | null {
  try {
    return parseConfig(data);
  } catch {
    return null;
  }
}

export function safeParseRun(data: unknown): Run | null {
  const result = runSchema.safeParse(data);
  return result.success ? result.data : null;
}

export function isRunning(run: Run | null): run is Run {
  return run !== null && run.status === 'running';
}

export function isTerminal(status: RunStatus): boolean {
  return status !== 'running';
}

// ============================================================================
// Validation Functions (for runtime checks with better error messages)
// ============================================================================

export function validateConfig(data: unknown): Config {
  try {
    return parseConfig(data);
  } catch (err) {
    throw new Error(`Invalid config: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function validateRun(data: unknown): Run {
  const result = runSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid run: ${result.error.message}`);
  }
  return result.data;
}

export function validateAgentState(data: unknown): Session {
  const result = sessionSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid agent state: ${result.error.message}`);
  }
  return result.data;
}
