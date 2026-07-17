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

export interface SessionConfig {
  id: string;
  name: string;
  /** Auto-assigned human callsign (e.g. "mordecai") — accepted anywhere an id
   *  is; unique only among sessions created in the last 5 days. */
  teammate?: string;
  binary: string;
  harness: Harness;
  modelHint: string;
  /** Model passed to the harness via `--model`. User `--model` overrides the
   *  kfleet default (KTEAM_MODEL exported by the wrapper); undefined => omit the
   *  flag and let the wrapper keep its own default. */
  model?: string;
  mode: InteractionMode;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  turn: number;
  harnessSessionId: string;
  harnessHome?: string;
  harnessSessionBaseline?: string[];
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
  pendingQuestion?: {
    toolUseId: string;
    questions: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  };
  transcriptOffset?: number;
  lastTranscriptAt?: string;
  lastPaneAt?: string;
  /** Context-window usage (percent used) parsed from the TUI statusline. */
  contextPercent?: number;
  /** When the most recent tool started, from the transcript — distinguishes
   *  real work from a wedged hook that both render as "Working". */
  lastToolStartedAt?: string;
  quota?: {
    atLimit?: boolean;
    authOk?: boolean;
    fiveHourPercent?: number;
    weeklyPercent?: number;
    resetAt?: number;
  };
  retryAttempt?: number;
  /** True only after the harness transcript records the current turn ending. */
  turnCompleted?: boolean;
}

export interface KTeamEvent<T = unknown> {
  sequence: number;
  time: string;
  sessionId: string;
  turn: number;
  type: string;
  source: 'daemon' | 'claude' | 'codex' | 'tmux' | 'client' | 'watcher';
  data: T;
}

export interface StartSessionRequest {
  prompt: string;
  agent: string;
  name?: string;
  cwd?: string;
  mode?: InteractionMode;
  /** Override the model. When omitted, kteam feeds the wrapper's kfleet default
   *  (KTEAM_MODEL); when that too is absent, no `--model` flag is passed. */
  model?: string;
  intervalSeconds?: number;
  stallSeconds?: number;
  timeoutSeconds?: number;
  maxSnapshots?: number;
  initialAttachments?: Array<{
    filename: string;
    mime?: string;
    base64: string;
  }>;
}

export interface SendRequest {
  message: string;
  attachmentIds?: string[];
}

export interface Recommendation {
  binary: string;
  role: string;
  reason: string;
}
