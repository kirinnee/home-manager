export type Harness = 'claude' | 'codex';

export type SendFate = 'accepted' | 'delivered' | 'unaccounted';
export type SendPath = 'direct' | 'turn-file' | 'native-inline' | 'native-file' | 'revive' | 'revive-queue';
export type SendUnaccountedReason = 'timeout' | 'session_ended' | 'composer_discarded';

export interface SendEvidence {
  /** Stable identity for replay idempotency. */
  key: string;
  harness: Harness;
  kind: 'chat.user' | 'queued_command' | 'response_item';
  proof: 'normal-user-record' | 'native-queue-drain';
  observedAt: string;
  originatedAt?: string;
  shapeVersion: number;
  matchedTurn: number;
  tier: 'queue-file-id' | 'turn-instruction' | 'exact-text';
}

/** One last-wins snapshot in channel/sends.jsonl. The local record owns
 * existence; only SendEvidence supplied by a harness adapter may settle fate. */
export interface SendRecord {
  v: 1;
  sendId: string;
  acceptedAt: string;
  acceptedTurn: number;
  path: SendPath;
  /** Logical text shown to the user (peer preamble included when applicable). */
  message: string;
  /** Exact text expected to appear in the harness transcript. */
  matchText?: string;
  /** Turn assigned by an injection path that already advanced bookkeeping. */
  turn?: number;
  attachmentIds: string[];
  from?: string;
  fromName?: string;
  replyExpected?: boolean;
  payloadFile?: string;
  /** Intentionally retained for an explicit revive; never injected, timeout-exempt. */
  held?: boolean;
  /** Synchronous injection failed and the caller was told. Default projections
   * retain a bounded tombstone so incremental clients can retract acceptance;
   * renderers hide it after folding snapshots by sendId. */
  withdrawn?: boolean;
  fate: SendFate;
  fateAt?: string;
  evidence?: SendEvidence;
  unaccountedReason?: SendUnaccountedReason;
  /** Persisted timeout bookkeeping. acceptedAt itself is immutable. */
  opportunityAt?: string;
  unaccountedDeadline?: string;
  hardDeadline?: string;
  timeoutFrozenAt?: string;
}

/** One model value that is safe to pass to Claude Code's native `/model`
 * command on the session's CURRENT account. Values are deliberately supplied
 * by the daemon rather than invented by the browser: provider-backed wrappers
 * do not share Anthropic's model ids. */
export interface RuntimeModelOption {
  value: string;
  label: string;
}

/** Semantic native-TUI control. The daemon constructs the command so this
 * endpoint cannot become an arbitrary tmux keystroke injector.
 *  - `model`: Claude requires an allowlisted `model`; Codex omits it and opens
 *    its own account-aware model/reasoning picker.
 *  - `effort`: Claude accepts an allowlisted effort level; Codex configures
 *    reasoning inside its native model picker.
 *  - `clear`: the harness-native `/clear` — wipes the running model's
 *    conversation context. Local and destructive; it must be handled locally
 *    (never a model turn), and the UI gates it behind a confirmation.
 *  - `compact`: the harness-native `/compact` — summarises context. On Claude
 *    it runs the model; on Codex it completes locally. Either disposition is
 *    success. */
export interface RuntimeControlRequest {
  action: 'model' | 'effort' | 'clear' | 'compact';
  model?: string;
  effort?: string;
}
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

export interface PendingQuestion {
  toolUseId: string;
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  /** Lifecycle evidence used to diagnose and recover daemon↔pane divergence. */
  askedAt?: string;
  lastSeenAt?: string;
  missingSince?: string;
}

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
  /** Launch the harness with Remote Control enabled, so the session also shows
   *  up in the user's RC surface (claude only — codex has no RC flag). The
   *  DEFAULT is mode-dependent: interactive sessions follow the fleet default
   *  (on) since a human is at the wheel; auto teammates default OFF because RC
   *  with no human is pure overhead. An explicit `--rc`/`--no-rc` (a defined
   *  value here) overrides that default in either direction. Still orthogonal to
   *  `mode` in that you CAN force RC on for an auto teammate — it merely no
   *  longer happens by default. See resolveRemoteControl. */
  remoteControl?: boolean;
  /** Escape hatch: extra harness flags appended verbatim to the generated
   *  launcher (`kteam start --harness-flag …`, repeatable). Kept in the config
   *  so the launcher a session was started with is fully reconstructible on
   *  resume. */
  harnessFlags?: string[];
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
  /** The session's Remote Control surface, from the harness's own
   *  `bridge_status` transcript record (claude + `--rc`). Sticky for the whole
   *  session: the pane prints it once and it scrolls off, and the pane text is
   *  not attributable anyway (a teammate that merely READS another session's RC
   *  line would have that url scraped as its own). */
  remoteControlUrl?: string;
  openTools?: string[];
  pendingQuestion?: PendingQuestion;
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
  /** Native-queue injection mechanics only. Durable send existence and fate
   *  live in channel/sends.jsonl; transcript proof removes entries here but
   *  does not itself advance turns or mutate completion markers. */
  pendingNativeSends?: Array<{
    id: string;
    at: string;
    /** The complete logical message, materialized into the tracked turn file
     *  when the harness consumes this native-queue entry. */
    message: string;
    attachmentIds?: string[];
    /** What was actually typed into the native queue. For oversized/fallback
     *  sends this is a short instruction pointing at payloadFile, so a 4KB+
     *  collapsed paste never has to survive the busy composer. */
    queueText?: string;
    /** Durable absolute file holding `message` when queueText is indirect. */
    payloadFile?: string;
  }>;
  /** Bounded replay guard mirrored from delivered ledger evidence. The ledger
   *  remains authoritative if a crash lands between its append and this state
   *  update. */
  sendEvidenceKeys?: string[];
  /** A warden delivered a needs_human verdict for this session: the reason,
   *  shown in ps/UI. While set, the sweep suppresses re-triage of the same
   *  anomaly class (needsHumanKind) — no identical report every sweep.
   *  Cleared by answer/resume/stop (a human acted). */
  needsHuman?: string;
  /** Anomaly kind fingerprint the needs_human verdict was issued for. */
  needsHumanKind?: string;
  /** Context-window usage (percent used) parsed from the TUI statusline. */
  contextPercent?: number;
  /** Exact live context usage from the harness transcript when available. */
  contextTokens?: number;
  /** Context-window size paired with `contextTokens` by the harness. */
  contextWindow?: number;
  /** Rolling five-hour quota usage (percent used) from cached kfleet usage. */
  usage5hPercent?: number;
  /** Rolling weekly quota usage (percent used) from cached kfleet usage. */
  usageWeeklyPercent?: number;
  /** Epoch milliseconds when the rolling five-hour quota resets. */
  usage5hResetAt?: number;
  /** Epoch milliseconds when the rolling weekly quota resets. */
  usageWeeklyResetAt?: number;
  /** Whether kfleet reports this wrapper is currently at a usage limit. */
  usageAtLimit?: boolean;
  /** False when kfleet reports that this wrapper needs authentication. */
  usageAuthOk?: boolean;
  /** When this session's tmux pane was first created by a successful launch.
   *  Absence is the ONLY way to tell "the pane does not exist yet" (a launch
   *  still queued behind the bootstrap chain) from "the pane died" — both look
   *  identical to `tmux has-session`. A monitor that reads a missing pane on a
   *  session with no launchedAt must treat it as pending, never crashed. */
  launchedAt?: string;
  /** The model the harness ITSELF reported in its transcript usage records
   *  (e.g. `glm-5.2` on a wrapper whose alias is `opus`). Ground truth for
   *  display; the configured alias is only a request. */
  observedModel?: string;
  /** When the harness last supplied model evidence (Claude usage or Codex
   * runtime settings/usage). Unlike lastTranscriptAt, this does not advance for
   * a local `/model` command before the selected model has been verified. */
  observedModelAt?: string;
  /** The reasoning effort Codex itself reported in thread_settings_applied.
   *  Absent for Claude because Claude does not echo its effort back after a
   *  successful in-session `/effort` command. */
  observedReasoningEffort?: string;
  /** The harness's live activity/spinner line ("✻ Lollygagging… (34s · 2.1k
   *  tokens)") parsed from the pane — the UI's received-and-thinking signal.
   *  Cleared when the pane goes idle. */
  activity?: string;
  /** When the most recent tool started, from the transcript — distinguishes
   *  real work from a wedged hook that both render as "Working". */
  lastToolStartedAt?: string;
  quota?: {
    /** Exact kfleet billing evidence: true means a subscription/usage-window
     * account; false means an untracked raw API account. Missing is unknown. */
    usageBased?: boolean;
    /** Runtime provider/pool availability, independent of subscription windows. */
    availability?: 'available' | 'unavailable';
    unavailable?: boolean;
    unavailableReason?: 'cooldown' | 'spend_limit' | 'auth' | 'provider' | 'no_credentials';
    /** Epoch milliseconds when the provider says this wrapper may recover. */
    retryAt?: number;
    atLimit?: boolean;
    authOk?: boolean;
    /** Usage provider from the kfleet feed (anthropic/codex = OAuth,
     *  zai/minimax = API key). Selects the right auth-failure remedy. */
    provider?: string;
    fiveHourPercent?: number;
    weeklyPercent?: number;
    fiveHourResetAt?: number;
    weeklyResetAt?: number;
    resetAt?: number;
  };
  retryAttempt?: number;
  /** True only after the harness transcript records the current turn ending. */
  turnCompleted?: boolean;
  /** A DECLARED wait (`kteam signal waiting`): the teammate is deliberately
   *  parked on an external condition, not stalled. While set, the idle nudge,
   *  the stall kill, and the turn ceiling are suspended and the monitor emits
   *  heartbeats instead. Cleared on expiry, on the next turn, or by
   *  `kteam signal working`. */
  waiting?: {
    since: string;
    /** ISO deadline; at expiry the daemon wakes the teammate. Absent = open-ended. */
    until?: string;
    /** Human-readable description of what is being waited for. */
    condition?: string;
    /** PEER WAIT: this session is parked awaiting a reply from another kteam
     *  session, named here by id. A peer wait is a FIRST-CLASS healthy state,
     *  not a stall — the reflex nudge, the stall kill and the turn ceiling are
     *  suspended exactly as for any declared wait, and the warden's sus filter
     *  is aware of it (see warden-detect). It ends the moment the peer sends
     *  anything back, without the waiter having to poll or signal `working`. */
    peer?: string;
    /** Display name of `peer` at the time the wait was declared, so status
     *  output can say "awaiting mordecai" without a second lookup. */
    peerName?: string;
  };
  /** Seconds this turn has spent in declared waits, credited back against the
   *  turn ceiling so parked time never counts as runtime. */
  waitingCreditSeconds?: number;
}

export interface KTeamEvent<T = unknown> {
  /** Position in THIS session's journal. 0 = never journalled — the live-only
   *  classes (terminal.frame) and every harness-derived chat event, whose
   *  durable home is the harness transcript (indexed by chat pointer). A 0 is
   *  "outside the journal", NOT "older than everything": consumers must not
   *  apply a monotonic sequence filter to these. */
  sequence: number;
  time: string;
  sessionId: string;
  turn: number;
  type: string;
  source:
    | 'daemon'
    | 'claude'
    | 'codex'
    | 'tmux'
    | 'client'
    | 'watcher'
    | 'warden'
    | 'admin-cli'
    | 'admin-ui'
    | `warden:${string}`
    | `peer:${string}`
    | (string & {});
  data: T;
  /** Harness-record identity, present on live harness-derived chat frames so a
   *  live frame and the same record later read from /chat dedupe exactly. */
  recordUuid?: string;
  blockIndex?: number;
}

export interface StartSessionRequest {
  /** The opening turn. REQUIRED for auto mode (an autonomous teammate with no
   *  task is meaningless) and OPTIONAL for interactive mode: a bare
   *  `--mode interactive` start just brings the TUI up at its own prompt with
   *  nothing injected, and the human drives it from the kteam UI or the pane. */
  prompt?: string;
  agent: string;
  name?: string;
  /** Caller-chosen teammate callsign instead of an auto-assigned one, so the
   *  caller can compose a `[Name] Task` title BEFORE starting (the auto-assigned
   *  name is only known after start). Normalised to the pool's slug shape and
   *  rejected if invalid; a collision with a LIVE session in the resolution
   *  window fails loudly unless `teammateFallback` is set. Omitted => the daemon
   *  auto-assigns exactly as before. */
  teammate?: string;
  /** With `teammate`: on collision, auto-assign a free name instead of failing.
   *  Opt-in escape hatch — the default is to fail so a caller embedding the name
   *  in a title finds out immediately. */
  teammateFallback?: boolean;
  label?: string;
  /** Parent kteam session id — auto-filled by the CLI from KTEAM_SESSION_ID
   *  when a teammate starts a teammate. */
  parent?: string;
  cwd?: string;
  mode?: InteractionMode;
  /** Launch with Remote Control (claude only). Omitted => the daemon default
   *  (`remoteControl` in daemon config, itself defaulting to true). */
  remoteControl?: boolean;
  /** Extra harness flags appended to the generated launcher, verbatim. */
  harnessFlags?: string[];
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
  /** Return as soon as the session is persisted instead of waiting for the
   *  TUI bootstrap. The launch continues in the background either way — this
   *  only decides whether the caller waits for it. */
  detach?: boolean;
  initialAttachments?: Array<{
    filename: string;
    mime?: string;
    base64: string;
  }>;
}

export interface SendRequest {
  message: string;
  attachmentIds?: string[];
  /** Server-supplied idempotency identity copied from x-kteam-request-id.
   * api-server must overwrite/ignore any body value; SessionManager never
   * treats a client-chosen body field as authoritative. */
  requestId?: string;
  /** Immediate steer: interrupt the active turn (Escape) and deliver the
   *  message right away instead of riding the TUI's native queue. */
  now?: boolean;
  /** PEER MESSAGING: the kteam session this message came FROM, auto-filled by
   *  the CLI from KTEAM_SESSION_ID. Absent means a human sent it (browser UI,
   *  a human's own shell), which is the distinction the transcript needs —
   *  "the lead asked for this" and "a teammate asked for this" carry very
   *  different weight and were previously indistinguishable.
   *
   *  Never trusted as authorization: it only labels the message. Every send is
   *  already authorized by the bearer token. */
  from?: string;
  /** Sender's teammate callsign, filled in BY THE DAEMON once it resolves
   *  `from`. A client-supplied value is overwritten — the display name must
   *  come from the session record, not from whoever is calling. */
  fromName?: string;
  /** The sender is parked awaiting a reply to THIS message (see
   *  SessionState.waiting.peer). Recorded so the receiver's prompt can say who
   *  is blocked on it, and so the daemon can wake the sender when it answers. */
  replyExpected?: boolean;
}

/** What actually happened to a send: injected into the live turn, queued for
 *  the next prompt-ready boundary, delivered by reviving a finished session,
 *  or retained durably until an explicit revive can recover it. Additive —
 *  absent on older daemons. */
export type SendDisposition = 'delivered' | 'queued' | 'revived' | 'queued-for-revive';

/** Teammate-driven lifecycle signals. `done`/`help` are the original pair;
 *  `waiting`/`working` declare and end a deliberate park (see SessionState.waiting).
 *  ONE definition: the CLI, the API route, and the type all read this array. */
export const SIGNAL_KINDS = ['done', 'help', 'waiting', 'working'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface SignalOptions {
  /** Deadline for a declared wait: an ISO timestamp or a duration (`45m`, `2h`). */
  until?: string;
  /** What is being waited for — published in status, events, and heartbeats. */
  condition?: string;
  /** `signal waiting --peer <ref>`: park until THIS teammate replies. Resolved
   *  to a session id; an unknown ref is rejected rather than silently parking
   *  on nobody. The daemon ends the wait when that peer sends back. */
  peer?: string;
}

export interface Recommendation {
  binary: string;
  role: string;
  reason: string;
}
