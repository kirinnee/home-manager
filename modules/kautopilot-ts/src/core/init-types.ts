// ============================================================================
// Init Lifecycle Types
// ============================================================================

/**
 * Init state machine states.
 * Maps to spec section 3 phases + section 8.3 state machine.
 */
export type InitState =
  | 'identify'
  | 'research'
  | 'detect'
  | 'gather_context'
  | 'normalize'
  | 'generate'
  | 'verify'
  | 'promote'
  | 'downgrade_local'
  | 'failed'
  | 'cancelled';

/**
 * Init outcome classification (spec section 6).
 */
export type InitOutcome = 'promoted' | 'promoted_degraded' | 'downgraded_local' | 'cancelled' | 'failed' | 'abandoned';

/**
 * Init attempt row in the init tracking DB.
 */
export interface InitAttemptRow {
  id: string;
  repo_path: string;
  worktree: string;
  git_root: string;
  git_root_host: string;
  org: string | null;
  outcome: InitOutcome | null;
  promoted_session_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Init status — materialized from WAL, analogous to SessionStatus.
 * Spec section 8.5.
 */
export interface InitStatus {
  // Replay metadata
  walCursor: number;
  walTimestamp: string;

  // Current position
  state: InitState;
  stateStatus: 'pending' | 'running' | 'completed' | 'failed';

  // Process
  pid: number | null;
  running: boolean;
  startedAt: string | null;

  // Setup context (survives crash recovery)
  context: {
    systemName?: string;
    accessMethod?: string;
    stateMapping?: string;
    quirks?: string;
    setupAssessment?: string;
    detectedTools?: Record<string, string>;
    ticketId?: string;
    branch?: string;
    deliveryKind?: 'pr' | 'ticket';
    localMode?: boolean;
    repairAttempts?: number;
    maxRepairAttempts?: number;
  };

  // Completed states for resume
  completedStates: InitState[];

  // Final outcome
  outcome: InitOutcome | null;
}

/**
 * Identify phase artifact.
 */
export interface IdentifyArtifact {
  systemName: string;
  timestamp: string;
}

/**
 * Research phase normalized summary.
 */
export interface ResearchSummary {
  systemName: string;
  accessPaths: Array<{
    method: string;
    tool?: string;
    available: boolean;
    notes?: string;
  }>;
  hierarchy: string;
  transitionModel: string;
  constraints: string[];
  detectionPlan: Array<{
    check: string;
    type: 'binary' | 'config' | 'auth' | 'cli_test';
    command?: string;
  }>;
  detectedTools: Record<string, string>;
  followUpQuestions: string[];
  timestamp: string;
}

/**
 * Detection result.
 */
export interface DetectionResult {
  tools: Record<string, string>;
  configFiles: Record<string, boolean>;
  authStatus: Record<string, 'authenticated' | 'not_authenticated' | 'unknown'>;
  available: string[];
  missing: string[];
  uncertain: string[];
  timestamp: string;
}

/**
 * Setup brief (spec section 3.5).
 */
export interface SetupBrief {
  systemName: string;
  chosenAccessPath: string;
  readiness: 'ready' | 'partial' | 'not_ready';
  confidence: 'high' | 'medium' | 'low';
  hierarchy: string;
  defaults: Record<string, string>;
  stateMapping: {
    todo: string;
    inProgress: string;
    inReview: string;
    noOp: boolean;
  };
  quirks: string[];
  requiredCapabilities: string[];
  noOpCapabilities: string[];
  timestamp: string;
}

/**
 * Verification result.
 */
export interface VerifyResult {
  extractTicket: { ok: boolean; ticketId: string | null; error?: string };
  getTicket: { ok: boolean; contentLength: number; error?: string };
  nonCritical: Record<string, { ok: boolean; noOp: boolean; error?: string }>;
  repairAttempts: number;
  timestamp: string;
}

/**
 * Outcome artifact (spec section 3.7).
 */
export interface OutcomeArtifact {
  outcome: InitOutcome;
  promotedSessionId: string | null;
  criticalScriptsWorking: boolean;
  degradedCapabilities: string[];
  manualActions: string[];
  timestamp: string;
}

/**
 * Capability classification (spec section 4.2).
 */
export const CRITICAL_CAPABILITIES = ['extract-ticket', 'get-ticket'] as const;
export const NON_CRITICAL_CAPABILITIES = [
  'start-ticket',
  'to-review',
  'revert-to-inprogress',
  'update-ticket',
  'create-downstream-ticket',
  'add-comment',
  'move-to-todo',
  'attach-artifact',
] as const;

export const MAX_REPAIR_ATTEMPTS = 3;
