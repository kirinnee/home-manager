// Client-side mirrors of the shapes `kloop serve` emits (src/server/data.ts +
// src/server/config.ts). Kept intentionally loose — the server is the source of truth.

export type RunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'conflict'
  | 'agent_failure'
  | 'crashed';

export interface RunListItem {
  id: string;
  workspace: string;
  status: RunStatus;
  loop: number;
  maxIterations?: number;
  phase?: string;
  exitReason?: string;
  startedAt: string;
  elapsedMs: number;
  endedAt?: string;
}

export type AgentStatus = 'pending' | 'running' | 'completed' | 'error' | 'timeout';

export interface AgentState {
  binary: string;
  harness?: string;
  model?: string;
  status: AgentStatus;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  durationMs?: number;
  error?: string;
  verdict?: string;
  completionEstimate?: number;
  inputTokens?: number;
  outputTokens?: number;
  propagated?: boolean;
  lens?: string;
  reviewType?: string;
  retryAttempt?: number;
  retryMax?: number;
}

export interface ReviewPhase {
  phase: number;
  startedAt?: string;
  completedAt?: string;
  shortCircuited?: boolean;
  reviewers: AgentState[];
}

export interface Checkpoint {
  binary?: string;
  harness?: string;
  model?: string;
  status: string;
  outcome?: string;
  summary?: string;
  progressPercent?: number;
  durationMs?: number;
}

export interface LoopState {
  loop: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  implementer?: AgentState;
  reviewPhases: ReviewPhase[];
  verifyPhases?: ReviewPhase[];
  synthesis?: AgentState;
  checkpoint?: Checkpoint;
}

export interface RunDetail {
  id: string;
  workspace: string;
  status: RunStatus;
  loop: number;
  maxIterations?: number;
  synthesis?: boolean;
  verify?: boolean;
  startedAt: string;
  elapsedMs: number;
  exitCode?: number;
  exitReason?: string;
  failures?: number;
  failureThreshold?: number;
  loops: LoopState[];
  config?: KloopConfig | null;
}

export interface RunSession {
  id: string;
  name: string;
  binary?: string;
  status?: string;
  model?: string;
  updatedAt?: string;
}

export interface RunSessionsResponse {
  kteamBase: string;
  sessions: RunSession[];
}

// A subset of the resolved config the form edits (server applies the rest as defaults).
export interface KloopConfig {
  configVersion?: number;
  implementers: Record<string, number>;
  reviewPhases: unknown[][];
  reviewLenses: string[];
  verifyPhases: unknown[][];
  synthesizer?: unknown;
  conflictChecker?: unknown;
  poolProfiles?: Record<string, Record<string, number>>;
  maxIterations: number;
  implementerTimeout: number;
  reviewerTimeout: number;
  synthesisTimeout: number;
  verifyTimeout: number;
  conflictCheckThreshold: number;
  compressSpec: boolean;
  firstLoopFullReview: boolean;
  previousReviewPropagation: number;
  synthesis: boolean;
  verify: boolean;
  rerankAfterCheckpoint: boolean;
  snapshot: boolean;
  firstIterationWeightMultiplier: number;
  [k: string]: unknown;
}

export interface ConfigChangeNote {
  at: string;
  summary: string;
  fields: string[];
}

export interface ConfigResponse {
  path: string;
  exists: boolean;
  yaml: string;
  config: KloopConfig | null;
  flat: Record<string, unknown> | null;
  wrappers: string[];
  mtimeMs: number | null;
  lastChange: ConfigChangeNote | null;
}

export interface ConfigEditResult {
  ok: boolean;
  error?: string;
  change?: ConfigChangeNote;
  config?: KloopConfig | null;
}
