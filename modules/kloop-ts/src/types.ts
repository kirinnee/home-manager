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

// Reviewer retry config — retries a reviewer that produced NO parseable verdict
// (transport failure, crash, timeout). A real approve/reject verdict is never retried.
const reviewerRetrySchema = z.object({
  maxRetries: z.number().min(0).max(10).default(2),
  backoffBaseMs: z.number().min(0).default(5000),
});

// Synthesizer retry config — retries a synthesizer that produced NO summary file
// (transport failure, crash, timeout). Applies to both synthesis and re-synthesis.
const synthesizerRetrySchema = z.object({
  maxRetries: z.number().min(0).max(10).default(2),
  backoffBaseMs: z.number().min(0).default(5000),
});

// Verifier retry config — retries a verifier that produced NO parseable verdict.
// Mirrors reviewerRetry semantics: a real approve/reject verdict is never retried.
const verifierRetrySchema = z.object({
  maxRetries: z.number().min(0).max(10).default(2),
  backoffBaseMs: z.number().min(0).default(5000),
});

// Checkpointer retry config — retries a checkpointer that produced NO parseable
// result JSON (transport failure, crash, timeout). A real outcome is never retried.
const checkpointerRetrySchema = z.object({
  maxRetries: z.number().min(0).max(10).default(2),
  backoffBaseMs: z.number().min(0).default(5000),
});

// Implementer stall detection — the "frozen on a confirm dialog for 2.5h" fix.
// Activity = implementer log/evidence mtimes + a hash of the pane tail (the pane
// changes while the agent streams/thinks even when the JSONL log is quiet for
// 10+ minutes, so long generation stretches don't false-alarm).
const stallConfigSchema = z.object({
  // Master switch — everything below is inert when false.
  enabled: z.boolean().default(false),
  // No activity for this long → run the stuck-prompt check / flag idle.
  idleThresholdSec: z.number().min(30).max(7200).default(600),
  // How often the daemon samples activity while the implementer runs.
  checkIntervalSec: z.number().min(5).max(3600).default(60),
  // off   = detect + surface only (default).
  // safe  = auto-answer KNOWN confirm dialogs (send "1"), log the intervention.
  // all   = also auto-answer generic prompts ending at ❯ (send Enter). Risky.
  // YAML-1.1 leniency: a bare `off` may parse as boolean false — accept it.
  autoAnswer: z.preprocess(v => (v === false ? 'off' : v), z.enum(['off', 'safe', 'all'])).default('off'),
});
export type StallConfig = z.infer<typeof stallConfigSchema>;

// True if `account` parses as a reviewer binary (binary[:harness[:flag]]). Used to
// reject malformed type/pool accounts at config load instead of mid-run/at display.
// parseReviewerConfig is a hoisted function declaration, so referencing it here is safe.
function accountParses(account: string): boolean {
  try {
    parseReviewerConfig(account);
    return true;
  } catch {
    return false;
  }
}

function implementerParses(binary: string): boolean {
  try {
    parseImplementerConfig(binary);
    return true;
  } catch {
    return false;
  }
}

// A reviewer/verifier "type" entry within a phase. Either a single binary string
// (back-compat) or a weighted pool of interchangeable accounts ({ binary: weight })
// that load-balances per invocation (a separate concept from implementer type-rotation).
// Pools must be non-empty with parseable account names and positive weights — fail at
// config load, not mid-run or at display time.
const ACCOUNT_FORMAT_MSG = 'Invalid account name (expected binary[:harness[:flag]]).';
// A weighted account pool: { binary: weight }, non-empty, parseable accounts, positive weights.
const poolSchema = z
  .record(z.string().min(1), z.number().positive())
  .refine(pool => Object.keys(pool).length > 0, { message: 'Account pool cannot be empty.' })
  .refine(pool => Object.keys(pool).every(accountParses), { message: ACCOUNT_FORMAT_MSG });
// A type entry: a single binary string OR a profile NAME (resolved via poolProfiles at
// runtime) OR an inline weighted pool. A plain string that isn't a defined profile is
// treated as a bare binary, so it must be a valid binary-format name.
const typeEntrySchema = z.union([z.string().min(1).refine(accountParses, { message: ACCOUNT_FORMAT_MSG }), poolSchema]);
// Named, reusable pools referenceable by name from reviewPhases/verifyPhases entries and
// implementer keys.
const poolProfilesSchema = z.record(z.string().min(1), poolSchema);

// Backward compat: old nested shapes accepted as input aliases
const legacyReReviewSchema = z.object({
  enabled: z.boolean().optional(),
  phases: z.array(z.array(typeEntrySchema).min(1)).optional(),
  timeout: z.number().min(0.001).max(300).optional(),
});
const legacySynthesisSchema = z.object({
  enabled: z.boolean().optional(),
});

const configSchema = z
  .object({
    // Config-file format version (for the additive migration). Optional for back-compat.
    configVersion: z.number().int().nonnegative().optional(),
    // Binary names — new format: weighted implementers
    implementers: z
      .record(z.string(), z.number().int().positive())
      .refine(rec => Object.keys(rec).length > 0, { message: 'implementers cannot be empty.' })
      .refine(rec => Object.keys(rec).every(implementerParses), { message: ACCOUNT_FORMAT_MSG })
      .optional(),
    // Backwards compat: singular implementer
    implementer: z.string().min(1).refine(implementerParses, { message: ACCOUNT_FORMAT_MSG }).optional(),
    // Review phases — array of phases; each phase is an array of TYPES (binary string
    // or a weighted account pool). Reviews = reviewLenses × types.
    reviewPhases: z.array(z.array(typeEntrySchema).min(1)).optional(),
    // Review lenses (the prompt focus each type reviews through). Default: ['general'].
    reviewLenses: z.array(z.string().min(1)).optional(),
    // Lens focus overrides/additions, merged over the built-in REVIEW_LENS_PROFILES.
    lensProfiles: z.record(z.string(), z.string()).optional(),
    // Named reusable account pools, referenceable by name from review/verify type entries
    // and implementer keys.
    poolProfiles: poolProfilesSchema.optional(),
    // Backwards compat: flat reviewers array
    reviewers: z.array(z.string().min(1)).optional(),
    // Single account, an inline weighted pool, or a pool-profile NAME (load-balanced per
    // invocation via selectFromPool). Defaults to the implementer binary when unset.
    conflictChecker: typeEntrySchema.optional(),
    // Single account, an inline weighted pool, or a pool-profile NAME. Defaults to the first
    // implementer binary when unset.
    synthesizer: typeEntrySchema.optional(),
    // Counts and limits
    maxIterations: z.number().min(1).max(100).default(7),
    implementerTimeout: z.number().min(0.001).max(300).default(30),
    reviewerTimeout: z.number().min(0.001).max(300).default(15),
    // Conflict detection
    conflictCheckThreshold: z.number().min(1).max(100).default(3),
    // Checkpoint behavior
    compressSpec: z.boolean().default(false),
    // Review behavior
    firstLoopFullReview: z.boolean().default(true),
    previousReviewPropagation: z.number().min(0).max(1).default(0.7),
    // Synthesis and verify (flat booleans + timeouts)
    synthesis: z.union([z.boolean(), legacySynthesisSchema]).default(true),
    synthesisTimeout: z.number().min(0.001).max(300).optional(),
    verify: z.boolean().optional(),
    verifyPhases: z.array(z.array(typeEntrySchema).min(1)).optional(),
    verifyTimeout: z.number().min(0.001).max(300).optional(),
    rerankAfterCheckpoint: z.boolean().default(true),
    snapshot: z.boolean().default(false),
    // Run claude-harness agents as interactive TUIs (no --print). kloop injects the prompt
    // via tmux, detects completion via a marker file the agent touches, then sends /exit.
    // Non-claude harnesses (gemini/codex) ignore this and always run --print.
    interactive: z.boolean().default(false),
    // Who runs the agents. 'kteam' (default) dispatches every role through kteamd
    // detached sessions (auth/quota preflight, dialog handling, stall/login-wall
    // fail-fast, transcript-based health). 'tmux' is kloop's legacy self-managed
    // tmux path. kteam requires the wrapper to be a claude-auto-*/codex-auto-*
    // fleet binary; non-fleet binaries (bare `claude`) fall back to tmux.
    agentBackend: z.enum(['tmux', 'kteam']).default('kteam'),
    // Usage-aware account selection. When true, kloop only draws from the weighted
    // pools accounts that still have usage left (queried from kfleet's /usage), and
    // blocks until reset when the implementer pool is fully exhausted. Off by default.
    requireUsageLeft: z.boolean().default(false),
    // Where to fetch the usage snapshot (kfleet serve's /usage endpoint).
    usageEndpoint: z.string().min(1).optional(),
    // 5h hard gate: skip an account when its 5-hour window has < this % left (default 3).
    usageFiveHourFloorPercent: z.number().min(0).max(100).optional(),
    // Implementer stall detection: notice a frozen implementer (e.g. stuck on a
    // Claude Code confirm dialog that fires even with bypass-permissions) and
    // surface it in status/wait/ps. Detection only by default; autoAnswer can
    // unblock known-safe confirm dialogs by sending "1" to the pane.
    stall: stallConfigSchema.optional(),
    implementerRetry: implementerRetrySchema.optional(),
    reviewerRetry: reviewerRetrySchema.optional(),
    synthesizerRetry: synthesizerRetrySchema.optional(),
    verifierRetry: verifierRetrySchema.optional(),
    checkpointerRetry: checkpointerRetrySchema.optional(),
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
      configVersion: data.configVersion,
      implementers,
      reviewPhases,
      reviewLenses: data.reviewLenses ?? ['general'],
      lensProfiles: data.lensProfiles,
      poolProfiles: data.poolProfiles,
      conflictChecker: data.conflictChecker,
      // Leave undefined when unset — every consumer falls back to the primary implementer
      // at usage (`config.synthesizer ?? getPrimaryImplementer(...)`). Eagerly resolving it
      // here would also make the v1→v2 migration persist a synthesizer the user never chose.
      synthesizer: data.synthesizer,
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
      interactive: data.interactive ?? false,
      agentBackend: data.agentBackend ?? 'kteam',
      requireUsageLeft: data.requireUsageLeft ?? false,
      usageEndpoint: data.usageEndpoint,
      usageFiveHourFloorPercent: data.usageFiveHourFloorPercent,
      stall: data.stall ?? {
        enabled: false,
        idleThresholdSec: 600,
        checkIntervalSec: 60,
        autoAnswer: 'off' as const,
      },
      implementerRetry: data.implementerRetry ?? { maxRetries: 2, backoffBaseMs: 5000 },
      reviewerRetry: data.reviewerRetry ?? { maxRetries: 2, backoffBaseMs: 5000 },
      synthesizerRetry: data.synthesizerRetry ?? { maxRetries: 2, backoffBaseMs: 5000 },
      verifierRetry: data.verifierRetry ?? { maxRetries: 2, backoffBaseMs: 5000 },
      checkpointerRetry: data.checkpointerRetry ?? { maxRetries: 2, backoffBaseMs: 5000 },
      firstIterationWeightMultiplier: data.firstIterationWeightMultiplier ?? 2,
      prompts,
    };
  });

export const resolvedConfigSchema = z.object({
  configVersion: z.number().int().nonnegative().optional(),
  implementers: z
    .record(z.string(), z.number().int().positive())
    .refine(rec => Object.keys(rec).length > 0, { message: 'implementers cannot be empty.' })
    .refine(rec => Object.keys(rec).every(implementerParses), { message: ACCOUNT_FORMAT_MSG }),
  reviewPhases: z.array(z.array(typeEntrySchema)).min(1),
  reviewLenses: z.array(z.string().min(1)).min(1),
  lensProfiles: z.record(z.string(), z.string()).optional(),
  poolProfiles: poolProfilesSchema.optional(),
  conflictChecker: typeEntrySchema.optional(),
  synthesizer: typeEntrySchema.optional(),
  maxIterations: z.number().min(1).max(100),
  implementerTimeout: z.number().min(0.001).max(300),
  reviewerTimeout: z.number().min(0.001).max(300),
  synthesisTimeout: z.number().min(0.001).max(300),
  verifyTimeout: z.number().min(0.001).max(300),
  conflictCheckThreshold: z.number().min(1).max(100),
  compressSpec: z.boolean(),
  firstLoopFullReview: z.boolean(),
  previousReviewPropagation: z.number().min(0).max(1),
  synthesis: z.boolean(),
  verify: z.boolean(),
  verifyPhases: z.array(z.array(typeEntrySchema).min(1)),
  rerankAfterCheckpoint: z.boolean(),
  snapshot: z.boolean(),
  interactive: z.boolean().default(false),
  agentBackend: z.enum(['tmux', 'kteam']).default('kteam'),
  requireUsageLeft: z.boolean().default(false),
  usageEndpoint: z.string().optional(),
  usageFiveHourFloorPercent: z.number().min(0).max(100).optional(),
  stall: stallConfigSchema.default({
    enabled: false,
    idleThresholdSec: 600,
    checkIntervalSec: 60,
    autoAnswer: 'off',
  }),
  implementerRetry: z.object({
    maxRetries: z.number().min(0).max(10),
    backoffBaseMs: z.number().min(0),
  }),
  reviewerRetry: z.object({
    maxRetries: z.number().min(0).max(10),
    backoffBaseMs: z.number().min(0),
  }),
  synthesizerRetry: z.object({
    maxRetries: z.number().min(0).max(10),
    backoffBaseMs: z.number().min(0),
  }),
  verifierRetry: z.object({
    maxRetries: z.number().min(0).max(10),
    backoffBaseMs: z.number().min(0),
  }),
  checkpointerRetry: z.object({
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
 * Format: binary[:harness][*]  — harness is guessed from the binary's first word when
 * omitted (e.g. "claude-auto-x" → claude). Trailing `*` marks first-iteration preferred
 * (legacy `::i` still accepted).
 */
export interface ParsedBinary {
  binary: string;
  harness: HarnessType;
  firstIterationPreferred: boolean;
}

/**
 * Parsed binary config for reviewers (which add a noVerdictAsFailure flag).
 * Format: binary[:harness][*][!]  — trailing `!` IGNORES a no-verdict (treats it as a
 * pass); without `!` a no-verdict FAILS (rejects). Legacy `:0`/`:1` flag still accepted.
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
/**
 * Strip the trailing flag suffixes from a binary spec, in any order:
 *   *   → first-iteration preferred (new form of the legacy ::i)
 *   !   → no-verdict is IGNORED (treated as pass) instead of failing (reviewer-only)
 *   ::i → legacy first-iteration preferred
 * Returns the bare `base` plus the flags found.
 */
function stripFlagSuffixes(s: string): { base: string; firstIter: boolean; noVerdictAsFailure?: boolean } {
  let firstIter = false;
  let noVerdictAsFailure: boolean | undefined;
  for (;;) {
    if (s.endsWith('::i')) {
      firstIter = true;
      s = s.slice(0, -3);
    } else if (s.endsWith('*')) {
      firstIter = true;
      s = s.slice(0, -1);
    } else if (s.endsWith('!')) {
      noVerdictAsFailure = false;
      s = s.slice(0, -1);
    } else {
      break;
    }
  }
  return { base: s, firstIter, noVerdictAsFailure };
}

export function parseImplementerConfig(entry: string): ParsedBinary {
  const trimmed = entry.trim();
  if (!trimmed) {
    throw new Error('Implementer config cannot be empty.');
  }

  // Strip trailing flag suffixes (* / ::i first-iteration; ! is reviewer-only and ignored here).
  const { base: working, firstIter: firstIterationPreferred } = stripFlagSuffixes(trimmed);

  if (!working) {
    throw new Error(`Invalid implementer config "${entry}": binary name cannot be empty.`);
  }

  const colonCount = (working.match(/:/g) || []).length;
  if (colonCount > 1) {
    throw new Error(`Invalid implementer config "${entry}": too many colons. Expected format: binary[:harness][*]`);
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

  // New suffix flags first: * (first-iteration), ! (no-verdict is IGNORED instead of
  // failing). `base` is then binary[:harness], possibly with a legacy :0/:1 flag.
  const { base, firstIter, noVerdictAsFailure: noVerdFromBang } = stripFlagSuffixes(trimmed);

  const colonCount = (base.match(/:/g) || []).length;
  if (colonCount > 2) {
    throw new Error(`Invalid reviewer config "${entry}": too many colons. Expected format: binary[:harness][!]`);
  }

  // Legacy numeric flag (:0 = ignore no-verdict, :1 = fail). Detected on the last colon.
  let binaryHarness = base;
  let legacyFlag: boolean | undefined;
  const lastColonIndex = base.lastIndexOf(':');
  if (lastColonIndex !== -1) {
    const potentialFlag = base.slice(lastColonIndex + 1);
    if (potentialFlag.length > 0 && /^\d+$/.test(potentialFlag) && potentialFlag !== '0' && potentialFlag !== '1') {
      throw new Error(`Invalid reviewer config "${entry}": reviewer flag must be 0 or 1, got "${potentialFlag}".`);
    }
    if (potentialFlag === '0' || potentialFlag === '1') {
      binaryHarness = base.slice(0, lastColonIndex);
      if (!binaryHarness) {
        throw new Error(`Invalid reviewer config "${entry}": binary name cannot be empty.`);
      }
      legacyFlag = potentialFlag === '1';
    }
  }

  const parsed = parseImplementerConfig(binaryHarness);
  // Precedence: explicit ! wins, else legacy :0/:1, else default (fail on no verdict).
  const noVerdictAsFailure = noVerdFromBang ?? legacyFlag ?? true;
  return { ...parsed, noVerdictAsFailure, firstIterationPreferred: parsed.firstIterationPreferred || firstIter };
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
  reviewLenses: ['general'],
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
  interactive: false,
  agentBackend: 'kteam',
  requireUsageLeft: false,
  stall: { enabled: false, idleThresholdSec: 600, checkIntervalSec: 60, autoAnswer: 'off' },
  implementerRetry: { maxRetries: 2, backoffBaseMs: 5000 },
  reviewerRetry: { maxRetries: 2, backoffBaseMs: 5000 },
  synthesizerRetry: { maxRetries: 2, backoffBaseMs: 5000 },
  verifierRetry: { maxRetries: 2, backoffBaseMs: 5000 },
  checkpointerRetry: { maxRetries: 2, backoffBaseMs: 5000 },
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
export function selectImplementer(config: Config, loopNum?: number, usageWeight?: UsageWeight): string {
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

  // Usage-aware: scale each key by its usage weight (0 ⇒ gated out, fraction ⇒ less likely
  // by weekly headroom). If that zeroes EVERY key (all exhausted), leave weights as-is —
  // the caller is responsible for blocking until reset before getting here.
  if (usageWeight) {
    const keyW = entries.map(([key]) => implementerKeyWeight(key, config.poolProfiles, usageWeight));
    if (keyW.some(w => w > 0)) {
      for (let i = 0; i < effectiveWeights.length; i++) effectiveWeights[i] *= keyW[i];
    }
  }

  const totalWeight = effectiveWeights.reduce((sum, w) => sum + w, 0);
  // Fallback to the LAST key with a positive weight (never a zeroed-out / exhausted one).
  let pickedKey = '';
  for (let i = 0; i < entries.length; i++) if (effectiveWeights[i] > 0) pickedKey = entries[i][0];
  if (totalWeight > 0) {
    let rand = Math.random() * totalWeight;
    for (let i = 0; i < entries.length; i++) {
      rand -= effectiveWeights[i];
      if (effectiveWeights[i] > 0 && rand <= 0) {
        pickedKey = entries[i][0];
        break;
      }
    }
  } else if (entries.length > 0) {
    pickedKey = entries[entries.length - 1][0]; // degenerate (all weights 0): last key
  }
  // An implementer key may name a pool profile — load-balance within it. The suffix
  // flags (* / ::i first-iteration, ! ) only affect the weighted pick above, not the
  // account, so strip them for the profile lookup.
  const base = stripFlagSuffixes(pickedKey).base;
  if (config.poolProfiles && Object.prototype.hasOwnProperty.call(config.poolProfiles, base)) {
    return selectFromPool(base, config.poolProfiles, usageWeight);
  }
  return pickedKey;
}

/** The usage-weight multiplier for an implementer key. A key naming a pool profile takes
 *  the BEST (max) member weight (so a profile with one fresh account stays selectable; the
 *  inner selectFromPool then weights per-account); otherwise the key's own bare binary. */
function implementerKeyWeight(key: string, profiles: PoolProfiles | undefined, usageWeight: UsageWeight): number {
  const base = stripFlagSuffixes(key).base;
  if (profiles && Object.prototype.hasOwnProperty.call(profiles, base)) {
    return Math.max(0, ...Object.keys(profiles[base]).map(account => usageWeight(accountBinary(account))));
  }
  return usageWeight(accountBinary(base));
}

/** Every distinct bare binary an implementer selection could resolve to (pool profiles
 *  expanded). Used to know which accounts to wait on when blocking until reset. */
export function implementerCandidates(config: Config): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(config.implementers)) {
    const base = stripFlagSuffixes(key).base;
    if (config.poolProfiles && Object.prototype.hasOwnProperty.call(config.poolProfiles, base)) {
      for (const account of Object.keys(config.poolProfiles[base])) out.add(accountBinary(account));
    } else {
      out.add(accountBinary(base));
    }
  }
  return [...out];
}

// ============================================================================
// Reviewer/verifier TYPE + POOL helpers
// ============================================================================

/**
 * A reviewer/verifier "type" within a phase: a single binary string, a poolProfile
 * NAME (resolved via PoolProfiles), or an inline weighted pool ({ binary: weight }).
 */
export type ReviewTypeEntry = string | Record<string, number>;

/** Named, reusable account pools. */
export type PoolProfiles = Record<string, Record<string, number>>;

/** True if `entry` is a string that names a defined pool profile. */
function isProfileRef(entry: ReviewTypeEntry, profiles?: PoolProfiles): entry is string {
  return typeof entry === 'string' && !!profiles && Object.prototype.hasOwnProperty.call(profiles, entry);
}

/**
 * Resolve a type entry to a concrete account pool, expanding a profile NAME via
 * poolProfiles. A bare string becomes { binary: 1 }; an inline pool is returned as-is.
 */
export function resolvePool(entry: ReviewTypeEntry, profiles?: PoolProfiles): Record<string, number> {
  if (isProfileRef(entry, profiles)) return profiles![entry];
  if (typeof entry === 'string') return { [entry]: 1 };
  return entry;
}

/** Normalize a type entry to a weighted pool (no profile resolution). */
export function normalizeReviewType(entry: ReviewTypeEntry): Record<string, number> {
  if (typeof entry === 'string') return { [entry]: 1 };
  return entry;
}

/**
 * A short, stable display label for a type. A profile reference shows the profile name;
 * otherwise the parsed binary name(s) (harness/flag stripped), joined "a+b+c".
 */
export function reviewTypeLabel(entry: ReviewTypeEntry, profiles?: PoolProfiles): string {
  if (isProfileRef(entry, profiles)) return entry; // show the profile name
  // Never throw — display-only. Fall back to the raw account if it doesn't parse.
  return Object.keys(normalizeReviewType(entry))
    .map(account => {
      try {
        return parseReviewerConfig(account).binary;
      } catch {
        return account;
      }
    })
    .join('+');
}

/** The bare wrapper name of a pool account (harness/flags stripped); raw on parse failure. */
function accountBinary(account: string): string {
  try {
    return parseReviewerConfig(account).binary;
  } catch {
    return account;
  }
}

/**
 * A per-account WEIGHT MULTIPLIER (≥ 0), keyed by bare binary name. Threaded into pool
 * selection so kloop scales each configured weight by live usage: 0 ⇒ exclude (5h-gated /
 * not logged in / weekly-maxed), a fraction ⇒ proportionally less likely (weekly headroom),
 * 1 ⇒ full configured weight (fresh / unmeasurable).
 */
export type UsageWeight = (binary: string) => number;

/**
 * Pick one account from a type's pool, weighted-random — for LOAD DISTRIBUTION across
 * interchangeable accounts of the same type (distinct from implementer type-rotation).
 * Resolves a profile name via `profiles`. Stateless; picked per invocation.
 *
 * When `usageWeight` is given, each account's pool weight is MULTIPLIED by its usage
 * weight before the draw (so weekly headroom biases the pick and 0-weight accounts drop
 * out). If that zeroes the whole pool (all gated/exhausted), the FULL pool with its
 * original weights is used instead — weighting never makes selection fail; blocking-
 * until-reset is handled by the caller.
 */
export function selectFromPool(entry: ReviewTypeEntry, profiles?: PoolProfiles, usageWeight?: UsageWeight): string {
  const all = Object.entries(resolvePool(entry, profiles));
  if (all.length === 0) throw new Error('Reviewer type pool cannot be empty.');
  let pool = all;
  if (usageWeight) {
    const scaled = all.map(([account, w]) => [account, w * usageWeight(accountBinary(account))] as [string, number]);
    const nonzero = scaled.filter(([, w]) => w > 0);
    pool = nonzero.length > 0 ? nonzero : all; // all gated → fall back to full pool (caller blocks)
  }
  if (pool.length === 1) return pool[0][0];
  const total = pool.reduce((sum, [, w]) => sum + w, 0);
  if (!Number.isFinite(total) || total <= 0) return pool[0][0]; // degenerate/overflow weights
  let rand = Math.random() * total;
  for (const [binary, weight] of pool) {
    rand -= weight;
    if (rand <= 0) return binary;
  }
  return pool[pool.length - 1][0];
}

/**
 * Resolve a single-account role entry (synthesizer / conflict checker) to a concrete
 * account — pool-aware: expands an inline pool or a pool-profile NAME and load-balances
 * per call (same machinery as reviewer/verifier types). Returns undefined when the entry
 * is unset, so each caller keeps its own fallback (primary implementer / loop implementer).
 */
export function selectRoleAccount(
  entry: ReviewTypeEntry | undefined,
  profiles?: PoolProfiles,
  usageWeight?: UsageWeight,
): string | undefined {
  return entry != null ? selectFromPool(entry, profiles, usageWeight) : undefined;
}

// ============================================================================
// Nested config input layer (role blocks → flat Config)
// ============================================================================
//
// The on-disk config is organized into role blocks (implementer / reviewer /
// verifier / synthesizer / checkpointer), a top-level `pools` registry, and a
// `settings` block. Internally kloop uses a FLAT Config, so this flattens the
// nested input into the flat keys the schema expects.
//
// Back-compat: an OLD flat config passes through unchanged. A nested block is only
// recognized when its key holds an OBJECT — the legacy flat `implementer` and
// `synthesizer` keys are STRINGS, so they are left untouched. Nested-derived values
// overwrite any same-named flat key (an explicit block wins).

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Flatten a nested role-block config into the flat key set the schema consumes.
 * Idempotent on already-flat configs (no block keys hold objects → no-op).
 */
export function flattenNestedConfig(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const d = raw;
  const out: Record<string, unknown> = { ...d };

  // pools registry → poolProfiles
  if (isPlainObject(d.pools)) {
    out.poolProfiles = d.pools;
    delete out.pools;
  }

  // implementer block → flat implementer fields (a STRING here is the legacy
  // singular implementer — leave it for the schema's back-compat transform).
  if (isPlainObject(d.implementer)) {
    const im = d.implementer;
    delete out.implementer;
    if (im.pools !== undefined) out.implementers = im.pools;
    if (im.timeout !== undefined) out.implementerTimeout = im.timeout;
    if (im.firstIterationWeightMultiplier !== undefined)
      out.firstIterationWeightMultiplier = im.firstIterationWeightMultiplier;
    if (im.retry !== undefined) out.implementerRetry = im.retry;
  }

  // reviewer block
  if (isPlainObject(d.reviewer)) {
    const rv = d.reviewer;
    delete out.reviewer;
    if (rv.phases !== undefined) out.reviewPhases = rv.phases;
    if (rv.lenses !== undefined) out.reviewLenses = rv.lenses;
    if (rv.lensProfiles !== undefined) out.lensProfiles = rv.lensProfiles;
    if (rv.timeout !== undefined) out.reviewerTimeout = rv.timeout;
    if (rv.firstLoopFullReview !== undefined) out.firstLoopFullReview = rv.firstLoopFullReview;
    if (rv.retry !== undefined) out.reviewerRetry = rv.retry;
  }

  // verifier block
  if (isPlainObject(d.verifier)) {
    const vf = d.verifier;
    delete out.verifier;
    if (vf.phases !== undefined) out.verifyPhases = vf.phases;
    if (vf.timeout !== undefined) out.verifyTimeout = vf.timeout;
    if (vf.enabled !== undefined) out.verify = vf.enabled;
    if (vf.retry !== undefined) out.verifierRetry = vf.retry;
  }

  // synthesizer block → flat. A STRING here is the legacy synthesizer binary, and a bare
  // inline pool ({ binary: weight }) is a flat synthesizer value — both pass through. Only a
  // block carrying recognized keys (pool/timeout/enabled) is unwrapped here. Without this
  // guard an inline pool would be mistaken for a block and silently dropped (it has no `.pool`).
  if (
    isPlainObject(d.synthesizer) &&
    ('pool' in d.synthesizer || 'timeout' in d.synthesizer || 'enabled' in d.synthesizer || 'retry' in d.synthesizer)
  ) {
    const sy = d.synthesizer;
    delete out.synthesizer;
    if (sy.pool !== undefined) out.synthesizer = sy.pool;
    if (sy.timeout !== undefined) out.synthesisTimeout = sy.timeout;
    if (sy.enabled !== undefined) out.synthesis = sy.enabled;
    if (sy.retry !== undefined) out.synthesizerRetry = sy.retry;
  }

  // checkpointer block
  if (isPlainObject(d.checkpointer)) {
    const cp = d.checkpointer;
    delete out.checkpointer;
    if (cp.pool !== undefined) out.conflictChecker = cp.pool;
    if (cp.threshold !== undefined) out.conflictCheckThreshold = cp.threshold;
    if (cp.retry !== undefined) out.checkpointerRetry = cp.retry;
  }

  // settings block
  if (isPlainObject(d.settings)) {
    const st = d.settings;
    delete out.settings;
    if (st.synthesis !== undefined) out.synthesis = st.synthesis;
    if (st.verify !== undefined) out.verify = st.verify;
    if (st.rerankAfterCheckpoint !== undefined) out.rerankAfterCheckpoint = st.rerankAfterCheckpoint;
    if (st.previousReviewPropagation !== undefined) out.previousReviewPropagation = st.previousReviewPropagation;
    if (st.compressSpec !== undefined) out.compressSpec = st.compressSpec;
    if (st.snapshot !== undefined) out.snapshot = st.snapshot;
    if (st.interactive !== undefined) out.interactive = st.interactive;
    if (st.requireUsageLeft !== undefined) out.requireUsageLeft = st.requireUsageLeft;
    if (st.usageEndpoint !== undefined) out.usageEndpoint = st.usageEndpoint;
    if (st.usageFiveHourFloorPercent !== undefined) out.usageFiveHourFloorPercent = st.usageFiveHourFloorPercent;
    if (st.stall !== undefined) out.stall = st.stall;
  }

  return out;
}

/**
 * Re-nest a flat config into the role-block layout (inverse of flattenNestedConfig).
 * Used by the v1→v2 migration to rewrite an on-disk config into the new structure.
 * Only emits a block / key when the corresponding flat value is present.
 */
export function nestFlatConfig(flat: Record<string, unknown>): Record<string, unknown> {
  const d = flat;
  const out: Record<string, unknown> = {};

  // Top-level essentials first (configVersion, then the one knob that matters most).
  if (d.configVersion !== undefined) out.configVersion = d.configVersion;
  if (d.maxIterations !== undefined) out.maxIterations = d.maxIterations;

  // PROFILES section: pools registry + lens definitions (grouped together, top-level).
  if (d.poolProfiles !== undefined) out.pools = d.poolProfiles;
  if (d.lensProfiles !== undefined) out.lensProfiles = d.lensProfiles;

  // implementer
  const implementers = d.implementers ?? (typeof d.implementer === 'string' ? { [d.implementer]: 1 } : undefined);
  const implementer: Record<string, unknown> = {};
  if (implementers !== undefined) implementer.pools = implementers;
  if (d.implementerTimeout !== undefined) implementer.timeout = d.implementerTimeout;
  if (d.firstIterationWeightMultiplier !== undefined)
    implementer.firstIterationWeightMultiplier = d.firstIterationWeightMultiplier;
  if (d.implementerRetry !== undefined) implementer.retry = d.implementerRetry;
  if (Object.keys(implementer).length > 0) out.implementer = implementer;

  // reviewer
  const reviewer: Record<string, unknown> = {};
  if (d.reviewPhases !== undefined) reviewer.phases = d.reviewPhases;
  if (d.reviewLenses !== undefined) reviewer.lenses = d.reviewLenses;
  // lensProfiles is emitted top-level in the PROFILES section above (not nested here).
  if (d.reviewerTimeout !== undefined) reviewer.timeout = d.reviewerTimeout;
  if (d.firstLoopFullReview !== undefined) reviewer.firstLoopFullReview = d.firstLoopFullReview;
  if (d.reviewerRetry !== undefined) reviewer.retry = d.reviewerRetry;
  if (Object.keys(reviewer).length > 0) out.reviewer = reviewer;

  // verifier
  const verifier: Record<string, unknown> = {};
  if (d.verifyPhases !== undefined) verifier.phases = d.verifyPhases;
  if (d.verifyTimeout !== undefined) verifier.timeout = d.verifyTimeout;
  if (d.verifierRetry !== undefined) verifier.retry = d.verifierRetry;
  if (Object.keys(verifier).length > 0) out.verifier = verifier;

  // synthesizer
  const synthesizer: Record<string, unknown> = {};
  if (d.synthesizer !== undefined) synthesizer.pool = d.synthesizer;
  if (d.synthesisTimeout !== undefined) synthesizer.timeout = d.synthesisTimeout;
  if (d.synthesizerRetry !== undefined) synthesizer.retry = d.synthesizerRetry;
  if (Object.keys(synthesizer).length > 0) out.synthesizer = synthesizer;

  // checkpointer
  const checkpointer: Record<string, unknown> = {};
  if (d.conflictChecker !== undefined) checkpointer.pool = d.conflictChecker;
  if (d.conflictCheckThreshold !== undefined) checkpointer.threshold = d.conflictCheckThreshold;
  if (d.checkpointerRetry !== undefined) checkpointer.retry = d.checkpointerRetry;
  if (Object.keys(checkpointer).length > 0) out.checkpointer = checkpointer;

  // settings
  const settings: Record<string, unknown> = {};
  if (d.synthesis !== undefined) settings.synthesis = d.synthesis;
  if (d.verify !== undefined) settings.verify = d.verify;
  if (d.rerankAfterCheckpoint !== undefined) settings.rerankAfterCheckpoint = d.rerankAfterCheckpoint;
  if (d.previousReviewPropagation !== undefined) settings.previousReviewPropagation = d.previousReviewPropagation;
  if (d.compressSpec !== undefined) settings.compressSpec = d.compressSpec;
  if (d.snapshot !== undefined) settings.snapshot = d.snapshot;
  if (d.interactive !== undefined) settings.interactive = d.interactive;
  if (d.requireUsageLeft !== undefined) settings.requireUsageLeft = d.requireUsageLeft;
  if (d.usageEndpoint !== undefined) settings.usageEndpoint = d.usageEndpoint;
  if (d.usageFiveHourFloorPercent !== undefined) settings.usageFiveHourFloorPercent = d.usageFiveHourFloorPercent;
  if (d.stall !== undefined) settings.stall = d.stall;
  if (Object.keys(settings).length > 0) out.settings = settings;

  // prompts (top-level in both layouts)
  if (d.prompts !== undefined) out.prompts = d.prompts;

  return out;
}

export function parseRawConfig(data: unknown): Config {
  // Flatten the nested role-block layout into flat keys first (old flat configs are a
  // no-op here). Everything below operates on the flattened object.
  const flat = flattenNestedConfig(data);
  // Reject dangerous poolProfiles key names before Zod's z.record silently strips them
  // (a profile literally named __proto__/constructor/prototype would otherwise vanish and
  // its references would resolve to a bogus binary). Checked on the flattened input.
  if (flat && typeof flat === 'object') {
    const pp = (flat as Record<string, unknown>).poolProfiles;
    if (pp && typeof pp === 'object') {
      for (const reserved of ['__proto__', 'constructor', 'prototype']) {
        if (Object.prototype.hasOwnProperty.call(pp, reserved)) {
          throw new Error(`poolProfiles name "${reserved}" is reserved — choose a different name.`);
        }
      }
    }
  }
  // Parse with the schema that handles backwards compat transform
  const result = configSchema.safeParse(flat);
  if (!result.success) {
    // Fallback: try the resolved schema directly
    return resolvedConfigSchema.parse(flat);
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

  // Implementer stall detection (specs/implementer-stall-detection)
  IMPLEMENTER_STALL: 'implementer_stall',
  IMPLEMENTER_STALL_END: 'implementer_stall_end',
  IMPLEMENTER_STALL_AUTOANSWERED: 'implementer_stall_autoanswered',

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
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
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
  reviewerIndex?: number; // global reviewer index in the loop (matrix slot identity)
  lens?: string; // review lens (e.g. quality, completion) — omitted for legacy single-lens
  reviewType?: string; // type label (the account pool this reviewer was drawn from)
}

export interface ReviewerEndEvent extends BaseEvent {
  type: typeof EVENT_TYPES.REVIEWER_END;
  loop: number;
  phase: number;
  reviewer: string;
  harness?: HarnessType;
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
  exitCode: number;
  durationMs: number;
  error?: string; // 'timeout' | 'no_verdict' | 'exit_code_N'
  verdict?: string; // 'approved' | 'rejected'
  completionEstimate?: number;
  propagated?: boolean; // true if this reviewer received previous loop reviews
  reviewerIndex?: number; // global reviewer index in the loop (matrix slot identity)
  lens?: string; // review lens
  reviewType?: string; // type label (account pool)
  retryAttempt?: number; // 0-indexed attempt that produced this result (0 = first try)
  maxRetries?: number; // configured retry budget for this role
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
  binary?: string;
  harness?: HarnessType;
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
  outcome: 'conflict_found' | 'spec_auto_fixed' | 'spec_compressed' | 'no_action';
  summary: string;
  progressPercent?: number;
  durationMs: number;
  exitCode: number;
  retryAttempt?: number; // 0-indexed attempt that produced this result (0 = first try)
  maxRetries?: number; // configured retry budget for this role
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
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
  exitCode: number;
  durationMs: number;
  error?: string;
  verdict?: string;
  retryAttempt?: number; // 0-indexed attempt that produced this result (0 = first try)
  maxRetries?: number; // configured retry budget for this role
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
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
  exitCode: number;
  durationMs: number;
  error?: string;
  summaryPath?: string;
  retryAttempt?: number; // 0-indexed attempt that produced this result (0 = first try)
  maxRetries?: number; // configured retry budget for this role
}

// Loop end event
export interface LoopEndEvent extends BaseEvent {
  type: typeof EVENT_TYPES.LOOP_END;
  loop: number;
  durationMs: number;
}

// Implementer stall detection — a stall MUST produce an event: `kloop wait`
// parks on events.jsonl, and silence is indistinguishable from progress.
export interface ImplementerStallEvent extends BaseEvent {
  type: typeof EVENT_TYPES.IMPLEMENTER_STALL;
  loop: number;
  /** Why the stall fired. */
  reason: 'confirm-dialog' | 'idle';
  /** Ms of no observed activity when the stall fired. */
  idleMs: number;
  /** Captured dialog/pane tail text (for confirm-dialog: the dialog itself). */
  dialogText?: string;
}

export interface ImplementerStallEndEvent extends BaseEvent {
  type: typeof EVENT_TYPES.IMPLEMENTER_STALL_END;
  loop: number;
  /** How the stall cleared: activity resumed, auto-answered, or the agent finished. */
  resolution: 'activity' | 'autoanswer' | 'agent-exit';
  stalledForMs: number;
}

export interface ImplementerStallAutoAnsweredEvent extends BaseEvent {
  type: typeof EVENT_TYPES.IMPLEMENTER_STALL_AUTOANSWERED;
  loop: number;
  /** The keys sent to the pane (e.g. "1"). */
  answer: string;
  /** The dialog text that was auto-answered — the run record must show the intervention. */
  dialogText: string;
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
  | ImplementerStallEvent
  | ImplementerStallEndEvent
  | ImplementerStallAutoAnsweredEvent
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
  /** Implementer stall detection — present only while stalled. */
  stalled?: boolean;
  stallReason?: 'confirm-dialog' | 'idle';
  stalledSinceMs?: number;
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
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
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
  // Matrix review: which lens this reviewer applied + which type (account pool) it belongs to
  lens?: string;
  reviewType?: string;
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
  harness?: HarnessType;
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
  retryAttempt?: number; // 0-indexed attempt that produced this result (0 = first try)
  retryMax?: number; // configured retry budget for this role
}

export interface MaterializedCheckpoint {
  binary?: string;
  harness?: HarnessType;
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
  status: 'running' | 'completed';
  startedAt?: string;
  completedAt?: string;
  outcome?: 'conflict_found' | 'spec_auto_fixed' | 'spec_compressed' | 'no_action';
  summary?: string;
  progressPercent?: number;
  durationMs?: number;
  exitCode?: number;
  retryAttempt?: number; // 0-indexed attempt that produced this result (0 = first try)
  retryMax?: number; // configured retry budget for this role
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

  // Implementer stall detection (run-level: at most one implementer runs at a
  // time, and consumers — wait/ps/status — want it without digging into loops).
  stalled?: boolean;
  stalledSinceMs?: number;
  stallReason?: 'confirm-dialog' | 'idle';
  /** Captured dialog/pane tail from the stall event. */
  stallDialogText?: string;

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
    model?: string;
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
      model?: string;
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
      model?: string;
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
    harness?: HarnessType;
    model?: string;
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
