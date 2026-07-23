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
  /** Caller-supplied ownership label (e.g. the lead session/repo/ticket slug)
   *  so a lead can list only its own teammates: `kteam ps --label <label>`. */
  label?: string;
  /** The kteam session that STARTED this one (auto-captured from the caller's
   *  KTEAM_SESSION_ID pane env) — teammates spawning teammates form a tree. */
  parent?: string;
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
  /** Assigned-warden stop capability: an unguessable secret minted when this
   *  (warden) session was spawned for a sus target, exported into its pane as
   *  KTEAM_STOP_CAPABILITY, and required by the api-server to authorize
   *  `stop` on the assigned target. Same-user filesystem access is the
   *  accepted threat-model exception (documented in daemon-config.ts). */
  stopCapability?: string;
  intervalSeconds: number;
  /** Legacy stall knob — superseded by nudgeAfterSeconds/killAfterSeconds but
   *  kept on old configs; the monitor falls back to it when the new knobs are
   *  absent (nudge at 3/5 of it, kill at it). */
  stallSeconds: number;
  timeoutSeconds: number;
  /** A6 reflex: zero life-signs (no transcript growth, no pane change, no
   *  subprocess) this long → one nudge (interrupt + continue message). */
  nudgeAfterSeconds?: number;
  /** A6 reflex: zero life-signs this long (nudge didn't revive any) → kill. */
  killAfterSeconds?: number;
  /** Short-direct sends: a single-line no-attachment payload at most this
   *  long is TYPED verbatim into the composer instead of the turn-file
   *  indirection. 0 disables direct sends. Default 500. */
  directSendMaxChars?: number;
  /** How to answer Claude Code's large-session resume gate ("Resume from
   *  summary (recommended)" / "Resume full session as-is"). Default 'full'
   *  for fidelity; option 3 ("Don't ask me again") is never selected. */
  resumeMenuChoice?: 'full' | 'summary';
  maxSnapshots: number;
  systemPromptFile: string;
  originalPromptFile: string;
  transcriptFile?: string;
  /** Staged migration intent, written BEFORE the old pane is stopped and cleared
   *  once the new account relaunches. A non-empty value on a stopped/failed
   *  session means a migration was interrupted mid-flight — the config was rolled
   *  back to `from` and the failure reason records what happened. */
  migration?: {
    from: string;
    to: string;
    at: string;
  };
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
  /** Liveness ledger (A6, see liveness.ts): explicit per-life-sign timestamps.
   *  Reflex life-signs = transcript growth + ANY pane change + subprocess;
   *  counterAdvance powers the sus_thinking classifier. */
  lastTranscriptAt?: string;
  lastPaneAt?: string;
  /** Recognized work vocabulary whose counters (elapsed clock / token count)
   *  ADVANCED across polls — proof of silent thinking. */
  lastCounterAdvanceAt?: string;
  /** The TOKEN count specifically climbed (token exemption: certain progress,
   *  never sus). Only harnesses that render one (claude); codex has none. */
  lastTokenAdvanceAt?: string;
  /** A harness tool/subprocess was running (open tool.use with a live child
   *  process under the pane, or a codex background terminal). */
  lastSubprocessAt?: string;
  /** Start of the current continuous subprocess episode (sus_subprocess). */
  subprocessSince?: string;
  /** When the reflex layer nudged this zero-life-signs episode (one nudge per
   *  episode; cleared when any life-sign returns). */
  nudgedAt?: string;
  /** Native-queue sends typed into the TUI while it was busy, awaiting their
   *  transcript consumption boundary. Durable: the turn advances only when a
   *  matching chat.user record appears (correlated under the session lock);
   *  entries surviving into a terminal state are surfaced as lost. */
  pendingNativeSends?: Array<{ id: string; at: string; message: string; attachmentIds?: string[] }>;
  /** A warden delivered a needs_human verdict for this session: the reason,
   *  shown in ps/UI. While set, the sweep suppresses re-triage of the same
   *  anomaly class (needsHumanKind) — no identical report every sweep.
   *  Cleared by answer/resume/stop (a human acted). */
  needsHuman?: string;
  /** Anomaly kind fingerprint the needs_human verdict was issued for. */
  needsHumanKind?: string;
  /** Context-window usage (percent used) parsed from the TUI statusline. */
  contextPercent?: number;
  /** The harness's live activity/spinner line ("✻ Lollygagging… (34s · 2.1k
   *  tokens)") parsed from the pane — the UI's received-and-thinking signal.
   *  Cleared when the pane goes idle. */
  activity?: string;
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
  source: 'daemon' | 'claude' | 'codex' | 'tmux' | 'client' | 'watcher' | 'warden';
  data: T;
}

export interface StartSessionRequest {
  prompt: string;
  agent: string;
  name?: string;
  label?: string;
  /** Parent kteam session id — auto-filled by the CLI from KTEAM_SESSION_ID
   *  when a teammate starts a teammate. */
  parent?: string;
  cwd?: string;
  mode?: InteractionMode;
  /** Override the model. When omitted, kteam feeds the wrapper's kfleet default
   *  (KTEAM_MODEL); when that too is absent, no `--model` flag is passed. */
  model?: string;
  intervalSeconds?: number;
  stallSeconds?: number;
  timeoutSeconds?: number;
  nudgeAfterSeconds?: number;
  killAfterSeconds?: number;
  directSendMaxChars?: number;
  resumeMenuChoice?: 'full' | 'summary';
  /** Internal (daemon-minted): assigned-warden stop capability to embed in
   *  the new session's config/pane env. Harmless if a client sets it — the
   *  authorization check compares against the capability recorded in the
   *  daemon's own assignment record, never against this field. */
  stopCapability?: string;
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
  /** Immediate steer: interrupt the active turn (Escape) and deliver the
   *  message right away instead of riding the TUI's native queue. */
  now?: boolean;
}

/** What actually happened to a send: injected into the live turn, queued for
 *  the next prompt-ready boundary, or delivered by reviving a finished
 *  session as its next turn. Additive — absent on older daemons. */
export type SendDisposition = 'delivered' | 'queued' | 'revived';

export interface Recommendation {
  binary: string;
  role: string;
  reason: string;
}
