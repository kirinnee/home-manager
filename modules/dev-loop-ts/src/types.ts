import { z } from 'zod';

// ============================================================================
// Zod Schemas (for validation and type inference)
// ============================================================================

export const configSchema = z.object({
  // Binary names
  implementer: z.string().min(1).default('claude'),
  reviewers: z.array(z.string().min(1)).min(1).default(['claude-reviewer-zai']),
  conflictChecker: z.string().min(1).optional(), // defaults to implementer binary
  // Counts and limits
  maxIterations: z.number().min(1).max(100).default(10),
  implementerTimeout: z.number().min(1).max(120).default(30),
  reviewerTimeout: z.number().min(1).max(120).default(15),
  // Conflict detection
  conflictCheckThreshold: z.number().min(1).max(100).default(3),
});

export const runStatusSchema = z.enum(['running', 'completed', 'cancelled', 'failed', 'conflict']);
export const phaseSchema = z.enum(['implementing', 'reviewing', 'done']);
export const agentRoleSchema = z.enum(['implementer', 'reviewer', 'checkpointer']);
export const sessionStatusSchema = z.enum(['running', 'completed', 'error']);
export const verdictSchema = z.enum(['approved', 'rejected']);

// Config stored in .kagent/config.json
export type Config = z.infer<typeof configSchema>;

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

export const historyEntrySchema = z.object({
  id: z.string().min(1), // run ID (short UUID)
  spec: z.string(),
  config: configSchema,
  status: runStatusSchema,
  iterations: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  summary: z.array(iterationSummarySchema),
  checkpointRan: z.boolean().optional(), // Whether checkpointer ran during this run
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
  implementer: 'claude',
  reviewers: ['claude-reviewer-zai'],
  conflictChecker: undefined,
  maxIterations: 10,
  implementerTimeout: 30,
  reviewerTimeout: 15,
  conflictCheckThreshold: 3,
};

// ============================================================================
// Helper Functions
// ============================================================================

export function parseConfig(data: unknown): Config {
  return configSchema.parse(data);
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
  const result = configSchema.safeParse(data);
  return result.success ? result.data : null;
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
  const result = configSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid config: ${result.error.message}`);
  }
  return result.data;
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
