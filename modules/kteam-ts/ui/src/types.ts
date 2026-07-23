// Mirror of modules/kteam-ts/src/types.ts. Keep narrow; the daemon is the
// source of truth, this file just gives us autocomplete and shape checks.

export type Harness = 'claude' | 'codex';
export type InteractionMode = 'auto' | 'interactive';

export type SessionStatus =
  | 'created'
  | 'starting'
  | 'running'
  | 'thinking'
  | 'tool_running'
  | 'awaiting_question'
  | 'awaiting_user'
  | 'interrupted'
  | 'rate_limited'
  | 'retrying'
  | 'kill_failed'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stalled'
  | 'stopped';

export interface PendingQuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  toolUseId: string;
  questions: Array<{
    question: string;
    header?: string;
    options?: PendingQuestionOption[];
    multiSelect?: boolean;
  }>;
}

export interface SessionConfig {
  id: string;
  name: string;
  teammate?: string;
  label?: string;
  binary: string;
  harness: Harness;
  modelHint: string;
  model?: string;
  mode: InteractionMode;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  turn: number;
  harnessSessionId: string;
  harnessHome?: string;
  tmuxSession: string;
  watcherSession: string;
  intervalSeconds: number;
  stallSeconds: number;
  timeoutSeconds: number;
  maxSnapshots: number;
  systemPromptFile: string;
  originalPromptFile: string;
  transcriptFile?: string;
  retry?: {
    transientAttempts: number;
    stalledAttempts: number;
    waitForQuotaReset: boolean;
    allowAccountFailover: boolean;
  };
}

export interface SessionState {
  id: string;
  status: SessionStatus;
  turn: number;
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  lastActivityAt?: string;
  lastSnapshotAt?: string;
  lastDiffAt?: string;
  exitCode?: number;
  reason?: string;
  health?: 'healthy' | 'thinking' | 'waiting' | 'idle' | 'stalled' | 'rate_limited' | 'crashed' | 'unknown';
  promptReady?: boolean;
  openTools?: string[];
  pendingQuestion?: PendingQuestion | null;
  contextPercent?: number;
  activity?: string;
  lastToolStartedAt?: string;
  /** A6 liveness ledger (see src/liveness.ts): per-life-sign timestamps. */
  lastTranscriptAt?: string;
  lastPaneAt?: string;
  lastCounterAdvanceAt?: string;
  lastTokenAdvanceAt?: string;
  lastSubprocessAt?: string;
  subprocessSince?: string;
  nudgedAt?: string;
  retryAttempt?: number;
  turnCompleted?: boolean;
  quota?: {
    atLimit?: boolean;
    authOk?: boolean;
    fiveHourPercent?: number;
    weeklyPercent?: number;
    resetAt?: number;
  };
}

export interface SessionView {
  config: SessionConfig;
  state: SessionState;
  directory: string;
}

// ============================================================================
// Chat records (normalized, both harnesses)
//
// Extra metadata fields the daemon also emits (recordUuid, messageId, itemType,
// etc.) are captured in the index signature — render code must never crash on
// unknown record shapes.
// ============================================================================

export interface ChatRecordUser {
  source: 'claude' | 'codex';
  timestamp?: string;
  type: 'chat.user';
  data: { text: string };
}

export interface ChatRecordAssistantText {
  source: 'claude' | 'codex';
  timestamp?: string;
  type: 'chat.assistant.text';
  data: { text: string };
}

export interface ChatRecordAssistantThinking {
  source: 'claude' | 'codex';
  timestamp?: string;
  type: 'chat.assistant.thinking';
  data: { thinking: string };
}

export interface ChatRecordAssistantReasoning {
  source: 'claude' | 'codex';
  timestamp?: string;
  type: 'chat.assistant.reasoning';
  data: { reasoning: string };
}

export interface ChatRecordToolUse {
  source: 'claude' | 'codex';
  timestamp?: string;
  type: 'tool.use';
  data: {
    toolUseId?: string;
    name?: string;
    input?: unknown;
    id?: string;
  };
}

export interface ChatRecordToolResult {
  source: 'claude' | 'codex';
  timestamp?: string;
  type: 'tool.result';
  data: {
    toolUseId?: string;
    content?: unknown;
    text?: string;
    isError?: boolean;
    [k: string]: unknown;
  };
}

export interface ChatRecordTurnStarted {
  source: 'claude' | 'codex';
  timestamp?: string;
  type: 'turn.started' | 'turn.completed' | 'turn.aborted';
  data?: unknown;
}

export interface ChatRecordInteraction {
  source: 'claude' | 'codex';
  timestamp?: string;
  type: 'interaction.question' | 'interaction.answer';
  data?: unknown;
}

export interface ChatRecordUnknown {
  source?: 'claude' | 'codex' | string;
  timestamp?: string;
  type: string;
  data?: unknown;
  [k: string]: unknown;
}

export type ChatRecord =
  | ChatRecordUser
  | ChatRecordAssistantText
  | ChatRecordAssistantThinking
  | ChatRecordAssistantReasoning
  | ChatRecordToolUse
  | ChatRecordToolResult
  | ChatRecordTurnStarted
  | ChatRecordInteraction
  | ChatRecordUnknown;

export interface ChatHistoryPage {
  total: number;
  offset: number;
  records: ChatRecord[];
}

export type EventSource = 'daemon' | 'claude' | 'codex' | 'tmux' | 'client' | 'watcher';

export interface KTeamEvent<T = unknown> {
  sequence: number;
  time: string;
  sessionId: string;
  turn?: number;
  type: string;
  source: EventSource;
  data: T;
}

export interface TerminalFrameData {
  activity?: string;
  contextPercent?: number;
  promptReady?: boolean;
  [k: string]: unknown;
}

// ============================================================================
// Warden fleet-health ("checks"). Mirror of the daemon's WardenStatusView —
// rendered defensively: every field is optional so an older daemon that omits
// the route (or fields) degrades to "hidden" rather than crashing.
// ============================================================================

export interface WardenAnomaly {
  kind: string;
  sessionId: string;
  teammate?: string;
  label?: string;
  status?: string;
  detail?: string;
  since?: string;
  idleMinutes?: number;
  [k: string]: unknown;
}

// New-session flow: wrappers + projects (mirrors src/fleet-inventory.ts).
export interface WrapperInfo {
  name: string;
  harness: Harness;
  mode: 'auto' | 'interactive';
  launchable: boolean;
  modelHint: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  lastActivity?: string;
}

export interface StartSessionPayload {
  prompt: string;
  agent: string;
  cwd?: string;
  mode?: InteractionMode;
  model?: string;
  label?: string;
  name?: string;
}

export type WardenVerdictKind = 'killed' | 'revived' | 'nudged' | 'cleared' | 'needs_human' | 'unknown';

export interface WardenVerdict {
  at: string;
  targetSession?: string;
  teammate?: string;
  label?: string;
  verdict: WardenVerdictKind;
  reason?: string;
  reportPath: string;
}

export interface WardenStatusView {
  config?: {
    enabled?: boolean;
    wrapper?: string;
    intervalMinutes?: number;
    [k: string]: unknown;
  };
  lastSweepAt?: string;
  anomalies?: WardenAnomaly[];
  liveWarden?: string;
  lastSpawnAt?: string;
  lastReport?: { path: string; head: string };
  [k: string]: unknown;
}
