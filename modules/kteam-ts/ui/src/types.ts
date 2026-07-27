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
  /** The kteam session that STARTED this one (auto-captured from the caller's
   *  KTEAM_SESSION_ID pane env) — teammates spawning teammates form a tree. */
  parent?: string;
  binary: string;
  harness: Harness;
  modelHint: string;
  model?: string;
  mode: InteractionMode;
  /** Launched with Remote Control (claude only): the session is also visible
   *  and steerable in the users RC surface. */
  remoteControl?: boolean;
  harnessFlags?: string[];
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
  /** The session's Remote Control surface (claude + `--rc`), from the harness's
   *  own bridge_status transcript record. Sticky for the session's whole life. */
  remoteControlUrl?: string;
  openTools?: string[];
  pendingQuestion?: PendingQuestion | null;
  contextPercent?: number;
  /** Account quota for THIS session's wrapper, projected from the daemon's
   *  cached `kfleet usage` feed (refreshed on kfleet's own 300s interval).
   *  Percent USED, so higher is worse — the same polarity as contextPercent.
   *  Every field is optional and is simply absent when the feed has no record
   *  for the wrapper: a missing quota must read as "unknown", never as 0%. */
  usage5hPercent?: number;
  usageWeeklyPercent?: number;
  /** Epoch ms when each window rolls over. */
  usage5hResetAt?: number;
  usageWeeklyResetAt?: number;
  usageAtLimit?: boolean;
  /** false ⇒ the wrapper is not authenticated; show that, not a percentage. */
  usageAuthOk?: boolean;
  /** The model the harness itself most recently reported. This is runtime
   * ground truth; config.model is only the launch-time request and can be an
   * alias that the account resolved differently. */
  observedModel?: string;
  /** Timestamp of the last harness record that actually supplied model
   * evidence. A local `/model` command alone does not advance it. */
  observedModelAt?: string;
  /** The reasoning effort Codex itself last reported. It is not a requested
   * setting and is deliberately absent for Claude, whose installed runtime has
   * no reliable in-session effort control here. */
  observedReasoningEffort?: string;
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
  needsHuman?: string;
  needsHumanKind?: string;
  retryAttempt?: number;
  turnCompleted?: boolean;
  /** A DECLARED wait (`kteam signal waiting`): parked on an external condition
   *  with the daemon holding the deadline — NOT a question waiting on a human. */
  waiting?: {
    since: string;
    until?: string;
    condition?: string;
    /** PEER WAIT: parked awaiting a reply from this kteam session. Healthy —
     *  the daemon ends the park the moment that peer sends back. */
    peer?: string;
    /** The peer's teammate callsign, so the UI can name it without a lookup. */
    peerName?: string;
  };
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
// Account quota — GET /v1/usage
//
// The daemon's cached `kfleet usage` snapshot, one record per wrapper binary.
// Session STATE also carries usage fields, but only after that session's
// monitor loop has run its 60s quota tick, so it is blank for anything idle,
// newly launched, or terminal. This feed is the same fact for every session
// and is available at once; the UI joins it onto `config.binary` and prefers
// whichever source actually has a number (see lib/usage.ts).
//
// Absent field = UNKNOWN. Never render a missing value as 0%.
// ============================================================================

export interface UsageAccountView {
  binary: string;
  fiveHourPercent?: number;
  weeklyPercent?: number;
  fiveHourResetAt?: number;
  weeklyResetAt?: number;
  atLimit?: boolean;
  /** false ⇒ the wrapper needs logging in; that is not a quota reading. */
  authOk?: boolean;
}

export interface UsageFeedView {
  /** ISO time of the daemon's last successful refresh, when it has had one. */
  at?: string;
  /** True before the first successful refresh — show "no data", not zeros. */
  stale: boolean;
  accounts: UsageAccountView[];
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
export interface RuntimeModelOption {
  /** Exact account-valid value sent to the harness's native /model command. */
  value: string;
  /** Human-readable account-valid model name. */
  label: string;
}

export interface WrapperInfo {
  name: string;
  harness: Harness;
  mode: 'auto' | 'interactive';
  launchable: boolean;
  modelHint: string;
  /** Present only when the daemon can safely advertise this wrapper's native
   * in-place Claude model choices. Absence is deliberately not a fallback to a
   * global catalog: provider accounts have different valid model sets. */
  runtimeModels?: RuntimeModelOption[];
}

export interface ProjectInfo {
  name: string;
  path: string;
  lastActivity?: string;
}

export interface StartSessionPayload {
  /** Optional for interactive mode: a bare start brings the TUI up with
   *  nothing typed into it. */
  prompt?: string;
  agent: string;
  cwd?: string;
  mode?: InteractionMode;
  model?: string;
  label?: string;
  name?: string;
  /** Omit to take the daemons default (on for claude). */
  remoteControl?: boolean;
}

export interface SearchResult {
  sessionId: string;
  teammate?: string;
  turn?: number;
  snippet: string;
  at?: string;
}

export interface SearchResponse {
  query: string;
  scanned: number;
  results: SearchResult[];
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
