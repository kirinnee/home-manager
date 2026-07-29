// Mirror of modules/kteam-ts/src/types.ts. Keep narrow; the daemon is the
// source of truth, this file just gives us autocomplete and shape checks.

export type Harness = 'claude' | 'codex';
export type InteractionMode = 'auto' | 'interactive';

/** Explicit daemon PWA fields. Omitted means unknown/default, never a guessed
 * hostname or monogram supplied by the browser. */
export interface PwaConfig {
  version: 1;
  name?: string;
  icon?: string;
}

export interface PwaConfigView {
  config: PwaConfig;
}

export interface PwaConfigPatch {
  name?: string | null;
  icon?: string | null;
}

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
  askedAt?: string;
  lastSeenAt?: string;
  missingSince?: string;
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
   * setting and is absent for Claude, which does not echo the level back after
   * a successful in-session `/effort` command. */
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
  /** Exact kfleet billing evidence. true = subscription quota; false = raw
   * API metering; absent = unknown. Never infer this from provider/auth. */
  usageBased?: boolean;
  /** Diagnostic/auth-provider identity only; not a billing classifier. */
  provider?: string;
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

// ============================================================================
// SEND LEDGER — mirror of the daemon's `SendRecord` (src/types.ts).
//
// THE THREE-STATE EVIDENCE MODEL. A send is durable the instant it is accepted,
// and its FATE is owned by the harness transcript, never by anything kteam
// merely believes:
//
//   accepted     the daemon holds a durable record; instant, survives refresh
//   delivered    the backend matched a real harness record — proof, not a guess
//   unaccounted  no proof after a generous timeout; "unconfirmed", NEVER "failed"
//
// `unaccounted` is non-terminal UPWARD: late proof still promotes it to
// `delivered`. `delivered` never degrades.
//
// WHY THIS BLOCK IS DELIBERATELY LOOSE. Every field the daemon might omit is
// optional and every literal union is widened by the parser in lib/sends.ts
// rather than trusted here, because the browser is served from a build that can
// be older OR newer than the daemon it talks to. The one invariant that must
// survive any skew: an unrecognised fate is read as `accepted` (visible, no
// delivery claim), never as `delivered`. Preferring a false "unconfirmed" over a
// false "delivered" is the whole point of the model — a reader who is told a
// message landed and acts on it has been given worse information than a reader
// who is told kteam cannot tell.
// ============================================================================

export type SendFate = 'accepted' | 'delivered' | 'unaccounted';

export type SendPath = 'direct' | 'turn-file' | 'native-inline' | 'native-file' | 'revive' | 'revive-queue';

export type SendUnaccountedReason = 'timeout' | 'session_ended' | 'composer_discarded';

export type SendEvidenceKind = 'chat.user' | 'queued_command' | 'response_item';

/** How the match was anchored. `queue-file-id` is a uuid (unforgeable by
 *  coincidence); `exact-text` is normalized EQUALITY — never a prefix or a
 *  substring, which is what once let a message that merely QUOTED a pending send
 *  stand in as proof for it. */
export type SendEvidenceTier = 'queue-file-id' | 'turn-instruction' | 'exact-text';

/** Which harness record shape carried the proof. `native-queue-drain` is
 *  Claude's busy-composer queue echo; `normal-user-record` is an ordinary user
 *  turn (both harnesses). */
export type SendProof = 'normal-user-record' | 'native-queue-drain';

export interface SendEvidence {
  /** Stable per-proof identity, so a re-read of the same transcript bytes cannot
   *  prove the same send twice. */
  key: string;
  kind?: SendEvidenceKind;
  tier?: SendEvidenceTier;
  harness?: Harness;
  proof?: SendProof;
  /** When the text ENTERED the conversation (the harness clock). */
  observedAt?: string;
  /** When the human supplied it, when the harness records that separately. */
  originatedAt?: string;
  matchedTurn?: number;
  shapeVersion?: number;
}

export interface SendRecord {
  v?: number;
  /** Stable identity: the queue id on native paths, and the client's own
   *  request id when the caller supplied one — which is what lets an optimistic
   *  browser row join to its durable row by ID rather than by content. */
  sendId: string;
  acceptedAt: string;
  acceptedTurn?: number;
  path?: SendPath;
  /** The LOGICAL message, with any peer preamble — what the reader should see,
   *  as opposed to the short harness instruction a file-backed send injects. */
  message: string;
  /** Exactly what the harness should echo back. Not rendered. */
  matchText?: string;
  turn?: number;
  attachmentIds: string[];
  from?: string;
  fromName?: string;
  replyExpected?: boolean;
  payloadFile?: string;
  /** Held by kteam on purpose (a send awaiting an explicit revive) — exempt from
   *  the timeout sweep, so it must never read as unconfirmed. */
  held?: boolean;
  /** Tombstone: injection failed SYNCHRONOUSLY and the caller was told, so they
   *  hold the message and may retry. Withdrawn rows are not unaccounted and are
   *  never rendered as durable rows. */
  withdrawn?: boolean;
  fate: SendFate;
  fateAt?: string;
  /** Set iff `fate === 'delivered'`. */
  evidence?: SendEvidence;
  unaccountedReason?: SendUnaccountedReason;
  // Timeout bookkeeping, persisted so a daemon restart re-derives deadlines from
  // disk instead of restarting the clock. Read-only here.
  opportunityAt?: string;
  unaccountedDeadline?: string;
  hardDeadline?: string;
  timeoutFrozenAt?: string;
}

/** Response envelope of `GET /v1/sessions/:id/sends`. */
export interface SendsResponse {
  sends: SendRecord[];
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
export type WardenRecommendedAction = 'nudge' | 'stop' | 'resume' | 'restart' | 'migrate' | 'leave';

export interface WardenRecommendation {
  action: WardenRecommendedAction;
  reason: string;
  /** Required for a migrate control; it is daemon-checked before execution. */
  wrapper?: string;
  [k: string]: unknown;
}

/** Who actually ran a warden check — resolved at spawn, not read from config.
 *  Every field is optional: reports written before the daemon started emitting
 *  provenance carry none of it, and that case must render as an explicit
 *  "unknown", never as a missing line. */
export interface WardenSpawnInfo {
  wardenSessionId?: string;
  /** Wrapper/account the check ran on, e.g. `claude-auto-glm52a`. */
  wrapper?: string;
  /** Display model the daemon resolved from the session it actually started. */
  model?: string;
  /** Where `model` came from: observed from the harness, the wrapper's default,
   *  the configured `--model`, or nothing at all. */
  modelSource?: 'harness' | 'wrapper' | 'configured' | 'unknown';
  /** Wrapper default, for daemons that report a hint instead of a model. */
  modelHint?: string;
  harness?: string;
  failedOver?: boolean;
  /** Configured first choice at spawn time — what failover moved off. */
  configuredFirst?: string;
  /** wrapper → why it was skipped, exactly as the selector phrased it. */
  skipped?: Record<string, string>;
  /** Pre-computed failover explanation, if a daemon supplies one directly. */
  failoverReason?: string;
  [k: string]: unknown;
}

export interface WardenVerdict {
  at: string;
  targetSession?: string;
  teammate?: string;
  label?: string;
  verdict: WardenVerdictKind;
  reason?: string;
  reportPath: string;
  /** Absent on older daemons/reports — render "unknown", do not hide the row. */
  spawn?: WardenSpawnInfo;
}

// ============================================================================
// Fleet warden attention (mirror of the daemon's WardenAttentionView, served
// by admin-only GET /v1/warden/attention). Mirrored defensively: optional
// everywhere the daemon may omit a field — EXCEPT `judgement`, which is
// required by design. "The warden reached no judgement" must be a value the UI
// can print, never an absence it can silently read as healthy.
// ============================================================================

export type WardenJudgementState = 'judged' | 'pending' | 'queued' | 'failed' | 'none';

export interface WardenJudgedBy {
  wardenSessionId?: string;
  wrapper?: string;
  model?: string;
  harness?: string;
  [k: string]: unknown;
}

export interface WardenJudgement {
  state: WardenJudgementState;
  /** Present when `state === 'judged'` and the report parsed. */
  verdict?: WardenVerdictKind;
  /** Verdict reason, or the explicit failure text when `state === 'failed'`. */
  reason?: string;
  judgedBy?: WardenJudgedBy;
  at?: string;
  reportPath?: string;
  recommendation?: WardenRecommendation;
  /** The judgement predates this attention item — it did not look at it. */
  stale?: boolean;
  [k: string]: unknown;
}

export interface FleetAttentionItem {
  sessionId: string;
  teammate?: string;
  label?: string;
  sessionStatus?: string;
  /** Attention board id (`A3`), or `anomaly:<kind>:<sessionId>` for a row the
   *  warden synthesized from a live anomaly with no board record. */
  id?: string;
  source?: string;
  /** True when the row came from an anomaly rather than an attention board. */
  fromAnomaly?: boolean;
  /** Set for a provider-wide anomaly expanded across affected sessions. */
  provider?: string;
  subject?: string;
  why?: string;
  /** Stranger-readable background carried by the board item, when present. */
  context?: string;
  waitingSince?: string;
  /** The fuller human explanation from the durable Attention record. */
  howToResolve?: string;
  /** Every live row has one named recommendation; older daemons may omit it,
   *  so the UI supplies a conservative Nudge fallback instead of silence. */
  recommendation?: WardenRecommendation;
  raisedBy?: string;
  raisedByName?: string;
  judgement: WardenJudgement;
  [k: string]: unknown;
}

/** The daemon's own answer to "is this list empty because everything is fine,
 *  or because nothing could look?" — these must never render alike.
 *  - `items`       rows exist; someone needs the human.
 *  - `clean-sweep` a sweep ran, every board read, nothing is waiting.
 *  - `degraded`    a sweep ran but a board could not be read — a waiting agent
 *                  may be HIDDEN, so this is never an all-clear.
 *  - `no-sweep`    nothing has looked yet; we do not know. */
export type WardenAttentionOutcome = 'items' | 'clean-sweep' | 'degraded' | 'no-sweep';

export interface WardenAttentionView {
  generatedAt?: string;
  lastSweepAt?: string;
  /** Absent on a daemon that predates it; the UI then infers from lastSweepAt. */
  outcome?: WardenAttentionOutcome;
  wardenDegraded?: { since?: string; reason?: string };
  items?: FleetAttentionItem[];
  boardsWithParseErrors?: { sessionId: string; parseErrors?: number }[];
  /** The finite recent-verdict window every judgement on this view was matched
   *  against. Optional: an older daemon does not report it, and the UI must not
   *  claim a bound it was never told about. */
  verdictCoverage?: WardenVerdictCoverage;
  [k: string]: unknown;
}

/** How far back the judgement matching could actually see. `truncated` means
 *  older verdicts exist BEYOND the window, so "no matching judgement" is a
 *  statement about this window — never about the world. */
export interface WardenVerdictCoverage {
  limit?: number;
  truncated?: boolean;
  [k: string]: unknown;
}

// Warden account failover (mirrors src/service.ts WardenFailoverStatus /
// WardenConfigView). Defensive like the rest of this block: every field the
// daemon might omit is optional so an older daemon degrades to "hidden".

export type WardenFailoverPolicy = 'fallback' | 'round_robin';

export interface WardenAccountConfig {
  wrapper: string;
  model?: string;
}

export interface WardenFailoverAccountView {
  wrapper: string;
  model?: string;
  eligible: boolean;
  reason?: string;
  demotedUntil?: string;
  strikes?: number;
  quota?: { fiveHourPercent?: number; weeklyPercent?: number; atLimit?: boolean; authOk?: boolean };
}

export interface WardenFailoverStatus {
  policy: WardenFailoverPolicy;
  failureThreshold: number;
  cooldownMinutes: number;
  accounts: WardenFailoverAccountView[];
  lastSelection?: { wrapper: string; policy: WardenFailoverPolicy; at: string; reason: string };
  exhaustedSince?: string;
}

export interface WardenConfig {
  enabled?: boolean;
  wrapper?: string;
  model?: string;
  accounts?: (WardenAccountConfig | string)[];
  failover?: { policy?: WardenFailoverPolicy; failureThreshold?: number; cooldownMinutes?: number };
  intervalMinutes?: number;
  [k: string]: unknown;
}

export interface WardenConfigView {
  config: WardenConfig;
  accounts: WardenAccountConfig[];
  warnings: string[];
}

/** PATCH body for /v1/warden/config — any subset; failover may be partial. */
export interface WardenConfigPatch {
  enabled?: boolean;
  accounts?: (WardenAccountConfig | string)[];
  failover?: { policy?: WardenFailoverPolicy; failureThreshold?: number; cooldownMinutes?: number };
  [k: string]: unknown;
}

export interface WardenStatusView {
  config?: WardenConfig;
  lastSweepAt?: string;
  anomalies?: WardenAnomaly[];
  liveWarden?: string;
  lastSpawnAt?: string;
  lastReport?: { path: string; head: string };
  failover?: WardenFailoverStatus;
  [k: string]: unknown;
}
