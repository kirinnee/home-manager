import { appendFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { AttachmentError, AttachmentStore, type StoredAttachment } from './attachments';
import { listDirectory, readChanges, readDiff, readFileView } from './fs';
import {
  startClaudeTranscriptWatcher,
  type ClaudeNormalizedEvent,
  type ClaudeTranscriptWatcher,
  type TranscriptCursor,
  parseClaudeTranscriptLine,
} from './claude-transcript';
import {
  startCodexTranscriptWatcher,
  type CodexNormalizedEvent,
  type CodexTranscriptWatcher,
  parseCodexTranscriptLine,
} from './codex-transcript';
import {
  codexRuntimeModelCatalog,
  driveCodexModelPicker,
  parseCodexPickerScreen,
  preflightCodexModelPicker,
  sendTmuxPickerKey,
  waitForCodexRuntimeObservation,
  waitForCodexThreadSettingsApplied,
  type CodexPickerTransport,
  type CodexPickerTarget,
  type RuntimeModelCatalog,
} from './codex-runtime';
import {
  contextWindowForModel,
  contextWindowForSession,
  resolveDisplayModel,
  discoverAutoAgents,
  inferHarness,
  modelHint,
  shellSafeSessionName,
  startWaitMsFor,
} from './core';
import {
  listWrappers,
  runtimeModelsForWrapper,
  scanProjects,
  type ProjectInfo,
  type WrapperInfo,
} from './fleet-inventory';
import { currentActor } from './actor-context';
import type { ObservedHumanInput } from './observed-human-input';
import {
  advanceSendTimeout,
  appendEvidenceKey,
  matchObservedHumanInputs,
  newAcceptedSend,
  SendLedger,
  shiftFrozenSendTimeout,
  type SendMatch,
} from './send-ledger';
import { classifyVerdict, parseWardenAnomalyKind, type WardenVerdict } from './warden-verdicts';
import {
  readWardenReport as readWardenReportFromDisk,
  readWardenVerdicts as readWardenVerdictsFromDisk,
} from './warden-reports';
import { buildWardenSpawnProvenance, provenancePath, type WardenSelectionProvenance } from './warden-provenance';
import {
  blessingTtlMs,
  isAnomalyBlessed,
  reconcileBlessings,
  recordBlessing,
  type BlessingStore,
} from './warden-bless';
import {
  discoverCodexSession,
  codexSessionIds,
  resolveBinary,
  wrapperHome,
  wrapperModel,
  claudeTranscriptPath,
} from './harness';
import {
  defaultProviderOutageConfig,
  defaultScratchConfig,
  type ScratchConfig,
  type WardenConfig,
} from './daemon-config';
import { type ScratchEntry, reclaimScratch, scanScratch, scratchEligibility, trimSnapshots } from './scratch-gc';
import { atomicJson, now, readJson, run, writeTextAtomic } from './io';
import { NAME_WINDOW_MS, displayName, normalizeTeammateName, pickTeammateName } from './names';
import type { KTeamPaths } from './paths';
import { configFile, markerFile, sessionDir, stateFile, turnLog, turnPrompt } from './paths';
import type {
  AttachmentView,
  KTeamService,
  SearchResponse,
  SearchResult,
  SessionView,
  UsageFeedView,
  WardenConfigPatch,
  WardenConfigView,
  WardenRunView,
  WardenStatusView,
} from './service';
import { searchRecords } from './transcript-search';
import {
  detectAnomalies,
  fingerprintAnomalies,
  isWardenScannableStatus,
  WAITING_BACKSTOP_MS,
  WARDEN_LABEL,
  type WardenAnomaly,
  type WardenAnomalyKind,
  type WardenSessionView,
} from './warden-detect';
import {
  detectProviderOutages,
  providerEligibleSessionIds,
  providerSnapshotEligible,
  type ProviderOutageState,
  type ProviderSnapshotView,
} from './provider-outage';
import { rankFailoverCandidates, selectFailoverCandidate } from './failover';
import {
  classifyWardenFailure,
  effectiveFailoverConfig,
  ineligibilityReason,
  normalizeWardenAccounts,
  reconcileDemotions,
  recordWardenFailure,
  recordWardenSuccess,
  selectWardenAccount,
  type WardenFailoverState,
} from './warden-failover';
import { decideAssignedWardens, wardenSlotsFree, type LiveWarden } from './warden-concurrency';
import type { AgentUsage } from './core';
import { chatEventFingerprint, EventStore, type IndexedSession, type JsonValue, type SessionEvent } from './storage';
import { KTEAM_VERSION } from './version';
import {
  authFailureRemedy,
  fetchKfleetUsage,
  providerUnavailableDetail,
  quotaFromUsage,
  UsageFeed,
  usageAccountView,
  usageEventData,
  usageStateFromQuota,
} from './usage';
import {
  anyQuestionVisible,
  contextPercentUsed,
  backgroundTerminalCount,
  foldStallLiveness,
  paneActivityLine,
  paneShowsActiveWork,
  StructuredQuestionDriveError,
  INTERACTIVE_READY_TIMEOUT_MS,
  TmuxController,
  type PaneState,
  type StallLivenessState,
} from './tmux-controller';
import { reflexAssess, renderLivenessYaml, susFindings, type LivenessLedger } from './liveness';
import type {
  Harness,
  InteractionMode,
  KTeamEvent,
  RuntimeControlRequest,
  SendDisposition,
  SendPath,
  SendRecord,
  SendRequest,
  SendUnaccountedReason,
  SessionConfig,
  SessionState,
  SessionStatus,
  SignalKind,
  SignalOptions,
  StartSessionRequest,
} from './types';

/** A FIRST launch in flight: when it was registered, and the bootstrap promise
 *  so control actions can queue behind it instead of being refused. */
interface LaunchProgress {
  at: number;
  bootstrap: Promise<void>;
  /** True once `start` gave up waiting and announced the background launch. */
  backgrounded?: boolean;
}

interface MonitorHandle {
  abort: AbortController;
  transcript?: ClaudeTranscriptWatcher | CodexTranscriptWatcher;
  /** In-flight transcript arming. Both startMonitor and the tick loop ask for
   *  the codex watcher, and `transcript` is only set at the END of that
   *  async work â without this they each start one, doubling every event and
   *  leaking the loser (which nothing ever stops). */
  transcriptStarting?: Promise<void>;
  /** In-flight background attach of the transcript watcher (startMonitor does
   *  not await it â see the comment there). stopMonitor drains it so a watcher
   *  that finishes arming after the monitor died is still stopped. */
  attaching?: Promise<void>;
  loop?: Promise<void>;
  /** Interrupts the loop's current sleep so a freshly queued send is
   *  considered immediately instead of after the full tick. */
  wake?: () => void;
}

/** Escape is a failure-only teardown key. Normal picker selection remains
 * restricted to the digit-only driver in codex-runtime.ts. */
export interface CodexPickerDismissTransport {
  resolvePane: () => Promise<string>;
  capturePane: (paneId: string) => Promise<{ visiblePane: string; promptReady: boolean }>;
  sendEscape: (paneId: string) => Promise<void>;
}

export interface CodexPickerDismissOptions {
  timeoutMs?: number;
  pollMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Dismiss only a currently parsed Codex picker on the exact pane resolved at
 * cleanup start. Unknown or already-idle screens are left untouched. */
export async function dismissCodexPicker(
  transport: CodexPickerDismissTransport,
  options: CodexPickerDismissOptions = {},
): Promise<void> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 2_000);
  const pollMs = Math.max(0, options.pollMs ?? 50);
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const paneId = await transport.resolvePane();
  if (!/^%\d+$/.test(paneId)) throw new Error('failed to resolve the Codex picker pane for cleanup');

  const deadline = clock() + timeoutMs;
  let lastVisible = 'an unknown picker';
  for (;;) {
    const pane = await transport.capturePane(paneId);
    const screen = parseCodexPickerScreen(pane.visiblePane);
    if (screen.kind === 'none' && pane.promptReady) return;
    if (screen.kind === 'none')
      throw new Error('Codex picker cleanup could not verify that the exact pane returned to an idle prompt');
    lastVisible = screen.title ?? screen.kind;
    if (clock() >= deadline) break;
    // Capture is intentionally repeated before every Escape. If Codex changes
    // the pane to an idle or unknown screen, no key is sent into it.
    await transport.sendEscape(paneId);
    await sleep(pollMs);
  }
  throw new Error(`Codex picker cleanup did not close ${lastVisible} within ${Math.ceil(timeoutMs / 1000)}s`);
}

async function dismissCodexPickerInTmux(tmux: TmuxController, tmuxSession: string): Promise<void> {
  await dismissCodexPicker({
    resolvePane: async () => {
      const resolved = await run(['tmux', 'display-message', '-p', '-t', tmuxSession, '#{pane_id}']);
      const paneId = resolved.stdout.trim();
      if (resolved.code !== 0 || !/^%\d+$/.test(paneId))
        throw new Error(resolved.stderr.trim() || 'failed to resolve the Codex picker pane for cleanup');
      return paneId;
    },
    capturePane: async paneId => {
      const [captured, cursor] = await Promise.all([
        run(['tmux', 'capture-pane', '-p', '-t', paneId]),
        run(['tmux', 'display-message', '-p', '-t', paneId, '#{cursor_x}|#{cursor_y}']),
      ]);
      if (captured.code !== 0)
        throw new Error(captured.stderr.trim() || 'failed to capture the Codex picker pane for cleanup');
      const [rawX, rawY] = cursor.stdout.trim().split('|');
      const cursorX = Number(rawX);
      const cursorY = Number(rawY);
      if (cursor.code !== 0 || !Number.isFinite(cursorX) || !Number.isFinite(cursorY))
        throw new Error(cursor.stderr.trim() || 'failed to inspect the Codex picker pane for cleanup');
      return { visiblePane: captured.stdout, promptReady: tmux.promptReady(captured.stdout, cursorY, cursorX) };
    },
    sendEscape: async paneId => {
      const sent = await run(['tmux', 'send-keys', '-t', paneId, 'Escape']);
      if (sent.code !== 0) throw new Error(sent.stderr.trim() || 'failed to dismiss the Codex picker');
    },
  });
}

/** Production is deliberately bound to the screen-verified picker driver and
 * raw transcript confirmation helpers. The object is a narrow prototype-test
 * seam only; it does not broaden the runtime-control API. */
interface CodexRuntimeControl {
  preflightModelPicker: typeof preflightCodexModelPicker;
  driveModelPicker: typeof driveCodexModelPicker;
  sendPickerKey: typeof sendTmuxPickerKey;
  dismissPicker: (tmuxSession: string) => Promise<void>;
  waitForThreadSettingsApplied: typeof waitForCodexThreadSettingsApplied;
  waitForRuntimeObservation: typeof waitForCodexRuntimeObservation;
}

const defaultCodexRuntimeControl: CodexRuntimeControl = {
  preflightModelPicker: preflightCodexModelPicker,
  driveModelPicker: driveCodexModelPicker,
  sendPickerKey: sendTmuxPickerKey,
  dismissPicker: async () => undefined,
  waitForThreadSettingsApplied: waitForCodexThreadSettingsApplied,
  waitForRuntimeObservation: waitForCodexRuntimeObservation,
};

interface StoredEnvelope {
  source?: KTeamEvent['source'];
  turn?: number;
  payload?: unknown;
  /** Legacy: the fleet-wide counter kteam used to stamp on every event.
   *  Still present in old journals, no longer written or read. */
  globalSequence?: number;
}

/** Only this failure class is eligible for the single file-backed retry. An
 *  error after verified typing (for example, an audit-log write failure) must
 *  never be mistaken for composer rejection and duplicate the send. */
class NativeQueueComposerError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'NativeQueueComposerError';
  }
}

export interface ScratchPlan {
  sessionId: string;
  teammate?: string;
  directory: string;
  bytes: number;
  entries: ScratchEntry[];
  eligible: boolean;
  reason?: string;
}

interface SessionManagerOptions {
  healthIntervalSeconds: number;
  quotaUrl: string;
  transcriptReconcileSeconds: number;
  publicUrl: string;
  projectRoots: string[];
  /** Fleet default for Remote Control on claude launches; a request may
   *  override it per session. Undefined => on. */
  remoteControl?: boolean;
  warden: WardenConfig;
  scratch?: ScratchConfig;
  contextWindows?: Record<string, number>;
  /** Invoked when the daemon decides its own index is unhealable and a clean
   *  restart is the only repair. The entrypoint owns HOW (and WHETHER â only a
   *  process a service manager will re-spawn may exit); the manager only
   *  decides WHEN. Returns false when it declined, so the manager can say so. */
  onSelfRestart?: () => boolean | Promise<boolean>;
}

/** Internal lifecycle gates for daemon-created sessions. The public API never
 *  supplies functions; wardens use this to persist mandatory spawn evidence
 *  after the pane launches but before turn 1 can run. */
interface SessionStartHooks {
  beforeFirstTurn?: (view: SessionView) => Promise<void>;
  onBootstrapFailure?: () => Promise<void>;
}
interface WardenRuntimeState {
  lastSweepAt?: string;
  lastSpawnAt?: string;
  /** The escalation-suppression key of the last spawn: the anomaly fingerprint
   *  qualified by `recoveryGeneration` (`<gen>:<fingerprint>`). Qualifying by the
   *  generation means an anomaly set that RECURS after a clean recovery escalates
   *  again instead of being suppressed as "unchanged". */
  lastSpawnFingerprint?: string;
  /** Fingerprint of the most recent sweep â used to detect the non-emptyâempty
   *  transition that marks a recovery. */
  lastFingerprint?: string;
  /** Bumped every time the fleet goes from having anomalies to having none. */
  recoveryGeneration?: number;
  /** Live assigned-warden records, keyed by TARGET session id. The api-server
   *  consults these (via wardenMayStop) to let the warden token stop ONLY
   *  sessions under an active assignment. `capability` is the unguessable
   *  secret minted at spawn and exported only into that warden's pane â
   *  authorization compares capabilities, never client-chosen identities. */
  assignments?: Record<
    string,
    {
      wardenId: string;
      spawnedAt: string;
      capability: string;
      /** The flag classes this warden was assigned to judge — recorded so a LEAVE
       *  verdict can bless exactly (and only) those flags. Absent on records
       *  written before blessings shipped (treated as "nothing to bless"). */
      kinds?: WardenAnomalyKind[];
      /** The report file this warden writes its verdict to — read at reconcile
       *  time to decide whether the verdict was LEAVE. */
      reportPath?: string;
    }
  >;
  /** Per-target cooldown after an assigned warden finished (verdict given):
   *  no respawn for the same session within assignedCooldownMinutes. */
  assignedCooldowns?: Record<string, string>;
  /** Sus targets detected but not given a warden this sweep because the
   *  fleet-wide concurrency cap was full. FIFO, persisted so a deferred
   *  investigation is never lost: every sweep retries these BEFORE fresh
   *  candidates and drops any that have since recovered. Full anomaly records
   *  (not just ids) so a drained target still has a prompt without re-detection. */
  assignedQueue?: WardenAnomaly[];
  /** Active warden blessings, keyed by target session id. A LEAVE verdict adds
   *  one with a TTL; the sweep skips a blessed session's cleared flags until it
   *  lapses. Persisted so a kteamd restart does not drop every blessing and
   *  re-investigate the whole fleet at once. */
  blessings?: BlessingStore;
  /** Account-failover bookkeeping (rrCursor, per-wrapper strikes/demotions,
   *  last selection, exhaustion). Durable so a daemon restart cannot amnesty
   *  a demotion or reset a strike count. See warden-failover.ts. */
  failover?: WardenFailoverState;
  /** Pending/confirmed provider failures from persisted pane snapshots. A
   *  restart must not turn the second sighting back into the first. */
  providerOutages?: ProviderOutageState;
}

interface PickedWardenAccount extends WardenSelectionProvenance {
  wrapper: string;
  model?: string;
}

const wardenReportInstructions = (reportPath: string): string[] => [
  '',
  '## Report writing',
  '- Lead with the outcome.',
  '- Use point form only.',
  '- Keep one idea per bullet.',
  '- Keep every line short and plain.',
  '- Bold one key value per bullet.',
  '- Do not write CLI, model, harness, or failover facts: the daemon injects those from session metadata when rendering.',
  `- The daemon-owned provenance sidecar is: ${provenancePath(reportPath)}`,
  '',
];
interface WardenSweep {
  at: string;
  anomalies: WardenAnomaly[];
  fingerprint: string;
}
interface ResumePolicy {
  /** Automatic callers retain the historical label+cwd duplicate-work
   *  suppression. Explicit admin/peer resume and terminal send set or resolve
   *  this false, so a batch label can never gate a deliberate recipient. */
  dedupeSharedRecoveryScope: boolean;
  /** Automatic retries must not clear human/retry state as if an operator had
   *  explicitly recovered the session. */
  automatic: boolean;
  expectedStatus?: SessionStatus;
  retryAttempt?: number;
}

function implicitResumePolicy(actor: KTeamEvent['source'] | undefined): ResumePolicy | undefined {
  // Admin and peer API calls are explicit operator/lead actions. A warden API
  // call is automated recovery even though it reaches the same public method;
  // no actor means an internal daemon caller. Unknown future automation kinds
  // default to the safer deduped path rather than silently gaining an override.
  if (actor === 'admin-cli' || actor === 'admin-ui' || actor?.startsWith('peer:')) return undefined;
  return { automatic: true, dedupeSharedRecoveryScope: true };
}
interface QuotaWaiter {
  abort: AbortController;
  promise: Promise<void>;
}

class ResumeCancelled extends Error {}

class ReviveRefused extends Error {}

class ReviveDedupeConflict extends ReviveRefused {
  constructor(
    readonly target: SessionConfig,
    readonly conflict: SessionConfig,
  ) {
    const conflictName = conflict.teammate ?? conflict.id;
    const label = target.label?.trim() ?? '';
    const cwd = path.resolve(target.cwd);
    super(
      `automatic revive suppressed for session ${target.id}: live session ${conflictName} (${conflict.id}) ` +
        `shares label ${label} and checkout ${cwd}, the legacy automatic-recovery dedupe scope; ` +
        `run \`kteam resume ${target.id}\` to explicitly recover the original session`,
    );
    this.name = 'ReviveDedupeConflict';
  }
}

class WardenProvenancePersistenceError extends Error {
  constructor(
    readonly wardenId: string,
    readonly reportPath: string,
    cause: unknown,
  ) {
    super(`could not persist mandatory warden provenance: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'WardenProvenancePersistenceError';
  }
}

function wardenProvenanceError(error: unknown): WardenProvenancePersistenceError | undefined {
  if (error instanceof WardenProvenancePersistenceError) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = wardenProvenanceError(nested);
      if (found) return found;
    }
  }
  return undefined;
}

const terminalStatuses: SessionStatus[] = ['completed', 'failed', 'stalled', 'stopped'];
const protectedStatuses: SessionStatus[] = [...terminalStatuses, 'kill_failed'];
const waitingStatuses: SessionStatus[] = ['waiting', 'awaiting_question', 'awaiting_user', 'rate_limited'];
const CODEX_PICKER_QUARANTINE_KIND = 'codex_picker_cleanup';

function rejectKillFailedPaneInput(): never {
  throw new Error(
    'input is blocked because the previous tmux shutdown was not confirmed; run `kteam stop <session>` successfully before sending or retrying runtime control',
  );
}

function rejectUnconfirmedCodexPickerInput(): never {
  throw new Error(
    'input is blocked because Codex picker cleanup was not confirmed; run `kteam resume <session>` or `kteam stop <session>` before sending or retrying runtime control',
  );
}
/** Statuses a session can hold BEFORE its tmux pane has ever been created.
 *  In these the absence of a pane means "not launched yet", never "crashed". */
const preLaunchStatuses: SessionStatus[] = ['created', 'starting'];

const isMissingPath = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

async function readJsonIfPresent<T>(file: string): Promise<T | undefined> {
  try {
    return await readJson<T>(file);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}
/** How far back a FLEET-WIDE replay cursor may reach. The cross-session feed
 *  is a live stream, not an archive: a client asking for the whole fleet from
 *  sequence 0 would page through every event ever recorded. Per-session
 *  replay stays complete â only the fleet feed is windowed. */
const GLOBAL_BACKLOG_MAX = 5_000;
/** Expected cadence of the daemon self-check. Lag is the measured timer gap
 * above this interval, not the whole interval itself. */
const SELF_CHECK_INTERVAL_MS = 60_000;
/** A bootstrap phase is best-effort repair, never a lease on daemon health.
 *  Five minutes accommodates the known ~30 s cold scan with ample headroom,
 *  while putting a hard ceiling on a wedged transcript/tmux await. */
const BOOTSTRAP_PHASE_TIMEOUT_MS = 5 * 60_000;
/** Warden state is one small JSON document. A slow/broken read must release the
 *  single-flight latch well before the enclosing bootstrap phase deadline so
 *  a later self-check can retry it. */
const WARDEN_STATE_READ_TIMEOUT_MS = 10_000;
/** A self-check tick this late means the event loop stopped running: the
 *  timer interval is 60 s, so three missed ticks is unambiguous. */
const WEDGE_GAP_MS = 180_000;
/** Long fleet scans yield at this boundary so timers and request handling can
 * run even when every store lookup is satisfied synchronously from cache. */
const SWEEP_CHUNK_SIZE = 25;
/** A terminal session whose journal keeps growing this long after finishedAt
 *  is still doing work nothing supervises (and `ps` cannot show). */
const TERMINAL_ACTIVITY_GRACE_MS = 60_000;
/** Consecutive consistency passes that failed to heal the index before a
 *  clean self-restart is requested. */
const INCOHERENT_RESTART_THRESHOLD = 3;
/** Minimum wall-clock gap between two self-restarts, across process lifetimes. */
const SELF_RESTART_COOLDOWN_MS = 30 * 60_000;
/** How often the consistency pass re-verifies that chat pointers RESOLVE. A
 *  rotted chat index is not urgent (control/lifecycle journals are unaffected),
 *  so this runs far less often than the 60 s membership check to avoid steady
 *  file I/O and needless rebuilds of transcripts a harness is actively
 *  rewriting. */
const CHAT_VERIFY_INTERVAL_MS = 5 * 60_000;
/** Newest chat pointers sampled per session when probing resolvability. */
const CHAT_VERIFY_SAMPLE = 3;
/** How long `start` holds its HTTP request open waiting for the TUI bootstrap
 *  before answering with the persisted 'starting' session and letting the
 *  launch finish in the background. Comfortably under every caller deadline
 *  that produced the exit-143 spawn timeouts. */
const START_WAIT_MS = 45_000;
/** How long a control action (send/resume) queues behind an in-flight FIRST
 *  launch before answering "still launching". Long enough to swallow the
 *  bootstrap queue for a slow provider, short enough to stay under the client
 *  request timeout. */
const CONTROL_LAUNCH_WAIT_MS = 60_000;
/** Long bracketed pastes are unreliable in a busy Claude composer (4.3KB was
 *  lost 8/8 in live repros). Keep native-queue typing below this bound and put
 *  the complete logical message in a durable file instead. */
const NATIVE_QUEUE_INLINE_MAX_CHARS = 1_000;
/** Browser request ids become durable ledger ids and, for file-backed native
 * sends, part of a filename. Keep the accepted alphabet intentionally smaller
 * than a general HTTP header token; invalid/absent ids get a fresh UUID. */
const SAFE_SEND_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

function sendRequestId(value: string | undefined): string {
  return value !== undefined && SAFE_SEND_REQUEST_ID.test(value) ? value : crypto.randomUUID();
}
/** How long a queued first launch is given before the self-check stops
 *  excluding it and repairs (or fails) it like any other session. */
const LAUNCH_GRACE_MS = 10 * 60_000;
/** A failed `tmux has-session` is only one observation. Give tmux a moment to
 *  settle, then probe the pane and process tree independently before writing
 *  an irreversible terminal status. */
const TERMINAL_REPROBE_MS = 250;
/** Event classes that are broadcast live but NEVER journalled. They are
 *  liveness signals, not history: keeping them out of events.jsonl removed the
 *  largest write class the daemon had (6584 terminal.frame records in one real
 *  12.7k-event session, every one of them an fsync). */
const LIVE_ONLY_EVENT_TYPES = new Set(['terminal.frame']);
/** Event classes the HARNESS already recorded in its own transcript. kteam
 *  indexes these by byte offset (chat_pointers) and streams them live, but never
 *  copies their content into its own journal. They were 5.9 MB of an 8.2 MB
 *  events.jsonl plus the whole 6.2 MB chat.jsonl on one real session.
 *
 *  turn.completed / interaction.question are deliberately NOT here: they are
 *  low-volume CONTROL signals the daemon acts on, so they stay journalled. */
const HARNESS_DERIVED_EVENT_TYPES = new Set([
  'chat.user',
  'chat.assistant.text',
  'chat.assistant.thinking',
  'tool.use',
  'tool.result',
  'context.usage',
]);
/** How many recent live-only frames to retain per session, for a late
 *  subscriber and for the wedge/liveness reflexes. */
const LIVE_FRAME_RING = 50;
/** Coalesce monitors for teammates sharing one checkout. This is far below the
 *  30 s tick, so it changes no observable freshness while avoiding five
 *  identical git subprocesses per session in an aligned fleet tick. */
const GIT_FINGERPRINT_COALESCE_MS = 2_000;
/** How often a declared wait publishes a heartbeat, so "parked" never looks
 *  the same as "gone" to a lead reading the event stream. */
const WAITING_HEARTBEAT_MS = 300_000;

/** True when the reflex layer and the turn ceiling must stand down: a declared
 *  wait, a waiting status, or an interrupted turn. `state.waiting` â not the
 *  status â is the authority for a park, because transcript records recompute
 *  the status every few seconds. */
export function lifecycleSuspended(state: SessionState): boolean {
  return state.waiting !== undefined || waitingStatuses.includes(state.status) || state.status === 'interrupted';
}

/** Strong pane evidence that a persisted question is no longer the active TUI
 * menu. Unknown/non-idle frames deliberately return undefined: the monitor may
 * diagnose them, but only retry/abandon may mutate that ambiguous state. */
export function pendingQuestionPaneAdvance(
  state: SessionState,
  pane: Pick<PaneState, 'promptReady' | 'visiblePane'>,
): 'prompt-ready' | 'turn-started' | undefined {
  const pending = state.pendingQuestion;
  if (!pending) return undefined;
  // A visible question wins over the broad prompt-ready heuristic. Claude's
  // native “Other” page contains an editable composer while the structured
  // interaction is still live; two monitor ticks must not cancel it while a
  // human is typing.
  const visible = anyQuestionVisible(pane.visiblePane, pending.questions);
  if (visible) return undefined;
  if (pane.promptReady) return 'prompt-ready';
  if (paneShowsActiveWork(pane.visiblePane)) return 'turn-started';
  return undefined;
}

type OpenStructuredQuestion = NonNullable<SessionState['pendingQuestion']>;

/** Preserve the harness's raw question wording when a structured form has to
 * be released. Once `pendingQuestion` is cleared the form disappears, so this
 * text must travel in both the durable lifecycle event and the HTTP error if
 * the human is going to answer the same question in prose. */
function pendingQuestionText(pending: OpenStructuredQuestion): string {
  return pending.questions.map(question => question.question).join('\n\n');
}

/** The state edge that makes the ordinary composer available again. It never
 * consults the pane matcher: that matcher may be the component that just
 * failed. Pane evidence only decides whether the harness has already started
 * working or is waiting for prose. */
function releasedQuestionState(
  view: SessionView,
  pending: OpenStructuredQuestion,
  pane: Pick<PaneState, 'promptReady' | 'visiblePane'> | undefined,
  reason?: string,
): Partial<SessionState> {
  const active = pane !== undefined && paneShowsActiveWork(pane.visiblePane);
  return {
    status: active ? 'running' : 'awaiting_user',
    health: active ? 'healthy' : 'idle',
    promptReady: pane?.promptReady ?? !active,
    pendingQuestion: undefined,
    openTools: (view.state.openTools ?? []).filter(tool => tool !== pending.toolUseId),
    reason,
    lastActivityAt: now(),
  };
}

/** Keep the original drive error loud while telling the human exactly how to
 * continue after the form was released. */
function releasedQuestionError(error: unknown, pending: OpenStructuredQuestion): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message}\n\nThe structured form was released. Reply in prose to:\n${pendingQuestionText(pending)}`,
    { cause: error },
  );
}

/** Native structured-question chrome for both harnesses. This is intentionally diagnostic only:
 * without a persisted tool id/questions payload the daemon cannot safely
 * reconstruct or drive the menu, but it can make reverse divergence visible. */
export function paneShowsStructuredQuestionMenu(pane: string): boolean {
  return (
    /^\s*[❯›>»]\s*\d+[.)]\s+\S/mu.test(pane) &&
    /(?:enter|return)\s+to\s+(?:select|submit(?:\s+answer)?)/iu.test(pane) &&
    /esc(?:ape)?\s+to\s+(?:cancel|interrupt)/iu.test(pane)
  );
}

interface PendingQuestionMonitorState {
  advancedTool?: string;
  advancedFrames: number;
  missingTool?: string;
  missingFrames: number;
  missingReported?: string;
  orphanMenuReported?: boolean;
}

function resetPendingQuestionMonitor(state: PendingQuestionMonitorState): void {
  state.advancedTool = undefined;
  state.advancedFrames = 0;
  state.missingTool = undefined;
  state.missingFrames = 0;
  state.missingReported = undefined;
  state.orphanMenuReported = undefined;
}

/** IMMORTAL INTERACTIVE: an interactive session is a terminal a human drives.
 *  Sitting at a ready prompt for days is its NORMAL state, so every automatic
 *  lifecycle reflex stands down for it — the nudge, the stall kill, the per-turn
 *  timeout ceiling and the lost-prompt reaper. `lifecycleSuspended` already
 *  covers the common case (`awaiting_user` is a waiting status), but only while
 *  the status is accurate: a pane that never reports promptReady (late splash,
 *  a menu, a repainting composer) stays `running`, and that is exactly the
 *  session the reflex used to kill after 300 s of "silence". The MODE is the
 *  durable fact, so it decides.
 *
 *  Auto sessions are unchanged: they have no human at the keyboard, so the
 *  reflex layer is the only thing standing between a frozen teammate and a
 *  four-hour hang. */
export function reflexSuspended(config: Pick<SessionConfig, 'mode'>, state: SessionState): boolean {
  return config.mode === 'interactive' || lifecycleSuspended(state);
}

/** The turn ceiling, with declared-wait time credited back: a babysitter parked
 *  for three hours has not been RUNNING for three hours. */
export function turnCeilingMs(config: Pick<SessionConfig, 'timeoutSeconds'>, state: SessionState): number {
  return (config.timeoutSeconds + (state.waitingCreditSeconds ?? 0)) * 1000;
}

/** The banner prepended to a message one SESSION sent to another.
 *
 *  A teammate reads only the message text, so attribution has to live in it.
 *  Without this every peer message reads as the lead speaking — and a
 *  teammate that cannot tell a peer from its lead cannot judge whether to
 *  simply comply, to push back, or to escalate.
 *
 *  When the sender is parked awaiting an answer (`signal waiting --peer`), the
 *  banner also states the exact command that unblocks them, because "reply to
 *  X" without the addressing rule is the step teammates get wrong. It is
 *  omitted for fire-and-forget so a note that wants nothing back never reads
 *  as a demand. */
export function peerPreamble(sender: Pick<SessionView, 'config'>, replyExpected: boolean): string {
  const from = sender.config.teammate ?? sender.config.id;
  const lines = [`[peer message from teammate ${from} (session ${sender.config.id}) — not from the human lead]`];
  if (replyExpected)
    lines.push(
      `${from} is PARKED waiting for your reply and cannot continue until it arrives. ` +
        `Answer with: kteam send ${from} "<your reply>"`,
    );
  else lines.push(`No reply is required; ${from} has carried on. Reply with \`kteam send ${from} "…"\` if useful.`);
  return `${lines.join('\n')}\n\n`;
}

/** Turn a `--until` argument into an ISO deadline. Accepts an ISO timestamp or
 *  a relative duration (`45m`, `2h`, `90s`, `1h30m`). */
export function parseDeadline(value: string, fromMs = Date.now()): string {
  const text = value.trim();
  if (!text) throw new Error('--until requires a duration (45m, 2h) or an ISO timestamp');
  const duration = text.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i);
  if (duration && duration.slice(1).some(part => part !== undefined)) {
    const [hours, minutes, seconds] = duration.slice(1).map(part => Number(part ?? 0)) as [number, number, number];
    const ms = (hours * 3600 + minutes * 60 + seconds) * 1000;
    if (ms <= 0) throw new Error('--until must be a positive duration');
    return new Date(fromMs + Math.min(ms, WAITING_BACKSTOP_MS)).toISOString();
  }
  // Only a real ISO-8601 DATE is accepted here. Date.parse is far looser â
  // it reads a bare "45" as the YEAR 2045, so the very plausible typo
  // `--until 45` (for 45m) would have parked a session, unsupervised, for two
  // decades: no nudge, no stall kill, no ceiling, and no warden verdict.
  if (!/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(text))
    throw new Error(`could not read "${value}" as a duration (45m, 2h, 90s) or an ISO timestamp`);
  const absolute = Date.parse(text);
  if (!Number.isFinite(absolute)) throw new Error(`could not read "${value}" as a duration or ISO timestamp`);
  if (absolute <= fromMs) throw new Error(`--until ${value} is already in the past`);
  // The backstop is a ceiling on every wait, not just open-ended ones: a park
  // must always end within a bounded time of when it was declared.
  return new Date(Math.min(absolute, fromMs + WAITING_BACKSTOP_MS)).toISOString();
}

/** Whether a session launches with Remote Control. RC is claude-only (codex has
 *  no RC flag) and exists so a HUMAN can watch/steer the session from the RC
 *  surface (phone, claude.ai). An explicit per-session choice (`--rc`/`--no-rc`,
 *  i.e. a defined `requestRemoteControl`) always wins. With NO explicit choice
 *  the default is MODE-DEPENDENT: an interactive session is the user's own
 *  hands-on window and follows the fleet default (on); an auto teammate has no
 *  human at the wheel, so RC is pure overhead and defaults OFF regardless of the
 *  fleet default. The fleet `remoteControl` config is therefore now read as the
 *  default for INTERACTIVE sessions only. */
export function resolveRemoteControl(
  harness: Harness,
  mode: InteractionMode,
  requestRemoteControl: boolean | undefined,
  fleetDefault: boolean | undefined,
): boolean {
  if (harness !== 'claude') return false;
  if (requestRemoteControl !== undefined) return requestRemoteControl;
  if (mode === 'auto') return false;
  return fleetDefault ?? true;
}

/** What one index-vs-disk reconciliation found. */
interface ConsistencyReport {
  /** Session directories with no index row at all (invisible to `ps`). */
  missingFromIndex: string[];
  /** Index rows whose status disagrees with the session's own state.json. */
  staleRows: string[];
  /** Terminal sessions whose journal is still growing. */
  zombies: string[];
  /** Sessions this pass reindexed or re-adopted. */
  repaired: string[];
  /** Live sessions whose chat pointer rows exist but no longer RESOLVE to
   *  readable transcript bytes, and could not be healed by a rebuild this pass. */
  chatIndexBroken: string[];
}

async function interruptibleSleep(
  milliseconds: number,
  signal: AbortSignal,
  register?: (wake: () => void) => void,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
    register?.(done);
  });
}

/** A durable needs-human flag suppresses only the exact anomaly class it was
 *  issued for. Legacy flags have no kind and therefore cover nothing. */
export function needsHumanCoversAnomaly(needsHumanKind: string | undefined, anomalyKind: WardenAnomalyKind): boolean {
  return needsHumanKind === anomalyKind;
}

export function needsHumanStateCoversAnomaly(
  state: Pick<SessionState, 'needsHuman' | 'needsHumanKind' | 'needsHumanRequests'>,
  anomalyKind: WardenAnomalyKind,
): boolean {
  if (state.needsHuman !== undefined && needsHumanCoversAnomaly(state.needsHumanKind, anomalyKind)) return true;
  return (state.needsHumanRequests ?? []).some(request => request.anomalyKind === anomalyKind);
}

export class SessionManager implements KTeamService {
  private readonly tmux: TmuxController;
  private readonly attachments: AttachmentStore;
  private readonly monitors = new Map<string, MonitorHandle>();
  private readonly listeners = new Set<(event: KTeamEvent) => void>();
  private readonly queues = new Map<string, Promise<void>>();
  /** Keep model/effort gestures mutually exclusive while allowing the Codex
   * transcript reducer to take `queues` and publish the acknowledgement. */
  private readonly runtimeControlQueues = new Map<string, Promise<void>>();
  private readonly codexRuntimeControl: CodexRuntimeControl = {
    ...defaultCodexRuntimeControl,
    dismissPicker: async tmuxSession => await dismissCodexPickerInTmux(this.tmux, tmuxSession),
  };
  private readonly deleting = new Set<string>();
  private readonly autoContinued = new Set<string>();
  /** One-shot flags for done-markers deferred while the pane is still working. */
  private readonly doneDeferred = new Set<string>();
  /** Sessions whose launch/relaunch is still queued behind the bootstrap chain.
   *  Their tmux session does not exist yet, so a monitor started for them
   *  would read a dead pane and mark a launching session `failed` â and a
   *  terminal status suppresses every later patch, including the launch's own
   *  `session.running`. Bounded `start`/`--detach` make this window routine.
   *
   *  Registered BEFORE the `starting` transition on purpose: transition()
   *  awaits emit(), which rides the global event queue, and under a launch
   *  storm that queue ran 10+ seconds behind. Registering after it left a
   *  window where the session was persisted as `starting` but unknown to this
   *  map â the self-check then "repaired" it with a monitor that read a pane
   *  which did not exist yet and recorded `session.crashed` on a healthy
   *  teammate (2026-07-24, mrzi4r0p / claude-auto-glm52a). */
  private readonly launching = new Map<string, LaunchProgress>();
  /** True while this session's FIRST launch is still plausibly queued behind
   *  the cross-session bootstrap chain. */
  private launchingRecently(id: string): boolean {
    const progress = this.launching.get(id);
    return progress !== undefined && Date.now() - progress.at < LAUNCH_GRACE_MS;
  }

  /** Give an in-flight FIRST launch up to `waitMs` to finish, so a control
   *  action that lands during the launch window queues behind it instead of
   *  being refused outright. Resolves true when the launch settled. */
  private async awaitLaunchSettled(id: string, waitMs: number): Promise<boolean> {
    const progress = this.launching.get(id);
    if (!progress) return true;
    const settled = await Promise.race([
      progress.bootstrap.then(
        () => true,
        () => true,
      ),
      Bun.sleep(waitMs).then(() => false),
    ]);
    return settled;
  }

  /** Zombie sessions already re-adopted this daemon lifetime (once each). */
  private readonly readoptedZombies = new Set<string>();
  /** id â when this declared wait last published a heartbeat. */
  private readonly waitingHeartbeats = new Map<string, number>();
  /** TUI bootstrap (launch + first inject) serialized ACROSS sessions: rapid
   *  concurrent starts race the injector â only the first survives, the rest
   *  land typed-but-never-started. */
  private bootstrapChain: Promise<void> = Promise.resolve();
  /** One daemon-wide cache over kfleet's 300-second usage feed. */
  private readonly usageFeed: UsageFeed;
  private readonly quotaWaiters = new Map<string, QuotaWaiter>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Counter for TRANSIENT (never-journalled) events only â WS-only frames
   *  like fleet.bootstrap_errors that have no session journal to number them.
   *  Not persisted and not comparable to a session's own sequence. */
  private transientSequence = 0;
  /** Recent LIVE-ONLY frames per session (see LIVE_ONLY_EVENT_TYPES). */
  private readonly liveFrames = new Map<string, KTeamEvent[]>();
  /** One lazy full-transcript index check per session and daemon lifetime.
   *  This makes chat_pointers genuinely disposable: after a DB rebuild (or
   *  the first v4 boot of an existing session), the first chat read recreates
   *  every pointer from the harness's authoritative file. */
  private readonly chatIndexChecks = new Map<string, Promise<void>>();
  private readonly gitFingerprintCache = new Map<string, { at: number; value?: string; pending?: Promise<string> }>();
  /** In-flight journal appends per session, so close() can drain what
   *  `transition` deliberately did not await. */
  private readonly pendingEmits = new Map<string, Promise<unknown>>();
  /** Lazy last-wins channel/sends.jsonl indexes, one per touched session. */
  private sendLedgers = new Map<string, Promise<SendLedger>>();
  /** Sessions whose legacy inbox/pending rows and historical proof were
   * reconciled during this daemon lifetime. */
  private reconciledSendLedgers = new Set<string>();
  /** One terminal transcript-drain/classification job per session, plus the
   * newest cutoff queued while that job is draining EOF. */
  private terminalSendFinalizers = new Map<string, Promise<void>>();
  private terminalSendFinalizerCutoffs = new Map<string, string>();
  private closed = false;
  /** Fleet warden (layer-3 oversight): a periodic deterministic sweep plus,
   *  when enabled, rate-limited LLM escalation. */
  private wardenTimer?: ReturnType<typeof setInterval>;
  /** Deduplicates concurrent bootstrap/self-check attempts to arm the warden. */
  private wardenStarting?: Promise<void>;
  /** Test seams for the poisoned-single-flight regression. */
  private wardenStateReadTimeoutMs = WARDEN_STATE_READ_TIMEOUT_MS;
  private readWardenState = async (): Promise<WardenRuntimeState | undefined> =>
    await readJsonIfPresent<WardenRuntimeState>(this.paths.wardenState);
  /** Armed in create(), independent of bootstrap â the watchdog for the
   *  silent-partial-boot class. */
  private selfCheckTimer?: ReturnType<typeof setInterval>;
  /** True once the boot import finished: the consistency check is meaningless
   *  before it (everything on disk is legitimately unindexed). */
  private indexImported = false;
  /** Health must not report `ok` during the intentionally early-listening
   *  bootstrap window. A cold empty index previously claimed healthy at
   *  136 ms while journal import/recovery continued for another 29.8 s. */
  private bootstrapFinished = false;
  /** Field (rather than an inlined constant) so the never-settling regression
   *  can exercise the real deadline path without waiting five minutes. */
  private bootstrapPhaseTimeoutMs = BOOTSTRAP_PHASE_TIMEOUT_MS;
  /** When the self-check last ran; its lateness is the wedge detector. */
  private lastSelfCheckAt = 0;
  /** Latest observed timer delay beyond the expected self-check interval. */
  private eventLoopLagMs = 0;
  /** Daemon-lifetime count of self-check gaps classified as wedges. */
  private wedgeCount = 0;
  /** When chat-pointer resolvability was last verified (own slower cadence). */
  private lastChatVerifyAt = 0;
  /** Consecutive consistency passes that left `ps` incomplete. */
  private consecutiveIncoherentChecks = 0;
  private selfRestartRequested = false;
  /** An unhealable index has already been reported (once per daemon). */
  private selfRestartAnnounced = false;
  /** A field (rather than an inlined sleep) so hermetic race tests can run the
   *  real confirmation path without wall-clock delay. */
  private readonly terminalReprobeMs = TERMINAL_REPROBE_MS;
  private wardenState: WardenRuntimeState = {};
  private lastSweep?: WardenSweep;
  private lastEmittedFingerprint = '';
  /** Serializes sweeps so a forced `warden run` never races the interval. */
  private wardenSweepChain: Promise<unknown> = Promise.resolve();
  /** Live warden config override, swapped by updateWardenConfig (hot reload).
   *  Every warden read goes through the `wardenConfig` getter so a PATCH is
   *  picked up by the next sweep/spawn without a daemon restart; the boot
   *  config from options stays the fallback. */
  private wardenConfigOverride?: WardenConfig;
  /** Configured-but-missing warden wrappers already warned about — the
   *  fleet.warden_config_invalid event fires once per daemon boot per wrapper,
   *  not once per sweep. */
  private wardenMissingWarned?: Set<string>;

  /** The warden config every warden code path must read (never
   *  options.warden directly): options.warden until a live PATCH swaps it. */
  private get wardenConfig(): WardenConfig {
    return this.wardenConfigOverride ?? this.options.warden;
  }

  private constructor(
    readonly paths: KTeamPaths,
    private readonly store: EventStore,
    private readonly options: SessionManagerOptions,
  ) {
    this.tmux = new TmuxController(paths, options.publicUrl);
    this.attachments = new AttachmentStore({ rootDir: paths.home });
    const hermetic = process.env.KTEAM_TEST_HERMETIC === '1' || process.env.NODE_ENV === 'test';
    this.usageFeed = new UsageFeed(options.quotaUrl, { fallback: hermetic ? undefined : fetchKfleetUsage });
  }

  static async create(paths: KTeamPaths, options: SessionManagerOptions): Promise<SessionManager> {
    await mkdir(paths.daemon, { recursive: true, mode: 0o700 });
    // Open WITHOUT the disk import: the journal scan (even incremental) must
    // never hold the API bind hostage. bootstrap() runs it after listen.
    const store = await EventStore.open({ home: paths.home, databasePath: paths.database, importExisting: false });
    const manager = new SessionManager(paths, store, options);
    // Self-check timer armed HERE â independent of bootstrap, so it survives
    // any bootstrap failure and flags the residue (the class the user had to
    // spot by eyeballing a timestamp on 2026-07-23).
    manager.selfCheckTimer = setInterval(() => void manager.selfCheck().catch(() => undefined), SELF_CHECK_INTERVAL_MS);
    return manager;
  }

  /** Detect the silent-partial-boot class: active sessions without a monitor,
   *  and a warden sweep that stopped happening (timer dead or wedged). Emits
   *  a fleet.self_check_failed transient and â where safe â repairs by
   *  starting the missing monitors and re-arming the warden. */
  private async selfCheck(): Promise<void> {
    if (this.closed) return;
    // The timer's OWN lateness is the wedge detector: this interval fires
    // every 60 s, so a multi-minute gap means the event loop was starved (the
    // 2026-07-23 incident: 23:26:46Z â 23:37:55Z, no timers, no accepts).
    // Nothing the daemon believes about the fleet survives that gap
    // unverified, so a wedge always forces a full consistency pass.
    const tickAt = Date.now();
    const gapMs = this.lastSelfCheckAt === 0 ? 0 : tickAt - this.lastSelfCheckAt;
    this.lastSelfCheckAt = tickAt;
    this.eventLoopLagMs = gapMs === 0 ? 0 : Math.max(0, gapMs - SELF_CHECK_INTERVAL_MS);
    const wedged = gapMs >= WEDGE_GAP_MS;
    if (wedged) {
      this.wedgeCount = (this.wedgeCount ?? 0) + 1;
      const gapSeconds = Math.round(gapMs / 1000);
      console.error(
        `kteamd self-check: event loop was starved for ${gapSeconds}s (timer gap) â verifying index against session directories`,
      );
      this.emitTransient('fleet.daemon_wedge', {
        gapSeconds,
        since: new Date(tickAt - gapMs).toISOString(),
        monitors: this.monitors.size,
      });
    }
    await this.consistencyCheck(wedged).catch(error =>
      console.error(`kteamd self-check: consistency check failed: ${String(error)}`),
    );
    const sessions = await this.list();
    const unmonitored = sessions.filter(
      view =>
        !terminalStatuses.includes(view.state.status) &&
        !this.monitors.has(view.config.id) &&
        // â¦but only while the launch is plausibly still queued. A bootstrap
        // that never finishes (one hung tmux command holds the whole chain)
        // must not hide its session from repair forever.
        !this.launchingRecently(view.config.id),
    );
    const lastSweepMs = this.wardenState.lastSweepAt ? Date.parse(this.wardenState.lastSweepAt) : 0;
    const sweepStale =
      this.wardenTimer === undefined ||
      (lastSweepMs > 0 && Date.now() - lastSweepMs > Math.max(120_000, this.wardenConfig.intervalMinutes * 60_000 * 3));
    if (unmonitored.length === 0 && !sweepStale) return;
    this.emitTransient('fleet.self_check_failed', {
      unmonitoredRunning: unmonitored.map(view => view.config.id),
      wardenTimerArmed: this.wardenTimer !== undefined,
      wardenLastSweepAt: this.wardenState.lastSweepAt,
      bootstrapErrors: this.bootstrapErrors,
    });
    console.error(
      `kteamd self-check: ${unmonitored.length} running session(s) without a monitor` +
        `${sweepStale ? '; warden sweep stale/dead' : ''} â repairing`,
    );
    for (const view of unmonitored) {
      await this.startMonitor(view.config.id).catch(error =>
        console.error(`kteamd self-check: monitor start failed for ${view.config.id}: ${String(error)}`),
      );
    }
    if (sweepStale) {
      if (this.wardenTimer) clearInterval(this.wardenTimer);
      this.wardenTimer = undefined;
      await this.startWarden().catch(error =>
        console.error(`kteamd self-check: warden re-arm failed: ${String(error)}`),
      );
    }
  }

  /** `kteam ps` reads the disposable SQLite index; the session DIRECTORIES are
   *  the authority. After the 2026-07-23 wedge the two disagreed â sessions
   *  were missing from `ps` while their journals kept growing â and only a
   *  full daemon restart restored coherence.
   *
   *  This is that reconciliation, made routine: membership is compared every
   *  tick (cheap), and a deep pass (per-session state + zombie detection)
   *  runs after a wedge or whenever membership drifted. Everything found is
   *  repaired in place â reindex the row, re-adopt the session with a live
   *  monitor â and only a discrepancy that SURVIVES repair escalates to a
   *  clean self-restart, so restarts stay a last resort (they cost every live
   *  pane in the fleet). */
  private async sweepYield(): Promise<void> {
    await Bun.sleep(0);
  }

  private async yieldSweepChunk(index: number): Promise<void> {
    if (index > 0 && index % SWEEP_CHUNK_SIZE === 0) await this.sweepYield();
  }

  private async consistencyCheck(deep: boolean): Promise<ConsistencyReport> {
    const report: ConsistencyReport = {
      missingFromIndex: [],
      staleRows: [],
      zombies: [],
      repaired: [],
      chatIndexBroken: [],
    };
    // Never race the boot import. Until it finishes, EVERY session directory
    // legitimately looks "missing from the index" â repairing against that
    // would duplicate the import's work and, three passes in, restart a daemon
    // that was merely still booting (a permanent boot loop).
    if (!this.indexImported) return report;
    const onDisk = await this.store.sessionIdsOnDisk();
    const indexed = this.store.listSessions();
    // Verify chat pointers actually RESOLVE (not just that rows exist). This is
    // independent of index membership â a chat index can rot while `ps` is
    // perfectly healthy â and must NOT feed the membership-restart counter, so
    // it runs here on its own cadence and reports separately.
    await this.verifyChatIndexes(indexed, report).catch(error =>
      console.error(`kteamd consistency: chat-index verification failed: ${String(error)}`),
    );
    const indexedIds = new Set<string>();
    for (let index = 0; index < indexed.length; index++) {
      await this.yieldSweepChunk(index);
      indexedIds.add(indexed[index]!.id);
    }
    const onDiskSet = new Set<string>();
    for (let index = 0; index < onDisk.length; index++) {
      await this.yieldSweepChunk(index);
      const id = onDisk[index]!;
      onDiskSet.add(id);
      if (!indexedIds.has(id)) report.missingFromIndex.push(id);
    }
    if (deep || report.missingFromIndex.length > 0) {
      for (let index = 0; index < indexed.length; index++) {
        await this.yieldSweepChunk(index);
        const item = indexed[index]!;
        // Rows for deleted/purged directories are metadata-only leftovers,
        // not incoherence.
        if (!onDiskSet.has(item.id)) continue;
        const state = await this.store.readState<SessionState>(item.id).catch(() => undefined);
        if (!state) continue;
        if (state.status !== item.status) report.staleRows.push(item.id);
        if (terminalStatuses.includes(state.status) && (await this.journalOutlivedTerminal(item.id, state)))
          report.zombies.push(item.id);
      }
    }
    const drifted = report.missingFromIndex.length + report.staleRows.length + report.zombies.length;
    if (drifted === 0) {
      this.consecutiveIncoherentChecks = 0;
      return report;
    }
    console.error(
      `kteamd consistency: ${report.missingFromIndex.length} unindexed, ${report.staleRows.length} stale row(s), ` +
        `${report.zombies.length} terminal-but-active â repairing`,
    );
    const resyncIds = [...report.missingFromIndex, ...report.staleRows];
    for (let index = 0; index < resyncIds.length; index++) {
      await this.yieldSweepChunk(index);
      const id = resyncIds[index]!;
      const synced = await this.store.syncSession(id).then(
        () => true,
        error => {
          console.error(`kteamd consistency: reindex of ${id} failed: ${String(error)}`);
          return false;
        },
      );
      if (synced) report.repaired.push(id);
    }
    // A terminal session whose journal keeps growing still owns a live,
    // UNMONITORED pane: its completion was recorded but never carried out.
    // Re-adopting it lets the normal monitor finish the job (it defers while
    // the pane is genuinely working, then reaps it) instead of leaving work
    // that `ps` cannot show and nothing supervises.
    for (let index = 0; index < report.zombies.length; index++) {
      await this.yieldSweepChunk(index);
      const id = report.zombies[index]!;
      // ONCE per session per daemon lifetime. The re-adopt itself would
      // otherwise re-trigger its own detector â the readopt event lands in the
      // journal whose mtime IS the zombie test, and a monitor over a dead pane
      // exits immediately â so an unguarded repair loops forever.
      if (this.monitors.has(id) || this.readoptedZombies.has(id)) continue;
      this.readoptedZombies.add(id);
      await this.startMonitor(id).then(
        () => report.repaired.push(id),
        error => console.error(`kteamd consistency: re-adopt of ${id} failed: ${String(error)}`),
      );
    }
    // Verify the repair rather than trusting it: membership that is STILL
    // wrong after reindexing means the index cannot be healed in place.
    const diskAfterRepair = await this.store.sessionIdsOnDisk();
    const stillMissing: string[] = [];
    for (let index = 0; index < diskAfterRepair.length; index++) {
      await this.yieldSweepChunk(index);
      const id = diskAfterRepair[index]!;
      if (!this.store.getSession(id)) stillMissing.push(id);
    }
    this.consecutiveIncoherentChecks = stillMissing.length > 0 ? this.consecutiveIncoherentChecks + 1 : 0;
    this.emitTransient('fleet.index_incoherent', {
      missingFromIndex: report.missingFromIndex,
      staleRows: report.staleRows,
      zombies: report.zombies,
      repaired: report.repaired.filter(id => !stillMissing.includes(id)),
      stillMissing,
      consecutive: this.consecutiveIncoherentChecks,
    });
    if (this.consecutiveIncoherentChecks >= INCOHERENT_RESTART_THRESHOLD) await this.requestSelfRestart(stillMissing);
    return report;
  }

  /** True when a terminal session's journal kept growing well after it was
   *  declared finished â the "done-marked but still writing events" shape. */
  private async journalOutlivedTerminal(id: string, state: SessionState): Promise<boolean> {
    const finishedMs = state.finishedAt ? Date.parse(state.finishedAt) : 0;
    if (!Number.isFinite(finishedMs) || finishedMs === 0) return false;
    const info = await stat(path.join(sessionDir(this.paths, id), 'events.jsonl')).catch(() => undefined);
    if (!info) return false;
    return info.mtimeMs - finishedMs >= TERMINAL_ACTIVITY_GRACE_MS;
  }

  /** Last resort: an index that cannot be healed in place is fixed by a clean
   *  restart (the service manager restarts us; the journals are authoritative,
   *  so boot rebuilds from disk). Announced, evidenced, and only ever from a
   *  quiescent close â never a hard exit that abandons in-flight writes. */
  private async requestSelfRestart(unhealable: string[]): Promise<void> {
    if (this.selfRestartRequested) return;
    // ACROSS restarts too: a condition the boot cannot fix (an unreadable
    // journal, a directory the index refuses) would otherwise restart the
    // daemon every few minutes forever, dropping fleet supervision for each
    // boot window. One restart per cooldown, then live with it and complain.
    const stampFile = path.join(this.paths.daemon, 'self-restart.json');
    const stamp = await readJson<{ at?: string }>(stampFile).catch(() => ({}) as { at?: string });
    const lastAt = stamp.at ? Date.parse(stamp.at) : 0;
    const cooling = lastAt > 0 && Date.now() - lastAt < SELF_RESTART_COOLDOWN_MS;
    const preview = unhealable.slice(0, 10);
    const previewSuffix = unhealable.length > preview.length ? `, +${unhealable.length - preview.length} more` : '';
    const headline =
      `kteamd: session index is unhealable after ${this.consecutiveIncoherentChecks} passes ` +
      `(${unhealable.length} session(s) invisible to ps; ids: ${preview.join(', ')}${previewSuffix}) â `;
    // The report is announced ONCE per outcome, but the decision is re-made
    // every pass: whether a restart is possible is the ENTRYPOINT's answer
    // (it asks the service manager whether it owns this pid) and can change,
    // so a single "no" must not silence the daemon about a broken index for
    // the rest of its life.
    const announceOnce = (detail: string, data: Record<string, unknown>) => {
      if (this.selfRestartAnnounced) return;
      this.selfRestartAnnounced = true;
      console.error(headline + detail);
      this.emitTransient('fleet.daemon_self_restart', {
        reason: 'session index unhealable in place',
        sessions: [...unhealable],
        consecutive: this.consecutiveIncoherentChecks,
        ...data,
      });
    };
    if (cooling) {
      announceOnce(
        `NOT restarting: a self-restart already happened within ${Math.round(SELF_RESTART_COOLDOWN_MS / 60_000)}m â this needs a human`,
        { supervised: true, cooling: true },
      );
      return;
    }
    this.selfRestartRequested = true;
    // Stamp BEFORE handing over: the handler drains and exits, so a stamp
    // written after it may never land â and an unstamped restart loses the
    // cooldown that stops a restart loop. A declined restart takes it back.
    await atomicJson(stampFile, { at: now(), sessions: unhealable.slice(0, 20) }).catch(() => undefined);
    // A handler that THROWS is a decline, not a restart: treating it as one
    // would leave the latch and the stamp set for a restart that never
    // happened, disabling the repair for the next 30 minutes.
    const restarting = await (async () => (await this.options.onSelfRestart?.()) ?? false)().catch(error => {
      console.error(`kteamd: self-restart handler failed: ${String(error)}`);
      return false;
    });
    if (restarting) {
      announceOnce('restarting cleanly', { supervised: true, cooling: false });
      return;
    }
    // Nothing would re-spawn this daemon (started by hand, no unit owns the
    // pid). Un-latch and un-stamp so a later pass reconsiders.
    this.selfRestartRequested = false;
    await rm(stampFile, { force: true }).catch(() => undefined);
    announceOnce(
      'NOT restarting: this daemon is not under a service manager. Restart it yourself: `kteam daemon restart`',
      { supervised: false, cooling: false },
    );
  }

  /** Index journals, reconcile survivors, and arm the warden. Runs AFTER the
   *  API socket is listening â early requests see a possibly-partial index
   *  (which only grows) rather than a connection refused. */
  /** Errors collected during bootstrap â surfaced via /v1/health so a partial
   *  boot can never be silent again (2026-07-23 06:23 incident: bootstrap
   *  died quietly mid-recover, 4 running sessions unmonitored, warden timer
   *  never armed, nothing logged). */
  readonly bootstrapErrors: string[] = [];

  async bootstrap(): Promise<void> {
    // Partition-tolerant, BOUNDED, and LOUD: each phase runs even if an
    // earlier one threw or never settled; every failure is logged AND kept
    // for the health endpoint. The self-check timer (armed in create(),
    // independent of this chain) watches for the residue: unmonitored running
    // sessions, dead warden timer.
    const phase = async (name: string, work: (signal: AbortSignal) => Promise<unknown>) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const abort = new AbortController();
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            abort.abort();
            reject(new Error(`timed out after ${this.bootstrapPhaseTimeoutMs}ms`));
          }, this.bootstrapPhaseTimeoutMs);
        });
        const operation = Promise.resolve().then(() => work(abort.signal));
        // Promise.race consumes a losing rejection, which avoids an unhandled
        // rejection but would also hide the actionable late error. Preserve it
        // in the daemon log while the durable bootstrap diagnostic retains the
        // bounded timeout outcome.
        void operation.catch(error => {
          if (timedOut)
            console.error(
              `kteamd: bootstrap phase ${name} failed after its deadline: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
        await Promise.race([operation, deadline]);
      } catch (error) {
        const message = `bootstrap phase ${name} failed: ${error instanceof Error ? error.message : String(error)}`;
        this.bootstrapErrors.push(message);
        console.error(`kteamd: ${message}`);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    };
    try {
      await phase('import', async () => {
        const result = await this.store.importFromDisk();
        if (result.failedSessionIds?.length) {
          const preview = result.failedSessionIds.slice(0, 10);
          const suffix = result.failedSessionIds.length > preview.length ? ', …' : '';
          throw new Error(
            `${result.failedSessionIds.length} session(s) failed to import and were skipped: ${preview.join(', ')}${suffix}`,
          );
        }
      });
      // Set even when the phase failed or timed out: a partial index is exactly
      // what the consistency check should repair. Import operations are
      // idempotent, so a timed-out import finishing in the background may
      // safely overlap that repair.
      this.indexImported = true;
      await phase('recover', signal => this.recover(signal));
      await phase('warden', () => this.startWarden());
      await phase('scratch-gc', () => this.sweepScratch());
    } finally {
      // This latch describes whether bootstrap is still running, not whether
      // every best-effort repair succeeded. Health exposes degradation
      // separately and selfCheck owns ongoing invariant repair.
      this.bootstrapFinished = true;
    }
    if (this.bootstrapErrors.length > 0) {
      this.emitTransient('fleet.bootstrap_errors', { errors: this.bootstrapErrors });
    }
  }

  async close(): Promise<void> {
    // Drain deferred journal writes BEFORE latching `closed`: emit() refuses
    // once the daemon is shutting down, so latching first would discard the
    // very last status change of every session (the one that says it stopped).
    await this.flushEmits().catch(() => undefined);
    this.closed = true;
    if (this.wardenTimer) clearInterval(this.wardenTimer);
    if (this.selfCheckTimer) clearInterval(this.selfCheckTimer);
    await this.wardenSweepChain.catch(() => undefined);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    const stopping: Promise<unknown>[] = [];
    for (const waiter of this.quotaWaiters.values()) {
      waiter.abort.abort();
      stopping.push(waiter.promise);
    }
    for (const monitor of this.monitors.values()) {
      monitor.abort.abort();
      if (monitor.transcript) stopping.push(monitor.transcript.stop());
      if (monitor.loop) stopping.push(monitor.loop);
    }
    this.monitors.clear();
    await Promise.allSettled(stopping);
    await this.flushEmits();
    await Promise.allSettled([...this.queues.values()]);
    this.store.close();
  }

  async health(): Promise<Record<string, unknown>> {
    const sessions = await this.list();
    const active = sessions.filter(item => !terminalStatuses.includes(item.state.status));
    // Self-check surface (2026-07-23 silent-bootstrap incident): the operator
    // must be able to see â and the sweep must be able to flag â a partial
    // boot without eyeballing timestamps.
    const unmonitoredRunning = active.filter(item => !this.monitors.has(item.config.id)).length;
    const lastSweepMs = this.wardenState.lastSweepAt ? Date.parse(this.wardenState.lastSweepAt) : 0;
    const wardenTimerArmed = this.wardenTimer !== undefined;
    const bootstrapState = !this.bootstrapFinished
      ? 'running'
      : this.bootstrapErrors.length > 0
        ? 'degraded'
        : 'complete';
    return {
      // `ok` is current serviceability. Historical bootstrap failures remain
      // visible below, but no longer condemn a repaired fleet forever. After
      // an import timeout the indexed membership can briefly undercount
      // on-disk sessions; bootstrapState stays degraded while the independent
      // consistency check discovers and repairs those rows (at most one tick).
      ok: this.bootstrapFinished && unmonitoredRunning === 0 && wardenTimerArmed,
      bootstrapping: !this.bootstrapFinished,
      bootstrapState,
      bootstrapDegraded: bootstrapState === 'degraded',
      version: KTEAM_VERSION,
      pid: process.pid,
      home: this.paths.home,
      sessions: sessions.length,
      running: active.length,
      monitors: this.monitors.size,
      unmonitoredRunning,
      wardenLastSweepSeconds: lastSweepMs > 0 ? Math.floor((Date.now() - lastSweepMs) / 1000) : null,
      wardenTimerArmed,
      eventLoopLagMs: this.eventLoopLagMs,
      lastSelfCheckAt: this.lastSelfCheckAt > 0 ? new Date(this.lastSelfCheckAt).toISOString() : null,
      wedgeCount: this.wedgeCount,
      scratchGcEnabled: this.scratchConfig.enabled,
      scratchReclaimedSessions: this.scratchReclaimed.sessions,
      scratchReclaimedBytes: this.scratchReclaimed.bytes,
      bootstrapErrors: this.bootstrapErrors.length,
      ...(this.bootstrapErrors.length > 0 ? { bootstrapErrorMessages: this.bootstrapErrors.slice(0, 10) } : {}),
      time: now(),
    };
  }

  async list(): Promise<SessionView[]> {
    return this.store.listSessions().flatMap(item => {
      if (!item.config || !item.state) return [];
      return [{ config: item.config as SessionConfig, state: item.state as SessionState, directory: item.directory }];
    });
  }

  async get(id: string): Promise<SessionView> {
    id = this.resolveRef(id);
    try {
      const [config, state] = await Promise.all([
        this.store.readConfig<SessionConfig>(id),
        this.store.readState<SessionState>(id),
      ]);
      return { config, state, directory: sessionDir(this.paths, id) };
    } catch {
      throw new Error(`unknown kteam session "${id}"`);
    }
  }

  private async sendLedger(id: string): Promise<SendLedger> {
    const ledgers = (this.sendLedgers ??= new Map<string, Promise<SendLedger>>());
    let pending = ledgers.get(id);
    if (!pending) {
      pending = SendLedger.open(path.join(sessionDir(this.paths, id), 'channel', 'sends.jsonl'));
      ledgers.set(id, pending);
      void pending.catch(() => {
        if (ledgers.get(id) === pending) ledgers.delete(id);
      });
    }
    return await pending;
  }

  /** GET-ready durable send projection. Unknown ids retain get()'s normal
   * error. The bounded history includes withdrawn tombstones so a client that
   * already folded an ACCEPTED snapshot can remove it after a refresh. */
  async listSends(id: string, options: { all?: boolean } = {}): Promise<SendRecord[]> {
    id = this.resolveRef(id);
    await this.serialized(id, async () => {
      const view = await this.get(id);
      await this.ensureSendLedgerReconciledUnlocked(view);
    });
    const ledger = await this.sendLedger(id);
    if (options.all === true) return ledger.all({ includeWithdrawn: true }).slice(0, 2_000);
    const records = ledger.all({ includeWithdrawn: true });
    const active = records.filter(record => !record.withdrawn && record.fate !== 'delivered');
    const settled = records.filter(record => record.withdrawn === true || record.fate === 'delivered').slice(0, 200);
    return [...active, ...settled].sort((left, right) => Date.parse(right.acceptedAt) - Date.parse(left.acceptedAt));
  }

  private async acceptSendUnlocked(
    id: string,
    view: SessionView,
    input: {
      sendId: string;
      path: SendPath;
      message: string;
      matchText?: string;
      turn?: number;
      attachmentIds: string[];
      from?: string;
      fromName?: string;
      replyExpected?: boolean;
      payloadFile?: string;
      held?: boolean;
    },
  ): Promise<{ record: SendRecord; created: boolean }> {
    await this.ensureSendLedgerReconciledUnlocked(view);
    const ledger = await this.sendLedger(id);
    const record = newAcceptedSend({
      sendId: input.sendId,
      acceptedAt: now(),
      acceptedTurn: view.config.turn,
      path: input.path,
      message: input.message,
      ...(input.matchText === undefined ? {} : { matchText: input.matchText }),
      ...(input.turn === undefined ? {} : { turn: input.turn }),
      attachmentIds: [...input.attachmentIds],
      ...(input.from ? { from: input.from } : {}),
      ...(input.fromName ? { fromName: input.fromName } : {}),
      ...(input.replyExpected ? { replyExpected: true } : {}),
      ...(input.payloadFile ? { payloadFile: input.payloadFile } : {}),
      ...(input.held ? { held: true } : {}),
    });
    const accepted = await ledger.accept(record);
    if (!accepted.created) return accepted;
    try {
      await this.emit(
        id,
        'control.send_accepted',
        {
          sendId: record.sendId,
          path: record.path,
          acceptedTurn: record.acceptedTurn,
          ...(record.turn === undefined ? {} : { turn: record.turn }),
          message: record.message.slice(0, 200),
          attachmentIds: record.attachmentIds,
          ...(record.from ? { from: record.from } : {}),
          ...(record.fromName ? { fromName: record.fromName } : {}),
          ...(record.replyExpected ? { replyExpected: true } : {}),
          ...(record.path === 'native-file' ? { fileBacked: true } : {}),
          ...(record.held ? { held: true } : {}),
        },
        'client',
        record.turn ?? view.config.turn,
      );
    } catch (error) {
      await ledger.withdraw(record.sendId, now()).catch(() => undefined);
      throw error;
    }
    return accepted;
  }

  /** Revise transport facts before a retry/fallback without creating a second
   * logical send. Only a live ACCEPTED record may change this way. */
  private async reviseAcceptedSendUnlocked(
    id: string,
    sendId: string,
    patch: Partial<Pick<SendRecord, 'path' | 'matchText' | 'payloadFile' | 'held' | 'turn'>>,
  ): Promise<SendRecord | undefined> {
    const ledger = await this.sendLedger(id);
    const current = ledger.get(sendId);
    if (!current || current.withdrawn || current.fate !== 'accepted') return undefined;
    return await ledger.persist({ ...current, ...patch });
  }

  private sendDisposition(record: SendRecord): SendDisposition {
    if (record.path === 'native-inline' || record.path === 'native-file') return 'queued';
    if (record.path === 'revive-queue') return 'queued-for-revive';
    if (record.path === 'revive') return 'revived';
    return 'delivered';
  }

  private async withdrawSendUnlocked(id: string, sendId: string, reason: string): Promise<void> {
    const record = await (await this.sendLedger(id)).withdraw(sendId, now());
    if (!record) return;
    await this.emit(id, 'control.send_withdrawn', { sendId, path: record.path, reason }, 'daemon', record.turn).catch(
      () => undefined,
    );
  }

  private async reconcileObservedInputsUnlocked(
    id: string,
    view: SessionView,
    inputs: readonly ObservedHumanInput[],
  ): Promise<number> {
    if (inputs.length === 0) return 0;
    const ledger = await this.sendLedger(id);
    const observedTimes = inputs
      .flatMap(input => {
        const milliseconds = Date.parse(input.observedAt);
        return Number.isFinite(milliseconds) ? [{ at: input.observedAt, milliseconds }] : [];
      })
      .sort((left, right) => left.milliseconds - right.milliseconds);
    // A dedicated harness record is authoritative evidence that consumption
    // resumed. It can beat the next monitor tick, so persist the freeze shift
    // before matching rather than rejecting the first valid post-resume proof
    // against a stale pre-freeze upper bound.
    for (const record of ledger.all()) {
      if (!record.timeoutFrozenAt) continue;
      const frozenAt = Date.parse(record.timeoutFrozenAt);
      if (!Number.isFinite(frozenAt)) continue;
      const resumed = observedTimes.find(candidate => candidate.milliseconds >= frozenAt);
      if (!resumed) continue;
      const shifted = shiftFrozenSendTimeout(record, resumed.at);
      if (shifted !== record) await ledger.persist(shifted);
    }
    const used = ledger.usedEvidenceKeys();
    for (const key of view.state.sendEvidenceKeys ?? []) used.add(key);
    const matches = matchObservedHumanInputs(ledger.all(), inputs, used);
    let delivered = 0;
    for (const match of matches) {
      const current = await this.get(id);
      if (await this.deliverSendMatchUnlocked(id, current, ledger, match)) delivered++;
    }
    return delivered;
  }

  private async deliverSendMatchUnlocked(
    id: string,
    view: SessionView,
    ledger: SendLedger,
    match: SendMatch,
  ): Promise<boolean> {
    const before = ledger.get(match.sendId);
    if (!before) return false;
    const deliveredAt = now();
    const record = await ledger.deliver(match, view.config.turn, deliveredAt);
    if (!record?.evidence) return false;
    await this.store.updateState<SessionState>(id, current => ({
      ...current,
      pendingNativeSends: (current.pendingNativeSends ?? []).filter(entry => entry.id !== record.sendId),
      sendEvidenceKeys: appendEvidenceKey(current.sendEvidenceKeys, record.evidence!.key),
    }));
    await this.emit(
      id,
      'control.send_delivered',
      {
        sendId: record.sendId,
        turn: view.config.turn,
        evidence: {
          kind: record.evidence.kind,
          tier: record.evidence.tier,
          key: record.evidence.key,
          proof: record.evidence.proof,
          observedAt: record.evidence.observedAt,
        },
      },
      'daemon',
      view.config.turn,
    );
    // Compatibility for readers that still key queued placement off the old
    // event. Fate proof itself deliberately advances no turn and clears no
    // marker: Claude drains are commonly batched in the middle of one turn.
    if (before.path === 'native-inline' || before.path === 'native-file') {
      await this.emit(
        id,
        'control.send_consumed',
        { queueId: record.sendId, turn: view.config.turn, message: record.message.slice(0, 200) },
        'daemon',
        view.config.turn,
      );
    }
    return true;
  }

  private async transitionUnaccountedUnlocked(
    id: string,
    view: SessionView,
    reason: SendUnaccountedReason,
    acceptedThrough?: string,
  ): Promise<number> {
    const ledger = await this.sendLedger(id);
    const cutoff = acceptedThrough ? Date.parse(acceptedThrough) : Number.POSITIVE_INFINITY;
    const transitioned: SendRecord[] = [];
    for (const record of ledger.all()) {
      if (record.fate !== 'accepted' || record.held || record.withdrawn) continue;
      if (reason === 'composer_discarded' && record.path !== 'native-inline' && record.path !== 'native-file') continue;
      if (Date.parse(record.acceptedAt) > cutoff) continue;
      const next = await ledger.unaccount(record.sendId, reason, now());
      if (next) transitioned.push(next);
    }
    if (transitioned.length === 0) return 0;
    const ids = new Set(transitioned.map(record => record.sendId));
    await this.store.updateState<SessionState>(id, current => ({
      ...current,
      ...(reason === 'session_ended' && terminalStatuses.includes(current.status)
        ? {
            reason:
              `${current.reason ? `${current.reason}; ` : ''}${transitioned.length} send(s) unconfirmed before the session ended ` +
              '(kept durably in channel/sends.jsonl; resend with kteam send)',
          }
        : {}),
      ...(reason === 'session_ended' || reason === 'composer_discarded'
        ? { pendingNativeSends: (current.pendingNativeSends ?? []).filter(entry => !ids.has(entry.id)) }
        : {}),
    }));
    for (const record of transitioned) {
      await this.emit(
        id,
        'control.send_unaccounted',
        { sendId: record.sendId, reason, path: record.path },
        'daemon',
        record.turn ?? view.config.turn,
        true,
      ).catch(() => undefined);
    }
    return transitioned.length;
  }

  /** Existing monitor/recovery observations drive timeout bookkeeping; there
   * is deliberately no send-specific timer. Opportunity is record-relative:
   * a later tracked turn or an idle prompt proves the harness had a chance to
   * consume the queued input. */
  private async sweepSendFatesUnlocked(
    id: string,
    view: SessionView,
    context: { at?: string; promptReady?: boolean; frozen: boolean },
  ): Promise<number> {
    await this.ensureSendLedgerReconciledUnlocked(view);
    const ledger = await this.sendLedger(id);
    const at = context.at ?? now();
    let transitioned = 0;
    for (const record of ledger.all()) {
      const next = advanceSendTimeout(record, {
        now: at,
        opportunity:
          context.promptReady === true || view.state.promptReady === true || view.config.turn > record.acceptedTurn,
        frozen: context.frozen,
      });
      if (next === record) continue;
      await ledger.persist(next);
      if (record.fate !== 'accepted' || next.fate !== 'unaccounted') continue;
      transitioned++;
      // Matching is ledger-owned now; pendingNativeSends is only pre-submit
      // mechanics. Once timeout fate is fsynced, remove the mechanics mirror
      // just as terminal/composer transitions do. Startup reconciliation
      // repairs the same gap if this state write loses a crash race.
      await this.store.updateState<SessionState>(id, current => ({
        ...current,
        pendingNativeSends: (current.pendingNativeSends ?? []).filter(entry => entry.id !== next.sendId),
      }));
      await this.emit(
        id,
        'control.send_unaccounted',
        { sendId: next.sendId, reason: 'timeout', path: next.path },
        'daemon',
        next.turn ?? view.config.turn,
        true,
      ).catch(() => undefined);
    }
    return transitioned;
  }

  private async historicalObservedInputs(view: SessionView): Promise<ObservedHumanInput[]> {
    const inputs: ObservedHumanInput[] = [];
    if (view.config.harness === 'claude' && view.config.harnessHome && view.config.harnessSessionId) {
      const watcher = await startClaudeTranscriptWatcher({
        transcriptRoot: path.join(view.config.harnessHome, 'projects'),
        sessionId: view.config.harnessSessionId,
        initialOffset: 0,
        reconcileIntervalMs: Math.max(10, this.options.transcriptReconcileSeconds * 1000),
        onEvents: () => undefined,
        onObservedInput: observed => {
          inputs.push(...observed);
        },
        onError: () => undefined,
      });
      try {
        // A fulfilled flush with zero candidates is authoritative. A rejected
        // start/flush is not: propagate it so terminal reconciliation cannot
        // turn an unread transcript into a false UNACCOUNTED fate.
        await watcher.flush();
      } finally {
        // Best-effort cleanup must never replace the primary start/flush
        // failure. The temporary replay watcher owns no long-lived monitor.
        await watcher.stop().catch(() => undefined);
      }
    } else if (view.config.harness === 'codex' && view.config.transcriptFile) {
      const watcher = await startCodexTranscriptWatcher({
        transcriptFile: view.config.transcriptFile,
        sessionId: view.config.harnessSessionId,
        initialOffset: 0,
        reconcileIntervalMs: Math.max(10, this.options.transcriptReconcileSeconds * 1000),
        onEvents: () => undefined,
        onObservedInput: observed => {
          inputs.push(...observed);
        },
        onError: () => undefined,
      });
      try {
        await watcher.flush();
      } finally {
        await watcher.stop().catch(() => undefined);
      }
    }
    return inputs;
  }

  private async legacySendRecords(view: SessionView): Promise<SendRecord[]> {
    const pending = new Map((view.state.pendingNativeSends ?? []).map(entry => [entry.id, entry]));
    const inboxFile = path.join(view.directory, 'channel', 'inbox.jsonl');
    const rows = (await readFile(inboxFile, 'utf8').catch(() => ''))
      .split('\n')
      .flatMap(line => {
        if (!line.trim()) return [];
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          return [value];
        } catch {
          return [];
        }
      })
      .filter(row => typeof row.queueId === 'string' && (row.queued === true || row.queuedForRevive === true));
    const rowsById = new Map(rows.map(row => [row.queueId as string, row]));
    const ids = new Set([...pending.keys(), ...rowsById.keys()]);
    const records: SendRecord[] = [];
    for (const sendId of ids) {
      const row = rowsById.get(sendId);
      const mechanics = pending.get(sendId);
      const held = row?.queuedForRevive === true;
      const inferredPayload = path.join(view.directory, 'channel', `queued-${sendId}.md`);
      const payloadFile = mechanics?.payloadFile ?? (existsSync(inferredPayload) ? inferredPayload : undefined);
      const logicalMessage = (typeof row?.message === 'string' ? row.message : undefined) ?? mechanics?.message ?? '';
      const acceptedAt = mechanics?.at ?? (typeof row?.at === 'string' ? row.at : now());
      const attachmentIds = Array.isArray(row?.attachmentIds)
        ? row.attachmentIds.filter((value): value is string => typeof value === 'string')
        : [...(mechanics?.attachmentIds ?? [])];
      const attachmentBlock = attachmentIds.length
        ? await this.attachments.buildImageReferenceBlock(view.config.id, attachmentIds).catch(() => '')
        : '';
      const reconstructedPayload = mechanics?.message ?? [logicalMessage, attachmentBlock].filter(Boolean).join('\n\n');
      const queueText = payloadFile
        ? `Read the queued message file at ${payloadFile} completely now, then follow every instruction inside it.`
        : (mechanics?.queueText ?? reconstructedPayload);
      records.push(
        newAcceptedSend({
          sendId,
          acceptedAt,
          acceptedTurn: view.config.turn,
          path: held ? 'revive-queue' : payloadFile ? 'native-file' : 'native-inline',
          message: logicalMessage,
          ...(!held && queueText ? { matchText: queueText } : {}),
          attachmentIds,
          ...(typeof row?.from === 'string' ? { from: row.from } : {}),
          ...(typeof row?.fromName === 'string' ? { fromName: row.fromName } : {}),
          ...(row?.replyExpected === true ? { replyExpected: true } : {}),
          ...(payloadFile ? { payloadFile } : {}),
          ...(held ? { held: true } : {}),
        }),
      );
    }
    return records;
  }

  private async ensureSendLedgerReconciledUnlocked(view: SessionView): Promise<void> {
    const id = view.config.id;
    const reconciled = (this.reconciledSendLedgers ??= new Set<string>());
    if (reconciled.has(id)) return;
    const ledger = await this.sendLedger(id);
    for (const record of await this.legacySendRecords(view)) {
      const accepted = await ledger.accept(record);
      if (!accepted.created) continue;
      await this.emit(
        id,
        'control.send_accepted',
        {
          sendId: record.sendId,
          path: record.path,
          acceptedTurn: record.acceptedTurn,
          message: record.message.slice(0, 200),
          attachmentIds: record.attachmentIds,
          migrated: true,
          ...(record.held ? { held: true } : {}),
        },
        'daemon',
        view.config.turn,
      ).catch(() => undefined);
    }
    // Crash repair: ledger.deliver() fsyncs before the mechanics/state mirror
    // update. If the process died in that gap, the proof key is already used
    // and replay correctly refuses to deliver twice, but the old mechanics row
    // would otherwise live forever. Rebuild the mirror from settled snapshots.
    const snapshots = ledger.all({ includeWithdrawn: true });
    const settledIds = new Set(
      snapshots.filter(record => record.withdrawn === true || record.fate !== 'accepted').map(record => record.sendId),
    );
    const deliveredKeys = snapshots
      .filter(record => record.fate === 'delivered' && record.evidence?.key)
      .reverse()
      .map(record => record.evidence!.key);
    if (settledIds.size > 0 || deliveredKeys.length > 0) {
      await this.store.updateState<SessionState>(id, current => {
        let sendEvidenceKeys = current.sendEvidenceKeys;
        for (const key of deliveredKeys) sendEvidenceKeys = appendEvidenceKey(sendEvidenceKeys, key);
        return {
          ...current,
          pendingNativeSends: (current.pendingNativeSends ?? []).filter(entry => !settledIds.has(entry.id)),
          ...(sendEvidenceKeys === undefined ? {} : { sendEvidenceKeys }),
        };
      });
    }
    if (
      ledger.all().some(record => !record.withdrawn && !record.held && record.fate !== 'delivered' && record.matchText)
    ) {
      await this.reconcileObservedInputsUnlocked(id, view, await this.historicalObservedInputs(view));
    }
    const current = await this.get(id).catch(() => view);
    if (terminalStatuses.includes(current.state.status)) {
      // First reconciliation owns only rows that already existed when this
      // lock was entered: acceptSendUnlocked always runs ensure before adding
      // a new acceptance, and held revive-queue rows are exempt below. Do not
      // reuse the terminal state's old finishedAt cutoff here. Pre-fix revive
      // failures could durably accept after that timestamp, and latching the
      // ledger with such a row still ACCEPTED would strand it forever.
      await this.transitionUnaccountedUnlocked(id, current, 'session_ended');
    }
    reconciled.add(id);
  }

  /** Canonicalize a session reference: an exact id passes through; otherwise try
   *  it as a teammate name (case-insensitive) among sessions created within the
   *  name window â most recent wins. Unknown refs pass through so the caller's
   *  own "unknown session" error fires. */
  private resolveRef(ref: string): string {
    const sessions = this.store.listSessions();
    if (sessions.some(item => (item.config as SessionConfig | undefined)?.id === ref)) return ref;
    const needle = ref.trim().toLowerCase();
    const cutoff = Date.now() - NAME_WINDOW_MS;
    const match = sessions
      .flatMap(item => {
        const config = item.config as SessionConfig | undefined;
        return config?.teammate?.toLowerCase() === needle && Date.parse(config.createdAt) >= cutoff ? [config] : [];
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return match?.id ?? ref;
  }

  /** Gather teammate-name usage inside the resolution window ONCE, so the
   *  auto-assigner, the `--teammate` collision check, and `kteam name` all read
   *  the same facts. `recent` = names used in the window (auto-assign avoids
   *  these); `lastUsedAt` = newest creation time per name (the LRU fallback);
   *  `liveByName` = the LIVE (non-terminal) sessions holding each name, which is
   *  what a `--teammate` collision is defined against. */
  private teammateNameUsage(): {
    recent: string[];
    lastUsedAt: Map<string, number>;
    liveByName: Map<string, SessionConfig[]>;
  } {
    const recent: string[] = [];
    const lastUsedAt = new Map<string, number>();
    const liveByName = new Map<string, SessionConfig[]>();
    const cutoff = Date.now() - NAME_WINDOW_MS;
    for (const item of this.store.listSessions()) {
      const config = item.config as SessionConfig | undefined;
      if (!config?.teammate) continue;
      const name = config.teammate.toLowerCase();
      const created = Date.parse(config.createdAt) || 0;
      if (created >= cutoff) recent.push(name);
      lastUsedAt.set(name, Math.max(lastUsedAt.get(name) ?? 0, created));
      const state = item.state as SessionState | undefined;
      if (created >= cutoff && state && !terminalStatuses.includes(state.status)) {
        const live = liveByName.get(name) ?? [];
        live.push(config);
        liveByName.set(name, live);
      }
    }
    return { recent, lastUsedAt, liveByName };
  }

  /** Assign a fresh teammate callsign, avoiding names used within the window. */
  private assignTeammateName(): string {
    const { recent, lastUsedAt } = this.teammateNameUsage();
    return pickTeammateName(recent, lastUsedAt);
  }

  /** Resolve the teammate name for a new session. Absent `--teammate` =>
   *  auto-assign (unchanged path). A supplied name is normalised to the pool's
   *  slug shape and REJECTED if invalid; if a live session in the window already
   *  holds it the start FAILS with the conflict listed, unless `teammateFallback`
   *  opts into auto-assigning a free name instead. */
  private resolveTeammateName(request: StartSessionRequest): string {
    const requested = request.teammate?.trim();
    if (!requested) return this.assignTeammateName();
    const normalized = normalizeTeammateName(requested);
    if (!normalized)
      throw new Error(
        `invalid --teammate name "${requested}": use a slug like "hayden" — ` +
          'lowercase, start with a letter, then letters/digits/hyphens, at most 32 chars',
      );
    const { recent, lastUsedAt, liveByName } = this.teammateNameUsage();
    const live = liveByName.get(normalized) ?? [];
    if (live.length > 0) {
      if (request.teammateFallback) {
        const used = new Set(recent);
        used.add(normalized);
        return pickTeammateName([...used], lastUsedAt);
      }
      const conflicts = live.map(config => `${config.id} (${config.name})`).join(', ');
      throw new Error(
        `teammate name "${normalized}" is already taken by a live session in the last 5 days: ${conflicts}. ` +
          'Pass --teammate-fallback to auto-assign a free name instead, or pick another with `kteam name`.',
      );
    }
    return normalized;
  }

  /** Suggest teammate names that are free within the resolution window, for a
   *  caller composing a `[Name] Task` title before it starts. A SUGGESTION, not
   *  a reservation: nothing is persisted, so a later `start --teammate` may
   *  still collide (a correct reservation needs a durable TTL store and would
   *  race on the reservation record itself — not worth it when the collision is
   *  already handled and the caller just retries with the next name). */
  async suggestNames(count = 1): Promise<string[]> {
    const wanted = Math.max(1, Math.min(Math.floor(count) || 1, 50));
    const { recent, lastUsedAt } = this.teammateNameUsage();
    const used = new Set(recent);
    const names: string[] = [];
    while (names.length < wanted) {
      const name = pickTeammateName([...used], lastUsedAt);
      // Pool exhausted: pickTeammateName falls back to an LRU name that may
      // already be in `used`. Stop rather than emit a duplicate suggestion.
      if (used.has(name)) break;
      used.add(name);
      names.push(name);
    }
    return names;
  }

  /** Walk a parent chain (by id); true if the session or any ancestor carries
   *  the warden label. Cycle-guarded. */
  private async hasWardenAncestor(startId: string | undefined): Promise<boolean> {
    const seen = new Set<string>();
    let current = startId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const view = await this.get(current).catch(() => undefined);
      if (!view) return false;
      if (view.config.label === WARDEN_LABEL) return true;
      current = view.config.parent;
    }
    return false;
  }

  async start(request: StartSessionRequest, hooks: SessionStartHooks = {}): Promise<SessionView> {
    const prompt = request.prompt?.trim() ?? '';
    // Pure argument validation first, before any wrapper/filesystem probing, so a
    // malformed request is rejected on the same terms whatever the environment.
    const mode = request.mode ?? 'auto';
    if (mode !== 'auto' && mode !== 'interactive') throw new Error('mode must be auto or interactive');
    // An automode teammate with no task cannot do anything but violate the
    // protocol, so the prompt stays mandatory there. INTERACTIVE mode is a plain
    // TUI a human drives: a bare start is the normal case, and injecting an
    // opening turn into it would be kteam typing into the human's session.
    if (!prompt && mode !== 'interactive') throw new Error('prompt is required');
    // Resolve the teammate callsign up front (pure + store-only): a bad
    // `--teammate` slug or a live-session collision must fail on the same terms
    // whatever the wrapper/filesystem look like, and before any launch work.
    const teammate = this.resolveTeammateName(request);
    const binary = request.agent;
    const harness = inferHarness(binary);
    if (!path.basename(binary).startsWith(`${harness}-auto-`))
      throw new Error('kteam only launches auto-mode fleet wrappers');
    const wrapper = resolveBinary(binary, [this.paths.kfleetBin, process.env.PATH ?? ''].join(path.delimiter));
    if (!wrapper) throw new Error(`wrapper not found: ${binary}; run kfleet apply`);
    const requestedCwd = path.resolve(request.cwd ?? process.cwd());
    if (!(await stat(requestedCwd).catch(() => undefined))?.isDirectory())
      throw new Error(`not a directory: ${requestedCwd}`);
    // macOS exposes /tmp through /private/tmp. Store the canonical path so
    // harness trust records and transcript metadata agree with the session.
    const cwd = await realpath(requestedCwd);
    // Remote Control: claude-only, explicit request wins, else a MODE-DEPENDENT
    // default (interactive follows the fleet default, auto is off). See
    // resolveRemoteControl.
    const remoteControl = resolveRemoteControl(harness, mode, request.remoteControl, this.options.remoteControl);
    const harnessFlags = (request.harnessFlags ?? []).map(flag => flag.trim()).filter(Boolean);
    const harnessHome = await wrapperHome(wrapper, harness);
    if (!harnessHome)
      throw new Error(
        `could not determine ${harness === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'} from ${wrapper}`,
      );
    const harnessSessionBaseline = harness === 'codex' ? await codexSessionIds(harnessHome) : undefined;
    // Parent capture: teammates starting teammates form a tree. Resolve the
    // caller-supplied parent ref (id or teammate name) to a real session; a
    // dangling ref is dropped rather than stored broken. Children inherit the
    // parent's label when none is given, so whole trees group in ps/UI.
    const parentRef = request.parent?.trim();
    const parentView = parentRef ? await this.get(parentRef).catch(() => undefined) : undefined;
    // Recursion guard: a session anywhere below a warden in the parent tree is
    // FORCE-labelled kteam-warden regardless of the requested/inherited label, so
    // the detector's lineage exclusion covers it and a warden can never spawn an
    // escalatable (non-warden) session. (The warden-scoped token also 403s the
    // start route outright â this is the server-side backstop.)
    const forcedWarden = await this.hasWardenAncestor(parentView?.config.id);
    const label = forcedWarden ? WARDEN_LABEL : request.label?.trim() || parentView?.config.label || undefined;
    // Model resolution: explicit request wins, else the wrapper's kfleet default
    // (KTEAM_MODEL). A default is always fed in when kfleet declares one, so the
    // per-account default model can't silently drift; undefined => no --model.
    const model = request.model?.trim() || (await wrapperModel(wrapper));

    // Preflight 1 â duplicate guard: a client retrying start after a transient
    // error must not spawn a second live session for the same work. An
    // identical (binary, cwd, prompt) session started in the last 10 minutes
    // that is still live IS that earlier request succeeding server-side.
    // …but a BARE interactive start has no prompt to be identical to, and a human
    // opening a second terminal on the same repo is not a retry. Only prompted
    // starts are de-duplicated.
    for (const existing of prompt ? await this.list() : []) {
      if (
        existing.config.binary === binary &&
        existing.config.cwd === cwd &&
        !terminalStatuses.includes(existing.state.status) &&
        Date.now() - Date.parse(existing.config.createdAt) < 600_000 &&
        (await readFile(existing.config.originalPromptFile, 'utf8').catch(() => '')).trim() === prompt
      ) {
        throw new Error(
          `an identical session is already live: ${existing.config.id} (${existing.state.status}); ` +
            'the earlier start succeeded â use it, or stop it first',
        );
      }
    }
    // Preflight 2 â quota/auth: launching on an exhausted or logged-out
    // account burns a session that can only no-op. Fail fast, wrapper named.
    const preflightQuota = await this.fetchQuota({ binary } as SessionConfig);
    if (preflightQuota?.authOk === false) {
      throw new Error(
        `wrapper ${binary}'s credentials were rejected (kfleet usage reports auth failure); ${authFailureRemedy(preflightQuota.provider)}`,
      );
    }
    if (preflightQuota?.unavailable === true) {
      throw new Error(
        `wrapper ${binary} CLI/provider is unavailable: ${providerUnavailableDetail(preflightQuota)}; pick another account`,
      );
    }
    if (preflightQuota?.atLimit === true) {
      const reset = preflightQuota.resetAt ? ` (resets ${new Date(preflightQuota.resetAt).toISOString()})` : '';
      throw new Error(`wrapper ${binary} is at its usage limit${reset}; pick another account`);
    }

    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const directory = sessionDir(this.paths, id);
    await Promise.all(
      ['markers', 'channel', 'checks', 'snapshots', 'logs', 'turns', 'raw', 'attachments'].map(name =>
        mkdir(path.join(directory, name), { recursive: true, mode: 0o700 }),
      ),
    );
    const initialAttachments: StoredAttachment[] = [];
    try {
      for (const attachment of request.initialAttachments ?? []) {
        if (attachment.base64.length > 28 * 1024 * 1024)
          throw new AttachmentError('attachment_too_large', 'initial attachment exceeds the 20 MiB decoded limit');
        const stored = await this.attachments.upload(id, Buffer.from(attachment.base64, 'base64'), {
          filename: attachment.filename,
          mime: attachment.mime,
        });
        initialAttachments.push(stored);
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const attachmentBlock = await this.attachments.buildImageReferenceBlock(
      id,
      initialAttachments.map(item => item.manifest.id),
    );
    const assignedPrompt = [prompt, attachmentBlock].filter(Boolean).join('\n\n');
    const createdAt = now();
    const config: SessionConfig = {
      id,
      // The human task title, shown verbatim in ps/the dashboard — the
      // `[Teammate] Task Title` convention is preserved, only control chars and
      // length are normalised (see displayName). A bare interactive session has
      // no prompt to name itself after, so it is named for what it is (renamed
      // via --name if the human cares).
      name: displayName(request.name ?? (prompt ? prompt.split(/\s+/).slice(0, 5).join('-') : 'interactive')),
      teammate,
      label,
      parent: parentView?.config.id,
      binary,
      harness,
      modelHint: modelHint(binary),
      model,
      mode,
      ...(remoteControl ? { remoteControl: true } : {}),
      ...(harnessFlags.length ? { harnessFlags } : {}),
      cwd,
      createdAt,
      updatedAt: createdAt,
      turn: 1,
      harnessSessionId: harness === 'claude' ? crypto.randomUUID() : '',
      harnessHome,
      harnessSessionBaseline,
      tmuxSession: shellSafeSessionName(id, 'agent'),
      watcherSession: shellSafeSessionName(id, 'watch'),
      intervalSeconds: this.number(request.intervalSeconds, this.options.healthIntervalSeconds, 2, 'intervalSeconds'),
      stallSeconds: this.number(request.stallSeconds, 900, 10, 'stallSeconds'),
      timeoutSeconds: this.number(request.timeoutSeconds, 14_400, 30, 'timeoutSeconds'),
      nudgeAfterSeconds: this.number(request.nudgeAfterSeconds, 180, 30, 'nudgeAfterSeconds'),
      killAfterSeconds: this.number(request.killAfterSeconds, 300, 60, 'killAfterSeconds'),
      directSendMaxChars: this.number(request.directSendMaxChars, 500, 0, 'directSendMaxChars'),
      resumeMenuChoice: request.resumeMenuChoice === 'summary' ? 'summary' : 'full',
      maxSnapshots: this.number(request.maxSnapshots, 200, 1, 'maxSnapshots'),
      ...(request.stopCapability ? { stopCapability: request.stopCapability } : {}),
      systemPromptFile: path.join(directory, 'system.md'),
      originalPromptFile: path.join(directory, 'prompt.md'),
      retry: { transientAttempts: 3, stalledAttempts: 0, waitForQuotaReset: true, allowAccountFailover: false },
    };
    config.transcriptFile = claudeTranscriptPath(config);
    const state: SessionState = {
      id,
      status: 'created',
      turn: 1,
      health: 'unknown',
      openTools: [],
      transcriptOffset: 0,
      turnCompleted: false,
      ...(preflightQuota ? { quota: preflightQuota, ...usageStateFromQuota(preflightQuota) } : {}),
    };
    const systemPrompt = this.systemPrompt(config);
    // A bare interactive start gets NO turn-1 prompt file: the file is what
    // `promptInstruction` points the harness at, and the whole point of a bare
    // start is that nothing is typed into the human's TUI. Its absence is also
    // what the re-inject reflex checks before re-sending a turn.
    const deliverFirstTurn = assignedPrompt.length > 0;
    await Promise.all([
      this.store.writeConfig(id, config),
      this.store.writeState(id, state),
      writeFile(config.systemPromptFile, systemPrompt, { mode: 0o600 }),
      writeFile(config.originalPromptFile, `${assignedPrompt}\n`, { mode: 0o600 }),
      ...(deliverFirstTurn
        ? [
            writeFile(turnPrompt(this.paths, id, 1), `${systemPrompt}\n# Assigned task\n\n${assignedPrompt}\n`, {
              mode: 0o600,
            }),
          ]
        : []),
      writeFile(turnLog(this.paths, id, 1), '', { mode: 0o600 }),
      writeFile(path.join(directory, 'chat.jsonl'), '', { mode: 0o600 }),
      writeFile(path.join(directory, 'channel', 'inbox.jsonl'), '', { mode: 0o600 }),
      writeFile(path.join(directory, 'channel', 'outbox.jsonl'), '', { mode: 0o600 }),
    ]);
    // Claim the launch window BEFORE anything that awaits the event queue.
    // `emit`/`transition` can sit behind a 10-second global queue during a
    // launch storm, and everything that protects a launching session keys off
    // this map â registering it later left the session visible as `starting`
    // to the self-check while still unregistered here. The real bootstrap
    // promise replaces this placeholder a few lines down.
    let releaseLaunch = () => {};
    this.launching.set(id, {
      at: Date.now(),
      bootstrap: new Promise<void>(resolve => {
        releaseLaunch = resolve;
      }),
    });
    try {
      await this.emit(id, 'session.created', { binary, harness, mode, cwd }, 'daemon', 1);
      for (const stored of initialAttachments) {
        await this.emit(id, 'attachment.created', this.attachmentView(stored), 'client', 1);
      }
      await this.transition(
        id,
        { status: 'starting', startedAt: now(), health: 'healthy', nudgedAt: undefined },
        'session.starting',
      );
    } catch (error) {
      this.launching.delete(id);
      releaseLaunch();
      throw error;
    }
    // The TUI bootstrap is serialized ACROSS sessions, so a launch storm makes
    // each caller wait for every queued predecessor. Callers have their own
    // deadlines: the exec responders SIGTERMed `kteam start` (exit 143) while
    // the daemon went on to create the session anyway â a launch reported as
    // failed that a retry then duplicated. So the REQUEST is bounded here: the
    // session is already persisted and its bootstrap keeps running in the
    // background, and the caller gets a real view of a 'starting' session
    // instead of an open socket and a timeout.
    // The caller waits for the RUNNING MILESTONE, not for the whole bootstrap.
    // `bootstrapSession` keeps working after it (transcript watcher attach,
    // first reconcile), and those steps used to hold `kteam start` open for
    // the full 45 s window even though the teammate was demonstrably up: on
    // 2026-07-25 a session reached `running` in 3.7 s, COMPLETED its task, and
    // only then was the launch declared "backgrounded".
    let signalRunning = () => {};
    const running = new Promise<void>(resolve => {
      signalRunning = resolve;
    });
    const bootstrap = this.bootstrapSession(id, config, signalRunning, deliverFirstTurn, hooks).finally(() => {
      this.launching.delete(id);
      releaseLaunch();
    });
    // Keep the launch registered under the REAL bootstrap promise so control
    // actions can queue behind it (awaitLaunchSettled).
    const claim = this.launching.get(id);
    if (claim)
      this.launching.set(id, {
        ...claim,
        bootstrap: bootstrap.then(
          () => undefined,
          () => undefined,
        ),
      });
    await this.awaitBootstrap(
      id,
      bootstrap,
      running,
      // A daemon-owned pre-turn gate is part of the launch contract, not
      // optional bookkeeping. Never return a warden as successfully spawned
      // before that gate has either passed or failed back to its caller.
      hooks.beforeFirstTurn ? undefined : request.detach === true ? 0 : startWaitMsFor(binary, START_WAIT_MS),
    );
    return await this.get(id);
  }

  /** Wait for a launch, but only for `waitMs`, and only up to the RUNNING
   *  milestone (pane up, prompt delivered, monitor attached) â not for the
   *  whole bootstrap to unwind. A bootstrap that fails inside the window
   *  throws (callers keep today's fast-failure semantics); one that is merely
   *  SLOW is announced and left running in the background. */
  private async awaitBootstrap(
    id: string,
    bootstrap: Promise<void>,
    running: Promise<void>,
    waitMs: number | undefined,
  ): Promise<void> {
    let bootstrapError: unknown;
    const guarded = bootstrap.catch(error => {
      bootstrapError = error;
    });
    const outcomes: Array<Promise<'settled' | 'running' | 'timeout'>> = [
      guarded.then(() => 'settled' as const),
      running.then(() => 'running' as const),
    ];
    if (waitMs !== undefined) outcomes.push(Bun.sleep(waitMs).then(() => 'timeout' as const));
    const outcome = await Promise.race(outcomes);
    if (outcome === 'settled') {
      if (bootstrapError !== undefined) throw bootstrapError;
      return;
    }
    // The session is up and monitored; the rest of the bootstrap is bookkeeping
    // the caller has no reason to wait for. This is a SUCCESS, not a
    // backgrounded launch â no launch_backgrounded event.
    if (outcome === 'running') return;
    // A backgrounded launch is PENDING, never failed: the session keeps its
    // `starting` status and the bootstrap resolves it (session.launch_settled
    // â running, or the normal failure path with the real reason).
    const claim = this.launching.get(id);
    if (claim) this.launching.set(id, { ...claim, backgrounded: true });
    await this.emit(
      id,
      'session.launch_backgrounded',
      {
        status: 'starting',
        pending: true,
        reason:
          waitMs === 0
            ? 'detached start: the launch runs in the background'
            : `launch still in progress after ${Math.round((waitMs ?? 0) / 1000)}s (bootstrap queue); it continues in the background`,
      },
      'daemon',
    ).catch(() => undefined);
  }

  /** Launch the TUI, inject turn 1, and hand the session to its monitor. Any
   *  failure is recorded ON THE SESSION (status + reason) before it is
   *  rethrown, so a caller that already gave up still leaves durable evidence. */
  private async bootstrapSession(
    id: string,
    config: SessionConfig,
    signalRunning: () => void = () => {},
    deliverFirstTurn = true,
    hooks: SessionStartHooks = {},
  ): Promise<void> {
    try {
      // send() re-verifies prompt readiness right before typing â launch()'s
      // readiness can go stale if a late startup splash repaints the pane,
      // and a prompt injected into a booting TUI lands as a no-op turn.
      const queuedAt = Date.now();
      await this.serializedBootstrap(async () => {
        await this.launchWithRetry(config);
        // The pane demonstrably EXISTS from here on. Durable, because it is
        // what tells a monitor apart from "the tmux session does not exist
        // yet" â the state a pre-launch monitor used to misread as a crash.
        await this.store.updateState<SessionState>(id, current => ({ ...current, launchedAt: now() }));
        // Mandatory daemon evidence must exist before the model can consume its
        // task. Warden hooks write the provenance sidecar here; any failure
        // aborts bootstrap before prompt delivery, so no report can outrun it.
        if (hooks.beforeFirstTurn) await hooks.beforeFirstTurn(await this.get(id));
        // Bare interactive start: the pane is up at its own prompt and that IS
        // the deliverable. Nothing is typed.
        if (deliverFirstTurn) await this.tmux.send(config, this.promptInstruction(id, 1));
      });
      const backgrounded = this.launching.get(id)?.backgrounded === true;
      await this.transition(
        id,
        {
          status: 'running',
          health: 'healthy',
          reason: undefined,
          finishedAt: undefined,
          exitCode: undefined,
          lastActivityAt: now(),
          promptReady: false,
          turnCompleted: false,
        },
        'session.running',
        {},
        // A launch that outlived its request window must be able to write its
        // own outcome even if something recorded a (wrong) terminal status
        // while it was still queued â otherwise the healthy teammate stays
        // `failed` forever and every control action refuses it.
        { force: true },
      );
      await this.startMonitor(id);
      // Pane up, prompt delivered, monitor attached: the launch is genuinely
      // running and `kteam start` may return now.
      signalRunning();
      if (backgrounded) {
        await this.emit(
          id,
          'session.launch_settled',
          {
            status: 'running',
            outcome: 'running',
            elapsedSeconds: Math.round((Date.now() - queuedAt) / 1000),
            reason: 'the backgrounded launch came up: prompt delivered and the monitor is attached',
          },
          'daemon',
        ).catch(() => undefined);
      }
    } catch (error) {
      // A shutdown mid-launch is not a failed launch: emit() rejects once the
      // daemon is closing, and treating that as a launch failure would kill
      // the pane of a teammate that had just started. Leave it for the next
      // boot's recover() to adopt.
      if (this.closed) {
        console.error(`kteamd: launch of ${id} interrupted by shutdown; leaving the pane for recovery`);
        return;
      }
      // "already exists" means something else owns this tmux name (a revive
      // that raced the queue). Killing it would destroy a live teammate; the
      // owner is responsible for it, so bail out without touching the pane.
      if (/already exists/i.test(String(error))) {
        console.error(`kteamd: launch of ${id} found its tmux session already live; leaving it to its owner`);
        return;
      }
      await hooks.onBootstrapFailure?.().catch(cleanupError => {
        console.error(`kteamd: start-hook cleanup failed for ${id}: ${String(cleanupError)}`);
      });
      await this.tmux.snapshot(config, true).catch(() => '');
      let killError: unknown;
      try {
        await this.stopTmuxWithEvidence(config, 'failed initial launch cleanup');
      } catch (caught) {
        killError = caught;
      }
      if (killError) {
        const reason = `initial launch failed and tmux could not be killed: ${killError instanceof Error ? killError.message : String(killError)}`;
        await this.transition(
          id,
          { status: 'kill_failed', health: 'crashed', reason, promptReady: false },
          'session.kill_failed',
        );
        const paneState = await this.tmux.state(config.tmuxSession);
        if (paneState.alive && !paneState.dead) await this.startMonitor(id).catch(() => undefined);
        throw new AggregateError([error, killError], reason);
      }
      // A GENUINE launch failure still fails, with the real reason â this is
      // the other half of the pending contract: backgrounding never fails a
      // session, but a launch that actually died must say so.
      await this.transition(
        id,
        { status: 'failed', health: 'crashed', reason: String(error), finishedAt: now(), promptReady: false },
        'session.failed',
        {},
        { force: true },
      );
      if (this.launching.get(id)?.backgrounded === true) {
        await this.emit(
          id,
          'session.launch_settled',
          { status: 'failed', outcome: 'failed', reason: String(error) },
          'daemon',
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  async send(id: string, request: SendRequest): Promise<SessionView & { disposition: SendDisposition }> {
    id = this.resolveRef(id);
    // Defence in depth: the API validates the header before copying it, but
    // SessionManager also has direct callers. This id can become both a ledger
    // key and `channel/queued-<id>.md`, so never use arbitrary header/body text.
    request = { ...request, requestId: sendRequestId(request.requestId) };
    // Preserve what the peer actually asked us to send before adding the
    // receiver-facing attribution preamble. The sender's outbox is an audit
    // record of the logical message, not of transport decoration.
    const outboundMessage = request.message;
    const outboundAttachmentIds = [...(request.attachmentIds ?? [])];
    // PEER MESSAGING. `from` is a LABEL, never an authorization: the bearer
    // token already authorized this call, and the sender is resolved here only
    // so the message can be attributed to a teammate rather than to "the
    // human". An unresolvable ref degrades to an unattributed send rather than
    // failing — a delivered message matters more than a cosmetic field.
    const sender =
      request.from === undefined || request.from === id
        ? undefined
        : await this.get(this.resolveRef(request.from)).catch(() => undefined);
    if (sender) {
      // The harness only ever sees the message TEXT, so attribution has to be
      // in it: an unlabelled peer message reads as the lead speaking, and a
      // teammate that cannot tell the difference cannot decide whether to
      // obey it, negotiate, or escalate. The reply instruction is included
      // only when the sender is actually parked on one, so a fire-and-forget
      // note never nags the receiver into answering.
      request = {
        ...request,
        // Canonicalized from the session record: the id, and the callsign the
        // daemon knows it by — never whatever the caller claimed.
        from: sender.config.id,
        ...(sender.config.teammate ? { fromName: sender.config.teammate } : {}),
        message: `${peerPreamble(sender, request.replyExpected === true)}${request.message}`,
      };
    }
    {
      // Cheap pre-lock probe ONLY to route obvious revives without waiting on
      // the lock; the authoritative terminal/liveness decision is re-made
      // UNDER the lock below (a completion can win the race after this).
      // A launch still in flight is PENDING, not a refusal: queue behind it
      // rather than rejecting a send that the caller has no way to time. Only
      // a launch that is still queued after the whole window fails, and it
      // fails with something the caller can act on.
      if (this.launchingRecently(id) && !(await this.awaitLaunchSettled(id, CONTROL_LAUNCH_WAIT_MS))) {
        throw new Error(
          `session ${id} is still launching (queued behind the bootstrap chain for ` +
            `${Math.round(CONTROL_LAUNCH_WAIT_MS / 1000)}s); it is pending, not failed â retry once \`kteam ps\` shows it running`,
        );
      }
      const probe = await this.get(id);
      if (probe.state.status === 'kill_failed') rejectKillFailedPaneInput();
      if (probe.state.needsHumanKind === CODEX_PICKER_QUARANTINE_KIND) rejectUnconfirmedCodexPickerInput();
      const paneProbe = await this.tmux.state(probe.config.tmuxSession);
      if (terminalStatuses.includes(probe.state.status) || !paneProbe.alive || paneProbe.dead) {
        return await this.reviveWithMessage(id, request);
      }
    }
    const outcome = await this.serialized(id, async () => {
      const view = await this.get(id);
      // Authoritative re-check under the lock: a session that reached a
      // terminal status while we waited must take the resume path (its live
      // pane, if any, is an unmonitored leftover â never type into it).
      // resume() takes the lock itself, so signal the caller instead.
      if (view.state.status === 'kill_failed') rejectKillFailedPaneInput();
      if (view.state.needsHumanKind === CODEX_PICKER_QUARANTINE_KIND) rejectUnconfirmedCodexPickerInput();
      if (terminalStatuses.includes(view.state.status)) return { kind: 'revive' as const };
      const paneState = await this.tmux.state(view.config.tmuxSession);
      if (!paneState.alive || paneState.dead) return { kind: 'revive' as const };
      if (view.state.status === 'awaiting_question' || view.state.pendingQuestion)
        throw new Error('answer the structured question with `kteam answer`');
      // promptReady means the TUI input box is demonstrably idle even when the
      // transcript-derived status lags (dropped end-of-turn records).
      let busy =
        !waitingStatuses.includes(view.state.status) &&
        view.state.status !== 'interrupted' &&
        view.state.promptReady !== true;
      if (busy) {
        // `--now` = stop the active turn first (Escape, the same safe key
        // interrupt() uses), then RE-READ the pane: once Escape produced a
        // ready prompt this is a normal tracked direct send, not a queue
        // ride. waitReady bounds the settle instead of a blind sleep.
        if (request.now === true && paneShowsActiveWork(paneState.visiblePane)) {
          await run(['tmux', 'send-keys', '-t', view.config.tmuxSession, 'Escape']);
          await this.tmux.waitReady(view.config.tmuxSession, INTERACTIVE_READY_TIMEOUT_MS).catch(() => undefined);
          const after = await this.tmux.state(view.config.tmuxSession);
          if (!after.alive || after.dead) return { kind: 'revive' as const };
          if (after.promptReady) busy = false;
        } else {
          // The busy verdict is otherwise re-validated right before typing:
          // if the pane turned prompt-ready in the probeâlock window, fall
          // through to the tracked delivered path instead of typing into an
          // idle composer and mis-reporting 'queued' (an Enter at an idle
          // prompt SUBMITS â that would be an untracked ghost turn).
          const recheck = await this.tmux.state(view.config.tmuxSession);
          if (!recheck.alive || recheck.dead) return { kind: 'revive' as const };
          if (recheck.promptReady) busy = false;
        }
      }
      if (busy) {
        // Busy session: type the message into the TUI's NATIVE queue (both
        // harnesses hold text typed mid-turn and auto-submit it at the next
        // boundary â verified 2026-07-23, fixtures *-native-queue.txt). The
        // send is recorded DURABLY in the ledger before pendingNativeSends
        // mechanics or keystrokes. Dedicated harness proof later updates fate
        // and clears mechanics only; a mid-turn/batched drain never advances
        // turns or clears completion markers.
        const queuedMessage = request.message?.trim();
        if (!queuedMessage && !request.attachmentIds?.length) throw new Error('message or attachment is required');
        const attachmentBlock = await this.attachments.buildImageReferenceBlock(id, request.attachmentIds ?? []);
        const payload = [queuedMessage, attachmentBlock].filter(Boolean).join('\n\n');
        const fileBacked = payload.length > NATIVE_QUEUE_INLINE_MAX_CHARS;
        const sendId = request.requestId!;
        const payloadFile = fileBacked ? path.join(view.directory, 'channel', `queued-${sendId}.md`) : undefined;
        const queueText = payloadFile
          ? `Read the queued message file at ${payloadFile} completely now, then follow every instruction inside it.`
          : payload;
        const accepted = await this.acceptSendUnlocked(id, view, {
          sendId,
          path: fileBacked ? 'native-file' : 'native-inline',
          message: queuedMessage ?? '',
          matchText: queueText,
          attachmentIds: request.attachmentIds ?? [],
          ...(request.from ? { from: request.from } : {}),
          ...(request.fromName ? { fromName: request.fromName } : {}),
          ...(request.replyExpected ? { replyExpected: true } : {}),
          ...(payloadFile ? { payloadFile } : {}),
        });
        if (!accepted.created)
          return {
            kind: 'result' as const,
            disposition: this.sendDisposition(accepted.record),
            applied: false,
          };
        // typeIntoQueue can fail after Enter/Tab. Without a typed transport
        // phase, every error is ambiguous: preserve ACCEPTED + mechanics and
        // never auto-retype through the file route (that duplicated Codex
        // messages). A same-id caller retry becomes an idempotent no-op.
        await this.queueNativeSend(id, view, request, sendId, queuedMessage, payload, fileBacked);
        return { kind: 'result' as const, disposition: 'queued' as const, applied: true };
      }
      const accepted = await this.deliverToIdlePrompt(id, view, request);
      return {
        kind: 'result' as const,
        disposition: this.sendDisposition(accepted.record),
        applied: accepted.created,
      };
    });
    if (outcome.kind === 'revive') return await this.reviveWithMessage(id, request);
    // The RECIPIENT may be parked awaiting a reply from this very sender —
    // in which case this send IS that reply, and the park ends here. Doing it
    // on the daemon side (rather than making the waiter poll, or requiring the
    // replier to also `signal working` on someone else's behalf) is what turns
    // request/response into a real pattern: both sides only ever call
    // `kteam send`. Runs after delivery, so a waiter is never woken for a
    // message that failed to land.
    if (sender && outcome.applied) {
      await appendFile(
        path.join(sender.directory, 'channel', 'outbox.jsonl'),
        `${JSON.stringify({
          at: now(),
          type: 'message',
          from: sender.config.id,
          ...(sender.config.teammate ? { fromName: sender.config.teammate } : {}),
          to: id,
          disposition: outcome.disposition,
          message: outboundMessage?.trim() ?? '',
          attachmentIds: outboundAttachmentIds,
        })}\n`,
      ).catch(async error => {
        // Delivery already happened, so never invite a duplicate retry by
        // changing the disposition. Surface the missing audit row loudly.
        await this.emit(
          id,
          'control.outbox_write_failed',
          { from: sender.config.id, to: id, disposition: outcome.disposition, message: String(error) },
          'daemon',
        ).catch(() => undefined);
      });
      await this.endPeerWait(id, sender.config.id).catch(() => undefined);
    }
    return { ...(await this.get(id)), disposition: outcome.disposition };
  }

  /** Session-scoped because wrapper identity, provider config, credentials and
   * project config all participate in the authoritative model catalog. */
  async runtimeModels(id: string): Promise<RuntimeModelCatalog> {
    id = this.resolveRef(id);
    const view = await this.get(id);
    if (view.config.harness === 'claude') {
      return {
        harness: 'claude',
        source: 'wrapper-inventory',
        choices: runtimeModelsForWrapper(view.config.binary).map(choice => ({
          ...choice,
          reasoningEfforts: [],
        })),
      };
    }
    const binary = resolveBinary(view.config.binary);
    if (!binary) throw new Error(`could not resolve Codex wrapper ${view.config.binary}`);
    return {
      harness: 'codex',
      source: 'codex-app-server',
      choices: await codexRuntimeModelCatalog.get(binary, view.config.cwd),
    };
  }

  /** Native `/model`, `/effort`, or `/compact` control that
   * deliberately bypasses send(): it never queues behind active work, does not
   * relaunch the harness, and never optimistically rewrites observed settings.
   * Targeted Codex switches succeed only after a post-input raw
   * thread_settings_applied record and the same persisted session observation. */
  async runtime(id: string, request: RuntimeControlRequest): Promise<SessionView> {
    id = this.resolveRef(id);
    return await this.serializedRuntimeControl(id, async () => {
      let pendingCodex:
        | {
            target: CodexPickerTarget;
            transcriptFile: string;
            transcriptBaseline: number;
            observedAtBaseline?: string;
          }
        | undefined;

      // Picker driving must exclude other control mutations, but observation
      // waits must NOT hold this queue: the transcript reducer uses it too.
      const immediate = await this.serialized(id, async (): Promise<SessionView | undefined> => {
        const view = await this.get(id);
        if (view.state.status === 'kill_failed') rejectKillFailedPaneInput();
        if (view.state.needsHumanKind === CODEX_PICKER_QUARANTINE_KIND) rejectUnconfirmedCodexPickerInput();
        if (terminalStatuses.includes(view.state.status))
          throw new Error('an in-session command requires a running session');

        const pane = await this.tmux.state(view.config.tmuxSession);
        if (!pane.alive || pane.dead) throw new Error('an in-session command requires a live harness pane');
        if (!pane.promptReady)
          throw new Error('an in-session command is available only while the harness is waiting at an idle prompt');

        if (request.action === 'compact') return await this.runSessionCommand(id, view);

        const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
        let command: string;
        let requestedModel: string | undefined;
        let requestedEffort: string | undefined;
        if (request.action === 'effort') {
          if (view.config.harness !== 'claude')
            throw new Error('effort is set inside Codex’s native picker, not as a runtime command');
          requestedEffort = request.effort?.trim();
          if (!requestedEffort || !EFFORT_LEVELS.includes(requestedEffort as (typeof EFFORT_LEVELS)[number]))
            throw new Error(`effort must be one of ${EFFORT_LEVELS.join(', ')}`);
          command = `/effort ${requestedEffort}`;
        } else if (view.config.harness === 'claude') {
          requestedModel = request.model?.trim();
          if (!requestedModel) throw new Error('model is required for a Claude runtime switch');
          const allowed = runtimeModelsForWrapper(view.config.binary);
          if (!allowed.length)
            throw new Error(`in-session model switching is not supported for wrapper ${view.config.binary}`);
          if (!allowed.some(option => option.value === requestedModel))
            throw new Error(`model ${requestedModel} is not available on wrapper ${view.config.binary}`);
          command = `/model ${requestedModel}`;
        } else {
          requestedModel = request.model?.trim();
          requestedEffort = request.effort?.trim();
          if (!requestedModel && !requestedEffort) {
            // Compatibility/manual fallback: preserve the established bare
            // picker and make no pending or success claim for a human choice.
            command = '/model';
          } else {
            if (!requestedModel || !requestedEffort)
              throw new Error('Codex targeted switching requires both model and effort');
            const catalog = await this.runtimeModels(id);
            const advertised = catalog.choices.find(choice => choice.value === requestedModel);
            if (!advertised) throw new Error(`model ${requestedModel} is not in this Codex account’s current catalog`);
            if (!advertised.reasoningEfforts.some(choice => choice.value === requestedEffort))
              throw new Error(`${requestedEffort} is not advertised for Codex model ${requestedModel}`);

            // Codex's quick picker applies a preset default directly unless it
            // can open advanced reasoning. The driver checks this only after it
            // positively identifies the target as a visible quick-picker row,
            // before sending that row's digit; an All-models row stays valid.
            const opensReasoningMenu =
              advertised.reasoningEfforts.some(choice => choice.value === 'max' || choice.value === 'ultra') ||
              advertised.defaultReasoningEffort === 'max' ||
              advertised.defaultReasoningEffort === 'ultra';
            const quickPickerDefaultEffort =
              !opensReasoningMenu && advertised.defaultReasoningEffort !== requestedEffort
                ? advertised.defaultReasoningEffort
                : undefined;

            const transcriptFile = view.config.transcriptFile;
            if (!transcriptFile)
              throw new Error('Codex transcript discovery must finish before a switch can be verified');
            const ready = await this.tmux.state(view.config.tmuxSession);
            if (!ready.alive || ready.dead || !ready.promptReady)
              throw new Error('Codex left its idle prompt while model choices were loading');
            const transcriptBaseline = (await stat(transcriptFile)).size;
            const target = {
              model: requestedModel,
              effort: requestedEffort,
              ...(quickPickerDefaultEffort ? { quickPickerDefaultEffort } : {}),
            };
            pendingCodex = {
              target,
              transcriptFile,
              transcriptBaseline,
              observedAtBaseline: view.state.observedModelAt,
            };
            try {
              const pickerTransport: CodexPickerTransport = {
                openPicker: async () => await this.tmux.inject(view.config.tmuxSession, '/model'),
                readPane: async () => await this.tmux.state(view.config.tmuxSession),
                sendKey: async (key, expected) =>
                  await this.codexRuntimeControl.sendPickerKey(view.config.tmuxSession, key, expected),
              };
              // Only a mismatched potentially-direct quick row needs the
              // screen-aware preflight. It opens and reads the native picker
              // without selecting anything; the selection driver gets the
              // same verified screen only when the target remains expressible.
              const preflightScreen =
                target.quickPickerDefaultEffort === undefined
                  ? undefined
                  : await this.codexRuntimeControl.preflightModelPicker(pickerTransport, target);
              await this.codexRuntimeControl.driveModelPicker(pickerTransport, target, {}, preflightScreen);
            } catch (error) {
              try {
                await this.codexRuntimeControl.dismissPicker(view.config.tmuxSession);
              } catch (cleanupError) {
                await this.quarantineUnconfirmedCodexPicker(id, view, error, cleanupError);
              }
              throw error;
            }
            return undefined;
          }
        }

        const outcome = await this.tmux.inject(view.config.tmuxSession, command);
        if (outcome !== 'handled-local')
          throw new Error(`the harness consumed ${command} as a model turn instead of a native runtime control`);
        await this.emit(
          id,
          'control.runtime_model',
          {
            harness: view.config.harness,
            ...(requestedModel ? { requestedModel } : {}),
            ...(requestedEffort ? { requestedEffort } : {}),
            ...(!requestedModel && !requestedEffort ? { picker: true } : {}),
          },
          'client',
          view.config.turn,
        );
        return await this.get(id);
      });

      if (immediate) return immediate;
      const pending = pendingCodex;
      if (!pending) throw new Error('Codex runtime control ended without a result');

      await this.codexRuntimeControl.waitForThreadSettingsApplied(async () => {
        const currentSize = (await stat(pending.transcriptFile)).size;
        if (currentSize < pending.transcriptBaseline)
          throw new Error('Codex rollout changed while waiting for runtime confirmation');
        return await Bun.file(pending.transcriptFile).slice(pending.transcriptBaseline).text();
      }, pending.target);
      await this.codexRuntimeControl.waitForRuntimeObservation(
        async () => (await this.get(id)).state,
        pending.observedAtBaseline,
        pending.target,
        { afterTranscriptOffset: pending.transcriptBaseline },
      );

      // This event is intentionally after verification. Besides auditability,
      // it makes the browser refetch the now-fresh timestamp even when the user
      // re-selected the already-observed model and effort.
      return await this.serialized(id, async () => {
        const confirmed = await this.get(id);
        await this.emit(
          id,
          'control.runtime_model',
          {
            harness: 'codex',
            requestedModel: pending.target.model,
            requestedEffort: pending.target.effort,
            verified: true,
          },
          'client',
          confirmed.config.turn,
        );
        return await this.get(id);
      });
    });
  }

  /** A failed picker drive must never leave ordinary controls able to type
   * into an unverified modal. Persist the terminal quarantine before trying to
   * stop the pane; if stopping itself fails, stopTmuxWithEvidence records
   * kill_failed and the input gates above keep that live pane inert. */
  private async quarantineUnconfirmedCodexPicker(
    id: string,
    view: SessionView,
    driveFailure: unknown,
    cleanupFailure: unknown,
  ): Promise<never> {
    const driveMessage = driveFailure instanceof Error ? driveFailure.message : String(driveFailure);
    const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
    const reason =
      'Codex picker cleanup could not confirm the exact pane returned to an idle prompt; ' +
      'the session was quarantined to prevent input into an unknown modal';

    await this.transition(
      id,
      {
        status: 'failed',
        health: 'crashed',
        reason,
        finishedAt: now(),
        promptReady: false,
        needsHuman: `${reason}; run kteam resume or stop before sending more input`,
        needsHumanKind: CODEX_PICKER_QUARANTINE_KIND,
      },
      'session.codex_picker_quarantined',
      { driveError: driveMessage, cleanupError: cleanupMessage },
    );
    await this.tmux.snapshot(view.config, true).catch(() => undefined);
    try {
      await this.stopManagedSession(view.config, reason);
    } catch (stopFailure) {
      const stopMessage = stopFailure instanceof Error ? stopFailure.message : String(stopFailure);
      throw new Error(
        `Codex picker drive failed: ${driveMessage}; picker cleanup failed: ${cleanupMessage}; ` +
          `session remains quarantined because its tmux pane could not be stopped: ${stopMessage}`,
        { cause: cleanupFailure },
      );
    }
    throw new Error(
      `Codex picker drive failed: ${driveMessage}; picker cleanup failed: ${cleanupMessage}; ` +
        'session was stopped for safety and must be resumed before retrying runtime control',
      { cause: cleanupFailure },
    );
  }

  /** `/compact` — the harness-native context command, delivered through the
   * same exactly-once `inject()` as `/model`. Preconditions were already
   * checked by `runtime()`.
   *
   * `/compact` may start a summarisation turn on Claude or complete locally on
   * Codex. It does not advance `config.turn`; the normal watcher observes any
   * real turn. Compacting affects only the harness's memory: kteam keeps its
   * transcript. */
  private async runSessionCommand(id: string, view: SessionView): Promise<SessionView> {
    const outcome = await this.tmux.inject(view.config.tmuxSession, '/compact');
    await this.emit(
      id,
      'control.session_command',
      { harness: view.config.harness, command: 'compact', disposition: outcome },
      'client',
      view.config.turn,
    );
    return await this.get(id);
  }

  /** Persist and type one native-queue entry. For file-backed delivery the
   *  pane sees only a short instruction; the full logical payload remains in
   *  both pendingNativeSends and a mode-0600 channel file. */
  private async queueNativeSend(
    id: string,
    view: SessionView,
    request: SendRequest,
    sendId: string,
    queuedMessage: string | undefined,
    payload: string,
    fileBacked: boolean,
  ): Promise<void> {
    const payloadFile = fileBacked ? path.join(view.directory, 'channel', `queued-${sendId}.md`) : undefined;
    const queueText = payloadFile
      ? `Read the queued message file at ${payloadFile} completely now, then follow every instruction inside it.`
      : payload;
    const entry: NonNullable<SessionState['pendingNativeSends']>[number] = {
      id: sendId,
      at: now(),
      message: payload,
      attachmentIds: request.attachmentIds ?? [],
      ...(payloadFile ? { queueText, payloadFile } : {}),
    };
    try {
      if (payloadFile) await writeFile(payloadFile, `${payload}\n`, { mode: 0o600 });
      // Durable BEFORE the keystrokes: a daemon crash between type-in and
      // consumption must leave evidence to recover/report from.
      await this.store.updateState<SessionState>(id, current => ({
        ...current,
        pendingNativeSends: [...(current.pendingNativeSends ?? []), entry],
      }));
    } catch (error) {
      // No tmux entry method has been called yet. This is the narrow, proven
      // no-attempt phase where a tombstone is safe and a same-id retry may
      // resurrect a fresh ACCEPTED snapshot.
      await this.withdrawSendUnlocked(id, sendId, 'native queue pre-submit persistence failed');
      throw error;
    }
    try {
      await this.tmux.typeIntoQueue(view.config.tmuxSession, queueText);
    } catch (error) {
      if (payloadFile) {
        throw new NativeQueueComposerError(
          `durable queue instruction could not be confirmed; it will not be retried automatically, and the complete payload remains at ${payloadFile}: ${String(error)}`,
          error,
        );
      }
      throw new NativeQueueComposerError(
        `native queue delivery could not be confirmed and will not be retried automatically: ${String(error)}`,
        error,
      );
    }
    await appendFile(
      path.join(view.directory, 'channel', 'inbox.jsonl'),
      `${JSON.stringify({ at: now(), type: 'message', queued: true, queueId: entry.id, message: queuedMessage, attachmentIds: request.attachmentIds ?? [], ...(request.from ? { from: request.from, fromName: request.fromName } : {}) })}\n`,
    );
    await this.emit(
      id,
      'control.send_queued',
      {
        queueId: entry.id,
        message: queuedMessage,
        attachmentIds: request.attachmentIds ?? [],
        native: true,
        ...(payloadFile ? { fileBacked: true, payloadFile } : {}),
        ...(request.from ? { from: request.from, ...(request.fromName ? { fromName: request.fromName } : {}) } : {}),
        ...(request.replyExpected ? { replyExpected: true } : {}),
      },
      'client',
    );
  }

  /** Terminal/dead-pane send: relaunch through resume() with the message as
   *  the next tracked turn. Explicit message delivery bypasses batch-label
   *  dedupe; if a genuine safety refusal still prevents relaunch, retain the
   *  message durably instead of turning that transport decision into loss. */
  private async reviveWithMessage(
    id: string,
    request: SendRequest,
  ): Promise<SessionView & { disposition: SendDisposition }> {
    const sendId = sendRequestId(request.requestId);
    request = { ...request, requestId: sendId };
    const message = request.message?.trim();
    const attachmentBlock = await this.attachments.buildImageReferenceBlock(id, request.attachmentIds ?? []);
    const complete = [message, attachmentBlock].filter(Boolean).join('\n\n');
    if (!complete) throw new Error('message or attachment is required');
    const accepted = await this.serialized(id, async () => {
      const view = await this.get(id);
      const turn = view.config.turn + 1;
      return await this.acceptSendUnlocked(id, view, {
        sendId,
        path: 'revive',
        message: message ?? '',
        matchText: this.promptInstruction(id, turn),
        turn,
        attachmentIds: request.attachmentIds ?? [],
        ...(request.from ? { from: request.from } : {}),
        ...(request.fromName ? { fromName: request.fromName } : {}),
        ...(request.replyExpected ? { replyExpected: true } : {}),
      });
    });
    if (!accepted.created) return { ...(await this.get(id)), disposition: this.sendDisposition(accepted.record) };
    try {
      return {
        ...(await this.resume(id, complete, {
          automatic: false,
          dedupeSharedRecoveryScope: false,
        })),
        disposition: 'revived',
      };
    } catch (error) {
      if (error instanceof ReviveRefused) {
        try {
          return await this.serialized(id, async () => this.queueForExplicitRevive(id, request, error));
        } catch (queueError) {
          await this.serialized(id, async () =>
            this.withdrawSendUnlocked(id, sendId, 'explicit revive queue persistence failed'),
          );
          throw queueError;
        }
      }
      // resume may have launched or typed before reporting failure. Preserve
      // ACCEPTED whenever its fresh state is nonterminal; hiding it as
      // withdrawn would invite an unsafe duplicate retry. A fresh terminal
      // state may be either the original terminal state or a newly failed
      // resume after an ambiguous launch/type attempt. In both cases, queue a
      // fresh EOF pass whose cutoff includes this acceptance: proof is drained
      // before any UNACCOUNTED classification, and nothing is withdrawn.
      const current = await this.get(id).catch(() => undefined);
      if (current && terminalStatuses.includes(current.state.status)) {
        this.scheduleTerminalSendFinalization(id, now());
        await this.terminalSendFinalizers.get(id)?.catch(() => undefined);
      }
      throw error;
    }
  }

  private async queueForExplicitRevive(
    id: string,
    request: SendRequest,
    refusal: ReviveRefused,
  ): Promise<SessionView & { disposition: SendDisposition }> {
    const view = await this.get(id);
    const queueId = request.requestId!;
    const message = request.message?.trim() ?? '';
    const channel = path.join(view.directory, 'channel');
    const held = await this.reviseAcceptedSendUnlocked(id, queueId, {
      path: 'revive-queue',
      held: true,
      matchText: undefined,
      payloadFile: undefined,
      turn: undefined,
    });
    if (!held) throw new Error(`could not retain accepted send ${queueId} for explicit revive`);
    await mkdir(channel, { recursive: true, mode: 0o700 });
    await appendFile(
      path.join(channel, 'inbox.jsonl'),
      `${JSON.stringify({
        at: now(),
        type: 'message',
        queueId,
        queuedForRevive: true,
        message,
        attachmentIds: request.attachmentIds ?? [],
        ...(request.from ? { from: request.from, fromName: request.fromName } : {}),
        ...(refusal instanceof ReviveDedupeConflict ? { reviveConflict: refusal.conflict.id } : {}),
        reviveRefusal: refusal.message,
      })}\n`,
    );
    await this.emit(
      id,
      'control.send_queued',
      {
        queueId,
        message,
        attachmentIds: request.attachmentIds ?? [],
        queuedForRevive: true,
        native: false,
        ...(refusal instanceof ReviveDedupeConflict ? { conflictSessionId: refusal.conflict.id } : {}),
        reason: refusal.message,
        ...(request.from ? { from: request.from, ...(request.fromName ? { fromName: request.fromName } : {}) } : {}),
        ...(request.replyExpected ? { replyExpected: true } : {}),
      },
      'client',
    ).catch(() => undefined);
    return { ...(await this.get(id)), disposition: 'queued-for-revive' };
  }

  /** Tracked idle-prompt delivery: write the turn artifacts, advance the turn,
   *  inject (direct or via the turn-file instruction), and transition. Runs
   *  UNDER the session lock (callers hold it). */
  private async deliverToIdlePrompt(
    id: string,
    view: SessionView,
    request: SendRequest,
  ): Promise<{ record: SendRecord; created: boolean }> {
    {
      const message = request.message?.trim();
      if (!message && !request.attachmentIds?.length) throw new Error('message or attachment is required');
      const attachmentBlock = await this.attachments.buildImageReferenceBlock(id, request.attachmentIds ?? []);
      const complete = [message, attachmentBlock].filter(Boolean).join('\n\n');
      const turn = view.config.turn + 1;
      // Short simple payloads go DIRECT (typed verbatim into the composer);
      // the write-file-then-"read your turn file" indirection stays for
      // long/multi-line/attachment payloads and the original turn-1 prompt.
      // The turn file is still written on both paths (bookkeeping: logs,
      // resume context) â direct only changes what gets TYPED.
      //
      // INTERACTIVE sessions always go direct: the composer is a chat box a human
      // is typing into, and answering a human's paragraph with "read
      // /home/.../turns/turn-014.md" is not a conversation. Attachments still take
      // the indirection - that block is a list of file paths the harness must
      // open. Bracketed paste (tmux-controller) keeps multi-line payloads whole.
      const direct =
        view.config.mode === 'interactive' && !request.attachmentIds?.length
          ? true
          : this.isDirectPayload(complete, view.config);
      const accepted = await this.acceptSendUnlocked(id, view, {
        sendId: request.requestId!,
        path: direct ? 'direct' : 'turn-file',
        message: message ?? '',
        matchText: direct ? complete : this.promptInstruction(id, turn),
        turn,
        attachmentIds: request.attachmentIds ?? [],
        ...(request.from ? { from: request.from } : {}),
        ...(request.fromName ? { fromName: request.fromName } : {}),
        ...(request.replyExpected ? { replyExpected: true } : {}),
      });
      if (!accepted.created) return accepted;
      // Prove the prompt landed before recording a delivered message or
      // advancing the turn. A failed injection must leave no phantom inbox
      // row and no turn bump.
      try {
        await writeFile(turnPrompt(this.paths, id, turn), `${complete}\n`, { mode: 0o600 });
      } catch (error) {
        await this.withdrawSendUnlocked(id, request.requestId!, 'idle prompt delivery failed');
        throw error;
      }
      // tmux.send may throw after keys landed or Enter was consumed. That is
      // uncertain fate, never a withdrawn/no-attempt tombstone.
      await this.tmux.send(view.config, direct ? complete : this.promptInstruction(id, turn));
      await appendFile(
        path.join(view.directory, 'channel', 'inbox.jsonl'),
        `${JSON.stringify({ at: now(), type: 'message', turn, message, attachmentIds: request.attachmentIds ?? [], ...(request.from ? { from: request.from, fromName: request.fromName } : {}) })}\n`,
      );
      await this.store.updateConfig<SessionConfig>(id, current => ({
        ...current,
        turn,
        updatedAt: now(),
      }));
      await rm(markerFile(this.paths, id, 'needs-help'), { force: true });
      await this.emit(
        id,
        'control.send',
        {
          message,
          attachmentIds: request.attachmentIds ?? [],
          ...(direct ? { direct: true } : {}),
          // Who sent this. Present only for SESSION-to-session messages, so
          // its absence is exactly "a human sent it" — the UI keys the sender
          // chip off that (see lib/transcript.ts peerFrom).
          ...(request.from ? { from: request.from, ...(request.fromName ? { fromName: request.fromName } : {}) } : {}),
          ...(request.replyExpected ? { replyExpected: true } : {}),
        },
        'client',
        turn,
      );
      // Markers written between the send request and the prompt landing
      // (tmux.send can still block briefly on late startup dialogs) belong to
      // the PREVIOUS turn â e.g. the agent's `signal done` racing this send.
      // Clear them now that the new turn's prompt has actually landed, else
      // the monitor reports a false `completed` for a turn that is just
      // starting (observed live: geoffrey, 2026-07-21). The old busy-QUEUE
      // gate is gone (native TUI queueing), which shrank this race window
      // from minutes to seconds â but not to zero.
      await Promise.all(['done', 'needs-help'].map(name => rm(markerFile(this.paths, id, name), { force: true })));
      this.autoContinued.delete(id);
      this.doneDeferred.delete(id);
      await this.transition(
        id,
        {
          status: 'running',
          turn,
          promptReady: false,
          pendingQuestion: undefined,
          // timeoutSeconds bounds one turn of work, so every user turn restarts
          // the clock; otherwise a healthy interactive session is killed as soon
          // as its wall-clock age exceeds the timeout.
          startedAt: now(),
          reason: undefined,
          lastActivityAt: now(),
          turnCompleted: false,
          // A new turn is a new liveness episode: a stale nudge from the
          // previous turn must never let the reflex cold-kill this one
          // without nudging it first (review P1).
          nudgedAt: undefined,
        },
        'turn.started',
      );
      return accepted;
    }
  }

  /** F4 auto-revive guard: if a control action left the pane DEAD (e.g. a
   *  keystroke the TUI interpreted as quit), recover it once through the
   *  normal resume path and record that it happened. Runs OUTSIDE the session
   *  lock â resume() takes it itself. */
  private async withAutoRevive(
    id: string,
    action: string,
    operation: () => Promise<SessionView>,
    reviveMessage?: string,
  ): Promise<SessionView> {
    try {
      return await operation();
    } catch (error) {
      const view = await this.get(id).catch(() => undefined);
      // A structured question is a semantic control surface, not a generic
      // “retry after pane death” operation. Relaunching here would return 200 to
      // an answer/abandon request that never landed and reopen the same dead end.
      if (view?.state?.pendingQuestion) throw error;
      if (view) {
        const pane = await this.tmux.state(view.config.tmuxSession);
        if (!pane.alive || pane.dead) {
          await this.emit(id, 'control.autorevive', { action, error: String(error) }, 'daemon').catch(() => undefined);
          return await this.resume(id, reviveMessage, {
            automatic: true,
            dedupeSharedRecoveryScope: true,
          });
        }
      }
      throw error;
    }
  }

  async answer(
    id: string,
    toolUseId: string,
    labels: string[],
    other?: string,
    responses?: string[],
  ): Promise<SessionView> {
    id = this.resolveRef(id);
    return await this.serialized(id, async () => {
      const view = await this.get(id);
      if (view.state.needsHumanKind === CODEX_PICKER_QUARANTINE_KIND) rejectUnconfirmedCodexPickerInput();
      if (view.state.status !== 'awaiting_question' || !view.state.pendingQuestion)
        throw new Error('session is not waiting on a structured question');
      if (view.state.pendingQuestion.toolUseId !== toolUseId)
        throw new Error(
          `the displayed question changed before this answer arrived (expected ${toolUseId}, current ${view.state.pendingQuestion.toolUseId}); refresh and answer the current question`,
        );
      await this.clearNeedsHuman(id);
      let outcome;
      try {
        outcome = await this.tmux.answerQuestion(view.config, view.state, labels, other, responses);
      } catch (error) {
        const pending = view.state.pendingQuestion;
        const pane = await this.tmux.state(view.config.tmuxSession).catch(() => undefined);
        await this.tmux.snapshot(view.config).catch(() => undefined);
        const questionText = pendingQuestionText(pending);
        await this.emit(
          id,
          'interaction.question_failed',
          {
            action: 'answer',
            toolUseId,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof StructuredQuestionDriveError ? { matcher: error.diagnostics } : {}),
            requestedLabels: labels,
            responseCount: responses?.length,
            hasOther: !!other,
            questionText,
            questions: pending.questions.map(question => question.question),
            snapshot: 'last-snapshot.txt',
            ...(pane
              ? {
                  pane: {
                    alive: pane.alive,
                    dead: pane.dead,
                    promptReady: pane.promptReady,
                    activeWork: paneShowsActiveWork(pane.visiblePane),
                    cursorX: pane.cursorX,
                    cursorY: pane.cursorY,
                    width: pane.paneWidth,
                    height: pane.paneHeight,
                    hash: Bun.hash(pane.visiblePane).toString(16),
                    excerpt: pane.visiblePane.split('\n').slice(-40).join('\n').slice(-6_000),
                  },
                }
              : {}),
          },
          'client',
        ).catch(() => undefined);

        // Do not leave the human behind the same matcher that just refused the
        // answer. Best-effort one Escape closes the native overlay only when the
        // controller positively re-binds THIS question; an answer failure is
        // not permission to Escape a selector that appeared afterwards.
        // Regardless of that cleanup, the daemon state edge below clears the
        // form and exposes the ordinary composer. No answer is synthesized.
        let release: Awaited<ReturnType<TmuxController['cancelQuestion']>> | undefined;
        let releaseError: unknown;
        try {
          release = await this.tmux.cancelQuestion(view.config, view.state, { requireBound: true });
        } catch (cancelError) {
          releaseError = cancelError;
        }
        const releasedPane = release?.pane ?? (await this.tmux.state(view.config.tmuxSession).catch(() => pane));
        const proseReason = `structured answer failed; reply in prose to: ${questionText.replaceAll('\n', ' / ')}`;
        await this.transition(
          id,
          releasedQuestionState(view, pending, releasedPane, proseReason),
          'interaction.question_cancelled',
          {
            toolUseId,
            reason: 'answer failed; structured form released for prose reply',
            confirmedBy: release?.confirmedBy ?? 'state-release',
            ...(releaseError
              ? { releaseError: releaseError instanceof Error ? releaseError.message : String(releaseError) }
              : {}),
            questionText,
            questions: pending.questions.map(question => question.question),
            pendingQuestion: null,
          },
          { source: currentActor() ?? 'client' },
        );
        throw releasedQuestionError(error, pending);
      }
      // This is the FIRST success record. The previous implementation emitted
      // interaction.answer before any key was checked, creating false answer
      // history for every refusal. `answerQuestion` now returns only after the
      // pane advanced / a turn started / a ready prompt appeared.
      const returnedToPrompt = outcome.confirmedBy === 'prompt-ready';
      await this.transition(
        id,
        {
          status: returnedToPrompt ? 'awaiting_user' : 'running',
          health: returnedToPrompt ? 'idle' : 'healthy',
          pendingQuestion: undefined,
          promptReady: returnedToPrompt,
          startedAt: now(),
          lastActivityAt: now(),
          turnCompleted: returnedToPrompt,
          nudgedAt: undefined,
        },
        'interaction.answer',
        { toolUseId, labels, other, responses, confirmation: outcome, pendingQuestion: null },
        { source: currentActor() ?? 'client' },
      );
      return await this.get(id);
    });
  }

  async interrupt(id: string, expectedToolUseId?: string): Promise<SessionView> {
    id = this.resolveRef(id);
    const operation = () =>
      this.serialized(id, async () => {
        const view = await this.get(id);
        if (expectedToolUseId !== undefined) {
          const currentToolUseId = view.state.pendingQuestion?.toolUseId;
          if (currentToolUseId === undefined)
            throw new Error(
              `the displayed question ${expectedToolUseId} is no longer pending; refresh before abandoning`,
            );
          if (currentToolUseId !== expectedToolUseId)
            throw new Error(
              `the displayed question changed before this abandon arrived (expected ${expectedToolUseId}, current ${currentToolUseId}); refresh before abandoning the current question`,
            );
        }
        if (view.state.pendingQuestion) {
          const pending = view.state.pendingQuestion;
          await this.emit(
            id,
            'interaction.question_cancel_requested',
            { toolUseId: pending.toolUseId, reason: 'abandoned by client' },
            'client',
          );
          try {
            const result = await this.tmux.cancelQuestion(view.config, view.state);
            await this.tmux.snapshot(view.config).catch(() => undefined);
            const active = paneShowsActiveWork(result.pane.visiblePane);
            await this.transition(
              id,
              {
                status: active ? 'running' : 'awaiting_user',
                health: active ? 'healthy' : 'idle',
                promptReady: result.pane.promptReady,
                pendingQuestion: undefined,
                openTools: (view.state.openTools ?? []).filter(tool => tool !== pending.toolUseId),
                reason: undefined,
                lastActivityAt: now(),
              },
              'interaction.question_cancelled',
              {
                toolUseId: pending.toolUseId,
                reason: 'abandoned by client',
                confirmedBy: result.confirmedBy,
                snapshot: 'last-snapshot.txt',
                pendingQuestion: null,
              },
              { source: currentActor() ?? 'client' },
            );
            return await this.get(id);
          } catch (error) {
            const pane = await this.tmux.state(view.config.tmuxSession).catch(() => undefined);
            await this.tmux.snapshot(view.config).catch(() => undefined);
            const questionText = pendingQuestionText(pending);
            await this.emit(
              id,
              'interaction.question_failed',
              {
                action: 'abandon',
                toolUseId: pending.toolUseId,
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof StructuredQuestionDriveError ? { matcher: error.diagnostics } : {}),
                questionText,
                questions: pending.questions.map(question => question.question),
                snapshot: 'last-snapshot.txt',
                ...(pane
                  ? {
                      pane: {
                        promptReady: pane.promptReady,
                        activeWork: paneShowsActiveWork(pane.visiblePane),
                        hash: Bun.hash(pane.visiblePane).toString(16),
                        excerpt: pane.visiblePane.split('\n').slice(-40).join('\n').slice(-6_000),
                      },
                    }
                  : {}),
              },
              'client',
            ).catch(() => undefined);
            // The key drive may be unconfirmed, but abandoning the daemon's
            // semantic question state is unconditional. Returning a normal
            // view makes this a real escape hatch; the reason/event keeps an
            // actual send/confirmation failure visible instead of retrying it.
            const releaseReason = `question abandoned; Escape could not be confirmed (${error instanceof Error ? error.message : String(error)}). Reply in prose to: ${questionText.replaceAll('\n', ' / ')}`;
            await this.transition(
              id,
              releasedQuestionState(view, pending, pane, releaseReason),
              'interaction.question_cancelled',
              {
                toolUseId: pending.toolUseId,
                reason: 'abandoned by client; Escape was not confirmed',
                confirmedBy: 'state-release',
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof StructuredQuestionDriveError ? { matcher: error.diagnostics } : {}),
                questionText,
                questions: pending.questions.map(question => question.question),
                snapshot: 'last-snapshot.txt',
                pendingQuestion: null,
              },
              { source: currentActor() ?? 'client' },
            );
            return await this.get(id);
          }
        }
        await this.emit(id, 'control.interrupt.requested', {}, 'client');
        await this.tmux.interrupt(view.config);
        // An interactive pane that is back (or still) at a ready prompt goes to
        // awaiting_user, not `interrupted`: the human pressed stop, the terminal
        // is theirs again. `interrupted` would also be sticky — the monitor's
        // awaiting_user transition deliberately skips that status — so an idle
        // interactive session would keep claiming it was interrupted forever.
        // "Idle" here is the ABSENCE OF ACTIVE WORK, not promptReady: a human
        // with half a message typed has a non-ready composer and is still idle,
        // and marking that session `interrupted` would stick (the monitor's
        // awaiting_user transition skips `interrupted` on purpose).
        const after = await this.tmux.state(view.config.tmuxSession).catch(() => undefined);
        const idleInteractive =
          view.config.mode === 'interactive' && after !== undefined && !paneShowsActiveWork(after.visiblePane);
        await this.transition(
          id,
          idleInteractive
            ? { status: 'awaiting_user', health: 'idle', promptReady: true, reason: undefined }
            : { status: 'interrupted', health: 'idle', promptReady: true, reason: 'interrupted by client' },
          'control.interrupted',
        );
        return await this.get(id);
      });
    // A bound abandon is a semantic operation against one rendered question.
    // If it has already cleared, a dead pane must not turn the stale retry into
    // an automatic resume. Generic CLI interrupt keeps its established revive
    // behavior.
    return expectedToolUseId === undefined ? await this.withAutoRevive(id, 'interrupt', operation) : await operation();
  }

  async stop(id: string, reason = 'stopped by client'): Promise<SessionView> {
    id = this.resolveRef(id);
    await this.clearNeedsHuman(id);
    this.cancelRetry(id);
    void this.cancelQuotaWaiter(id);
    return await this.serialized(id, async () => {
      const view = await this.get(id);
      await this.tmux.snapshot(view.config, true);
      await atomicJson(path.join(view.directory, 'kill.json'), {
        at: now(),
        reason,
        lastSnapshot: 'last-snapshot.txt',
      });
      await this.stopManagedSession(view.config, reason);
      // A verified stop is the first point at which this special quarantine
      // can be released: the unknown native picker cannot receive more input.
      await this.clearNeedsHuman(id, { clearCodexPickerQuarantine: true });
      await this.transition(
        id,
        { status: 'stopped', health: 'idle', reason, finishedAt: now(), promptReady: false },
        'session.stopped',
      );
      return await this.get(id);
    });
  }

  /** Confirm a harness really exited before making that verdict durable. A
   *  single failed tmux probe is not death: `has-session` has returned false
   *  transiently while the pane and harness process were both healthy. The
   *  second pane probe and the process-tree probe are independent evidence;
   *  either one reporting life is authoritative. */
  private async confirmHarnessExit(
    config: SessionConfig,
    firstProbe: PaneState,
    context: string,
    source: KTeamEvent['source'],
  ): Promise<{ confirmed: boolean; pane: PaneState; subprocessAlive: boolean }> {
    await Bun.sleep(this.terminalReprobeMs ?? TERMINAL_REPROBE_MS);
    const [secondProbe, subprocessAlive] = await Promise.all([
      this.tmux.state(config.tmuxSession).catch(() => firstProbe),
      this.tmux.subprocessAlive(config.tmuxSession).catch(() => false),
    ]);
    if ((secondProbe.alive && !secondProbe.dead) || subprocessAlive) {
      await this.emit(
        config.id,
        'control.false_terminal_averted',
        {
          context,
          firstProbe: { alive: firstProbe.alive, dead: firstProbe.dead, exitCode: firstProbe.exitCode },
          secondProbe: { alive: secondProbe.alive, dead: secondProbe.dead, exitCode: secondProbe.exitCode },
          subprocessAlive,
        },
        source,
      ).catch(() => undefined);
      return { confirmed: false, pane: secondProbe, subprocessAlive };
    }
    // Prefer whichever probe retained the final pane frame/exit status. A
    // failed has-session probe necessarily has neither.
    const pane =
      secondProbe.exitCode !== undefined || secondProbe.visiblePane.trim() || secondProbe.pane.trim()
        ? secondProbe
        : firstProbe;
    return { confirmed: true, pane, subprocessAlive: false };
  }

  private harnessExitReason(config: SessionConfig, pane: PaneState): string {
    if (pane.exitCode !== undefined) return `interactive ${config.harness} exited ${pane.exitCode}`;
    const finalFrame = (pane.visiblePane.trim() ? pane.visiblePane : pane.pane)
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .slice(-6)
      .join(' | ')
      .slice(0, 400);
    return (
      `interactive ${config.harness} exited; exit code unavailable after confirmed re-probe` +
      (finalFrame ? `; final frame: ${finalFrame}` : '; no final pane output captured')
    );
  }

  private resumeFailureReason(config: SessionConfig, error: unknown, pane: PaneState): string {
    const detail = error instanceof Error ? error.message : String(error);
    return /\bexited\b/i.test(detail) ? this.harnessExitReason(config, pane) : detail;
  }

  /** Legacy automatic-recovery collision detector. A label is a batch slug,
   *  not lineage, so this heuristic may suppress only automatic revivers.
   *  Explicit resume and message delivery must never consult it. */
  private liveRecoveryScopeConflictFor(view: SessionView): SessionConfig | undefined {
    const label = view.config.label?.trim();
    if (!label) return undefined;
    const cwd = path.resolve(view.config.cwd);
    for (const item of this.store.listSessions?.() ?? []) {
      const config = item.config as SessionConfig | undefined;
      const state = item.state as SessionState | undefined;
      if (!config || !state || config.id === view.config.id) continue;
      if (config.label?.trim() !== label || !config.cwd || path.resolve(config.cwd) !== cwd) continue;
      if (!terminalStatuses.includes(state.status)) return config;
    }
    return undefined;
  }

  async resume(id: string, message?: string, policy?: ResumePolicy): Promise<SessionView> {
    id = this.resolveRef(id);
    const effectivePolicy = policy ?? implicitResumePolicy(currentActor());
    // Same pending-not-refused contract as send(): wait for an in-flight first
    // launch instead of rejecting outright. A resume that lands mid-launch and
    // succeeds anyway would fight the bootstrap for the same tmux name.
    if (this.launchingRecently(id) && !(await this.awaitLaunchSettled(id, CONTROL_LAUNCH_WAIT_MS))) {
      throw new Error(
        `session ${id} is still launching (queued behind the bootstrap chain for ` +
          `${Math.round(CONTROL_LAUNCH_WAIT_MS / 1000)}s); it is pending, not failed â retry once \`kteam ps\` shows it running`,
      );
    }
    // Claim the relaunch BEFORE clearNeedsHuman/transition can await an event
    // append. The self-check and monitor death path use this map as their
    // launch amnesty; leaving resume unregistered let them terminalize the
    // session while its replacement pane was still being created.
    let releaseResumeLaunch = () => {};
    const resumeLaunch = new Promise<void>(resolve => {
      releaseResumeLaunch = resolve;
    });
    this.launching.set(id, { at: Date.now(), bootstrap: resumeLaunch });
    try {
      if (!effectivePolicy?.automatic) this.cancelRetry(id);
      let startMonitorAfterUnlock = false;
      const resumed = await this.serialized(id, async () => {
        const automaticRetry = effectivePolicy?.automatic === true && effectivePolicy.expectedStatus === 'retrying';
        let view = await this.get(id);
        if (view.state.status === 'kill_failed')
          throw new ReviveRefused('the previous tmux kill failed; use stop again before resume');
        const pickerQuarantined = view.state.needsHumanKind === CODEX_PICKER_QUARANTINE_KIND;
        // A kill_failed pane may still be sitting in an unknown native modal.
        // Do not clear its durable picker quarantine until the refusal check
        // above has passed and a real recovery can proceed.
        if (!effectivePolicy?.automatic) await this.clearNeedsHuman(id);
        if (
          effectivePolicy?.expectedStatus !== undefined &&
          (view.state.status !== effectivePolicy.expectedStatus ||
            (effectivePolicy.retryAttempt !== undefined && view.state.retryAttempt !== effectivePolicy.retryAttempt))
        ) {
          throw new ResumeCancelled(`resume guard changed from ${effectivePolicy.expectedStatus}`);
        }
        const paneState = await this.tmux.state(view.config.tmuxSession);
        if (
          view.state.pendingQuestion &&
          paneState.alive &&
          !paneState.dead &&
          !terminalStatuses.includes(view.state.status)
        )
          throw new Error('answer or abandon the structured question before resuming this live session');
        if (paneState.alive && !paneState.dead) {
          // A TERMINAL session's leftover live pane (daemon-restart re-adoption,
          // reconciled completion) is unmonitored â injecting into it loses the
          // message. Kill it and fall through to a tracked relaunch; only a
          // genuinely NON-terminal session takes the plain-send shortcut.
          if (!terminalStatuses.includes(view.state.status) && !pickerQuarantined) {
            if (!message) throw new Error('session is already running');
            return await this.sendUnlocked(view, message);
          }
        }
        if (effectivePolicy?.dedupeSharedRecoveryScope) {
          const conflict = this.liveRecoveryScopeConflictFor(view);
          if (conflict) throw new ReviveDedupeConflict(view.config, conflict);
        }
        // The old monitor must be disarmed before resume deliberately kills or
        // replaces its pane. Otherwise that monitor observes resume's own kill
        // and writes a terminal verdict in the middle of the relaunch.
        await this.stopMonitor(id);
        if (paneState.alive && !paneState.dead) {
          // Deliberate tradeoff, surfaced not silent: killing the leftover pane
          // discards any unsent text still sitting in its composer/native
          // queue. The final snapshot preserves the frame for the operator.
          await this.tmux.snapshot(view.config, true);
          await this.emit(
            id,
            'control.composer_discarded',
            {
              reason:
                'terminal-session pane killed before revive; unsent composer text (if any) is in the final snapshot',
            },
            'daemon',
          ).catch(() => undefined);
          await this.transitionUnaccountedUnlocked(id, view, 'composer_discarded');
          await this.stopTmuxWithEvidence(view.config, 'terminal session pane cleanup before revive');
        } else if (paneState.alive) {
          await this.stopTmuxWithEvidence(view.config, 'cleanup before resume');
        }
        if (view.config.harness === 'codex' && !view.config.harnessSessionId) {
          const found = await discoverCodexSession(view.config, await this.claimedCodexSessionIds(id));
          if (!found) throw new Error('could not identify the persisted Codex session to resume');
          view.config = await this.store.updateConfig<SessionConfig>(id, current => ({
            ...current,
            harnessSessionId: found.id,
            transcriptFile: found.file,
            updatedAt: now(),
          }));
        }
        // Bare relaunch: an interactive session resumed with no message just gets
        // its terminal back (`--resume <session-id>`, nothing typed). Telling a
        // human's TUI to "continue the assigned task" would be kteam inventing a
        // turn nobody asked for, so there is no new turn and no turn file either.
        const bareRelaunch = view.config.mode === 'interactive' && !message?.trim();
        const turn = bareRelaunch ? view.config.turn : view.config.turn + 1;
        const prompt = message?.trim() || 'Continue the assigned task from where you stopped.';
        if (!bareRelaunch)
          await writeFile(
            turnPrompt(this.paths, id, turn),
            `${prompt}\n\nContinue using the same kteam completion and interaction protocol.\n`,
            { mode: 0o600 },
          );
        await Promise.all(
          ['done', 'needs-help', 'process-exit'].map(name => rm(markerFile(this.paths, id, name), { force: true })),
        );
        const config = await this.store.updateConfig<SessionConfig>(id, current => ({
          ...current,
          turn,
          updatedAt: now(),
        }));
        const abandonedQuestion = view.state.pendingQuestion;
        if (abandonedQuestion) {
          // Relaunch replaces the native pane, so its old question cannot
          // survive. Append the lifecycle record before the state transition
          // clears it; a journal failure must not silently erase the evidence.
          await this.emit(
            id,
            'interaction.question_cancelled',
            {
              toolUseId: abandonedQuestion.toolUseId,
              reason: 'session relaunched before a daemon-confirmed answer',
              pendingQuestion: null,
            },
            'daemon',
          );
        }
        await this.transition(
          id,
          {
            status: 'starting',
            turn,
            startedAt: now(),
            reason: undefined,
            finishedAt: undefined,
            exitCode: undefined,
            nudgedAt: undefined,
            retryAttempt: automaticRetry ? view.state.retryAttempt : 0,
            openTools: [],
            pendingQuestion: undefined,
            promptReady: false,
            turnCompleted: false,
            waiting: undefined,
            waitingCreditSeconds: 0,
          },
          'session.resuming',
        );
        try {
          await this.serializedBootstrap(async () => {
            await this.launchWithRetry(config);
            // The replacement pane demonstrably exists from here on. Refreshing
            // launchedAt gives the monitor the same durable launch evidence the
            // first-start path already records.
            await this.store.updateState<SessionState>(id, current => ({ ...current, launchedAt: now() }));
            if (!bareRelaunch) await this.tmux.send(config, this.promptInstruction(id, turn));
          });
          this.autoContinued.delete(id);
          this.doneDeferred.delete(id);
          await this.transition(
            id,
            {
              status: 'running',
              health: 'healthy',
              reason: undefined,
              finishedAt: undefined,
              exitCode: undefined,
              promptReady: false,
              lastActivityAt: now(),
              turnCompleted: false,
            },
            'session.resumed',
            {},
            // A monitor racing this relaunch may already have written a terminal
            // status. The relaunch's proven success is the authoritative later
            // observation and must not be suppressed by terminal preservation.
            { force: true },
          );
          // launchWithRetry has proven that a replacement pane now exists, so
          // the old unconfirmed picker is no longer capable of receiving input.
          if (!effectivePolicy?.automatic) await this.clearNeedsHuman(id, { clearCodexPickerQuarantine: true });
          // A watcher immediately replays persisted transcript bytes through the
          // same per-session queue. Starting it while this queue is held would
          // deadlock resume against its own transcript callback.
          startMonitorAfterUnlock = true;
        } catch (error) {
          const firstFailureProbe = await this.tmux.state(config.tmuxSession).catch(
            () =>
              ({
                alive: false,
                dead: true,
                promptReady: false,
                pane: '',
                visiblePane: '',
              }) satisfies PaneState,
          );
          const exit = await this.confirmHarnessExit(config, firstFailureProbe, 'resume relaunch failure', 'daemon');
          if (!exit.confirmed) {
            // Readiness/injection reported an error, but the independent pane or
            // process probe proves the harness survived. Preserve it, restore a
            // steerable state, and hand it back to a fresh monitor instead of
            // killing a healthy prompt-ready successor.
            await this.transition(
              id,
              {
                status: 'running',
                health: exit.pane.promptReady ? 'healthy' : 'unknown',
                reason: undefined,
                finishedAt: undefined,
                exitCode: undefined,
                promptReady: exit.pane.promptReady,
                lastActivityAt: now(),
              },
              'session.resume_false_terminal_averted',
              { subprocessAlive: exit.subprocessAlive },
              { force: true },
            );
            if (!effectivePolicy?.automatic) await this.clearNeedsHuman(id, { clearCodexPickerQuarantine: true });
            startMonitorAfterUnlock = true;
            return await this.get(id);
          }
          await this.tmux.snapshot(config, true).catch(() => '');
          await this.stopTmuxWithEvidence(config, 'failed resume cleanup');
          const attempt = view.state.retryAttempt ?? 0;
          const failureReason = this.resumeFailureReason(config, error, exit.pane);
          if (automaticRetry && attempt < (config.retry?.transientAttempts ?? 0)) {
            const nextAttempt = attempt + 1;
            await this.transition(
              id,
              {
                status: 'retrying',
                health: 'crashed',
                reason: failureReason,
                retryAttempt: nextAttempt,
                promptReady: false,
              },
              'retry.scheduled',
              { attempt: nextAttempt, delaySeconds: 2 ** nextAttempt },
            );
            this.scheduleTransientRetry(id, nextAttempt);
          } else {
            await this.transition(
              id,
              {
                status: 'failed',
                health: 'crashed',
                reason: failureReason,
                finishedAt: now(),
                promptReady: false,
              },
              'session.failed',
            );
          }
          throw error;
        }
        return await this.get(id);
      });
      if (startMonitorAfterUnlock) {
        await this.startMonitor(id);
        return await this.get(id);
      }
      return resumed;
    } finally {
      if (this.launching.get(id)?.bootstrap === resumeLaunch) this.launching.delete(id);
      releaseResumeLaunch();
    }
  }

  /** Continue an existing session on a DIFFERENT same-kind account. kfleet pools
   *  harness session state across accounts of one kind (~/.kfleet/shared/<kind>),
   *  so any claude wrapper can `--resume` a conversation another claude wrapper
   *  started (same for codexâcodex). We validate the target, stop the old pane,
   *  rewrite the config to the new wrapper (binary/home/model â keeping the
   *  harnessSessionId, teammate, label, parent), then relaunch through the normal
   *  resume path under the new wrapper. Cross-KIND migration is unsupported. */
  async migrate(id: string, agent: string, model?: string, allowContextDowngrade = false): Promise<SessionView> {
    id = this.resolveRef(id);
    this.cancelRetry(id);
    // Abort (never drain) the quota waiter: failover calls migrate from INSIDE
    // that waiter's own promise, so draining would self-deadlock. The waiter's
    // status guard turns any stale wake into a no-op once we relaunch.
    await this.cancelQuotaWaiter(id);
    const view = await this.get(id);
    if (view.state.status === 'kill_failed')
      throw new Error(
        `cannot migrate session ${id}: the previous tmux kill failed; run \`kteam stop ${id}\` again before migrating`,
      );
    const from = view.config.binary;
    const harness = inferHarness(agent);
    if (harness !== view.config.harness)
      throw new Error(
        `cannot migrate a ${view.config.harness} session to ${harness} wrapper "${agent}"; ` +
          'cross-harness migration is not supported (v2: restart from a chat.jsonl digest)',
      );
    if (agent.includes(path.sep))
      throw new Error('migrate target must be a bare fleet wrapper name (no path), e.g. claude-auto-glm52b');
    if (!agent.startsWith(`${harness}-auto-`)) throw new Error('kteam only migrates to auto-mode fleet wrappers');
    // Resolve ONLY within the kfleet bin (the discoverAutoAgents source) â never
    // the daemon's $PATH â so a caller (incl. a warden) cannot migrate a session
    // onto an arbitrary wrapper that merely happens to be on PATH.
    const wrapper = resolveBinary(agent, this.paths.kfleetBin);
    if (!wrapper) throw new Error(`wrapper not found: ${agent}; run kfleet apply`);
    if (agent === from && !model?.trim()) throw new Error(`session ${id} is already on ${agent}`);
    const harnessHome = await wrapperHome(wrapper, harness);
    if (!harnessHome)
      throw new Error(
        `could not determine ${harness === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'} from ${wrapper}`,
      );
    // Model: explicit arg > the new wrapper's kfleet default (KTEAM_MODEL) > keep.
    const nextModel = model?.trim() || (await wrapperModel(wrapper)) || view.config.model;
    const currentModel = resolveDisplayModel(view.config.binary, view.config.model, view.state.observedModel).model;
    // Detect `[1m]` from config.model, not the stripped served id, so the
    // downgrade guard sees the true current window (was mis-reading a 1M session
    // as 200k). nextModel is a config-level id (arg / kfleet default), so it
    // still carries `[1m]` and can stay on contextWindowForModel.
    const currentWindow = contextWindowForSession({
      configModel: view.config.model,
      servedModel: currentModel,
      overrides: this.options.contextWindows,
    });
    const targetWindow = contextWindowForModel(nextModel, this.options.contextWindows);
    const currentContextTokens =
      view.state.contextTokens ??
      (view.state.contextPercent !== undefined
        ? Math.ceil(((view.state.contextWindow ?? currentWindow) * Math.max(0, view.state.contextPercent)) / 100)
        : undefined);
    // Reject before journalling intent or stopping the old pane. A smaller
    // target is opt-in because even a currently-small transcript can grow past
    // it; a transcript that ALREADY exceeds the target is never launchable and
    // the downgrade flag must not turn a delayed failure into an accepted one.
    if (targetWindow < currentWindow && !allowContextDowngrade) {
      const targetName = nextModel ?? 'the target model';
      const largerVariant = targetName.includes('[1m]') ? targetName : `${targetName}[1m]`;
      throw new Error(
        `refusing context-window downgrade from ${currentModel} (${currentWindow} tokens) to ${targetName} ` +
          `(${targetWindow} tokens); use --model ${largerVariant} to retain the larger window, or retry with ` +
          '--allow-context-downgrade',
      );
    }
    if (currentContextTokens !== undefined && currentContextTokens > targetWindow) {
      throw new Error(
        `refusing migration to ${nextModel ?? agent}: current context uses ${currentContextTokens} tokens, ` +
          `exceeding the target window of ${targetWindow} tokens; choose a [1m] model variant`,
      );
    }
    const at = now();
    // Snapshot the ORIGINAL account so a failed relaunch can be rolled back â
    // the config must never be left pointing at a wrapper that never launched.
    const original = {
      binary: view.config.binary,
      harness: view.config.harness,
      modelHint: view.config.modelHint,
      model: view.config.model,
      harnessHome: view.config.harnessHome,
      transcriptFile: view.config.transcriptFile,
    };
    let migrated = view.config;
    let resumed: SessionView;
    let relaunchRequired = false;
    try {
      // Journal the intent BEFORE stopping the pane: a crash between here and a
      // successful relaunch leaves a durable `migration` marker (plus this event)
      // rather than a silently half-migrated config. Every following step through
      // relaunch is inside this rollback boundary.
      await this.store.updateConfig<SessionConfig>(id, current => ({ ...current, migration: { from, to: agent, at } }));
      await this.emit(id, 'session.migrating', { from, to: agent, model: nextModel, at }, 'daemon');

      // Stop the old pane and its monitor before relaunching. The managed helper
      // re-arms the monitor if a kill fails and the old pane is still alive.
      const paneState = await this.tmux.state(view.config.tmuxSession);
      if (paneState.alive) {
        await this.stopManagedSession(view.config, `migrate ${from} -> ${agent}`, true);
        relaunchRequired = true;
      } else {
        await this.stopMonitor(id, true);
        relaunchRequired = true;
      }

      // Persist account identity and the account-derived transcript path in ONE
      // write. No observer can see a new wrapper/home paired with the old path.
      migrated = await this.store.updateConfig<SessionConfig>(id, current => {
        const next: SessionConfig = {
          ...current,
          binary: agent,
          harness,
          modelHint: modelHint(agent),
          model: nextModel,
          harnessHome,
          updatedAt: now(),
        };
        return next.harness === 'claude' ? { ...next, transcriptFile: claudeTranscriptPath(next) } : next;
      });
      if (agent !== from) {
        // Usage belongs to the wrapper account, not the conversation. Never show
        // the old account's cached quota while the new wrapper is coming up.
        await this.store.updateState<SessionState>(id, current => ({
          ...current,
          quota: undefined,
          usage5hPercent: undefined,
          usageWeeklyPercent: undefined,
          usage5hResetAt: undefined,
          usageWeeklyResetAt: undefined,
          usageAtLimit: undefined,
          usageAuthOk: undefined,
        }));
      }
      resumed = await this.resume(
        id,
        'You have been migrated to a different account mid-task due to quota/auth issues on the previous one. ' +
          'Re-read your latest turn file and continue exactly where you left off.',
      );
    } catch (error) {
      if (error instanceof ResumeCancelled) {
        // A newer operation superseded this relaunch and now owns the config;
        // just drop our staged marker and let it proceed.
        await this.store
          .updateConfig<SessionConfig>(id, current => ({ ...current, migration: undefined }))
          .catch(() => undefined);
        throw error;
      }
      // Relaunch failed: roll the ACCOUNT back. Model rollback is a separate
      // decision — once the new model was observed or reached a ready prompt,
      // reverting it would make the next resume request the wrong model and
      // recreate the relaunch loop this guard exists to stop.
      const detail = error instanceof Error ? error.message : String(error);
      const latest = await this.get(id).catch(() => undefined);
      const requestedModel = nextModel?.trim().toLowerCase();
      const observedModel = latest?.state.observedModel?.trim().toLowerCase();
      const targetConfigStillStaged = latest?.config.binary === agent && latest.config.model === nextModel;
      const observedNextModel = Boolean(
        targetConfigStillStaged &&
        requestedModel &&
        observedModel &&
        (observedModel === requestedModel ||
          observedModel.includes(requestedModel) ||
          requestedModel.includes(observedModel)),
      );
      const paneAfterFailure = await this.tmux.state(migrated.tmuxSession).catch(() => undefined);
      const reachedPromptReady = Boolean(
        targetConfigStillStaged &&
        (latest?.state.promptReady === true ||
          (paneAfterFailure?.alive && !paneAfterFailure.dead && paneAfterFailure.promptReady)),
      );
      const keepLaunchedModel = Boolean(nextModel && (observedNextModel || reachedPromptReady));
      let rolledBack: SessionConfig | undefined;
      let rollbackError: string | undefined;
      try {
        rolledBack = await this.store.updateConfig<SessionConfig>(id, current => ({
          ...current,
          ...original,
          ...(keepLaunchedModel ? { model: nextModel } : {}),
          migration: undefined,
          updatedAt: now(),
        }));
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure);
      }
      // updateConfig writes config.json before refreshing SQLite. A rejected
      // refresh may therefore still have restored the authoritative document;
      // observe it after the attempt rather than equating rejection with either
      // success or failure.
      const afterRollback = await this.get(id).catch(() => undefined);
      const observedConfig = afterRollback?.config ?? rolledBack;
      const restoredModel = keepLaunchedModel ? nextModel : original.model;
      const restoredToOriginal = Boolean(
        observedConfig &&
        observedConfig.binary === original.binary &&
        observedConfig.harness === original.harness &&
        observedConfig.modelHint === original.modelHint &&
        observedConfig.model === restoredModel &&
        observedConfig.harnessHome === original.harnessHome &&
        observedConfig.transcriptFile === original.transcriptFile &&
        observedConfig.migration === undefined,
      );
      const killFailed = latest?.state.status === 'kill_failed' || afterRollback?.state.status === 'kill_failed';
      const paneOutcome = killFailed
        ? 'tmux kill is unconfirmed (kill_failed)'
        : paneAfterFailure === undefined
          ? 'pane state unknown'
          : paneAfterFailure.alive && !paneAfterFailure.dead
            ? 'pane still alive'
            : 'pane stopped';
      const rollbackOutcome = restoredToOriginal
        ? `session restored to ${from}`
        : `rollback incomplete; observed wrapper ${observedConfig?.binary ?? 'unknown'}`;
      const reason =
        `migration to ${agent} failed: ${detail}; ${rollbackOutcome} (${paneOutcome})` +
        (keepLaunchedModel ? ` and kept launched model ${nextModel}` : '') +
        (rollbackError ? `; rollback write failed: ${rollbackError}` : '');
      // kill_failed is a quarantine backed by kill.json. Never downgrade it to
      // generic failed merely to fit the migration error path. Likewise, a
      // failure before the original pane was stopped leaves its existing state
      // and monitor intact rather than falsely terminalizing live work.
      if (!killFailed && relaunchRequired) {
        await this.transition(
          id,
          { status: 'failed', reason, finishedAt: now(), health: 'crashed' },
          'session.failed',
        ).catch(() => undefined);
      }
      await this.emit(
        id,
        'session.migrate_failed',
        {
          from,
          to: agent,
          model: nextModel,
          detail,
          ...(restoredToOriginal ? { restoredTo: from } : {}),
          ...(observedConfig?.binary ? { observedWrapper: observedConfig.binary } : {}),
          ...(rollbackError ? { rollbackError } : {}),
          status: killFailed
            ? 'kill_failed'
            : relaunchRequired
              ? 'failed'
              : (afterRollback?.state.status ?? latest?.state.status ?? view.state.status),
        },
        'daemon',
      ).catch(() => undefined);
      throw new Error(reason);
    }

    // Relaunch is the proof of success. Only now clear the intent marker and
    // publish durable completion evidence. A record-write failure must not roll
    // the config back underneath an already-running pane on the new account.
    await this.store
      .updateConfig<SessionConfig>(id, current => ({ ...current, migration: undefined }))
      .catch(error =>
        console.error(`kteamd: migrated session ${id} but could not clear its intent marker: ${String(error)}`),
      );
    await this.emit(id, 'session.migrated', { from, to: agent, model: nextModel }, 'daemon').catch(error =>
      console.error(`kteamd: migrated session ${id} but could not persist completion evidence: ${String(error)}`),
    );
    return await this.get(id).catch(() => resumed);
  }

  /** Validate a requested teammate callsign for a RENAME and ensure no OTHER
   *  live session in the window already holds it. Mirrors resolveTeammateName's
   *  checks, but excludes `exceptId` so renaming a session's title while keeping
   *  (or re-asserting) its own callsign is not a self-collision. Returns the
   *  normalised slug. */
  private resolveRenameTeammate(requested: string, exceptId: string): string {
    const normalized = normalizeTeammateName(requested);
    if (!normalized)
      throw new Error(
        `invalid --teammate name "${requested}": use a slug like "hayden" — ` +
          'lowercase, start with a letter, then letters/digits/hyphens, at most 32 chars',
      );
    const { liveByName } = this.teammateNameUsage();
    const live = (liveByName.get(normalized) ?? []).filter(config => config.id !== exceptId);
    if (live.length > 0) {
      const conflicts = live.map(config => `${config.id} (${config.name})`).join(', ');
      throw new Error(
        `teammate name "${normalized}" is already taken by a live session in the last 5 days: ${conflicts}. ` +
          'Pick another with `kteam name`.',
      );
    }
    return normalized;
  }

  /** Rename a session's TASK TITLE and/or its teammate CALLSIGN, and/or DETACH
   *  it from its parent (`clearParent`). Renaming the callsign is cheap and safe
   *  because the callsign is not load-bearing — tmux sessions, session
   *  directories, and KTEAM_SESSION_ID all key on the id, and
   *  `kteam send/attach/--parent` resolve the name live off `config.teammate`.
   *  So a callsign rename simply changes what the name resolves to, guarded by
   *  the same collision check as `start --teammate` (excluding this session).
   *  Clearing the parent drops the lineage pointer only — it re-roots a session
   *  in the `ps`/UI tree and is a safe no-op when there is no parent.
   *  Persists to config.json AND the metadata index (so `kteam ps` and the web
   *  UI both reflect it) and journals a `session.renamed` event so the live UI
   *  refetches without a manual refresh. Works on running and terminal
   *  sessions alike — it only rewrites config. */
  async rename(id: string, name?: string, teammate?: string, clearParent = false): Promise<SessionView> {
    const resolved = this.resolveRef(id);
    const title = name?.trim();
    const requestedTeammate = teammate?.trim();
    if (!title && !requestedTeammate && !clearParent)
      throw new Error('rename requires --name "New Title", --teammate <name>, and/or --clear-parent');
    const nextName = title ? displayName(title) : undefined;
    const nextTeammate = requestedTeammate ? this.resolveRenameTeammate(requestedTeammate, resolved) : undefined;
    const config = await this.store.updateConfig<SessionConfig>(resolved, current => {
      const next: SessionConfig = {
        ...current,
        ...(nextName !== undefined ? { name: nextName } : {}),
        ...(nextTeammate !== undefined ? { teammate: nextTeammate } : {}),
        updatedAt: now(),
      };
      // Detach from the parent — clears the lineage pointer ONLY. Nothing else
      // keys on `parent` for a non-warden session (name resolution uses
      // id/teammate; warden lineage only walks WARDEN ancestors), so a human
      // session mis-parented under the agent that spawned it is re-rooted
      // without side effects. Deleting the key (vs undefined) keeps config.json
      // clean; a no-op when there is no parent.
      if (clearParent) delete next.parent;
      return next;
    });
    await this.emit(resolved, 'session.renamed', { name: config.name, teammate: config.teammate }, 'client');
    return await this.get(resolved);
  }

  async remove(id: string, purge = false, force = false): Promise<void> {
    id = this.resolveRef(id);
    if (this.deleting.has(id)) throw new Error('session deletion is already in progress');
    this.deleting.add(id);
    this.cancelRetry(id);
    let restartMonitor: SessionConfig | undefined;
    try {
      await this.cancelQuotaWaiter(id, true);
      await this.queues.get(id)?.catch(() => undefined);
      const view = await this.get(id);
      const paneState = await this.tmux.state(view.config.tmuxSession);
      const running = paneState.alive && !paneState.dead;
      if (running && !force) throw new Error('session is running; stop it first or use --force');
      await this.stopMonitor(id, true);
      await this.terminalSendFinalizers.get(id)?.catch(() => undefined);
      if (paneState.alive) {
        await this.tmux.snapshot(view.config, true);
        try {
          await this.stopTmuxWithEvidence(view.config, 'session deletion');
        } catch (error) {
          if (running) restartMonitor = view.config;
          throw error;
        }
      }
      await this.emit(id, 'session.deleted', { purge }, 'client', undefined, true);
      if (purge) await rm(view.directory, { recursive: true, force: true });
      else {
        await mkdir(this.paths.trash, { recursive: true, mode: 0o700 });
        await rename(view.directory, path.join(this.paths.trash, `${id}-${Date.now()}`));
      }
      // Drop THIS session's rows. This used to rebuild the entire index —
      // a full re-import of every journal in the fleet to delete one session
      // (and it left the removed row behind anyway, which is why the index
      // carried 1036 sessions against 700 directories on disk).
      this.store.forgetSession(id);
      this.chatIndexChecks.delete(id);
      this.sendLedgers.delete(id);
      this.reconciledSendLedgers.delete(id);
      this.terminalSendFinalizers.delete(id);
      this.terminalSendFinalizerCutoffs.delete(id);
    } finally {
      this.deleting.delete(id);
      if (restartMonitor && !this.closed) await this.startMonitor(id).catch(() => undefined);
    }
  }

  /** True only when markers/done.json certifies the given CURRENT turn. A
   *  marker without a turn (pre-upgrade) or from an older turn is stale
   *  evidence and must not complete newer work. */
  private doneMarkerTurn(id: string): number | undefined {
    try {
      const marker = JSON.parse(readFileSync(markerFile(this.paths, id, 'done'), 'utf8')) as { turn?: number };
      return typeof marker.turn === 'number' ? marker.turn : undefined;
    } catch {
      return undefined;
    }
  }

  private doneMarkerForTurn(id: string, turn: number | undefined): boolean {
    const markerTurn = this.doneMarkerTurn(id);
    return markerTurn !== undefined && markerTurn === turn;
  }

  async signal(id: string, kind: SignalKind, message?: string, options: SignalOptions = {}): Promise<SessionView> {
    id = this.resolveRef(id);
    this.cancelRetry(id);
    return await this.serialized(id, async () => {
      const view = await this.get(id);
      if (kind === 'waiting' || kind === 'working') {
        return await this.applyWaitingSignal(view, kind, message, options);
      }
      if (kind === 'done') {
        void this.cancelQuotaWaiter(id);
        if (message) await writeFile(path.join(view.directory, 'summary.md'), `${message}\n`, { mode: 0o600 });
        if (!existsSync(path.join(view.directory, 'summary.md')))
          await writeFile(
            path.join(view.directory, 'summary.md'),
            'Task completed; inspect chat and repository diff.\n',
            { mode: 0o600 },
          );
        // The marker carries the turn it certifies: a marker from an OLDER turn
        // must never complete a NEWER turn (send bumps the persisted turn at
        // queue time, so a daemon death in the queueâdelivery window would
        // otherwise let stale evidence complete work that never ran).
        await atomicJson(markerFile(this.paths, id, 'done'), {
          at: now(),
          type: 'done',
          turn: view.state.turn ?? view.config.turn,
        });
        await this.tmux.snapshot(view.config, true);
        await this.stopManagedSession(view.config, 'completion');
        await this.transition(
          id,
          { status: 'completed', health: 'idle', reason: 'done marker written', finishedAt: now(), promptReady: false },
          'session.completed',
        );
      } else {
        if (!message) throw new Error('help requires a question');
        await appendFile(
          path.join(view.directory, 'channel', 'outbox.jsonl'),
          `${JSON.stringify({ at: now(), type: 'question', message })}\n`,
        );
        await atomicJson(markerFile(this.paths, id, 'needs-help'), { at: now(), type: 'question', message });
        if (view.config.mode === 'auto') {
          void this.cancelQuotaWaiter(id);
          await this.tmux.snapshot(view.config, true);
          await this.stopManagedSession(view.config, 'automode help protocol violation');
          await this.transition(
            id,
            {
              status: 'failed',
              health: 'crashed',
              reason: 'automode teammate requested user input',
              finishedAt: now(),
              promptReady: false,
            },
            'session.protocol_violation',
          );
        } else {
          await this.transition(
            id,
            { status: 'waiting', health: 'waiting', reason: message, promptReady: true },
            'interaction.help',
          );
        }
      }
      return await this.get(id);
    });
  }

  /** Enter or leave a DECLARED wait.
   *
   *  A parked custodian used to be indistinguishable from a dead one: the
   *  reflex layer nudged at 180 s and killed at 300 s, and the turn ceiling
   *  reaped long-running babysitters at 4 h (2026-07-23: four cap-kills and
   *  four park-loops in one night). Declaring the wait suspends both while
   *  keeping the session visibly alive â heartbeats keep flowing, the
   *  deadline is published, and expiry WAKES the teammate rather than killing
   *  it. Legal in automode: unlike `help`, it never asks a human for
   *  anything. */
  private async applyWaitingSignal(
    view: SessionView,
    kind: 'waiting' | 'working',
    message: string | undefined,
    options: SignalOptions,
  ): Promise<SessionView> {
    const id = view.config.id;
    if (kind === 'working') {
      await this.clearWaiting(id, 'signalled working');
      return await this.get(id);
    }
    if (protectedStatuses.includes(view.state.status))
      throw new Error(`session ${id} is ${view.state.status}; resume it before declaring a wait`);
    const until = options.until === undefined ? undefined : parseDeadline(options.until);
    // PEER WAIT: resolve the target NOW and refuse an unknown one. Parking on
    // a name that resolves to nobody would suspend the reflex layer waiting
    // for a reply that can never arrive — a typo becoming an effectively
    // immortal session. The deadline backstop would wake it eventually, but
    // hours late and with no explanation; failing the signal outright says
    // what is wrong while the teammate can still fix it.
    let peer: SessionView | undefined;
    if (options.peer !== undefined) {
      const peerId = this.resolveRef(options.peer);
      if (peerId === id) throw new Error('a session cannot wait on a reply from itself');
      peer = await this.get(peerId).catch(() => undefined);
      if (!peer) throw new Error(`unknown kteam session "${options.peer}" - cannot wait for a reply from it`);
    }
    const waiting = {
      since: now(),
      ...(until ? { until } : {}),
      ...(options.condition ? { condition: options.condition } : {}),
      ...(peer ? { peer: peer.config.id, ...(peer.config.teammate ? { peerName: peer.config.teammate } : {}) } : {}),
    };
    const peerLabel = peer ? `reply from ${peer.config.teammate ?? peer.config.id}` : undefined;
    const detail = [peerLabel ?? options.condition ?? message, until ? `until ${until}` : 'open-ended']
      .filter(Boolean)
      .join(' â ');
    await this.transition(
      id,
      { status: 'waiting', health: 'waiting', reason: `waiting: ${detail}`, waiting },
      'session.waiting',
      {
        until: until ?? null,
        condition: options.condition ?? null,
        ...(peer ? { peer: peer.config.id, peerName: peer.config.teammate ?? null } : {}),
      },
    );
    return await this.get(id);
  }

  /** `recipientId` was parked awaiting a reply from `senderId`, and that reply
   *  has just been delivered — so end the park.
   *
   *  This is what makes request/response work without polling: the waiter
   *  declares `signal waiting --peer <target>`, the target answers with an
   *  ordinary `kteam send <waiter> "…"`, and the wait ends here. Neither side
   *  needs a reply-specific command, and the replier never has to signal
   *  anything on the waiter's behalf.
   *
   *  No-op unless the recipient is parked on THIS sender: an unrelated peer
   *  message must not release a wait that is still genuinely outstanding. */
  private async endPeerWait(recipientId: string, senderId: string): Promise<void> {
    const view = await this.get(recipientId).catch(() => undefined);
    if (view?.state.waiting?.peer !== senderId) return;
    const who = view.state.waiting.peerName ?? senderId;
    await this.clearWaiting(recipientId, `${who} replied`);
  }

  /** Leave the declared wait: drop the marker, credit the parked time back
   *  against the turn ceiling, and return the session to running. */
  private async clearWaiting(id: string, reason: string): Promise<void> {
    this.waitingHeartbeats.delete(id);
    const view = await this.get(id).catch(() => undefined);
    if (view?.state.waiting === undefined) return;
    const since = view.state.waiting?.since ? Date.parse(view.state.waiting.since) : Number.NaN;
    const parkedSeconds = Number.isFinite(since) ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0;
    // The credit outlives the wait: the ceiling must never charge a session
    // for time it spent deliberately parked.
    const waitingCreditSeconds = (view.state.waitingCreditSeconds ?? 0) + parkedSeconds;
    await this.transition(
      id,
      {
        ...(protectedStatuses.includes(view.state.status) ? {} : { status: 'running', health: 'healthy' }),
        reason,
        waiting: undefined,
        waitingCreditSeconds,
        // Re-anchor the reflex: a park produces no life-signs by design, so
        // waking into a ledger that is hours stale would have the very next
        // tick nudge â or kill â the teammate the daemon just woke.
        nudgedAt: undefined,
        lastActivityAt: now(),
        lastTranscriptAt: now(),
        lastPaneAt: now(),
      },
      'session.waiting_cleared',
      { reason, parkedSeconds, waitingCreditSeconds },
    );
  }

  /** One monitor tick of a DECLARED wait: publish a heartbeat so the park is
   *  visibly alive, and at the deadline clear the wait and WAKE the teammate
   *  (the wait is a pause, not an ending â nothing here ever kills). */
  private async serviceWaiting(view: SessionView): Promise<void> {
    const id = view.config.id;
    const waiting = view.state.waiting;
    if (!waiting) return;
    const sinceMs = Date.parse(waiting.since);
    const elapsedSeconds = Number.isFinite(sinceMs) ? Math.round((Date.now() - sinceMs) / 1000) : 0;
    // An open-ended wait still ENDS. Without a backstop a park would suspend
    // the idle kill and the ceiling forever, so a teammate that declared a
    // wait and then died quietly would become immortal â the park-loop this
    // feature exists to end, inverted.
    const declaredUntilMs = waiting.until ? Date.parse(waiting.until) : Number.NaN;
    const untilMs = Number.isFinite(declaredUntilMs)
      ? declaredUntilMs
      : (Number.isFinite(sinceMs) ? sinceMs : Date.now()) + WAITING_BACKSTOP_MS;
    if (Date.now() >= untilMs) {
      const backstopped = !Number.isFinite(declaredUntilMs);
      const reason = backstopped
        ? `open-ended wait hit the ${Math.round(WAITING_BACKSTOP_MS / 60_000)}m backstop (${waiting.condition ?? 'no condition given'})`
        : `declared wait elapsed (${waiting.condition ?? 'no condition given'})`;
      await this.clearWaiting(id, reason);
      await this.emit(
        id,
        'session.waiting_expired',
        { until: waiting.until ?? null, condition: waiting.condition ?? null, backstopped, elapsedSeconds },
        'watcher',
      );
      await this.tmux
        .send(
          view.config,
          `The wait you declared has elapsed (${waiting.condition ?? 'no condition given'}). Re-check the condition and continue the task.`,
        )
        .catch(error => void this.emit(id, 'session.waiting_wake_failed', { message: String(error) }, 'watcher'));
      return;
    }
    // Hold the status against the transcript's constant recomputation, so the
    // park stays what `ps`, the UI, and `kteam wait` see.
    if (view.state.status !== 'waiting' && !protectedStatuses.includes(view.state.status)) {
      await this.transition(id, { status: 'waiting', health: 'waiting' }, 'session.waiting_held');
    }
    const lastBeat = this.waitingHeartbeats.get(id) ?? 0;
    if (Date.now() - lastBeat < WAITING_HEARTBEAT_MS) return;
    this.waitingHeartbeats.set(id, Date.now());
    await atomicJson(path.join(view.directory, 'checks', 'waiting.json'), {
      at: now(),
      since: waiting.since,
      until: waiting.until ?? null,
      condition: waiting.condition ?? null,
      elapsedSeconds,
    });
    await this.emit(
      id,
      'session.waiting_heartbeat',
      {
        elapsedSeconds,
        until: waiting.until ?? null,
        condition: waiting.condition ?? null,
        remainingSeconds: Math.max(0, Math.round((untilMs - Date.now()) / 1000)),
      },
      'watcher',
    );
  }

  async snapshot(id: string): Promise<string> {
    id = this.resolveRef(id);
    return await this.serialized(id, async () => {
      const view = await this.get(id);
      const state = await this.tmux.state(view.config.tmuxSession);
      // A dead pane used to yield an EMPTY capture with rc=0, indistinguishable
      // from a blank-but-healthy screen â callers scripting around `kteam
      // snapshot` read that as "fine". Fail loudly and point at the stored
      // final frame instead.
      if (!state.alive || state.dead) {
        throw new Error(
          `pane dead: session ${id} has no live tmux pane (status ${view.state.status}); ` +
            'the final frame is preserved in last-snapshot.txt (kteam snapshot reads live panes only)',
        );
      }
      return await this.tmux.snapshot(view.config, true);
    });
  }

  async lastSnapshot(id: string): Promise<string> {
    id = this.resolveRef(id);
    // Read the monitor's last written frame straight from disk. snapshot()
    // captures live tmux UNDER THE SESSION LOCK â on a busy session that
    // queues behind monitor/injection work for tens of seconds, which is what
    // made the web UI (polling it every few seconds) feel broken.
    return await readFile(path.join(sessionDir(this.paths, id), 'last-snapshot.txt'), 'utf8').catch(() => '');
  }

  async chatHistory(
    id: string,
    before?: number,
    limit = 200,
  ): Promise<{ total: number; offset: number; records: unknown[] }> {
    id = this.resolveRef(id);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be 1..1000');
    // Chat history is INDEXED, not copied: the records live in the harness's own
    // transcript and are re-normalized here by the same parser the live watcher
    // uses. Lazily scanning once makes the SQLite table rebuildable and also
    // avoids the rollout boundary bug where the first new pointer hid all of a
    // legacy session's older chat.jsonl records.
    const view = await this.get(id).catch(() => undefined);
    if (view) await this.ensureChatIndex(id, view);
    const total = this.store.chatPointerCount(id);
    if (total === 0) return await this.chatHistoryFromLegacyFile(id, before, limit);
    const normalize = this.chatNormalizer(view);
    const page = this.readChatWindow(id, total, before, limit, normalize);
    // A window that HAS pointer rows but resolves to ZERO records is the danger
    // case: the recorded byte offsets are stale. The classic trigger is a codex
    // rollout transcript the harness rewrote/compacted in place, which shifts
    // every offset so no pointer's bytes match its fingerprint any more. Do NOT
    // serve a valid-looking empty page (it reads as "nothing happened" rather
    // than "your index is broken"). Rebuild THIS ONE session's pointers from the
    // current transcript â no global reindex â and retry once.
    if (page.rows > 0 && page.records.length === 0 && view?.config.transcriptFile) {
      await this.rebuildChatIndex(id, view);
      const rebuiltTotal = this.store.chatPointerCount(id);
      const retry = this.readChatWindow(id, rebuiltTotal, before, limit, normalize);
      if (retry.rows > 0 && retry.records.length === 0) {
        throw new Error(
          `chat index for ${id} is unreadable: ${rebuiltTotal} pointer row(s) resolve to no records even ` +
            `after rebuilding from ${view.config.transcriptFile} â the harness likely rotated, compacted, or ` +
            `truncated that transcript. Refusing to serve a silent empty transcript.`,
        );
      }
      return {
        total: rebuiltTotal,
        offset: retry.offset,
        records: retry.records,
        ...(retry.skipped > 0 ? { degraded: retry.skipped } : {}),
      };
    }
    // Pointers exist and none resolve, but there is no transcript to rebuild from
    // (the harness file is gone). Still refuse to serve a silent empty page.
    if (page.rows > 0 && page.records.length === 0) {
      throw new Error(
        `chat index for ${id} is unreadable: ${total} pointer row(s) resolve to no records and the harness ` +
          `transcript is unavailable to rebuild from. Refusing to serve a silent empty transcript.`,
      );
    }
    // BEST EFFORT by design: the harness owns those files and may compact or
    // delete them. Say so rather than silently returning a short page.
    return {
      total,
      offset: page.offset,
      records: page.records,
      ...(page.skipped > 0 ? { degraded: page.skipped } : {}),
    };
  }

  /** The harness parser that turns one transcript line into normalized chat
   *  records. Shared by the live watcher, the lazy indexer, and resolution. */
  private chatNormalizer(view?: SessionView): (line: string) => unknown[] {
    return view?.config.harness === 'codex'
      ? (line: string) => parseCodexTranscriptLine(line) as unknown[]
      : (line: string) => parseClaudeTranscriptLine(line) as unknown[];
  }

  /** Read one page of chat pointers and resolve it. Reports how many pointer
   *  ROWS the window held (before resolution) so callers can distinguish a
   *  legitimately empty page (off the end of the history) from a broken index
   *  (rows present, none resolvable). */
  private readChatWindow(
    id: string,
    total: number,
    before: number | undefined,
    limit: number,
    normalize: (line: string) => unknown[],
  ): { offset: number; rows: number; records: unknown[]; skipped: number } {
    const end = before === undefined ? total : Math.max(0, Math.min(before, total));
    const offset = Math.max(0, end - limit);
    const rows = this.store.chatPointers(id, offset, end - offset);
    const { records, skipped } = this.store.resolveChatPointers(rows, normalize);
    return { offset, rows: rows.length, records, skipped };
  }

  /** Rebuild ONE session's chat pointers from its current transcript. Used when
   *  a served window has pointer rows but none resolve â the stored offsets are
   *  stale. Forgets just this session's chat pointers + source bookkeeping and
   *  re-scans the file once; far cheaper and safer than a global reindex. */
  private async rebuildChatIndex(id: string, view: SessionView): Promise<void> {
    const file = view.config.transcriptFile;
    if (!file) return;
    // Drop any in-flight ensureChatIndex memo so a later fetch re-verifies from
    // scratch rather than trusting the pass we are about to invalidate.
    this.chatIndexChecks.delete(id);
    this.store.forgetChatPointers(id);
    await this.indexHarnessTranscript(id, view, file, false);
  }

  /** Verify that live sessions' chat pointer rows actually RESOLVE to readable
   *  transcript bytes â not merely that rows exist. A session whose newest
   *  pointers no longer resolve (a rewritten/compacted transcript shifted every
   *  byte offset) is rebuilt in place from its current transcript; if it still
   *  cannot resolve afterwards it is reported LOUDLY rather than left to serve
   *  blank transcripts. Never feeds the membership-restart counter. */
  private async verifyChatIndexes(indexed: readonly IndexedSession[], report: ConsistencyReport): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastChatVerifyAt < CHAT_VERIFY_INTERVAL_MS) return;
    this.lastChatVerifyAt = nowMs;
    for (let index = 0; index < indexed.length; index++) {
      await this.yieldSweepChunk(index);
      const item = indexed[index]!;
      const config = item.config as SessionConfig | undefined;
      if (!config) continue;
      if (item.status && terminalStatuses.includes(item.status as SessionStatus)) continue;
      const id = config.id;
      if (this.store.chatPointerCount(id) === 0) continue;
      const view = await this.get(id).catch(() => undefined);
      if (!view) continue;
      const normalize = this.chatNormalizer(view);
      if (this.chatTailResolves(id, normalize)) continue;
      // Newest pointers do not resolve â rebuild this ONE session and re-probe.
      try {
        await this.rebuildChatIndex(id, view);
      } catch (error) {
        console.error(`kteamd consistency: chat-index rebuild of ${id} failed: ${String(error)}`);
      }
      if (this.chatTailResolves(id, normalize)) report.repaired.push(id);
      else report.chatIndexBroken.push(id);
    }
    if (report.chatIndexBroken.length > 0) {
      console.error(
        `kteamd consistency: ${report.chatIndexBroken.length} session(s) have chat pointers that no longer ` +
          `resolve to readable transcript bytes even after a rebuild: ${report.chatIndexBroken.join(', ')}`,
      );
      this.emitTransient('fleet.chat_index_broken', { sessions: report.chatIndexBroken });
    }
  }

  /** Does the NEWEST window of a session's chat pointers resolve to at least one
   *  record? A cheap tail sample, not a full-history scan. */
  private chatTailResolves(id: string, normalize: (line: string) => unknown[]): boolean {
    const total = this.store.chatPointerCount(id);
    if (total === 0) return true;
    const sample = Math.min(total, CHAT_VERIFY_SAMPLE);
    const rows = this.store.chatPointers(id, total - sample, sample);
    if (rows.length === 0) return true;
    const { records } = this.store.resolveChatPointers(rows, normalize);
    return records.length > 0;
  }

  /** Ensure this process has done one complete reconstruction pass over the
   *  current harness transcript. Live watcher inserts are identity-deduped, so
   *  scanning an already-complete index is cheap and harmless; after a schema
   *  rebuild it restores history that events.jsonl deliberately no longer
   *  duplicates. Missing/deleted harness files degrade to the legacy copy or
   *  skipped pointers rather than failing the API request. */
  private async ensureChatIndex(id: string, view: SessionView): Promise<void> {
    const file = view.config.transcriptFile;
    if (!file) return;
    let check = this.chatIndexChecks.get(id);
    if (!check) {
      check = (async () => {
        const info = await stat(file);
        if (this.store.chatSourceCurrent(id, file, info)) return;
        await this.indexHarnessTranscript(id, view, file, !this.store.chatSourceKnown(id, file));
      })();
      this.chatIndexChecks.set(id, check);
    }
    try {
      await check;
    } catch {
      // The harness owns this file and can rotate/delete it. Let resolution
      // report degradation, and allow a later request to retry if it returns.
      if (this.chatIndexChecks.get(id) === check) this.chatIndexChecks.delete(id);
    }
  }

  private async indexHarnessTranscript(
    id: string,
    view: SessionView,
    file: string,
    replaceUnverified: boolean,
  ): Promise<void> {
    const bytes = await readFile(file);
    if (replaceUnverified) this.store.forgetChatSourcePointers(id, file);
    const normalize =
      view.config.harness === 'codex'
        ? (line: string) => parseCodexTranscriptLine(line) as unknown[]
        : (line: string) => parseClaudeTranscriptLine(line) as unknown[];
    const fallbackTime = now();
    let lineStart = 0;
    let batch: Array<{
      time: string;
      type: string;
      turn: number;
      sourceFile: string;
      byteOffset: number;
      byteLength: number;
      recordIndex: number;
      fingerprint: string;
    }> = [];
    const flush = () => {
      if (batch.length === 0) return;
      this.store.appendChatPointers(id, batch);
      batch = [];
    };
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      const line = bytes.subarray(lineStart, index).toString('utf8');
      if (line.length > 0) {
        let events: unknown[] = [];
        try {
          events = normalize(line);
        } catch {
          // Same degradation contract as the live watcher: one malformed
          // complete record is skipped; later records remain indexable.
        }
        for (let recordIndex = 0; recordIndex < events.length; recordIndex += 1) {
          const event = events[recordIndex] as { type?: string; timestamp?: string };
          if (!event.type || !HARNESS_DERIVED_EVENT_TYPES.has(event.type)) continue;
          batch.push({
            time: event.timestamp ?? fallbackTime,
            type: event.type,
            turn: view.config.turn,
            sourceFile: file,
            byteOffset: lineStart,
            byteLength: index - lineStart,
            recordIndex,
            fingerprint: chatEventFingerprint(event),
          });
          if (batch.length >= 1_000) flush();
        }
      }
      lineStart = index + 1;
    }
    flush();
    // Only claim complete coverage if the file did not change underneath the
    // scan. Otherwise the inserted rows remain useful, but the next daemon
    // lifetime checks/reconstructs again instead of trusting a torn extent.
    const info = await stat(file);
    if (info.size === bytes.length) this.store.markChatSource(id, file, info);
  }

  /** Pre-pointer sessions: read the chat.jsonl copy kteam used to write. */
  private async chatHistoryFromLegacyFile(
    id: string,
    before: number | undefined,
    limit: number,
  ): Promise<{ total: number; offset: number; records: unknown[] }> {
    const raw = await readFile(path.join(sessionDir(this.paths, id), 'chat.jsonl'), 'utf8').catch(() => '');
    const records = raw
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
    const end = before === undefined ? records.length : Math.max(0, Math.min(before, records.length));
    const offset = Math.max(0, end - limit);
    return { total: records.length, offset, records: records.slice(offset, end) };
  }
  async logs(id: string, turn?: number): Promise<string> {
    id = this.resolveRef(id);
    const view = await this.get(id);
    return await readFile(turnLog(this.paths, id, turn ?? view.config.turn), 'utf8').catch(() => '');
  }

  async replay(id: string | undefined, after: number, limit = 1000): Promise<KTeamEvent[]> {
    if (id !== undefined) id = this.resolveRef(id);
    // Negative `after` = tail semantics: the last |after| events. Long sessions
    // accumulate thousands of events; the UI's live view only needs the recent
    // window, not a full-history replay on every WebSocket connect.
    if (!Number.isSafeInteger(after) || after < -10_000) throw new Error('after must be a safe integer >= -10000');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error('limit must be between 1 and 10000');
    // Both branches are INDEX-BOUNDED: the old implementation loaded every
    // event of every session into memory, mapped it, and sorted it before
    // slicing â one fleet-wide connect wedged the daemon for minutes and grew
    // its heap into the gigabytes (2026-07-23 wedge/listener-flap incident).
    if (id !== undefined) {
      // Per-session replay: `after` is that session's own sequence â exact,
      // gapless, and the cursor every per-session consumer already sends back.
      if (after < 0) return this.store.tailSession(id, -after).map(event => this.fromStored(event));
      return this.store.replay(id, { afterSequence: after, limit }).map(event => this.fromStored(event));
    }
    // Fleet-wide: no total order to page through any more, so the id-less feed
    // is "the recent tail, then live" â which is all `kteam stream` and the
    // socket's initial backfill ever wanted from it.
    return this.store.tailFleet(Math.min(after < 0 ? -after : GLOBAL_BACKLOG_MAX, limit)).map(e => this.fromStored(e));
  }

  subscribe(listener: (event: KTeamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async addAttachment(id: string, filename: string, mime: string, bytes: Uint8Array): Promise<AttachmentView> {
    id = this.resolveRef(id);
    return await this.serialized(id, async () => {
      await this.get(id);
      const stored = await this.attachments.upload(id, bytes, { filename, mime: mime || undefined });
      const attachment = this.attachmentView(stored);
      await this.emit(id, 'attachment.created', attachment, 'client');
      return attachment;
    });
  }

  async getAttachment(id: string, attachmentId: string): Promise<{ attachment: AttachmentView; bytes: Uint8Array }> {
    id = this.resolveRef(id);
    await this.get(id);
    const stored = await this.attachments.get(id, attachmentId);
    return {
      attachment: this.attachmentView(stored),
      bytes: new Uint8Array(await Bun.file(stored.path).arrayBuffer()),
    };
  }

  async fsList(id: string, relativePath?: string) {
    const cwd = (await this.get(id)).config.cwd;
    return await listDirectory(cwd, relativePath);
  }

  async fsFile(id: string, relativePath: string, rev?: 'head') {
    const cwd = (await this.get(id)).config.cwd;
    return await readFileView(cwd, relativePath, { rev });
  }

  async fsChanges(id: string) {
    const cwd = (await this.get(id)).config.cwd;
    return await readChanges(cwd);
  }

  async fsDiff(id: string, relativePath: string) {
    const cwd = (await this.get(id)).config.cwd;
    return await readDiff(cwd, relativePath);
  }

  private async recover(signal?: AbortSignal): Promise<void> {
    const aborted = (): boolean => this.closed || signal?.aborted === true;
    const sessions = await this.list();
    if (aborted()) return;
    const tmuxSessions = await this.tmux.listSessions();
    if (aborted()) return;
    for (const session of sessions) {
      if (aborted()) return;
      // A client may have started/resumed this session while bootstrap was
      // walking the imported index. Its fresh monitor owns reconciliation.
      if (this.monitors.has(session.config.id)) continue;
      try {
        // Reconcile every send ledger before the terminal fast-path. Historical
        // sessions (including Evan) may have locally accepted rows whose proof
        // lives only in an already-finished transcript.
        await this.serialized(session.config.id, async () => {
          await this.ensureSendLedgerReconciledUnlocked(session);
        });
      } catch (error) {
        if (aborted()) return;
        // Send-ledger repair must never prevent pane adoption. Surface the
        // reconciliation fault, then continue with ordinary recovery.
        const message =
          `send reconciliation of ${session.config.id} failed during recovery: ` +
          (error instanceof Error ? error.message : String(error));
        this.bootstrapErrors.push(message);
        console.error(`kteamd: ${message}`);
        await this.emit(session.config.id, 'daemon.send_reconciliation_failed', { message }, 'daemon').catch(
          () => undefined,
        );
      }
      // A phase deadline cannot cancel the awaited filesystem/tmux primitive,
      // but it does revoke this BOOT-TIME walk. Never let a late-unwedged
      // operation resume against a stale session snapshot.
      if (aborted()) return;
      try {
        // Terminal panes are exceptional restart wreckage. Inventory tmux ONCE
        // and probe only names that actually exist instead of forking one
        // `has-session` per historical session. Never use the snapshot to skip
        // an ACTIVE session: a launch can race boot after the inventory, and its
        // fresh state probe is the pane-safe guard against a false failure.
        if (terminalStatuses.includes(session.state.status) && !tmuxSessions.has(session.config.tmuxSession)) continue;
        await this.recoverSession(session, signal);
      } catch (error) {
        if (aborted()) return;
        // One bad session must never abort the chain: the 06:23 boot died
        // mid-recover and left every LATER session unmonitored with the
        // warden timer unarmed. Isolate, record, continue.
        const message = `recovery of ${session.config.id} failed: ${error instanceof Error ? error.message : String(error)}`;
        this.bootstrapErrors.push(message);
        console.error(`kteamd: ${message}`);
        await this.emit(session.config.id, 'daemon.recovery_failed', { message }, 'daemon').catch(() => undefined);
      }
    }
  }

  private async recoverSession(session: SessionView, signal?: AbortSignal): Promise<void> {
    {
      const aborted = (): boolean => this.closed || signal?.aborted === true;
      // Race guard: the API listens BEFORE bootstrap finishes, so a client
      // can start()/resume() a session while recover() walks the list. Such
      // a session already has a live monitor â adoption bookkeeping here
      // would fight the fresh launch (double monitors, spurious snapshots).
      if (aborted() || this.monitors.has(session.config.id)) return;
      const paneState = await this.tmux.state(session.config.tmuxSession);
      if (aborted() || this.monitors.has(session.config.id)) return;
      await this.serialized(session.config.id, async () => {
        const current = await this.get(session.config.id);
        await this.sweepSendFatesUnlocked(session.config.id, current, {
          promptReady: paneState.promptReady,
          frozen:
            !paneState.alive ||
            paneState.dead ||
            current.state.status === 'rate_limited' ||
            current.state.status === 'retrying',
        });
      }).catch(error => {
        if (aborted()) return;
        return this.emit(
          session.config.id,
          'daemon.send_reconciliation_failed',
          { message: error instanceof Error ? error.message : String(error) },
          'daemon',
        ).catch(() => undefined);
      });
      if (aborted() || this.monitors.has(session.config.id)) return;
      session = await this.get(session.config.id).catch(() => session);
      if (aborted() || this.monitors.has(session.config.id)) return;
      if (session.state.status === 'kill_failed') {
        if (paneState.alive) {
          await this.tmux.snapshot(session.config, true);
          if (aborted() || this.monitors.has(session.config.id)) return;
          try {
            await this.stopTmuxWithEvidence(session.config, 'retry kill after daemon restart');
          } catch {
            if (!paneState.dead) await this.startMonitor(session.config.id);
            return;
          }
        }
        await this.transition(
          session.config.id,
          {
            status: 'failed',
            health: 'crashed',
            reason: 'previous kill failure is no longer live',
            finishedAt: now(),
            promptReady: false,
          },
          'session.failed',
        );
        return;
      }
      if (terminalStatuses.includes(session.state.status)) {
        if (paneState.alive) {
          await this.tmux.snapshot(session.config, true);
          if (aborted() || this.monitors.has(session.config.id)) return;
          await this.stopTmuxWithEvidence(session.config, 'terminal session survived daemon restart');
        }
        return;
      }
      if (paneState.alive && !paneState.dead) {
        // A1: with KillMode=process the tmux server (and this pane) survives a
        // daemon restart â RE-ADOPT it: keep the session's status, restart its
        // monitor, and record the adoption. Never snapshot-and-kill a live,
        // healthy pane here.
        await this.transition(
          session.config.id,
          { status: session.state.status === 'starting' ? 'running' : session.state.status, health: 'healthy' },
          'daemon.readopted',
          { promptReady: paneState.promptReady },
        );
        if (aborted() || this.monitors.has(session.config.id)) return;
        await this.startMonitor(session.config.id);
        if (session.state.status === 'rate_limited' && session.config.retry?.waitForQuotaReset !== false) {
          this.scheduleQuotaWaiter(session.config.id);
        }
        return;
      }
      if (paneState.alive) {
        await this.tmux.snapshot(session.config, true);
        if (aborted() || this.monitors.has(session.config.id)) return;
        await this.stopTmuxWithEvidence(session.config, 'dead pane cleanup during daemon restart');
      }
      if (aborted() || this.monitors.has(session.config.id)) return;
      if (session.state.status === 'rate_limited' && session.config.retry?.waitForQuotaReset !== false) {
        this.scheduleQuotaWaiter(session.config.id);
      } else if (session.state.status === 'retrying' && (session.state.retryAttempt ?? 0) > 0) {
        this.scheduleTransientRetry(session.config.id, session.state.retryAttempt!);
      } else if (this.doneMarkerForTurn(session.config.id, session.state.turn ?? session.config.turn)) {
        // The teammate signalled done for THIS turn but the pane died before
        // the status flipped (or the daemon restart interleaved). The work
        // FINISHED â marking it failed here would invite the warden to resume
        // a completed session and make it redo the turn. A marker from an
        // older turn deliberately falls through to `failed`.
        await this.transition(
          session.config.id,
          {
            status: 'completed',
            health: 'idle',
            reason: 'done marker written (reconciled after daemon restart)',
            finishedAt: now(),
            promptReady: false,
          },
          'session.completed',
        );
      } else {
        await this.transition(
          session.config.id,
          {
            status: 'failed',
            health: 'crashed',
            reason: 'daemon restarted but the interactive tmux session no longer exists; use resume',
            finishedAt: now(),
            promptReady: false,
          },
          'daemon.recovery_failed',
        );
      }
    }
  }

  private async startMonitor(id: string): Promise<void> {
    await this.stopMonitor(id);
    const view = await this.get(id);
    const handle: MonitorHandle = { abort: new AbortController() };
    this.monitors.set(id, handle);
    // Arm the tick loop BEFORE the transcript watcher. Starting a watcher is
    // filesystem work over the SHARED harness home, and its first reconcile
    // could fail to settle at all while the fleet churned that tree (see the
    // watch-scope fix in claude-transcript.ts): every session started during
    // that stretch ran with NO monitor tick â no pane snapshots, no
    // heartbeat.json, no liveness.yaml, no stall reflex, no turn ceiling â
    // while `monitors.has(id)` made the self-check call it healthy
    // (2026-07-24: confirmed on every session created after the 23:49 restart).
    // The loop's own first act is reading state, so it needs nothing from the
    // watcher; a codex session arms its transcript from inside the loop.
    handle.loop = this.monitorLoop(id, handle.abort.signal);
    void handle.loop.catch(() => undefined);
    // The transcript watcher attaches in the BACKGROUND. Its first reconcile
    // walks the shared harness home AND delivers every record already in the
    // transcript â on a session that starts fast that is hundreds of events,
    // and awaiting it here held the launch open long after the teammate was
    // working. The tick loop above is what "monitored" means; the watcher
    // catches up on its own and reports its own failures.
    handle.attaching = this.startTranscriptWatcher(id, view, handle).catch(error => {
      void this.emit(id, 'transcript.error', { message: String(error) }, 'watcher').catch(() => undefined);
    });
  }

  /** Attach the harness transcript tail to a monitor handle. Separate from
   *  startMonitor so the tick loop can be armed first â see the comment there. */
  private async startTranscriptWatcher(id: string, view: SessionView, handle: MonitorHandle): Promise<void> {
    if (view.config.harness === 'claude' && view.config.harnessHome) {
      const watcher = await startClaudeTranscriptWatcher({
        transcriptRoot: path.join(view.config.harnessHome, 'projects'),
        sessionId: view.config.harnessSessionId,
        initialOffset: view.state.transcriptOffset ?? 0,
        reconcileIntervalMs: this.options.transcriptReconcileSeconds * 1000,
        onDiscovered: async file => {
          await this.store.updateConfig<SessionConfig>(id, current => ({
            ...current,
            transcriptFile: file,
            updatedAt: now(),
          }));
          await this.emit(id, 'transcript.discovered', { file }, 'watcher');
        },
        onEvents: async (events, cursor) => await this.handleClaudeEvents(id, events, cursor),
        onObservedInput: async inputs => await this.handleObservedInputs(id, inputs),
        onCheckpoint: async cursor => {
          await this.store.updateState<SessionState>(id, current => ({
            ...current,
            transcriptOffset: Math.max(current.transcriptOffset ?? 0, cursor.endOffset),
            lastTranscriptAt: now(),
          }));
        },
        onError: error => {
          void this.emit(id, 'transcript.error', { message: error.message }, 'watcher').catch(() => undefined);
        },
      });
      // The tick loop is armed first and may already have exited (dead pane,
      // done marker) by the time this resolves â its cleanup stops
      // handle.transcript, which was still undefined then. Without this the
      // watcher tails on forever, writing state for a session nobody watches.
      if (handle.abort.signal.aborted || this.monitors.get(id) !== handle) await watcher.stop();
      else handle.transcript = watcher;
    } else if (view.config.harness === 'codex') {
      await this.ensureCodexTranscript(id, handle);
    }
  }

  private async ensureCodexTranscript(id: string, handle: MonitorHandle): Promise<void> {
    if (handle.transcript || handle.abort.signal.aborted) return;
    if (handle.transcriptStarting) return await handle.transcriptStarting;
    const arming = this.armCodexTranscript(id, handle).finally(() => {
      handle.transcriptStarting = undefined;
    });
    handle.transcriptStarting = arming;
    return await arming;
  }

  private async armCodexTranscript(id: string, handle: MonitorHandle): Promise<void> {
    let view = await this.get(id);
    let transcriptFile = view.config.transcriptFile;
    let harnessSessionId = view.config.harnessSessionId;
    if (!transcriptFile || !harnessSessionId) {
      const found = await discoverCodexSession(view.config, await this.claimedCodexSessionIds(id));
      if (!found) return;
      transcriptFile = found.file;
      harnessSessionId = found.id;
      const config = await this.store.updateConfig<SessionConfig>(id, current => ({
        ...current,
        harnessSessionId,
        transcriptFile,
        harnessSessionBaseline: undefined,
        updatedAt: now(),
      }));
      view = { ...view, config };
    } else if (view.config.harnessSessionBaseline !== undefined) {
      // The baseline exists only to distinguish the rollout created by this
      // launch. Once both identifiers are known it is dead O(fleet) baggage in
      // config.json, SQLite metadata, and every session response.
      const config = await this.store.updateConfig<SessionConfig>(id, current => ({
        ...current,
        harnessSessionBaseline: undefined,
        updatedAt: now(),
      }));
      view = { ...view, config };
    }
    const watcher = await startCodexTranscriptWatcher({
      transcriptFile,
      sessionId: harnessSessionId,
      initialOffset: view.state.transcriptOffset ?? 0,
      reconcileIntervalMs: this.options.transcriptReconcileSeconds * 1000,
      onDiscovered: async file => {
        await this.store.updateConfig<SessionConfig>(id, current => ({
          ...current,
          harnessSessionId,
          transcriptFile: file,
          harnessSessionBaseline: undefined,
          updatedAt: now(),
        }));
        await this.emit(id, 'transcript.discovered', { file, harnessSessionId }, 'watcher');
      },
      onEvents: async (events, cursor) => await this.handleCodexEvents(id, events, cursor),
      onObservedInput: async inputs => await this.handleObservedInputs(id, inputs),
      onCheckpoint: async cursor => {
        await this.store.updateState<SessionState>(id, current => ({
          ...current,
          transcriptOffset: Math.max(current.transcriptOffset ?? 0, cursor.endOffset),
          lastTranscriptAt: now(),
        }));
      },
      onError: error => {
        void this.emit(id, 'transcript.error', { message: error.message }, 'watcher').catch(() => undefined);
      },
    });
    if (handle.abort.signal.aborted) await watcher.stop();
    else handle.transcript = watcher;
  }

  private async stopMonitor(id: string, drain = false): Promise<void> {
    const monitor = this.monitors.get(id);
    if (!monitor) return;
    this.monitors.delete(id);
    monitor.abort.abort();
    // Await the in-flight attach first: a watcher still arming has not set
    // `monitor.transcript` yet, so stopping only what is visible here would
    // leak it. (startTranscriptWatcher also re-checks the abort signal and
    // stops a watcher whose monitor died â this is the other half.)
    const stopAll = (monitor.attaching ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (drain) await monitor.transcript?.flush().catch(() => undefined);
        await monitor.transcript?.stop();
      });
    if (drain) {
      const pending: Promise<unknown>[] = [stopAll];
      if (monitor.loop) pending.push(monitor.loop);
      await Promise.allSettled(pending);
    } else void stopAll.catch(() => undefined);
  }

  /** Reconcile one pane observation with structured-question state while holding
   * the same per-session queue used by answer(), interrupt(), and transcript
   * reducers. The pane was captured before the lock, so its associated status
   * and tool id are revalidated inside the lock before any counter, state, or
   * lifecycle mutation. */
  private async reconcileStructuredQuestionFrame(
    id: string,
    pane: PaneState,
    paneHash: string,
    observedStatus: SessionState['status'],
    observedToolUseId: string | undefined,
    monitor: PendingQuestionMonitorState,
  ): Promise<SessionView> {
    return await this.serialized(id, async () => {
      let view = await this.get(id);
      if (view.state.status !== observedStatus || view.state.pendingQuestion?.toolUseId !== observedToolUseId) {
        // An answer, abandon, or transcript reduction won the queue while this
        // pane observation waited. It owns the lifecycle decision; a stale
        // monitor frame must neither clear state nor emit a competing event.
        resetPendingQuestionMonitor(monitor);
        return view;
      }

      const pendingQuestion = view.state.pendingQuestion;
      if (view.state.status === 'awaiting_question' && !pendingQuestion) {
        const active = paneShowsActiveWork(pane.visiblePane);
        await this.transition(
          id,
          {
            status: active ? 'running' : 'awaiting_user',
            health: active ? 'healthy' : 'idle',
            promptReady: pane.promptReady,
            reason: undefined,
          },
          'interaction.question_failed',
          {
            action: 'self-heal',
            reason: 'awaiting_question had no pendingQuestion state',
            paneHash,
            promptReady: pane.promptReady,
            activeWork: active,
          },
        );
        return await this.get(id);
      }

      if (!pendingQuestion) {
        const orphanMenu =
          view.config.mode === 'interactive' &&
          !protectedStatuses.includes(view.state.status) &&
          paneShowsStructuredQuestionMenu(pane.visiblePane);
        const alreadyReported = monitor.orphanMenuReported === true;
        resetPendingQuestionMonitor(monitor);
        monitor.orphanMenuReported = orphanMenu;
        if (orphanMenu && !alreadyReported) {
          await this.tmux.snapshot(view.config).catch(() => undefined);
          await this.emit(
            id,
            'interaction.question_failed',
            {
              action: 'self-heal',
              reason: 'structured question menu is visible but daemon state has no pendingQuestion; no keys were sent',
              status: view.state.status,
              promptReady: pane.promptReady,
              paneHash,
              snapshot: 'last-snapshot.txt',
              excerpt: pane.visiblePane.split('\n').slice(-40).join('\n').slice(-6_000),
            },
            'watcher',
          );
        }
        return view;
      }

      const visible = anyQuestionVisible(pane.visiblePane, pendingQuestion.questions);
      const active = paneShowsActiveWork(pane.visiblePane);
      if (
        view.config.mode === 'interactive' &&
        view.state.status !== 'awaiting_question' &&
        !protectedStatuses.includes(view.state.status)
      ) {
        await this.transition(
          id,
          { status: 'awaiting_question', health: 'waiting' },
          'interaction.question_reconciled',
          {
            toolUseId: pendingQuestion.toolUseId,
            reason: 'pendingQuestion existed while status diverged',
          },
        );
        view = await this.get(id);
      }

      const advanceEvidence = pendingQuestionPaneAdvance(view.state, pane);
      if (advanceEvidence) {
        if (monitor.advancedTool === pendingQuestion.toolUseId) monitor.advancedFrames++;
        else {
          monitor.advancedTool = pendingQuestion.toolUseId;
          monitor.advancedFrames = 1;
        }
        if (monitor.advancedFrames >= 2) {
          await this.tmux.snapshot(view.config).catch(() => undefined);
          await this.transition(
            id,
            {
              status: active ? 'running' : 'awaiting_user',
              health: active ? 'healthy' : 'idle',
              promptReady: pane.promptReady,
              pendingQuestion: undefined,
              openTools: (view.state.openTools ?? []).filter(tool => tool !== pendingQuestion.toolUseId),
              reason: undefined,
            },
            // This edge clears the question without a daemon-confirmed answer.
            // “Reconciled” alone would leave no ANSWER/CANCELLED/SUPERSEDED
            // lifecycle record for the clear, so both pane-advance shapes are
            // durably classified as cancellation.
            'interaction.question_cancelled',
            {
              toolUseId: pendingQuestion.toolUseId,
              reason:
                advanceEvidence === 'prompt-ready'
                  ? 'pane returned to an idle prompt without a daemon-confirmed answer'
                  : 'pane started a turn without a daemon-confirmed answer',
              confirmedBy: advanceEvidence,
              paneHash,
              snapshot: 'last-snapshot.txt',
              pendingQuestion: null,
            },
          );
          resetPendingQuestionMonitor(monitor);
        }
        return await this.get(id);
      }

      monitor.advancedTool = undefined;
      monitor.advancedFrames = 0;
      if (!visible) {
        if (monitor.missingTool === pendingQuestion.toolUseId) monitor.missingFrames++;
        else {
          monitor.missingTool = pendingQuestion.toolUseId;
          monitor.missingFrames = 1;
        }
        if (!pendingQuestion.missingSince) {
          await this.store.updateState<SessionState>(id, current => ({
            ...current,
            pendingQuestion:
              current.pendingQuestion?.toolUseId === pendingQuestion.toolUseId
                ? { ...current.pendingQuestion, missingSince: now() }
                : current.pendingQuestion,
          }));
        }
        if (monitor.missingFrames >= 3 && monitor.missingReported !== pendingQuestion.toolUseId) {
          monitor.missingReported = pendingQuestion.toolUseId;
          await this.tmux.snapshot(view.config).catch(() => undefined);
          await this.emit(
            id,
            'interaction.question_failed',
            {
              action: 'self-heal',
              toolUseId: pendingQuestion.toolUseId,
              reason: 'question missing from a non-idle pane; kept pending for safe retry or abandon',
              promptReady: pane.promptReady,
              activeWork: active,
              paneHash,
              snapshot: 'last-snapshot.txt',
              excerpt: pane.visiblePane.split('\n').slice(-40).join('\n').slice(-6_000),
            },
            'watcher',
          );
        }
      } else {
        monitor.missingTool = undefined;
        monitor.missingFrames = 0;
        monitor.missingReported = undefined;
        if (pendingQuestion.missingSince) {
          await this.store.updateState<SessionState>(id, current => ({
            ...current,
            pendingQuestion:
              current.pendingQuestion?.toolUseId === pendingQuestion.toolUseId
                ? { ...current.pendingQuestion, missingSince: undefined, lastSeenAt: now() }
                : current.pendingQuestion,
          }));
        }
      }
      return await this.get(id);
    });
  }

  private async monitorLoop(id: string, signal: AbortSignal): Promise<void> {
    let paneHash = '';
    let diffHash = '';
    let promptStable = 0;
    let lastQuotaCheck = 0;
    let reinjectedTurn = -1;
    // F6: the last turn whose pane visibly showed active work. A turn that
    // demonstrably RAN but produced no correlated transcript (e.g. GLM canary,
    // 2026-07-19) is a transcript-correlation gap, not a lost prompt â it must
    // not be reinjected or failed as turn-never-started.
    let activeWorkTurn = -1;
    const questionMonitor: PendingQuestionMonitorState = {
      advancedFrames: 0,
      missingFrames: 0,
    };
    // A stale marker remains on disk as forensic evidence until a new turn
    // writes its own marker. Journal each distinct stale/current-turn pair
    // once per monitor rather than flooding the event log every tick.
    let staleDoneMarkerFingerprint: string | undefined;
    // A6: recognized work vocabulary with advancing counters across polls is
    // full liveness â a long silent thinking block writes no transcript bytes
    // for many minutes while the spinner clock keeps climbing, and the stall
    // reflex must not flag it (2026-07-22: two healthy Fable sessions were
    // stall-killed mid-thinking this way).
    let liveness: StallLivenessState = { lastWorkAdvanceAt: 0 };
    try {
      while (!signal.aborted && !this.closed) {
        let sleepSeconds = this.options.healthIntervalSeconds;
        try {
          let view = await this.get(id);
          sleepSeconds = view.config.intervalSeconds;
          const monitor = this.monitors.get(id);
          if (view.config.harness === 'codex' && monitor && !monitor.transcript) {
            await this.ensureCodexTranscript(id, monitor);
            view = await this.get(id);
          }
          const currentTurn = view.state.turn ?? view.config.turn;
          const doneMarkerExists = existsSync(markerFile(this.paths, id, 'done'));
          const currentDoneMarker = this.doneMarkerForTurn(id, currentTurn);
          if (doneMarkerExists && !currentDoneMarker) {
            const markerTurn = this.doneMarkerTurn(id);
            const fingerprint = `${markerTurn ?? 'invalid'}:${currentTurn ?? 'unknown'}`;
            if (staleDoneMarkerFingerprint !== fingerprint) {
              staleDoneMarkerFingerprint = fingerprint;
              await this.emit(
                id,
                'session.stale_done_marker',
                {
                  markerTurn: markerTurn ?? null,
                  currentTurn: currentTurn ?? null,
                  reason: 'done marker does not certify the current turn and was ignored',
                },
                'watcher',
              );
            }
          } else {
            staleDoneMarkerFingerprint = undefined;
          }
          if (currentDoneMarker) {
            // A done marker written while the pane still shows an ACTIVE turn
            // (spinner/token counter) means the teammate declared victory
            // early â deliverables may not exist yet. Defer completion until
            // the pane actually idles; killing mid-turn produced sessions
            // marked completed whose files were never written.
            const donePane = await this.tmux.state(view.config.tmuxSession);
            if (donePane.alive && !donePane.dead && paneShowsActiveWork(donePane.visiblePane)) {
              if (!this.doneDeferred.has(id)) {
                this.doneDeferred.add(id);
                await this.emit(
                  id,
                  'session.done_deferred',
                  { reason: 'done marker present but the pane still shows an active turn; waiting for it to idle' },
                  'watcher',
                );
              }
            } else {
              this.doneDeferred.delete(id);
              await this.tmux.snapshot(view.config, true);
              await this.stopTmuxWithEvidence(view.config, 'done marker');
              await this.transition(
                id,
                {
                  status: 'completed',
                  health: 'idle',
                  reason: 'done marker written',
                  finishedAt: now(),
                  promptReady: false,
                },
                'session.completed',
              );
              return;
            }
          }
          if (existsSync(markerFile(this.paths, id, 'needs-help')) && !waitingStatuses.includes(view.state.status)) {
            const marker = (await readFile(markerFile(this.paths, id, 'needs-help'), 'utf8')
              .then(JSON.parse)
              .catch(() => ({}))) as { message?: string };
            if (view.config.mode === 'interactive') {
              await this.transition(
                id,
                { status: 'waiting', health: 'waiting', reason: marker.message ?? 'teammate requested help' },
                'interaction.help',
              );
              view = await this.get(id);
            } else {
              await this.tmux.snapshot(view.config, true);
              await this.stopTmuxWithEvidence(view.config, 'automode help protocol violation');
              await this.transition(
                id,
                {
                  status: 'failed',
                  health: 'crashed',
                  reason: 'automode teammate requested user input',
                  finishedAt: now(),
                  promptReady: false,
                },
                'session.protocol_violation',
              );
              return;
            }
          }
          const pane = await this.tmux.state(view.config.tmuxSession);
          if (!pane.alive || pane.dead) {
            await this.serialized(id, async () => {
              const current = await this.get(id);
              await this.sweepSendFatesUnlocked(id, current, { frozen: true });
            });
            // A pane that has NEVER been launched is not a crashed pane. Until
            // the bootstrap runs `tmux new-session`, `tmux.state` reports the
            // same "not alive" as a dead harness â and a monitor started into
            // that window (self-check repair, launch-grace expiry) used to
            // record `session.crashed` on a teammate that then came up and did
            // the whole task, leaving it `failed` forever because a terminal
            // status suppresses every later patch.
            if (view.state.launchedAt === undefined && preLaunchStatuses.includes(view.state.status)) {
              if (this.launchingRecently(id)) {
                // Still queued behind the bootstrap chain: PENDING, not dead.
                // Stay attached and re-check on the next tick.
                await interruptibleSleep(sleepSeconds * 1000, signal);
                continue;
              }
              // No launch is in flight any more and the pane was never
              // created (daemon restart mid-queue, or a bootstrap that died
              // without reaching tmux). That IS a real failure â say what it
              // actually was rather than blaming a harness that never ran.
              await this.transition(
                id,
                {
                  status: 'failed',
                  health: 'crashed',
                  reason: 'the launch never created its tmux session; use resume to relaunch',
                  finishedAt: now(),
                  promptReady: false,
                },
                'session.launch_failed',
              );
              return;
            }
            const exit = await this.confirmHarnessExit(view.config, pane, 'monitor dead-pane probe', 'watcher');
            if (!exit.confirmed) {
              // Do not spin if tmux keeps serving one bad has-session result;
              // this `continue` skips the loop's ordinary tail sleep.
              await interruptibleSleep(sleepSeconds * 1000, signal);
              continue;
            }
            const terminalPane = exit.pane;
            if (!terminalStatuses.includes(view.state.status)) {
              await this.tmux.snapshot(view.config, true);
              const exitEvidence = {
                at: now(),
                alive: terminalPane.alive,
                dead: terminalPane.dead,
                exitCode: terminalPane.exitCode,
                confirmedByReprobe: true,
              };
              await Promise.all([
                atomicJson(path.join(view.directory, 'checks', 'exit.json'), exitEvidence),
                atomicJson(markerFile(this.paths, id, 'process-exit'), exitEvidence),
              ]);
              const quota = await this.fetchQuota(view.config, signal);
              // Classify from the final visible screen, not the full scrollback:
              // task text and tool output routinely mention rate limits, quotas,
              // HTTP codes, and network errors, and must not steer classification.
              const lower = (
                terminalPane.visiblePane.trim()
                  ? terminalPane.visiblePane
                  : terminalPane.pane.split('\n').slice(-60).join('\n')
              ).toLowerCase();
              if (
                quota?.atLimit === true ||
                (quota?.atLimit !== false && /rate.?limit|usage limit|quota|out of tokens/.test(lower))
              ) {
                await this.transition(
                  id,
                  {
                    status: 'rate_limited',
                    health: 'rate_limited',
                    reason: 'account quota exhausted',
                    exitCode: terminalPane.exitCode,
                    quota,
                    ...(quota ? usageStateFromQuota(quota) : {}),
                  },
                  'quota.exhausted',
                  quota ?? {},
                );
                if (view.config.retry?.waitForQuotaReset !== false) this.scheduleQuotaWaiter(id);
              } else if (
                /network|connection|timed out|temporar|overloaded|\b50[234]\b/.test(lower) &&
                (view.state.retryAttempt ?? 0) < (view.config.retry?.transientAttempts ?? 0)
              ) {
                const attempt = (view.state.retryAttempt ?? 0) + 1;
                await this.transition(
                  id,
                  {
                    status: 'retrying',
                    health: 'crashed',
                    reason: 'transient harness failure',
                    exitCode: terminalPane.exitCode,
                    retryAttempt: attempt,
                  },
                  'retry.scheduled',
                  { attempt, delaySeconds: 2 ** attempt },
                );
                this.scheduleTransientRetry(id, attempt);
              } else {
                const reason = /no conversation found|could not resume/i.test(lower)
                  ? 'persisted conversation could not be resumed'
                  : /invalid api key|unauthorized|sign in|log in/i.test(lower)
                    ? 'harness authentication failed'
                    : this.harnessExitReason(view.config, terminalPane);
                await this.transition(
                  id,
                  {
                    status: 'failed',
                    health: 'crashed',
                    reason,
                    exitCode: terminalPane.exitCode,
                    finishedAt: now(),
                    promptReady: false,
                  },
                  'session.crashed',
                );
              }
            }
            return;
          }

          await this.serialized(id, async () => {
            const current = await this.get(id);
            await this.sweepSendFatesUnlocked(id, current, {
              promptReady: pane.promptReady,
              frozen: current.state.status === 'rate_limited' || current.state.status === 'retrying',
            });
          });
          view = await this.get(id);

          const nextPaneHash = Bun.hash(pane.pane).toString(16);
          if (nextPaneHash !== paneHash) {
            paneHash = nextPaneHash;
            await this.tmux.snapshot(view.config);
            await writeFile(turnLog(this.paths, id, view.config.turn), pane.pane, { mode: 0o600 });
            // Pane parse is only the FALLBACK: once a transcript usage record
            // has set contextPercent, the harness's own accounting wins (the
            // statusline can change shape any time â the 1M-suffix breakage).
            const paneContext = contextPercentUsed(pane.visiblePane);
            const contextPercent = view.state.contextPercent === undefined ? paneContext : undefined;
            const effectiveContext = view.state.contextPercent ?? paneContext;
            const contextTurnedHigh =
              effectiveContext !== undefined && effectiveContext >= 85 && (view.state.contextPercent ?? 0) < 85;
            // The harness's own spinner line ("â» Lollygaggingâ¦ (34s Â· 2.1k
            // tokens)") â the chat UI's received-and-thinking indicator.
            const activity = paneActivityLine(pane.visiblePane);
            await this.transition(
              id,
              {
                lastActivityAt: now(),
                lastPaneAt: now(),
                promptReady: pane.promptReady,
                activity,
                ...(contextPercent !== undefined ? { contextPercent } : {}),
                health: waitingStatuses.includes(view.state.status)
                  ? 'waiting'
                  : view.state.status === 'thinking'
                    ? 'thinking'
                    : 'healthy',
              },
              'terminal.frame',
              {
                hash: paneHash,
                promptReady: pane.promptReady,
                ...(activity !== undefined ? { activity } : {}),
                ...(contextPercent !== undefined ? { contextPercent } : {}),
                ...usageEventData(view.state),
              },
            );
            // Sessions past ~85% context wedge silently (prompts queue, never
            // process). Surface it once so the lead can rotate the teammate.
            if (contextTurnedHigh) await this.emit(id, 'context.high', { contextPercent }, 'watcher');
            view = await this.get(id);
          }

          // Structured-question self-heal. Transcript state can say
          // awaiting_question after the TUI has cancelled/accepted/repainted the
          // menu. A ready prompt, or active work with no pending question visible,
          // is strong pane evidence that the menu is no longer blocking. Require
          // two monitor frames, then reconcile instead of preserving a permanent
          // dead end. Ambiguous non-idle/missing panes are NOT cleared: snapshot +
          // journal them and leave the UI's retry/abandon controls available.
          const observedStatus = view.state.status;
          const observedToolUseId = view.state.pendingQuestion?.toolUseId;
          view = await this.reconcileStructuredQuestionFrame(
            id,
            pane,
            paneHash,
            observedStatus,
            observedToolUseId,
            questionMonitor,
          );

          const diff = await this.gitFingerprint(view.config.cwd);
          const nextDiffHash = Bun.hash(diff).toString(16);
          if (nextDiffHash !== diffHash) {
            diffHash = nextDiffHash;
            await atomicJson(path.join(view.directory, 'checks', 'diff.json'), {
              at: now(),
              hash: diffHash,
              summary: diff,
            });
            await this.transition(
              id,
              {
                lastActivityAt: now(),
                lastDiffAt: now(),
                health: waitingStatuses.includes(view.state.status)
                  ? 'waiting'
                  : view.state.status === 'thinking'
                    ? 'thinking'
                    : 'healthy',
              },
              'workspace.changed',
              { hash: diffHash },
            );
            view = await this.get(id);
          }

          if (pane.promptReady) promptStable++;
          else promptStable = 0;
          const transcriptBusy =
            view.state.status === 'thinking' ||
            view.state.status === 'tool_running' ||
            (view.state.openTools?.length ?? 0) > 0 ||
            view.state.turnCompleted !== true;
          // The pane prompt is the ground truth for "the turn ended". Codex
          // rollouts frequently omit task_complete and a dropped end-of-turn
          // record must not wedge idle detection forever, so a long-stable
          // ready prompt overrides stale transcript-derived busy state.
          const paneIdleOverride = promptStable >= Math.max(4, Math.ceil(20 / view.config.intervalSeconds));
          const turnBusy = view.state.pendingQuestion !== undefined || (transcriptBusy && !paneIdleOverride);
          if (
            promptStable >= 2 &&
            !turnBusy &&
            view.state.waiting === undefined &&
            !waitingStatuses.includes(view.state.status) &&
            !protectedStatuses.includes(view.state.status) &&
            view.state.status !== 'interrupted'
          ) {
            if (view.config.mode === 'interactive') {
              await this.transition(id, { status: 'awaiting_user', health: 'idle', promptReady: true }, 'turn.waiting');
            } else if (
              view.config.mode === 'auto' &&
              !this.autoContinued.has(id) &&
              !this.doneMarkerForTurn(id, view.state.turn ?? view.config.turn)
            ) {
              this.autoContinued.add(id);
              await this.emit(
                id,
                'session.protocol_warning',
                { reason: 'automode returned to input without a done marker' },
                'watcher',
              );
              await this.tmux.send(
                view.config,
                'Automode: do not wait for user input. Make the best reasonable decision, continue the task, and write the required done marker when complete.',
              );
              await this.transition(
                id,
                {
                  status: 'running',
                  health: 'healthy',
                  promptReady: false,
                  turnCompleted: false,
                },
                'turn.auto_continued',
              );
              promptStable = 0;
            }
          }

          if (Date.now() - lastQuotaCheck > 60_000) {
            lastQuotaCheck = Date.now();
            await this.updateQuota(id, view.config, signal);
            view = await this.get(id);
          }

          // A6 liveness ledger: record explicit per-life-sign timestamps.
          // Counter advance (recognized work vocabulary whose elapsed/token
          // counters strictly increased across polls) proves silent thinking
          // and powers sus_thinking; a live child process under the pane is
          // both a reflex life-sign and, via subprocessSince episode tracking,
          // the sus_subprocess input.
          const previousLiveness = liveness;
          liveness = foldStallLiveness(liveness, pane.visiblePane, Date.now());
          const counterAdvanced = liveness.lastWorkAdvanceAt > previousLiveness.lastWorkAdvanceAt;
          // Token exemption input: the token count SPECIFICALLY climbed
          // (claude renders one; codex has no token field so this never fires
          // there and its long thinks stay sus-eligible).
          const tokensAdvanced =
            liveness.lastTokenAdvanceAt !== undefined &&
            liveness.lastTokenAdvanceAt !== previousLiveness.lastTokenAdvanceAt;
          // Subprocess life-sign, two sources: any live child under the pane,
          // regardless of transcript tool correlation (background commands can
          // outlive/miss tool.use records), or the Codex background-terminal
          // footer. Long-lived-but-weird helpers are warden/sus territory; a
          // positively live process must never feed the reflex kill verdict.
          const subprocessAlive =
            (await this.tmux.subprocessAlive(view.config.tmuxSession)) || backgroundTerminalCount(pane.visiblePane) > 0;
          if (counterAdvanced || tokensAdvanced || subprocessAlive || view.state.subprocessSince !== undefined) {
            await this.store.updateState<SessionState>(id, current => ({
              ...current,
              ...(counterAdvanced ? { lastCounterAdvanceAt: now() } : {}),
              ...(tokensAdvanced ? { lastTokenAdvanceAt: now() } : {}),
              ...(subprocessAlive
                ? { lastSubprocessAt: now(), subprocessSince: current.subprocessSince ?? now() }
                : { subprocessSince: undefined }),
            }));
            view = await this.get(id);
          }
          // Declared wait (`kteam signal waiting`): keep it visible, expire it
          // on time, and wake the teammate rather than letting the reflex
          // layer treat a deliberate park as a corpse.
          if (view.state.waiting !== undefined) {
            await this.serviceWaiting(view);
            view = await this.get(id);
          }
          // `state.waiting` â not the status â is the authority for a declared
          // wait: transcript records recompute status every few seconds
          // (running/thinking/tool_running), so gating only on the status let
          // the very tool_result of `kteam signal waiting` erase the park and
          // hand the session straight back to the nudge, the stall kill, and
          // the automode auto-continue.
          // Suspends the ceiling, the lost-prompt reaper, the nudge and the kill
          // below — for a declared wait, a waiting status, OR any interactive
          // session (immortal by mode: see reflexSuspended).
          const waiting = reflexSuspended(view.config, view.state);
          const startedAt = view.state.startedAt ? Date.parse(view.state.startedAt) : Date.parse(view.config.createdAt);
          // Time spent in declared waits is credited back: a babysitter parked
          // for three hours has not been RUNNING for three hours, and the
          // ceiling must not reap it for waiting as instructed.
          const ceilingMs = turnCeilingMs(view.config, view.state);
          if (!waiting && Date.now() - startedAt >= ceilingMs) {
            await this.tmux.snapshot(view.config, true);
            await atomicJson(path.join(view.directory, 'kill.json'), {
              at: now(),
              reason: 'timeout',
              lastSnapshot: 'last-snapshot.txt',
            });
            await this.stopTmuxWithEvidence(view.config, 'timeout');
            await this.transition(
              id,
              {
                status: 'stopped',
                health: 'idle',
                reason:
                  `exceeded timeout of ${view.config.timeoutSeconds}s` +
                  ((view.state.waitingCreditSeconds ?? 0) > 0
                    ? ` (+${view.state.waitingCreditSeconds}s credited for declared waits)`
                    : ''),
                finishedAt: now(),
                promptReady: false,
              },
              'session.timeout',
            );
            return;
          }
          // A healthy turn writes its first transcript record within seconds of
          // the prompt landing. Zero transcript bytes minutes into a turn means
          // the prompt was lost or the TUI booted logged-out â both previously
          // burned the full stall timer while `status` said "running". Nudge
          // once, then fail fast with a distinct reason.
          const turnStartedAt = view.state.startedAt
            ? Date.parse(view.state.startedAt)
            : Date.parse(view.config.createdAt);
          const transcriptProgress =
            view.state.lastTranscriptAt !== undefined && Date.parse(view.state.lastTranscriptAt) >= turnStartedAt;
          // promptStable gates this: a busy pane (e.g. a working Codex whose
          // rollout file hasn't been correlated yet) must never be treated as
          // a lost prompt; only an idle input box with zero transcript is.
          if (paneShowsActiveWork(pane.visiblePane)) activeWorkTurn = view.config.turn;
          if (
            !waiting &&
            !transcriptProgress &&
            promptStable >= 2 &&
            activeWorkTurn !== view.config.turn &&
            !protectedStatuses.includes(view.state.status)
          ) {
            const sinceTurnStart = Date.now() - turnStartedAt;
            if (sinceTurnStart >= 120_000 && reinjectedTurn !== view.config.turn) {
              reinjectedTurn = view.config.turn;
              await this.emit(
                id,
                'turn.reinjected',
                { reason: 'no transcript activity 120s after turn start; re-sending the prompt' },
                'watcher',
              );
              await this.tmux
                .send(view.config, this.promptInstruction(id, view.config.turn))
                .catch(error =>
                  this.emit(id, 'turn.reinject_failed', { message: String(error) }, 'watcher').catch(() => undefined),
                );
            } else if (sinceTurnStart >= 360_000) {
              const pane = await this.tmux.snapshot(view.config, true);
              const loginWalled = /not logged in|please run \/login|invalid api key|unauthorized/i.test(pane);
              await this.stopTmuxWithEvidence(view.config, 'no transcript activity after turn start');
              await this.transition(
                id,
                {
                  status: 'failed',
                  health: 'crashed',
                  reason: loginWalled
                    ? 'harness authentication failed: TUI is login-walled and produced no transcript activity'
                    : 'turn never started: no transcript activity within 360s of the prompt (lost prompt or dead harness)',
                  finishedAt: now(),
                  promptReady: false,
                },
                'session.turn_never_started',
              );
              return;
            }
          }
          // A6 reflex rule (locked): life-signs at this layer are transcript
          // growth, ANY pane change, and subprocess activity â it only catches
          // totally-frozen agents. Zero life-signs for nudgeAfterSeconds â one
          // nudge per episode (interrupt + continue message); still zero at
          // killAfterSeconds â kill. Alive-but-weird cases (long silent think,
          // long background task) are the warden sweep's sus list, not ours.
          const ledger: LivenessLedger = {
            lastTranscriptAt: view.state.lastTranscriptAt,
            lastCounterAdvanceAt: view.state.lastCounterAdvanceAt,
            lastTokenAdvanceAt: view.state.lastTokenAdvanceAt,
            lastSubprocessAt: view.state.lastSubprocessAt,
            lastPaneChangeAt: view.state.lastPaneAt,
            subprocessSince: view.state.subprocessSince,
          };
          const nudgeAfter = view.config.nudgeAfterSeconds ?? 180;
          const killAfter = Math.max(view.config.killAfterSeconds ?? 300, nudgeAfter + 30);
          const assessment = reflexAssess({
            ledger,
            nowMs: Date.now(),
            anchorMs: turnStartedAt,
            tickSeconds: view.config.intervalSeconds,
            nudgeAfterSeconds: nudgeAfter,
            killAfterSeconds: killAfter,
            nudgedAtMs: view.state.nudgedAt ? Date.parse(view.state.nudgedAt) : undefined,
          });
          const secondsSince = Object.fromEntries(
            Object.entries(assessment.secondsSince).map(([key, value]) => [
              key,
              Number.isFinite(value) ? Math.floor(value) : null,
            ]),
          );
          if (waiting || assessment.verdict === 'alive') {
            // Only a returning STRONG life-sign ends the nudge episode. The
            // nudge's own injected text repaints the pane, so pane flicker
            // must never re-arm the nudge (that made a frozen agent loop
            // through endless nudges and never reach the kill).
            if (view.state.nudgedAt !== undefined && assessment.strongSeconds < nudgeAfter) {
              await this.store.updateState<SessionState>(id, current => ({ ...current, nudgedAt: undefined }));
              view = await this.get(id);
            }
          } else if (assessment.verdict === 'nudge') {
            await this.store.updateState<SessionState>(id, current => ({ ...current, nudgedAt: now() }));
            await this.emit(
              id,
              'session.nudged',
              { reason: `zero life-signs for ${Math.floor(assessment.zeroSeconds)}s`, ledger, secondsSince },
              'watcher',
            );
            // Escape stops a wedged turn without quitting either TUI; the
            // queued message lands once (if) the prompt becomes editable.
            await run(['tmux', 'send-keys', '-t', view.config.tmuxSession, 'Escape']);
            await this.tmux
              .send(
                view.config,
                'Liveness check: no output, pane change, or subprocess activity has been observed for several minutes. If you are alive, continue the task now.',
              )
              .catch(() => undefined);
            view = await this.get(id);
          } else {
            // kill: the nudge revived nothing.
            await this.tmux.snapshot(view.config, true);
            await atomicJson(path.join(view.directory, 'kill.json'), {
              at: now(),
              reason: 'stalled',
              evidence: { ledger, secondsSince, nudgedAt: view.state.nudgedAt },
              lastSnapshot: 'last-snapshot.txt',
            });
            await this.stopTmuxWithEvidence(view.config, 'stalled');
            await this.transition(
              id,
              {
                status: 'stalled',
                health: 'stalled',
                reason: `zero life-signs for ${Math.floor(assessment.strongSeconds)}s (nudged, no revival)`,
                finishedAt: now(),
                promptReady: false,
              },
              'session.stalled',
            );
            await this.emit(
              id,
              'session.killed',
              { reason: 'stalled', tmuxSession: view.config.tmuxSession },
              'daemon',
            );
            return;
          }
          await atomicJson(path.join(view.directory, 'checks', 'heartbeat.json'), {
            at: now(),
            tmuxAlive: true,
            promptReady: pane.promptReady,
            paneHash,
            diffHash,
            transcriptOffset: view.state.transcriptOffset ?? 0,
            liveness: { secondsSince, zeroSeconds: Math.floor(assessment.zeroSeconds), health: view.state.health },
          });
          // The always-fresh human-readable ledger view. Sus reflects the
          // sweep classifiers evaluated with the daemon's thresholds.
          const susNow =
            !waiting &&
            susFindings(ledger, Date.now(), {
              susThinkingSeconds: Math.max(60, this.wardenConfig.susThinkingSeconds),
              susSubprocessSeconds: Math.max(60, this.wardenConfig.susSubprocessSeconds),
              tickSeconds: view.config.intervalSeconds,
              anchorMs: turnStartedAt,
            }).length > 0;
          await writeTextAtomic(
            path.join(view.directory, 'liveness.yaml'),
            renderLivenessYaml({
              updatedAt: now(),
              secondsSince: assessment.secondsSince,
              triggers: {
                nudge: !waiting && assessment.verdict === 'nudge',
                kill: !waiting && assessment.verdict === 'kill',
                sus: susNow,
              },
            }),
          );
        } catch (error) {
          await this.emit(
            id,
            'monitor.error',
            { message: error instanceof Error ? error.message : String(error) },
            'watcher',
          ).catch(() => undefined);
        }
        // The wake hook lets send() interrupt a long tick when it needs the
        // monitor to re-evaluate promptly (e.g. right after a native-queue
        // type-in, so status/ledger reflect the new composer state).
        await interruptibleSleep(sleepSeconds * 1000, signal, wake => {
          const monitor = this.monitors.get(id);
          if (monitor && monitor.abort.signal === signal) monitor.wake = wake;
        });
      }
    } finally {
      const monitor = this.monitors.get(id);
      if (monitor?.abort.signal === signal) {
        await monitor.transcript?.flush().catch(() => undefined);
        await monitor.transcript?.stop();
        if (this.monitors.get(id) === monitor) this.monitors.delete(id);
      }
    }
  }

  /** Reconcile dedicated harness-owned input proof under the session lock.
   * Matching is exact, windowed, FIFO, one-to-one, and replay-safe in the
   * ledger. A match updates send fate and removes native mechanics only; it
   * deliberately does not advance a turn, write a turn file, or touch markers. */
  private async handleObservedInputs(id: string, inputs: readonly ObservedHumanInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.serialized(id, async () => {
      const view = await this.get(id);
      await this.ensureSendLedgerReconciledUnlocked(view);
      await this.reconcileObservedInputsUnlocked(id, await this.get(id), inputs);
    });
  }

  private scheduleTerminalSendFinalization(id: string, acceptedThrough: string): void {
    const finalizers = (this.terminalSendFinalizers ??= new Map<string, Promise<void>>());
    const cutoffs = (this.terminalSendFinalizerCutoffs ??= new Map<string, string>());
    const pending = cutoffs.get(id);
    // Transition timestamps are canonical ISO strings. Retain only the newest
    // terminal epoch while EOF work is in flight; an older completion must not
    // overwrite a later stop/failure cutoff.
    if (pending === undefined || acceptedThrough > pending) cutoffs.set(id, acceptedThrough);
    if (finalizers.has(id)) return;
    let finalizing: Promise<void>;
    const drain = async (): Promise<void> => {
      while (true) {
        const cutoff = cutoffs.get(id);
        if (cutoff === undefined) return;
        cutoffs.delete(id);
        await this.finalizeTerminalSends(id, cutoff);
      }
    };
    finalizing = drain().finally(() => {
      if (finalizers.get(id) !== finalizing) return;
      finalizers.delete(id);
      // A scheduler call can land after drain() observes an empty map but
      // before this finally callback removes the in-flight promise. Re-arm in
      // that narrow promise-settlement window instead of dropping its cutoff.
      const next = cutoffs.get(id);
      if (next !== undefined) this.scheduleTerminalSendFinalization(id, next);
    });
    finalizers.set(id, finalizing);
    void finalizing.catch(() => undefined);
  }

  /** Drain the existing stateful adapter to EOF before classifying the
   * terminal remainder. If no live watcher exists (boot migration), the
   * reconciliation helper replays the transcript once from byte zero. */
  private async finalizeTerminalSends(id: string, acceptedThrough: string): Promise<void> {
    const monitor = this.monitors.get(id);
    await monitor?.attaching?.catch(() => undefined);
    const transcript = monitor?.transcript;
    let flushSucceeded = false;
    if (transcript) {
      try {
        await transcript.flush();
        flushSucceeded = true;
      } catch {
        // A failed drain is not proof that the watcher reached EOF. The
        // historical adapter replay below is the authoritative fallback.
      }
    }

    const watcherStillAttached = (): boolean =>
      monitor !== undefined &&
      transcript !== undefined &&
      transcript.snapshot().running === true &&
      monitor.abort.signal.aborted === false &&
      this.monitors.get(id) === monitor &&
      monitor.transcript === transcript;

    // stopMonitor removes the handle and aborts it before its asynchronous
    // watcher.stop() settles. A captured transcript reference can therefore
    // still exist while flush() has become a no-op. Do not infer EOF from that
    // stale reference: replay through the same harness-owned adapter from byte
    // zero whenever the watcher was absent, failed its drain, or detached while
    // the drain was in flight.
    let replay: ObservedHumanInput[] | undefined;
    if (!flushSucceeded || !watcherStillAttached()) {
      try {
        replay = await this.historicalObservedInputs(await this.get(id));
      } catch {
        // This EOF pass was not authoritative. Leave every row visible as
        // ACCEPTED and clear the daemon-lifetime latch so a later list/send,
        // finalizer, or boot reconciliation performs a real retry. Requeueing
        // the same cutoff inside drain() would be a tight persistent-I/O loop.
        this.reconciledSendLedgers.delete(id);
        return;
      }
    }

    const settle = async (observed: readonly ObservedHumanInput[], requireCapturedWatcher: boolean): Promise<boolean> =>
      await this.serialized(id, async () => {
        // The watcher can detach after flush() returns but before this lock is
        // acquired. Defer classification and replay outside the lock rather
        // than trusting the now-stale live pass or holding the lock over I/O.
        if (requireCapturedWatcher && !watcherStillAttached()) return false;
        const view = await this.get(id);
        await this.ensureSendLedgerReconciledUnlocked(view);
        await this.reconcileObservedInputsUnlocked(id, await this.get(id), observed);
        const current = await this.get(id);
        // A stale terminal finalizer may finish its EOF pass after an explicit
        // revive has already launched or typed a new turn. Preserve that live
        // send; a later real terminal transition queues its own newer cutoff.
        if (!terminalStatuses.includes(current.state.status)) return true;
        // stopMonitor is intentionally not serialized on this queue. It can
        // detach the watcher while ensure/reconcile/get above are awaiting,
        // after the entry check has already passed. Revalidate immediately
        // before terminal fate assignment; a detach returns to the historical
        // EOF fallback instead of classifying against the earlier bounded
        // flush.
        if (requireCapturedWatcher && !watcherStillAttached()) return false;
        await this.transitionUnaccountedUnlocked(id, current, 'session_ended', acceptedThrough);
        return true;
      });

    if (await settle(replay ?? [], replay === undefined)) return;
    // The live watcher detached in the post-flush/pre-lock window. Complete one
    // fresh authoritative EOF pass, still outside the session lock, then apply
    // the normal one-to-one reconciliation and live-status guard.
    try {
      replay = await this.historicalObservedInputs(await this.get(id));
    } catch {
      this.reconciledSendLedgers.delete(id);
      return;
    }
    await settle(replay, false);
  }

  private async handleClaudeEvents(
    id: string,
    events: readonly ClaudeNormalizedEvent[],
    cursor: TranscriptCursor,
  ): Promise<void> {
    const offset = cursor.endOffset;
    await this.serialized(id, async () => {
      let view = await this.get(id);
      let autoQuestion = false;
      const questionLifecycleEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      // The harness already wrote these records. kteam INDEXES them where they
      // live (one SQLite row each, no bytes) and broadcasts them live; it does
      // not copy them into events.jsonl or chat.jsonl. Only the records the
      // harness does NOT produce — kteam's own control/lifecycle events — are
      // journalled, which is what makes the journal small and authoritative.
      this.indexChatRecords(id, view, events, cursor);
      for (const event of events) {
        if (HARNESS_DERIVED_EVENT_TYPES.has(event.type)) this.broadcastChat(id, event, view.config.turn, 'claude');
        else
          await this.emit(
            id,
            event.type,
            event.type === 'interaction.question' && view.config.mode === 'interactive'
              ? {
                  ...event.data,
                  status: 'awaiting_question',
                  health: 'waiting',
                  pendingQuestion: {
                    toolUseId: event.data.toolUseId,
                    questions: event.data.questions,
                    askedAt: event.timestamp ?? now(),
                  },
                }
              : event.data,
            'claude',
            view.config.turn,
          );
        if (event.type === 'interaction.question') {
          await appendFile(
            path.join(view.directory, 'channel', 'outbox.jsonl'),
            `${JSON.stringify({
              at: now(),
              type: 'structured_question',
              toolUseId: event.data.toolUseId,
              questions: event.data.questions,
            })}\n`,
          );
          if (view.config.mode === 'auto') {
            autoQuestion = true;
            await this.emit(
              id,
              'session.protocol_warning',
              { reason: 'AskUserQuestion attempted in automode', toolUseId: event.data.toolUseId },
              'watcher',
            );
          }
        }
      }
      // Remote Control URL, from the harness's OWN bridge_status record. Made
      // STICKY in state so the UI can offer the link for the session's whole
      // life — the pane prints the sentence once and it scrolls off within a
      // screen or two. The EVENT itself was already journalled by the loop above
      // (session.remote_control is not harness-derived), so this only persists
      // the fact.
      const rcEvent = [...events].reverse().find(event => event.type === 'session.remote_control') as
        | { data: { url: string } }
        | undefined;
      if (rcEvent && view.state.remoteControlUrl !== rcEvent.data.url) {
        await this.store
          .updateState<SessionState>(id, current => ({ ...current, remoteControlUrl: rcEvent.data.url }))
          .catch(() => undefined);
        view = await this.get(id);
      }
      // Transcript-based context accounting (turn-020): the harness's own
      // usage records are ground truth; the pane statusline is only a
      // fallback. Last usage event in the batch wins.
      const usageEvent = [...events].reverse().find(event => event.type === 'context.usage') as
        | { data: { contextTokens: number; model?: string; contextWindow?: number } }
        | undefined;
      const observedModelAt = usageEvent?.data.model ? now() : undefined;
      const contextWindowFromUsage = usageEvent
        ? contextWindowForSession({
            // `[1m]` survives ONLY on config.model — the transcript model id is
            // stripped, so it must drive the 1M determination. The served model
            // (observed > wrapper-resolved) still drives the overrides table.
            configModel: view.config.model,
            servedModel:
              usageEvent.data.model ??
              resolveDisplayModel(view.config.binary, view.config.model, view.state.observedModel).model,
            reportedWindow: usageEvent.data.contextWindow,
            overrides: this.options.contextWindows,
          })
        : undefined;
      const contextPercentFromUsage = usageEvent
        ? Math.round((usageEvent.data.contextTokens / contextWindowFromUsage!) * 100)
        : undefined;
      if (
        contextPercentFromUsage !== undefined &&
        contextPercentFromUsage >= 85 &&
        (view.state.contextPercent ?? 0) < 85
      ) {
        await this.emit(id, 'context.high', { contextPercent: contextPercentFromUsage }, 'watcher').catch(
          () => undefined,
        );
      }
      await this.store.updateState<SessionState>(id, current => {
        const madeProgress = events.some(event => event.type !== 'chat.user' && event.type !== 'interaction.question');
        const openTools = new Set(current.openTools ?? []);
        let status: SessionStatus = current.status;
        let pendingQuestion = current.pendingQuestion;
        let turnCompleted = current.turnCompleted ?? false;
        let lastToolStartedAt = current.lastToolStartedAt;
        for (const event of events) {
          if (event.type === 'tool.use') {
            openTools.add(event.data.toolUseId);
            status = 'tool_running';
            turnCompleted = false;
            lastToolStartedAt = now();
          } else if (event.type === 'tool.result') {
            openTools.delete(event.data.toolUseId);
            if (pendingQuestion?.toolUseId === event.data.toolUseId) {
              questionLifecycleEvents.push({
                type: 'interaction.question_cancelled',
                data: {
                  toolUseId: pendingQuestion.toolUseId,
                  reason: 'harness produced a tool result without a daemon-confirmed answer',
                  isError: event.data.isError,
                },
              });
              pendingQuestion = undefined;
            }
            status = openTools.size ? 'tool_running' : 'running';
          } else if (event.type === 'interaction.question') {
            if (pendingQuestion && pendingQuestion.toolUseId !== event.data.toolUseId) {
              questionLifecycleEvents.push({
                type: 'interaction.question_superseded',
                data: {
                  toolUseId: pendingQuestion.toolUseId,
                  successorToolUseId: event.data.toolUseId,
                  reason: 'a newer structured question replaced it',
                },
              });
            }
            pendingQuestion = {
              toolUseId: event.data.toolUseId,
              questions: event.data.questions,
              askedAt: event.timestamp ?? now(),
              lastSeenAt: now(),
            };
            status = view.config.mode === 'interactive' ? 'awaiting_question' : 'running';
            turnCompleted = false;
          } else if (event.type === 'chat.assistant.thinking') {
            status = 'thinking';
            turnCompleted = false;
          } else if (event.type === 'turn.completed') {
            // A completed turn cannot leave tools open; unmatched tool ids
            // (interrupted tools, harness id mismatches) must not wedge the
            // idle detector permanently in tool_running.
            openTools.clear();
            if (pendingQuestion) {
              questionLifecycleEvents.push({
                type: 'interaction.question_cancelled',
                data: {
                  toolUseId: pendingQuestion.toolUseId,
                  reason: 'turn completed before a daemon-confirmed answer',
                },
              });
              pendingQuestion = undefined;
            }
            turnCompleted = true;
            status = 'running';
          } else if (event.type.startsWith('chat.')) {
            if (event.type === 'chat.user') turnCompleted = false;
            status = 'running';
          }
        }
        if (pendingQuestion && view.config.mode === 'interactive') status = 'awaiting_question';
        const terminal = protectedStatuses.includes(current.status);
        return {
          ...current,
          status: terminal ? current.status : status,
          health: terminal
            ? current.health
            : status === 'awaiting_question'
              ? 'waiting'
              : status === 'thinking'
                ? 'thinking'
                : 'healthy',
          openTools: [...openTools],
          pendingQuestion,
          turnCompleted,
          lastToolStartedAt,
          transcriptOffset: Math.max(current.transcriptOffset ?? 0, offset),
          ...(contextPercentFromUsage !== undefined ? { contextPercent: contextPercentFromUsage } : {}),
          ...(usageEvent
            ? { contextTokens: usageEvent.data.contextTokens, contextWindow: contextWindowFromUsage }
            : {}),
          // Ground truth for the MODEL column: the wrapper alias (`opus` on a
          // GLM account) is only what was requested â this is what answered.
          ...(usageEvent?.data.model ? { observedModel: usageEvent.data.model } : {}),
          ...(observedModelAt ? { observedModelAt } : {}),
          retryAttempt: madeProgress ? 0 : current.retryAttempt,
          lastTranscriptAt: now(),
          lastActivityAt: now(),
          promptReady: terminal ? current.promptReady : false,
        };
      });
      for (const lifecycle of questionLifecycleEvents)
        await this.emit(id, lifecycle.type, lifecycle.data, 'watcher', view.config.turn);
      if (autoQuestion) {
        await this.tmux.snapshot(view.config, true);
        await this.stopManagedSession(view.config, 'automode structured-question protocol violation');
        await this.transition(
          id,
          {
            status: 'failed',
            health: 'crashed',
            reason: 'automode teammate attempted a structured user question',
            finishedAt: now(),
            promptReady: false,
          },
          'session.protocol_violation',
        );
      }
    });
  }

  private async handleCodexEvents(
    id: string,
    events: readonly CodexNormalizedEvent[],
    cursor: TranscriptCursor,
  ): Promise<void> {
    const offset = cursor.endOffset;
    await this.serialized(id, async () => {
      let view = await this.get(id);
      let autoQuestion = false;
      const questionLifecycleEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      // The harness already wrote these records. kteam INDEXES them where they
      // live (one SQLite row each, no bytes) and broadcasts them live; it does
      // not copy them into events.jsonl or chat.jsonl. Only the records the
      // harness does NOT produce — kteam's own control/lifecycle events — are
      // journalled, which is what makes the journal small and authoritative.
      this.indexChatRecords(id, view, events, cursor);
      for (const event of events) {
        // Runtime settings are persisted as session state below and journalled
        // only when they CHANGE. Codex repeats the same harness record at every
        // turn, so copying every occurrence would add history without signal.
        if (event.type === 'runtime.settings') continue;
        if (HARNESS_DERIVED_EVENT_TYPES.has(event.type)) this.broadcastChat(id, event, view.config.turn, 'codex');
        else
          await this.emit(
            id,
            event.type,
            event.type === 'interaction.question' && view.config.mode === 'interactive'
              ? {
                  ...event.data,
                  status: 'awaiting_question',
                  health: 'waiting',
                  pendingQuestion: {
                    toolUseId: event.data.toolUseId,
                    questions: event.data.questions,
                    askedAt: event.timestamp ?? now(),
                  },
                }
              : event.data,
            'codex',
            view.config.turn,
          );
        if (event.type === 'interaction.question') {
          await appendFile(
            path.join(view.directory, 'channel', 'outbox.jsonl'),
            `${JSON.stringify({
              at: now(),
              type: 'structured_question',
              toolUseId: event.data.toolUseId,
              questions: event.data.questions,
            })}\n`,
          );
          if (view.config.mode === 'auto') {
            autoQuestion = true;
            await this.emit(
              id,
              'session.protocol_warning',
              { reason: 'request_user_input attempted in automode', toolUseId: event.data.toolUseId },
              'watcher',
            );
          }
        }
      }
      // Transcript-based context accounting (turn-020): the harness's own
      // usage records are ground truth; the pane statusline is only a
      // fallback. Last usage event in the batch wins.
      const usageEvent = [...events].reverse().find(event => event.type === 'context.usage') as
        | { data: { contextTokens: number; model?: string; contextWindow?: number } }
        | undefined;
      const runtimeSettings = [...events].reverse().find(event => event.type === 'runtime.settings') as
        | { data: { model?: string; reasoningEffort?: string } }
        | undefined;
      const observedModelAt = usageEvent?.data.model || runtimeSettings?.data.model ? now() : undefined;
      const contextWindowFromUsage = usageEvent
        ? contextWindowForSession({
            // `[1m]` survives ONLY on config.model — the transcript model id is
            // stripped, so it must drive the 1M determination. The served model
            // (observed > wrapper-resolved) still drives the overrides table.
            configModel: view.config.model,
            servedModel:
              usageEvent.data.model ??
              resolveDisplayModel(view.config.binary, view.config.model, view.state.observedModel).model,
            reportedWindow: usageEvent.data.contextWindow,
            overrides: this.options.contextWindows,
          })
        : undefined;
      const contextPercentFromUsage = usageEvent
        ? Math.round((usageEvent.data.contextTokens / contextWindowFromUsage!) * 100)
        : undefined;
      if (
        contextPercentFromUsage !== undefined &&
        contextPercentFromUsage >= 85 &&
        (view.state.contextPercent ?? 0) < 85
      ) {
        await this.emit(id, 'context.high', { contextPercent: contextPercentFromUsage }, 'watcher').catch(
          () => undefined,
        );
      }
      await this.store.updateState<SessionState>(id, current => {
        const madeProgress = events.some(
          event =>
            event.type !== 'chat.user' && event.type !== 'interaction.question' && event.type !== 'runtime.settings',
        );
        const openTools = new Set(current.openTools ?? []);
        let status: SessionStatus = current.status;
        let pendingQuestion = current.pendingQuestion;
        let turnCompleted = current.turnCompleted ?? false;
        let lastToolStartedAt = current.lastToolStartedAt;
        for (const event of events) {
          if (event.type === 'turn.started') {
            turnCompleted = false;
            status = 'running';
          } else if (event.type === 'turn.completed' || event.type === 'turn.aborted') {
            // See the Claude handler: a finished turn must clear open tools so
            // unmatched tool ids cannot wedge the idle detector.
            openTools.clear();
            if (pendingQuestion) {
              questionLifecycleEvents.push({
                type: 'interaction.question_cancelled',
                data: {
                  toolUseId: pendingQuestion.toolUseId,
                  reason:
                    event.type === 'turn.aborted'
                      ? 'turn aborted before a daemon-confirmed answer'
                      : 'turn completed before a daemon-confirmed answer',
                },
              });
              pendingQuestion = undefined;
            }
            turnCompleted = true;
            status = 'running';
          } else if (event.type === 'tool.use') {
            openTools.add(event.data.toolUseId);
            status = 'tool_running';
            turnCompleted = false;
            lastToolStartedAt = now();
          } else if (event.type === 'tool.result') {
            openTools.delete(event.data.toolUseId);
            if (pendingQuestion?.toolUseId === event.data.toolUseId) {
              questionLifecycleEvents.push({
                type: 'interaction.question_cancelled',
                data: {
                  toolUseId: pendingQuestion.toolUseId,
                  reason: 'harness produced a tool result without a daemon-confirmed answer',
                  isError: event.data.isError,
                },
              });
              pendingQuestion = undefined;
            }
            status = openTools.size ? 'tool_running' : 'running';
          } else if (event.type === 'chat.assistant.reasoning') {
            status = 'thinking';
            turnCompleted = false;
          } else if (event.type === 'interaction.question') {
            if (pendingQuestion && pendingQuestion.toolUseId !== event.data.toolUseId) {
              questionLifecycleEvents.push({
                type: 'interaction.question_superseded',
                data: {
                  toolUseId: pendingQuestion.toolUseId,
                  successorToolUseId: event.data.toolUseId,
                  reason: 'a newer structured question replaced it',
                },
              });
            }
            pendingQuestion = {
              toolUseId: event.data.toolUseId,
              questions: event.data.questions,
              askedAt: event.timestamp ?? now(),
              lastSeenAt: now(),
            };
            status = view.config.mode === 'interactive' ? 'awaiting_question' : 'running';
            turnCompleted = false;
          } else if (event.type.startsWith('chat.')) {
            if (event.type === 'chat.user') turnCompleted = false;
            status = 'running';
          }
        }
        if (pendingQuestion && view.config.mode === 'interactive') status = 'awaiting_question';
        const terminal = protectedStatuses.includes(current.status);
        return {
          ...current,
          status: terminal ? current.status : status,
          health: terminal
            ? current.health
            : status === 'awaiting_question'
              ? 'waiting'
              : status === 'thinking'
                ? 'thinking'
                : 'healthy',
          openTools: [...openTools],
          pendingQuestion,
          turnCompleted,
          lastToolStartedAt,
          transcriptOffset: Math.max(current.transcriptOffset ?? 0, offset),
          ...(contextPercentFromUsage !== undefined ? { contextPercent: contextPercentFromUsage } : {}),
          ...(usageEvent
            ? { contextTokens: usageEvent.data.contextTokens, contextWindow: contextWindowFromUsage }
            : {}),
          // Ground truth for the MODEL column: the wrapper alias (`opus` on a
          // GLM account) is only what was requested â this is what answered.
          ...(usageEvent?.data.model ? { observedModel: usageEvent.data.model } : {}),
          ...(runtimeSettings?.data.model ? { observedModel: runtimeSettings.data.model } : {}),
          ...(observedModelAt ? { observedModelAt } : {}),
          ...(runtimeSettings?.data.reasoningEffort
            ? { observedReasoningEffort: runtimeSettings.data.reasoningEffort }
            : {}),
          retryAttempt: madeProgress ? 0 : current.retryAttempt,
          lastTranscriptAt: now(),
          lastActivityAt: now(),
          promptReady: terminal ? current.promptReady : false,
        };
      });
      for (const lifecycle of questionLifecycleEvents)
        await this.emit(id, lifecycle.type, lifecycle.data, 'watcher', view.config.turn);
      if (
        runtimeSettings &&
        ((runtimeSettings.data.model !== undefined && runtimeSettings.data.model !== view.state.observedModel) ||
          (runtimeSettings.data.reasoningEffort !== undefined &&
            runtimeSettings.data.reasoningEffort !== view.state.observedReasoningEffort))
      ) {
        await this.emit(id, 'session.runtime_settings', runtimeSettings.data, 'watcher', view.config.turn);
      }
      if (autoQuestion) {
        await this.tmux.snapshot(view.config, true);
        await this.stopManagedSession(view.config, 'automode structured-question protocol violation');
        await this.transition(
          id,
          {
            status: 'failed',
            health: 'crashed',
            reason: 'automode teammate attempted a structured user question',
            finishedAt: now(),
            promptReady: false,
          },
          'session.protocol_violation',
        );
      }
    });
  }

  private async transition(
    id: string,
    patch: Partial<SessionState>,
    eventType: string,
    eventData: Record<string, unknown> = {},
    options: { force?: boolean; source?: KTeamEvent['source'] } = {},
  ): Promise<void> {
    let suppressed = false;
    const state = await this.store.updateState<SessionState>(id, current => {
      const preserveTerminal =
        !options.force && terminalStatuses.includes(current.status) && patch.status !== 'starting';
      const preserveKillFailure =
        !options.force &&
        current.status === 'kill_failed' &&
        !(patch.status !== undefined && terminalStatuses.includes(patch.status));
      const next = { ...current, ...patch };
      // A session that ENDS is not waiting for anything any more. Nothing else
      // clears a declared wait on the terminal paths (stop, timeout, stall
      // kill, pane death), and once terminal every later patch is suppressed â
      // so a park left set here would be permanent: `kteam wait` would never
      // return and the warden would report an overdue wait on a dead session
      // forever.
      if (patch.status !== undefined && protectedStatuses.includes(patch.status)) next.waiting = undefined;
      if (!preserveTerminal && !preserveKillFailure) return next;
      suppressed = true;
      return current;
    });
    if (suppressed) return;
    // The STATE is already durable (updateState above, atomic + fsynced) and it
    // is what every reader consults. The journal ENTRY for the change is
    // history, so the caller does not wait for it: `transition` awaiting
    // `emit` meant "the agent is running" waited on a disk write. Subscribers
    // still get the event the moment its append lands (per-session, so no
    // other session can delay it), and close() drains what is in flight.
    this.emitDeferred(
      id,
      eventType,
      { status: state.status, health: state.health, ...eventData },
      options.source ?? 'daemon',
      state.turn,
    );
    // Fate is finalized only after the harness adapter has drained to EOF.
    // Scheduling outside the current session-lock holder avoids flush callback
    // deadlock; the finalizer then serializes proof and terminal classification.
    if (patch.status !== undefined && terminalStatuses.includes(patch.status)) {
      this.scheduleTerminalSendFinalization(id, patch.finishedAt ?? state.finishedAt ?? now());
    }
    // A finishing warden FREES a fleet-wide concurrency slot. If sus targets are
    // queued behind the cap, drain them now instead of waiting a full sweep
    // interval. runSweep re-detects suspicion, so a target that recovered while
    // waiting is dropped rather than investigated. Cheap + serialized on
    // wardenSweepChain; gated on a non-empty queue so non-warden terminals and
    // the idle fleet cost nothing.
    if (patch.status !== undefined && terminalStatuses.includes(patch.status)) {
      const finished = this.store.getSession(id);
      if (
        (finished?.config as SessionConfig | undefined)?.label === WARDEN_LABEL &&
        (this.wardenState.assignedQueue?.length ?? 0) > 0
      ) {
        setTimeout(() => void this.runSweep(false).catch(() => undefined), 0);
      }
    }
  }

  /** Index one harness record's chat events as pointers into the harness's OWN
   *  transcript. No bytes are written — this replaces what used to be an
   *  events.jsonl append plus a chat.jsonl append per event. */
  private indexChatRecords(
    id: string,
    view: SessionView,
    events: readonly { type: string; timestamp?: string }[],
    cursor: TranscriptCursor,
  ): void {
    const entries = events.flatMap((event, index) =>
      HARNESS_DERIVED_EVENT_TYPES.has(event.type)
        ? [
            {
              time: event.timestamp ?? now(),
              type: event.type,
              turn: view.config.turn,
              sourceFile: cursor.file,
              byteOffset: cursor.startOffset,
              // The record's own line length, excluding its newline.
              byteLength: Math.max(0, cursor.endOffset - cursor.startOffset - 1),
              recordIndex: index,
              fingerprint: chatEventFingerprint(event),
            },
          ]
        : [],
    );
    try {
      this.store.appendChatPointers(id, entries);
    } catch (error) {
      this.chatIndexChecks.delete(id);
      console.error(`kteamd: chat pointer index failed for ${id}: ${error}`);
    }
  }

  /** Deliver a harness-derived chat event to live subscribers WITHOUT
   *  journalling it. `sequence` is 0: it has no position in kteam's journal
   *  (its durable home is the harness transcript, indexed by chat pointer).
   *
   *  `time` is the HARNESS record's own timestamp, not the broadcast instant.
   *  It is the only identity a live chat frame carries (sequence is 0 for all of
   *  them), so consumers dedupe live-vs-history on it — and `now()` made every
   *  live frame a NEW record that history would later re-deliver under its real
   *  timestamp, duplicating the whole tail on reconnect. */
  private broadcastChat(
    id: string,
    event: { type: string; data: unknown; timestamp?: string; recordUuid?: string; blockIndex?: number },
    turn: number,
    source: 'claude' | 'codex',
  ): void {
    const live: KTeamEvent = {
      sequence: 0,
      time: event.timestamp ?? now(),
      sessionId: id,
      turn,
      type: event.type,
      source,
      data: event.data,
      // The harness record's own identity, carried through so a live frame and
      // the SAME record later served by /chat are recognizably one record. With
      // sequence pinned to 0 for this whole class, this is the only exact
      // identity available — without it a reader must guess from content, and a
      // reconnect re-shows the tail.
      ...(event.recordUuid === undefined ? {} : { recordUuid: event.recordUuid }),
      ...(event.blockIndex === undefined ? {} : { blockIndex: event.blockIndex }),
    };
    for (const listener of this.listeners) listener(live);
  }

  /** Emit without making the caller wait for the journal write. Ordering is
   *  preserved (appends are serialized per session), failures are logged
   *  rather than thrown at an unrelated caller, and close() drains it. */
  private emitDeferred(id: string, type: string, payload: unknown, source: KTeamEvent['source'], turn?: number): void {
    const previous = this.pendingEmits.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.emit(id, type, payload, source, turn))
      .catch(error => {
        if (!this.closed) console.error(`kteamd: deferred ${type} for ${id} failed: ${error}`);
      });
    this.pendingEmits.set(id, next);
    void next.finally(() => {
      if (this.pendingEmits.get(id) === next) this.pendingEmits.delete(id);
    });
  }

  /** Wait for this session's deferred journal writes to land. */
  private async flushEmits(id?: string): Promise<void> {
    const pending = id === undefined ? [...this.pendingEmits.values()] : [this.pendingEmits.get(id)];
    await Promise.allSettled(pending.filter(Boolean) as Promise<unknown>[]);
  }

  private async emit(
    id: string,
    type: string,
    payload: unknown,
    source: KTeamEvent['source'],
    turn?: number,
    allowDeleting = false,
  ): Promise<KTeamEvent> {
    if (this.closed) throw new Error('kteam daemon is shutting down');
    if (this.deleting.has(id) && !allowDeleting) throw new Error('session deletion is in progress');
    // Attribute to the request actor (e.g. a warden HTTP action) when one is in
    // scope. Captured synchronously â the append runs on a deferred queue where
    // the AsyncLocalStorage context would no longer be current.
    const effectiveSource = currentActor() ?? source;
    // LIVE-ONLY classes never reach the journal. `terminal.frame` was the
    // single biggest event class on disk (6584 of ~12.7k events in one real
    // session) and it exists purely for liveness/thinking detection — a LIVE
    // concern. The durable half of a frame is the state patch that
    // `transition` already writes, plus snapshots/ and last-snapshot.txt for
    // forensics. Frames stream to subscribers and are kept in a small
    // in-memory ring; they carry sequence 0 because they have no journal
    // position (consumers treat a 0 as "not part of history").
    if (LIVE_ONLY_EVENT_TYPES.has(type)) {
      const event: KTeamEvent = {
        sequence: 0,
        time: now(),
        sessionId: id,
        turn: turn ?? (this.store.getSession(id)?.state as SessionState | undefined)?.turn ?? 0,
        type,
        source: effectiveSource,
        data: payload,
      };
      const ring = this.liveFrames.get(id) ?? [];
      ring.push(event);
      while (ring.length > LIVE_FRAME_RING) ring.shift();
      this.liveFrames.set(id, ring);
      for (const listener of this.listeners) listener(event);
      return event;
    }
    // NO global queue. Sessions are independent: `store.append` already
    // serializes per session (its own append queue), which is all the ordering
    // a journal needs. The old fleet-wide chain existed only to hand out a
    // global sequence number, and it made every event in the fleet wait behind
    // every other event â 2.8 events/sec across the whole daemon, with a
    // launch's `session.running` stuck behind another session's transcript
    // backlog.
    //
    // Turn comes from the CACHED session metadata, not a state.json read: this
    // ran per event, and on the hot path the cache is exactly as fresh (the
    // daemon is the only writer, and every state write updates it).
    const resolvedTurn =
      turn ?? (this.store.getSession(id)?.state as SessionState | undefined)?.turn ?? (await this.turnFromDisk(id));
    const stored = await this.store.append(id, type, {
      source: effectiveSource,
      turn: resolvedTurn,
      payload,
    } as unknown as JsonValue);
    const event = this.fromStored(stored);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** Fallback for a session the metadata cache has never seen. */
  private async turnFromDisk(id: string): Promise<number> {
    return (await this.store.readState<SessionState>(id).catch(() => ({ turn: 0 }) as SessionState)).turn;
  }

  private fromStored(event: SessionEvent): KTeamEvent {
    const envelope = event.data as unknown as StoredEnvelope;
    return {
      // The session's OWN sequence. Journals written while the fleet counter
      // existed carry a `globalSequence` in their envelope; it is ignored â
      // per-session order is the contract every consumer actually uses.
      sequence: event.sequence,
      time: event.time,
      sessionId: event.sessionId,
      turn: envelope.turn ?? 0,
      type: event.type,
      source: envelope.source ?? 'daemon',
      data: envelope.payload,
    };
  }

  private async sendUnlocked(view: SessionView, message: string): Promise<SessionView> {
    const turn = view.config.turn + 1;
    await writeFile(turnPrompt(this.paths, view.config.id, turn), `${message.trim()}\n`, { mode: 0o600 });
    const config = await this.store.updateConfig<SessionConfig>(view.config.id, current => ({
      ...current,
      turn,
      updatedAt: now(),
    }));
    await this.tmux.send(config, this.promptInstruction(config.id, turn));
    // A new turn ends any declared wait: the teammate has been given work,
    // and the ceiling credit belongs to the turn that earned it.
    this.waitingHeartbeats.delete(config.id);
    await this.transition(
      config.id,
      {
        status: 'running',
        turn,
        promptReady: false,
        startedAt: now(),
        lastActivityAt: now(),
        turnCompleted: false,
        nudgedAt: undefined,
        waiting: undefined,
        waitingCreditSeconds: 0,
      },
      'turn.started',
    );
    return await this.get(config.id);
  }

  private async updateQuota(id: string, config: SessionConfig, signal: AbortSignal): Promise<void> {
    try {
      const quota = await this.fetchQuota(config, signal);
      if (!quota || signal.aborted) return;
      const usageState = usageStateFromQuota(quota);
      let newlyExhausted = false;
      let recoveredWithoutRetry = false;
      let readyToResume = false;
      let inactive = false;
      let usageChanged = false;
      const state = await this.store.updateState<SessionState>(id, current => {
        if (protectedStatuses.includes(current.status)) {
          inactive = true;
          return current;
        }
        usageChanged =
          current.usage5hPercent !== usageState.usage5hPercent ||
          current.usageWeeklyPercent !== usageState.usageWeeklyPercent ||
          current.usage5hResetAt !== usageState.usage5hResetAt ||
          current.usageWeeklyResetAt !== usageState.usageWeeklyResetAt ||
          current.usageAtLimit !== usageState.usageAtLimit ||
          current.usageAuthOk !== usageState.usageAuthOk ||
          current.quota?.availability !== quota.availability ||
          current.quota?.unavailable !== quota.unavailable ||
          current.quota?.unavailableReason !== quota.unavailableReason ||
          current.quota?.retryAt !== quota.retryAt;
        const blocked = quota.atLimit === true || quota.unavailable === true;
        const available = quota.atLimit === false && quota.unavailable !== true;
        newlyExhausted = blocked && current.status !== 'rate_limited';
        recoveredWithoutRetry =
          available && current.status === 'rate_limited' && config.retry?.waitForQuotaReset === false;
        readyToResume = available && current.status === 'rate_limited' && config.retry?.waitForQuotaReset !== false;
        return {
          ...current,
          quota,
          ...usageState,
          status: blocked
            ? 'rate_limited'
            : recoveredWithoutRetry
              ? config.mode === 'interactive' && current.promptReady
                ? 'awaiting_user'
                : 'running'
              : current.status,
          health: blocked
            ? 'rate_limited'
            : recoveredWithoutRetry
              ? config.mode === 'interactive' && current.promptReady
                ? 'idle'
                : 'healthy'
              : current.health,
        };
      });
      if (inactive || signal.aborted) return;
      await atomicJson(path.join(sessionDir(this.paths, id), 'checks', 'quota.json'), { at: now(), ...quota });
      if (signal.aborted) return;
      if (usageChanged)
        await this.emit(id, 'quota.updated', { binary: config.binary, ...usageEventData(state) }, 'watcher').catch(
          () => undefined,
        );
      if (newlyExhausted) await this.emit(id, 'quota.exhausted', quota, 'watcher');
      if ((quota.atLimit === true || quota.unavailable === true) && config.retry?.waitForQuotaReset !== false)
        this.scheduleQuotaWaiter(id);
      if (readyToResume) this.scheduleQuotaWaiter(id);
      if (recoveredWithoutRetry) await this.emit(id, 'quota.available', { ...quota, status: state.status }, 'watcher');
    } catch {}
  }

  private async fetchQuota(config: SessionConfig, signal?: AbortSignal): Promise<SessionState['quota'] | undefined> {
    const account = (await this.fetchUsageAccounts(signal)).find(item => item.binary === config.binary);
    if (account) return quotaFromUsage(account);
    // A successful snapshot that omits this wrapper is authoritative unknown:
    // clear any old wrapper's values. Before the first successful snapshot,
    // preserve state rather than treating a feed outage as real data.
    return this.usageFeed.hasSnapshot() ? {} : undefined;
  }

  /** The full per-account usage feed (same endpoint as fetchQuota), used to pick
   *  a failover target. Readers share the last good 300-second snapshot; empty
   *  before the first successful refresh means failover safely no-ops. */
  private async fetchUsageAccounts(signal?: AbortSignal): Promise<AgentUsage[]> {
    return await this.usageFeed.accounts(signal);
  }

  /** When `retry.allowAccountFailover` is on and a rate-limited session's quota
   *  reset is FAR out (>30 min), migrate it to a usable same-kind wrapper instead
   *  of idling until reset. Returns true when a migration was launched; false
   *  falls back to the normal quota wait. */
  private async attemptFailover(id: string, signal: AbortSignal): Promise<boolean> {
    const view = await this.get(id).catch(() => undefined);
    if (!view || view.state.status !== 'rate_limited') return false;
    if (view.config.retry?.allowAccountFailover !== true) return false;
    const resetAt = view.state.quota?.resetAt;
    const providerRetryAt = view.state.quota?.retryAt;
    const providerDown = view.state.quota?.unavailable === true;
    if (!providerDown && (typeof resetAt !== 'number' || resetAt - Date.now() < 30 * 60_000)) return false;
    const usage = await this.fetchUsageAccounts(signal);
    if (signal.aborted || this.deleting.has(id)) return false;
    // Positive-confirmation gate: automatic failover happens with no human in the
    // loop, so it must NOT fire on a mere rate_limited status. Require the usage
    // feed to confirm the CURRENT account is genuinely at its limit, and only
    // migrate to a candidate with confirmed headroom. Absent/unknown usage data
    // (empty feed, account not scored) is treated as "not confirmed" â no
    // failover, and the session keeps waiting for its own quota to reset.
    const currentUsage = usage.find(item => item.binary === view.config.binary);
    if (currentUsage?.atLimit !== true && currentUsage?.unavailable !== true) return false;
    const currentRetryAt = typeof currentUsage.retryAt === 'number' ? currentUsage.retryAt : providerRetryAt;
    // A short, structured proxy cooldown uses the normal waiter; hard spend,
    // auth, and generic provider outages can fail over immediately.
    if (
      currentUsage.unavailableReason === 'cooldown' &&
      typeof currentRetryAt === 'number' &&
      currentRetryAt - Date.now() < 30 * 60_000
    )
      return false;
    const candidate = selectFailoverCandidate({
      currentBinary: view.config.binary,
      harness: view.config.harness,
      agents: discoverAutoAgents(this.paths.kfleetBin),
      usage,
      requireConfirmedUsage: true,
    });
    if (!candidate) return false;
    await this.emit(
      id,
      'account.failover',
      {
        from: view.config.binary,
        to: candidate,
        ...(resetAt !== undefined ? { resetAt } : {}),
        ...(currentRetryAt !== undefined ? { retryAt: currentRetryAt } : {}),
        ...(currentUsage.unavailableReason !== undefined ? { reason: currentUsage.unavailableReason } : {}),
      },
      'watcher',
    ).catch(() => undefined);
    try {
      await this.migrate(id, candidate);
      return true;
    } catch (error) {
      await this.emit(id, 'account.failover.failed', { to: candidate, message: String(error) }, 'watcher').catch(
        () => undefined,
      );
      return false;
    }
  }

  private async waitForQuotaAndResume(id: string, signal: AbortSignal): Promise<void> {
    while (!this.closed && !signal.aborted) {
      if (this.deleting.has(id)) return;
      if (await this.attemptFailover(id, signal)) return;
      const view = await this.get(id).catch(() => undefined);
      if (!view || view.state.status !== 'rate_limited') return;
      const quota = await this.fetchQuota(view.config, signal);
      if (signal.aborted || this.deleting.has(id)) return;
      if (quota && quota.atLimit === false && quota.unavailable !== true) {
        const latest = await this.get(id).catch(() => undefined);
        if (!latest || latest.state.status !== 'rate_limited' || signal.aborted) return;
        await this.emit(id, 'quota.available', quota, 'watcher');
        await this.resume(id, 'The account quota is available again. Continue from the persisted conversation.', {
          automatic: true,
          dedupeSharedRecoveryScope: true,
          expectedStatus: 'rate_limited',
        }).catch(async error => {
          if (!(error instanceof ResumeCancelled))
            await this.emit(id, 'retry.failed', { message: String(error) }, 'watcher');
        });
        return;
      }
      const retryAt = quota?.retryAt ?? quota?.resetAt;
      const delay = retryAt ? Math.max(5_000, Math.min(60_000, retryAt - Date.now())) : 60_000;
      await interruptibleSleep(delay, signal);
    }
  }

  private scheduleQuotaWaiter(id: string): void {
    if (this.quotaWaiters.has(id) || this.closed || this.deleting.has(id)) return;
    const waiter: QuotaWaiter = { abort: new AbortController(), promise: Promise.resolve() };
    waiter.promise = this.waitForQuotaAndResume(id, waiter.abort.signal)
      .catch(async error => {
        if (!waiter.abort.signal.aborted && !this.closed && !this.deleting.has(id)) {
          await this.emit(id, 'retry.failed', { message: String(error) }, 'watcher').catch(() => undefined);
        }
      })
      .finally(() => {
        if (this.quotaWaiters.get(id) === waiter) this.quotaWaiters.delete(id);
      });
    this.quotaWaiters.set(id, waiter);
  }

  private async cancelQuotaWaiter(id: string, drain = false): Promise<void> {
    const waiter = this.quotaWaiters.get(id);
    if (!waiter) return;
    waiter.abort.abort();
    if (drain) await waiter.promise;
  }

  private scheduleTransientRetry(id: string, attempt: number): void {
    if (this.closed || this.deleting.has(id)) return;
    this.cancelRetry(id);
    if (this.closed || this.deleting.has(id)) return;
    const timer = setTimeout(
      () => {
        this.retryTimers.delete(id);
        if (this.closed || this.deleting.has(id)) return;
        void this.resume(id, 'The transient failure has cleared. Continue from the persisted conversation.', {
          automatic: true,
          dedupeSharedRecoveryScope: true,
          expectedStatus: 'retrying',
          retryAttempt: attempt,
        }).catch(async error => {
          if (!(error instanceof ResumeCancelled) && !this.closed && !this.deleting.has(id)) {
            await this.emit(id, 'retry.failed', { message: String(error) }, 'watcher').catch(() => undefined);
          }
        });
      },
      2 ** attempt * 1000,
    );
    this.retryTimers.set(id, timer);
  }

  private cancelRetry(id: string): void {
    const timer = this.retryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(id);
  }

  private async stopManagedSession(config: SessionConfig, reason: string, drain = false): Promise<void> {
    try {
      await this.stopMonitor(config.id, drain);
      await this.stopTmuxWithEvidence(config, reason);
    } catch (error) {
      const paneState = await this.tmux.state(config.tmuxSession);
      if (paneState.alive && !paneState.dead && !this.closed && !this.deleting.has(config.id)) {
        await this.startMonitor(config.id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async stopTmuxWithEvidence(config: SessionConfig, reason: string): Promise<void> {
    try {
      await this.tmux.stop(config.tmuxSession);
    } catch (error) {
      await this.tmux.snapshot(config, true).catch(() => '');
      const message = error instanceof Error ? error.message : String(error);
      await atomicJson(path.join(sessionDir(this.paths, config.id), 'kill.json'), {
        at: now(),
        reason,
        killFailed: true,
        error: message,
        tmuxSession: config.tmuxSession,
        lastSnapshot: 'last-snapshot.txt',
      });
      const state = await this.store.updateState<SessionState>(config.id, current => ({
        ...current,
        status: 'kill_failed',
        health: 'crashed',
        reason: `${reason}: ${message}`,
        finishedAt: undefined,
        promptReady: false,
        // This write bypasses transition(), so it clears the declared wait
        // itself: kill_failed is protected, and every later patch is
        // suppressed â a park left set here could never be cleared again.
        waiting: undefined,
      }));
      await this.emit(
        config.id,
        'session.kill_failed',
        {
          status: state.status,
          health: state.health,
          reason,
          error: message,
        },
        'daemon',
        state.turn,
        true,
      ).catch(() => undefined);
      throw error;
    }
  }

  private async gitFingerprint(cwd: string): Promise<string> {
    const key = path.resolve(cwd);
    const cached = this.gitFingerprintCache.get(key);
    if (cached && Date.now() - cached.at < GIT_FINGERPRINT_COALESCE_MS) {
      if (cached.pending) return await cached.pending;
      if (cached.value !== undefined) return cached.value;
    }
    const pending = this.computeGitFingerprint(key);
    this.gitFingerprintCache.set(key, { at: Date.now(), pending });
    try {
      const value = await pending;
      this.gitFingerprintCache.set(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      if (this.gitFingerprintCache.get(key)?.pending === pending) this.gitFingerprintCache.delete(key);
      throw error;
    }
  }

  private async computeGitFingerprint(cwd: string): Promise<string> {
    if ((await run(['git', '-C', cwd, 'rev-parse', '--is-inside-work-tree'])).code !== 0) return '';
    const [statusResult, statResult, worktreeDiff, indexDiff] = await Promise.all([
      run(['git', '-C', cwd, 'status', '--short']),
      run(['git', '-C', cwd, 'diff', '--stat']),
      run(['git', '-C', cwd, 'diff', '--no-ext-diff', '--binary']),
      run(['git', '-C', cwd, 'diff', '--cached', '--no-ext-diff', '--binary']),
    ]);
    const contentHash = Bun.hash(`${worktreeDiff.stdout}\0${indexDiff.stdout}`).toString(16);
    return `${statusResult.stdout}\n${statResult.stdout}\ncontent ${contentHash}`.trim();
  }

  private systemPrompt(config: SessionConfig): string {
    const directory = sessionDir(this.paths, config.id);
    const interaction =
      config.mode === 'auto'
        ? 'You are in AUTOMODE. Never ask the user a question and never wait for input. Make the best reasonable decision, continue autonomously, and document assumptions.'
        : 'You are in INTERACTIVE MODE. You may use AskUserQuestion or finish a conversational turn and wait. The daemon will relay the user response through this same interactive tmux session.';
    const helpRule =
      config.mode === 'interactive'
        ? '7. If blocked without a structured question tool, run: kteam signal help "your precise question"'
        : '7. Never signal help or wait for a HUMAN reply in automode. Waiting on an EXTERNAL condition is different and supported: see rule 9.';
    // Rule 9 (2026-07-24): before declared waits, a teammate parked on a long
    // suite or a deploy was indistinguishable from a dead one â nudged at
    // 180 s, stall-killed at 300 s, and reaped by the 4 h turn ceiling.
    const waitRule =
      '9. If you must wait on an EXTERNAL condition (a long suite, a deploy, a scheduled window), declare it: ' +
      'kteam signal waiting --until <45m|2h|ISO> --on "<what you are waiting for>". That suspends the idle nudge, ' +
      'the stall kill, and the turn ceiling while heartbeats keep you visible; the daemon wakes you at the deadline. ' +
      '--until is optional (an open-ended park is fine), but EVERY wait is force-woken after 4 hours. ' +
      'Run kteam signal working when the condition resolves. This is legal in automode â it asks nobody for anything. ' +
      'Never park instead of finishing: it is for waiting, not for idling.';
    // Rule 8 exists because a teammate once ran `bun add` at a repo root: bun
    // created a root package.json/node_modules that shadowed a nested package's
    // deps and broke tooling fleet-wide until a human cleaned it up.
    return `# kteam teammate contract\n\n${interaction}\n\nYour durable coordination directory is ${directory}.\n\nRules:\n1. Work only on the assigned task and respect repository instructions.\n2. Do not manage tmux or the daemon.\n3. Keep useful session-only artifacts under the coordination directory.\n4. When the assigned task is genuinely complete, write ${directory}/summary.md and run: kteam signal done\n5. Never claim completion without the done marker.\n6. Preserve unrelated user changes.\n${helpRule}\n8. Run \`bun add\`/\`bun install\` (and other package-manager installs) ONLY from inside the target package directory â cd there in the same command or use absolute paths. NEVER run them at the repository root: that creates a root package.json/node_modules that shadows nested packages and breaks their tooling.\n${waitRule}\n`;
  }

  private promptInstruction(id: string, turn: number): string {
    return `Read the file ${turnPrompt(this.paths, id, turn)} now, then carefully follow every instruction inside it. This is your complete task for this turn.`;
  }

  /** True when a payload is safe to type verbatim into the composer instead
   *  of the turn-file indirection: single line after trim, no attachment
   *  block (those embed file paths the model must read), under the
   *  directSendMaxChars threshold, and free of characters that fight TUI
   *  quoting/paste handling (control chars). */
  private isDirectPayload(payload: string, config: SessionConfig): boolean {
    const limit = config.directSendMaxChars ?? 500;
    if (limit <= 0) return false;
    const trimmed = payload.trim();
    if (!trimmed || trimmed.length > limit) return false;
    if (trimmed.includes('\n')) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
    return true;
  }

  private attachmentView(stored: {
    manifest: {
      id: string;
      filename: string;
      mime: string;
      size: number;
      hash: string;
      time: string;
      textExtraction?: {
        method: 'pdfjs' | 'docx-xml';
        characters: number;
        truncated: boolean;
        totalPages?: number;
        pagesRead?: number;
      };
      textExtractionFailure?: {
        code:
          | 'password_protected_document'
          | 'no_extractable_text'
          | 'unreadable_document'
          | 'document_extraction_timeout'
          | 'document_too_complex';
        message: string;
      };
    };
    path: string;
  }): AttachmentView {
    return {
      id: stored.manifest.id,
      filename: stored.manifest.filename,
      mime: stored.manifest.mime,
      size: stored.manifest.size,
      sha256: stored.manifest.hash,
      path: stored.path,
      createdAt: stored.manifest.time,
      ...(stored.manifest.textExtraction
        ? {
            textExtraction: {
              method: stored.manifest.textExtraction.method,
              characters: stored.manifest.textExtraction.characters,
              truncated: stored.manifest.textExtraction.truncated,
              ...(stored.manifest.textExtraction.totalPages === undefined
                ? {}
                : { totalPages: stored.manifest.textExtraction.totalPages }),
              ...(stored.manifest.textExtraction.pagesRead === undefined
                ? {}
                : { pagesRead: stored.manifest.textExtraction.pagesRead }),
            },
          }
        : {}),
      ...(stored.manifest.textExtractionFailure
        ? {
            textExtractionFailure: {
              code: stored.manifest.textExtractionFailure.code,
              message: stored.manifest.textExtractionFailure.message,
            },
          }
        : {}),
    };
  }

  private number(value: number | undefined, fallback: number, minimum: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved < minimum) throw new Error(`${name} must be at least ${minimum}`);
    return resolved;
  }

  private async claimedCodexSessionIds(exceptId: string): Promise<string[]> {
    return (await this.list()).flatMap(view =>
      view.config.id !== exceptId && view.config.harness === 'codex' && view.config.harnessSessionId
        ? [view.config.harnessSessionId]
        : [],
    );
  }

  /** Launch the TUI, relaunching ONCE when it never reaches a ready prompt.
   *  Codex TUIs occasionally wedge at the startup banner (observed during the
   *  2026-07-22 daemon flap: promptReady=false for the full 90 s window) and a
   *  single fresh pane reliably recovers â without this, the whole session
   *  fails on a boot hiccup. Only the startup-timeout shape retries; a dead
   *  pane or tmux error stays fatal on the first attempt. */
  private async launchWithRetry(config: SessionConfig): Promise<void> {
    try {
      await this.tmux.launch(config);
    } catch (error) {
      if (!/did not become ready/i.test(String(error))) throw error;
      await this.tmux.stop(config.tmuxSession).catch(() => undefined);
      await this.emit(
        config.id,
        'control.launch_retry',
        { reason: String(error instanceof Error ? error.message : error) },
        'daemon',
      ).catch(() => undefined);
      await this.tmux.launch(config);
    }
  }

  /** Run a TUI bootstrap (launch + first inject) exclusively â see bootstrapChain. */
  private async serializedBootstrap<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.bootstrapChain.then(operation, operation);
    this.bootstrapChain = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private async serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.deleting.has(id)) throw new Error('session deletion is in progress');
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(id, settled);
    try {
      return await result;
    } finally {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    }
  }

  private async serializedRuntimeControl<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.deleting.has(id)) throw new Error('session deletion is in progress');
    const previous = this.runtimeControlQueues.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.runtimeControlQueues.set(id, settled);
    try {
      return await result;
    } finally {
      if (this.runtimeControlQueues.get(id) === settled) this.runtimeControlQueues.delete(id);
    }
  }

  // ââ Scratch garbage collection ââââââââââââââââââââââââââââââââââââââââââââ

  /** Running total of scratch reclaimed this daemon lifetime. */
  private scratchReclaimed = { sessions: 0, bytes: 0 };

  private get scratchConfig(): ScratchConfig {
    return this.options.scratch ?? defaultScratchConfig();
  }

  /** Is this session holding a live warden? (An assigned warden's target must
   *  keep its scratch â the warden is about to read it.) */
  private hasLiveWarden(id: string): boolean {
    for (const session of this.store.listSessions()) {
      const config = session.config as SessionConfig | undefined;
      const state = session.state as SessionState | undefined;
      if (config?.label !== WARDEN_LABEL) continue;
      if (config.parent !== id) continue;
      if (state && !terminalStatuses.includes(state.status)) return true;
    }
    return false;
  }

  /** Decide (without touching anything) what a scratch sweep WOULD reclaim.
   *  `kteam gc --dry-run` renders exactly this. */
  async planScratchSweep(limit = this.scratchConfig.perSweep): Promise<ScratchPlan[]> {
    const ttlMs = Math.max(1, this.scratchConfig.ttlHours) * 3_600_000;
    const nowMs = Date.now();
    const plans: ScratchPlan[] = [];
    for (const session of this.store.listSessions()) {
      if (plans.filter(item => item.eligible).length >= limit) break;
      const config = session.config as SessionConfig | undefined;
      const state = session.state as SessionState | undefined;
      if (!config || !state) continue;
      const directory = sessionDir(this.paths, config.id);
      // Cheap gates BEFORE the directory walk: a live session must never pay
      // for a recursive stat of a teammate's whole checkout.
      const cheap = scratchEligibility({
        status: state.status,
        finishedAt: state.finishedAt,
        nowMs,
        ttlMs,
        hasMonitor: this.monitors.has(config.id),
        hasLivePane: false,
        launching: this.launchingRecently(config.id),
        wardenTarget: this.hasLiveWarden(config.id),
      });
      if (!cheap.eligible && cheap.reason !== 'no finishedAt and no file mtime to age from') continue;
      const scan = await scanScratch(directory);
      if (scan.entries.length === 0) continue;
      const pane = await this.tmux.state(config.tmuxSession).catch(() => ({ alive: false, dead: true }));
      const verdict = scratchEligibility({
        status: state.status,
        finishedAt: state.finishedAt,
        newestMtimeMs: scan.newestMtimeMs,
        nowMs,
        ttlMs,
        hasMonitor: this.monitors.has(config.id),
        hasLivePane: pane.alive === true && pane.dead !== true,
        launching: this.launchingRecently(config.id),
        wardenTarget: this.hasLiveWarden(config.id),
      });
      plans.push({
        sessionId: config.id,
        teammate: config.teammate,
        directory,
        bytes: scan.bytes,
        entries: scan.entries,
        eligible: verdict.eligible,
        reason: verdict.reason,
      });
    }
    return plans;
  }

  /** Reclaim expired scratch. Rate-limited by `scratch.perSweep` and folded
   *  into the warden sweep â no new timer, and it yields between sessions so a
   *  multi-gigabyte delete never blocks event delivery. */
  async scratchPlan(limit?: number): Promise<ScratchPlan[]> {
    return await this.planScratchSweep(limit ?? this.scratchConfig.perSweep);
  }

  async scratchSweep(force = false): Promise<{ sessions: number; bytes: number; failures: number }> {
    return await this.sweepScratch(force);
  }

  async sweepScratch(force = false): Promise<{ sessions: number; bytes: number; failures: number }> {
    if (!force && !this.scratchConfig.enabled) return { sessions: 0, bytes: 0, failures: 0 };
    const summary = { sessions: 0, bytes: 0, failures: 0 };
    for (const plan of await this.planScratchSweep()) {
      if (this.closed) break;
      if (!plan.eligible) continue;
      const result = await reclaimScratch(plan.directory, plan.entries);
      const trimmed = await trimSnapshots(
        plan.directory,
        ((this.store.getSession(plan.sessionId)?.config as SessionConfig | undefined)?.maxSnapshots ?? 200) as number,
      );
      summary.failures += result.failures.length;
      if (result.removed.length === 0 && trimmed.removed === 0) continue;
      summary.sessions += 1;
      summary.bytes += result.bytes;
      this.scratchReclaimed.sessions += 1;
      this.scratchReclaimed.bytes += result.bytes;
      for (const failure of result.failures) {
        console.error(`kteamd: scratch gc could not remove ${plan.sessionId}/${failure.entry}: ${failure.message}`);
      }
      // The reclaim is part of the session's OWN record: what went, how much
      // it freed, and anything that resisted.
      await this.emit(
        plan.sessionId,
        'session.scratch_reclaimed',
        {
          bytes: result.bytes,
          entries: result.removed,
          snapshotsTrimmed: trimmed.removed,
          failures: result.failures,
          ttlHours: this.scratchConfig.ttlHours,
        },
        'daemon',
      ).catch(() => undefined);
      await Bun.sleep(5);
    }
    if (summary.sessions > 0) {
      console.log(
        `kteamd: scratch gc reclaimed ${(summary.bytes / 1e6).toFixed(1)} MB from ${summary.sessions} session(s)`,
      );
    }
    return summary;
  }

  // ââ Fleet warden (layer 3) ââââââââââââââââââââââââââââââââââââââââââââââââ

  /** Load durable warden state and arm the periodic deterministic sweep. The
   *  detection sweep is always-on and free; LLM escalation inside it is gated on
   *  warden.enabled. */
  private async startWarden(): Promise<void> {
    if (this.wardenTimer) return;
    if (this.wardenStarting) return await this.wardenStarting;
    const starting = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const stateRead = this.readWardenState();
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`warden state read timed out after ${this.wardenStateReadTimeoutMs}ms`)),
          this.wardenStateReadTimeoutMs,
        );
      });
      let state: WardenRuntimeState;
      try {
        state = (await Promise.race([stateRead, deadline])) ?? {};
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      // Bootstrap's deadline does not cancel the underlying work. A self-check
      // may therefore arrive while this read is still in flight; only the
      // winner may arm a timer, and a late completion after close must do
      // nothing.
      if (this.closed || this.wardenTimer) return;
      this.wardenState = state;
      const intervalMs = Math.max(60_000, this.wardenConfig.intervalMinutes * 60_000);
      this.wardenTimer = setInterval(() => {
        void this.runSweep(false).catch(() => undefined);
      }, intervalMs);
      // A boot-time sweep so anomalies.json and `warden status` are populated
      // without waiting a full interval; escalation still respects its own gate.
      void this.runSweep(false).catch(() => undefined);
    })();
    this.wardenStarting = starting;
    try {
      await starting;
    } finally {
      if (this.wardenStarting === starting) this.wardenStarting = undefined;
    }
  }

  /** Run a sweep exclusively (serialized against the interval and other forced
   *  runs). `forceEscalation` bypasses the enabled flag, spawn gap, and
   *  fingerprint-unchanged suppression for a manual `warden run --spawn`. */
  private async runSweep(forceEscalation: boolean): Promise<WardenRunView> {
    const operation = this.wardenSweepChain.then(
      () => this.sweepOnce(forceEscalation),
      () => this.sweepOnce(forceEscalation),
    );
    this.wardenSweepChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  private async sweepOnce(forceEscalation: boolean): Promise<WardenRunView> {
    // Scratch GC rides the warden cadence — no extra timer. It is fired and
    // not awaited so a multi-gigabyte delete never holds the sweep chain when
    // the next interval fires; failures are logged, never fatal.
    void this.sweepScratch().catch(error => console.error(`kteamd: scratch gc sweep failed: ${error}`));
    const sessions = await this.list();
    // A warden sweeps live work only. Terminal sessions are durable history;
    // re-opening completed/failed/stopped work caused noisy, stale reports.
    const scanSessions = sessions.filter(view => isWardenScannableStatus(view.state.status));
    const views: WardenSessionView[] = scanSessions.map(view => ({
      config: view.config,
      state: view.state,
      hasLiveMonitor: this.monitors.has(view.config.id),
      hasDoneMarker: this.doneMarkerForTurn(view.config.id, view.state.turn ?? view.config.turn),
    }));
    // One knob (`unattendedMinutes`) drives both the idle-question threshold and
    // the recent-terminal-wreckage window â an old failure that nobody handled
    // within the window ages out rather than nagging forever.
    const unattendedMs = Math.max(60_000, this.wardenConfig.unattendedMinutes * 60_000);
    const sweepNowMs = Date.now();
    const sessionDetected = detectAnomalies(views, sweepNowMs, {
      unattendedMs,
      terminalWindowMs: unattendedMs,
      susThinkingSeconds: Math.max(60, this.wardenConfig.susThinkingSeconds),
      susSubprocessSeconds: Math.max(60, this.wardenConfig.susSubprocessSeconds),
    });
    // Provider failure detection reads daemon-owned snapshots directly. Bound
    // concurrent reads so a large historical fleet cannot create an fd storm;
    // only current auto sessions are candidates, and no live tmux/LLM work is
    // invoked. Confirmation requires a later, time-separated sweep.
    const providerViews: ProviderSnapshotView[] = [];
    const providerEligible = providerEligibleSessionIds(scanSessions);
    const providerCandidates = scanSessions.filter(
      view => providerEligible.has(view.config.id) && providerSnapshotEligible(view),
    );
    for (let index = 0; index < providerCandidates.length; index += 16) {
      providerViews.push(
        ...(await Promise.all(
          providerCandidates.slice(index, index + 16).map(async view => ({
            config: view.config,
            state: view.state,
            snapshot: await this.lastSnapshot(view.config.id),
          })),
        )),
      );
    }
    const providerOutage = { ...defaultProviderOutageConfig(), ...(this.wardenConfig.providerOutage ?? {}) };
    const providerDetected = detectProviderOutages(this.wardenState.providerOutages ?? {}, providerViews, sweepNowMs, {
      minDistinctSessions: providerOutage.minDistinctSessions,
      persistenceSweeps: providerOutage.persistenceSweeps,
      tailLines: providerOutage.tailLines,
      // A forced/manual sweep cannot manufacture a second observation before
      // the configured deterministic cadence has actually elapsed.
      minPersistenceMs: Math.max(60_000, this.wardenConfig.intervalMinutes * 60_000),
    });
    this.wardenState.providerOutages = providerDetected.state;
    const detected = { anomalies: [...sessionDetected.anomalies, ...providerDetected.anomalies] };
    // Reconcile fresh needs_human verdicts from warden reports into session
    // state, then SUPPRESS re-triage of a flagged session's same anomaly
    // class: a needs_human session already reached the human â an identical
    // report every sweep is noise (lacey, 2026-07-23). The flag clears when a
    // human acts (answer/resume/stop).
    await this.reconcileNeedsHuman(sessions);
    const flagged = new Map(sessions.map(view => [view.config.id, view.state]));
    const anomalies = detected.anomalies.filter(
      item => !needsHumanStateCoversAnomaly(flagged.get(item.sessionId) ?? {}, item.kind),
    );
    const result = { anomalies, fingerprint: fingerprintAnomalies(anomalies) };
    const at = now();
    this.lastSweep = { at, anomalies: result.anomalies, fingerprint: result.fingerprint };
    this.wardenState.lastSweepAt = at;
    // Recovery generation: bump when the fleet transitions from having anomalies
    // to having none. Escalation suppression is keyed by generation, so an
    // anomaly set that reappears AFTER a clean recovery is treated as new and
    // re-escalates rather than being silenced as "unchanged since last spawn".
    const previousFingerprint = this.wardenState.lastFingerprint ?? '';
    if (previousFingerprint !== '' && result.fingerprint === '') {
      this.wardenState.recoveryGeneration = (this.wardenState.recoveryGeneration ?? 0) + 1;
    }
    this.wardenState.lastFingerprint = result.fingerprint;
    // Warden blessings: prune BEFORE spawning. A LEAVE verdict grants a session a
    // short TTL during which the sweep skips its cleared flags (recorded in
    // spawnAssignedWardens). Here we drop blessings that expired, whose session
    // changed status, or whose session vanished — a blessing must never outlive
    // the situation it cleared, so a session that later breaks is caught. The
    // early revocation is journalled so a session that STOPS being skipped is
    // explicable rather than mysterious.
    const blessStatusById = new Map(sessions.map(view => [view.config.id, view.state.status]));
    const blessPrune = reconcileBlessings(this.wardenState.blessings ?? {}, blessStatusById, Date.now());
    this.wardenState.blessings = blessPrune.store;
    for (const revokedId of blessPrune.revoked)
      this.emitTransient('fleet.warden_bless_revoked', { sessionId: revokedId });
    await mkdir(this.paths.wardenDir, { recursive: true, mode: 0o700 });
    await atomicJson(this.paths.wardenAnomalies, {
      at,
      count: result.anomalies.length,
      fingerprint: result.fingerprint,
      anomalies: result.anomalies,
    });
    await this.saveWardenState();
    if (result.fingerprint !== this.lastEmittedFingerprint) {
      this.lastEmittedFingerprint = result.fingerprint;
      if (result.anomalies.length > 0)
        this.emitTransient('fleet.anomaly', {
          at,
          count: result.anomalies.length,
          fingerprint: result.fingerprint,
          anomalies: result.anomalies,
        });
    }
    // Sus anomalies (alive but weird) get ONE assigned warden each; everything
    // else goes through the shared fleet-triage escalation below.
    const assigned = await this.spawnAssignedWardens(
      result.anomalies.filter(item => item.assignedWarden === true),
      sessions,
      forceEscalation,
    );
    const triage = result.anomalies.filter(item => item.assignedWarden !== true);
    const escalation = await this.maybeEscalate(triage, result.fingerprint, sessions, forceEscalation);
    return {
      sweptAt: at,
      anomalies: result.anomalies,
      ...escalation,
      ...(assigned.length ? { assignedWardens: assigned } : {}),
    };
  }

  /** Pick the account for the NEXT warden spawn (both spawn sites call this
   *  per spawn, so round-robin rotates per spawn and fallback re-evaluates
   *  eligibility every time — fail-back is automatic). Reconciles demotions
   *  against the usage feed first (positive evidence restores early), warns
   *  once per configured-but-missing wrapper, and edge-emits
   *  fleet.warden_exhausted when every account is ineligible. Returns
   *  undefined on exhaustion — the caller must skip the spawn WITHOUT
   *  consuming its gap/fingerprint so recovery escalates immediately. */
  private async pickWardenAccount(): Promise<PickedWardenAccount | undefined> {
    const config = this.wardenConfig;
    const configuredAccounts = normalizeWardenAccounts(config);
    const usage = await this.fetchUsageAccounts().catch(() => [] as AgentUsage[]);
    const nowMs = Date.now();
    const reconciled = reconcileDemotions(this.wardenState.failover ?? {}, usage, nowMs);
    for (const restored of reconciled.restored) {
      this.emitTransient('fleet.warden_wrapper_restored', restored);
    }
    let installed: string[] = [];
    try {
      installed = discoverAutoAgents(this.paths.kfleetBin);
    } catch {
      // Unreadable bin dir == empty inventory: evidence about nobody.
    }
    if (installed.length > 0) {
      for (const account of configuredAccounts) {
        if (installed.includes(account.wrapper)) continue;
        this.wardenMissingWarned ??= new Set();
        if (this.wardenMissingWarned.has(account.wrapper)) continue;
        this.wardenMissingWarned.add(account.wrapper);
        this.emitTransient('fleet.warden_config_invalid', { wrapper: account.wrapper });
      }
    }
    const previousWrapper = reconciled.state.lastSelection?.wrapper;
    const wasExhausted = reconciled.state.exhaustedSince !== undefined;
    const selection = selectWardenAccount({
      config,
      installedAgents: installed,
      usage,
      state: reconciled.state,
      nowMs,
    });
    this.wardenState.failover = selection.state;
    if (selection.exhausted) {
      // Edge-triggered: one event per exhaustion episode, not one per sweep.
      if (!wasExhausted) {
        this.emitTransient('fleet.warden_exhausted', {
          accounts: selection.reasons,
          since: selection.state.exhaustedSince,
        });
      }
      return undefined;
    }
    // A failover is a HEALTH-driven change of wrapper — round-robin rotation is
    // routine and never emitted (the lastSelection record covers it).
    if (selection.reason === 'failover' && previousWrapper && previousWrapper !== selection.account.wrapper) {
      this.emitTransient('fleet.warden_failover', {
        from: previousWrapper,
        to: selection.account.wrapper,
        policy: config.failover?.policy ?? 'fallback',
        reason: 'preferred account unhealthy',
      });
    }
    return {
      ...selection.account,
      policy: effectiveFailoverConfig(config).policy,
      selection: selection.reason,
      configuredFirst: configuredAccounts[0]?.wrapper ?? selection.account.wrapper,
      skipped: selection.skipped,
    };
  }

  /** Record a warden spawn failure against the WRAPPER (never the target):
   *  feed-corroborated quota/auth evidence demotes in one strike, generic
   *  launch errors accumulate to the configured threshold. */
  private recordWardenSpawnFailure(wrapper: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const failover = effectiveFailoverConfig(this.wardenConfig);
    const result = recordWardenFailure(
      this.wardenState.failover ?? {},
      wrapper,
      classifyWardenFailure(message),
      message,
      Date.now(),
      failover,
    );
    this.wardenState.failover = result.state;
    if (result.demoted) {
      this.emitTransient('fleet.warden_wrapper_demoted', {
        wrapper,
        until: result.state.demotedUntil?.[wrapper],
        strikes: result.strikes,
        evidence: message,
      });
    }
  }

  /** Reconcile + spawn per-session assigned wardens for sus anomalies, bounded
   *  by the FLEET-WIDE warden cap (the sweep warden counts too). Dedupes against
   *  live assignments, applies the per-target post-assignment cooldown, and
   *  QUEUES any target it could not spawn this sweep (dropping ones that have
   *  since recovered). Returns spawned warden ids. */
  private async spawnAssignedWardens(
    susAnomalies: WardenAnomaly[],
    sessions: SessionView[],
    force: boolean,
  ): Promise<string[]> {
    const warden = this.wardenConfig;
    const queuedAnomalies = this.wardenState.assignedQueue ?? [];
    const hasAssignments = Object.keys(this.wardenState.assignments ?? {}).length > 0;
    if (!force && !warden.enabled && !hasAssignments) return [];
    // Even an empty detector result must reconcile old assignment records:
    // otherwise a finished/missing warden remains "pending" forever in the
    // Attention view and consumes the durable assignment slot.
    if (susAnomalies.length === 0 && queuedAnomalies.length === 0 && !hasAssignments) return [];
    const byId = new Map(sessions.map(view => [view.config.id, view]));
    // Reconcile: drop assignments whose warden session is gone/terminal, and
    // start the cooldown clock for the target at that moment.
    const assignments = { ...(this.wardenState.assignments ?? {}) };
    const cooldowns = { ...(this.wardenState.assignedCooldowns ?? {}) };
    let blessings: BlessingStore = { ...(this.wardenState.blessings ?? {}) };
    const blessTtlMs = blessingTtlMs(warden.blessMinutes);
    for (const [targetId, record] of Object.entries(assignments)) {
      const wardenView = byId.get(record.wardenId);
      if (!wardenView || protectedStatuses.includes(wardenView.state.status)) {
        // The assigned warden finished. If its verdict was LEAVE (session healthy
        // and progressing), bless the target against the exact FLAGS it judged, so
        // the next sweep skips it until the TTL lapses instead of spending another
        // warden session to reach the same verdict. Non-LEAVE verdicts never bless.
        // The blessing is dropped early if the session later changes state (see
        // reconcileBlessings in sweepOnce).
        const target = byId.get(targetId);
        const kinds = record.kinds ?? [];
        if (record.reportPath && target && kinds.length > 0) {
          const content = await readFile(record.reportPath, 'utf8').catch(() => '');
          if (content && classifyVerdict(content) === 'cleared') {
            blessings = recordBlessing(
              blessings,
              { sessionId: targetId, kinds, status: target.state.status, wardenId: record.wardenId },
              Date.now(),
              blessTtlMs,
            );
            const granted = blessings[targetId];
            if (granted)
              this.emitTransient('fleet.warden_blessed', {
                targetId,
                wardenId: record.wardenId,
                kinds,
                expiresAt: granted.expiresAt,
              });
          }
        }
        delete assignments[targetId];
        cooldowns[targetId] = now();
      }
    }
    this.wardenState.blessings = blessings;
    if (!force && !warden.enabled) {
      this.wardenState.assignments = assignments;
      this.wardenState.assignedCooldowns = cooldowns;
      await this.saveWardenState();
      return [];
    }
    const cooldownMs = Math.max(0, warden.assignedCooldownMinutes * 60_000);
    const nowMs = Date.now();

    // A blessed session must not even become a candidate, so it never occupies the
    // single warden slot (this filter runs BEFORE the concurrency gate). Narrow:
    // only the exact flags the warden cleared, only while the session holds the
    // status it was cleared in — a new flag class or a status change still spawns.
    const blessNowMs = Date.now();
    const candidates = susAnomalies.filter(anomaly => {
      const target = byId.get(anomaly.sessionId);
      if (!target) return true;
      return !isAnomalyBlessed(blessings, anomaly, target.state.status, blessNowMs);
    });

    // A target is worth a warden only if it is still present, not protected,
    // not already under a live warden, and not inside its post-assignment
    // cooldown. Recovered / gone / cooled targets are neither spawned nor
    // re-queued — this is the "drop a recovered target" rule.
    const isStillSuspect = (targetId: string): boolean => {
      const target = byId.get(targetId);
      if (!target || protectedStatuses.includes(target.state.status)) return false;
      if (assignments[targetId]) return false; // already under a live warden
      const cooledAt = cooldowns[targetId] ? Date.parse(cooldowns[targetId]!) : 0;
      if (!force && cooledAt && nowMs - cooledAt < cooldownMs) return false;
      return true;
    };

    // Every live warden fleet-wide (assigned AND the sweep warden) — the SAME
    // budget both spawn sites draw down. targetId ties an assigned warden to its
    // session; the sweep warden has none (guards no single target).
    const targetByWardenId = new Map<string, string>();
    for (const [targetId, record] of Object.entries(assignments)) {
      targetByWardenId.set(record.wardenId, targetId);
    }
    const live: LiveWarden[] = sessions
      .filter(view => view.config.label === WARDEN_LABEL && !protectedStatuses.includes(view.state.status))
      .map(view => ({ wardenId: view.config.id, targetId: targetByWardenId.get(view.config.id) }));

    // Fresh anomalies supersede queued copies of the same target (more current).
    const anomalyById = new Map<string, WardenAnomaly>();
    for (const anomaly of queuedAnomalies) anomalyById.set(anomaly.sessionId, anomaly);
    for (const anomaly of candidates) anomalyById.set(anomaly.sessionId, anomaly);

    const decision = decideAssignedWardens({
      maxConcurrent: warden.maxAssignedWardens,
      live,
      candidates: candidates.map(item => item.sessionId),
      queued: queuedAnomalies.map(item => item.sessionId),
      isStillSuspect,
    });

    const spawned: string[] = [];
    // Targets deferred because every warden account was ineligible — queued
    // (NOT cooled down) so the next sweep after any account recovers retries
    // them immediately.
    const deferred: string[] = [];
    for (const targetId of decision.spawn) {
      const anomaly = anomalyById.get(targetId);
      const target = byId.get(targetId);
      if (!anomaly || !target) continue; // defensive: id always resolves here
      // Account selection is per spawn: round-robin rotates across targets and
      // fallback re-checks the preferred account each time.
      const account = await this.pickWardenAccount();
      if (!account) {
        deferred.push(targetId);
        continue;
      }
      const at = now();
      const reportPath = path.join(this.paths.wardenReports, `${at.replace(/[:.]/g, '-')}-${targetId}.md`);
      await mkdir(this.paths.wardenReports, { recursive: true, mode: 0o700 });
      // Unguessable per-assignment capability: exported only into THIS
      // warden's pane; the api-server authorizes `stop <target>` by comparing
      // capabilities, so another warden holding the shared scoped token
      // cannot spoof its way to someone else's target (review P1).
      const capability = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`;
      const provenanceFile = provenancePath(reportPath);
      const writeProvenance = (spawnView: SessionView) =>
        atomicJson(provenanceFile, buildWardenSpawnProvenance(spawnView, account, target.config.id));
      const gateFirstTurnOnProvenance = async (spawnView: SessionView) => {
        try {
          await writeProvenance(spawnView);
        } catch (error) {
          throw new WardenProvenancePersistenceError(spawnView.config.id, reportPath, error);
        }
      };
      let view: SessionView;
      try {
        view = await this.start(
          {
            prompt: this.buildAssignedWardenPrompt(anomaly, target, reportPath),
            agent: account.wrapper,
            model: account.model,
            mode: 'auto',
            label: WARDEN_LABEL,
            name: `warden:${target.config.teammate ?? targetId}`,
            cwd: this.paths.home,
            stopCapability: capability,
          },
          {
            beforeFirstTurn: gateFirstTurnOnProvenance,
            onBootstrapFailure: () => rm(provenanceFile, { force: true }),
          },
        );
      } catch (error) {
        const provenanceError = wardenProvenanceError(error);
        if (provenanceError) {
          this.emitTransient('fleet.warden_provenance_failed', {
            wardenId: provenanceError.wardenId,
            targetId,
            reportPath: provenanceError.reportPath,
            message: provenanceError.message,
          });
          continue;
        }
        // Strike the WRAPPER (the attributed cause) so failover can route the
        // next spawn elsewhere — the old code punished only the TARGET's
        // cooldown, silently starving every sus target on a dead account. The
        // target cooldown is still recorded as damping for genuinely
        // target-scoped failures (it also stops a same-sweep hot loop).
        this.recordWardenSpawnFailure(account.wrapper, error);
        cooldowns[targetId] = at;
        this.emitTransient('fleet.warden_spawn_failed', {
          targetId,
          wrapper: account.wrapper,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      // start() succeeded. From here on, never attribute daemon persistence
      // failures to the wrapper or lose track of the already-live warden.
      await writeProvenance(view).catch(error => {
        this.emitTransient('fleet.warden_provenance_failed', {
          wardenId: view.config.id,
          targetId,
          reportPath,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      this.wardenState.failover = recordWardenSuccess(this.wardenState.failover ?? {}, account.wrapper);
      // The assigned prompt and report template investigate exactly ONE
      // anomaly block. Mark only that selected kind pending; simultaneous
      // sibling kinds remain visibly unjudged instead of borrowing a warden
      // that was never asked to assess them.
      assignments[targetId] = {
        wardenId: view.config.id,
        spawnedAt: at,
        capability,
        kinds: [anomaly.kind],
        reportPath,
      };
      spawned.push(view.config.id);
      this.emitTransient('fleet.warden_assigned', {
        wardenId: view.config.id,
        targetId,
        kind: anomaly.kind,
        reportPath,
      });
    }

    // Persist the carried-over queue (still-sus, no slot) and report drops.
    this.wardenState.assignments = assignments;
    this.wardenState.assignedCooldowns = cooldowns;
    this.wardenState.assignedQueue = [...decision.queue, ...deferred]
      .map(id => anomalyById.get(id))
      .filter((a): a is WardenAnomaly => a !== undefined);
    if (decision.dropped.length > 0) {
      this.emitTransient('fleet.warden_dequeued', { targets: decision.dropped, reason: 'recovered' });
    }
    await this.saveWardenState();
    return spawned;
  }

  /** True when `capability` matches the secret minted for `targetId`'s
   *  active assignment â the ONLY case the warden-scoped token may stop a
   *  session. Capabilities are unguessable and exported only into the
   *  assigned warden's pane, so possession IS the authorization; a
   *  client-chosen identity header is never trusted. */
  wardenMayStop(capability: string, targetId: string): boolean {
    const expected = this.wardenState.assignments?.[targetId]?.capability;
    return typeof expected === 'string' && expected.length > 0 && expected === capability;
  }

  private buildAssignedWardenPrompt(anomaly: WardenAnomaly, target: SessionView, reportPath: string): string {
    const kindHelp =
      anomaly.kind === 'sus_thinking'
        ? [
            'The session APPEARS to be thinking (work counters advancing) but its transcript has not grown for a long time.',
            'Judge whether that is legitimate: is the task complex enough to warrant a very long think? Are tokens actually',
            'flowing (counter values increasing between two snapshots)? Could it be a usage limit, a network wedge, or a',
            'crashed inference stream repainting a frozen spinner?',
          ]
        : anomaly.kind === 'sus_subprocess'
          ? [
              'The session has had a background subprocess running continuously for a long time.',
              'Judge whether that is expected for the task (build, test suite, long migrationâ¦) and whether the process is',
              'actually PROGRESSING: is its output growing (turn logs, files in the cwd), is it consuming CPU (`ps`), are',
              'artifacts appearing? A legitimate long task should show movement between two looks a minute apart.',
            ]
          : [
              'The session has been waiting on an unanswered question for a long time.',
              'Read its pending question and its own chat.jsonl/turns: answer with `kteam answer` ONLY when the answer is',
              'unambiguous from its own context; otherwise state precisely what a human must decide in the report.',
            ];
    return [
      `You are an ASSIGNED kteam warden for exactly one session: ${target.config.id} (teammate ${target.config.teammate ? `:${target.config.teammate}` : 'unknown'}).`,
      'It was flagged sus (alive but weird) by the fleet sweep. Investigate THIS session only and deliver one verdict.',
      '',
      '## The anomaly',
      '```json',
      JSON.stringify(anomaly, null, 2),
      '```',
      '',
      '## What to understand first',
      `- The live liveness ledger: ${target.directory}/liveness.yaml (rewritten every monitor tick â seconds since conversation/tokens/thinking/subprocess/pane life-signs plus the current nudge/kill/sus triggers). Read it twice a minute apart.`,
      `- The task and conversation so far: read ${target.directory}/prompt.md, chat.jsonl, and turns/ + logs/.`,
      `- Live pane: \`kteam snapshot ${target.config.id}\` (twice, a minute apart â compare).`,
      `- Recent events: \`kteam events ${target.config.id} --after -50\`.`,
      `- The workspace: read-only \`git -C ${target.config.cwd} diff --stat\` and file timestamps.`,
      ...kindHelp.map(line => `- ${line}`),
      '',
      '## Verdict (exactly one; state it and the evidence in the report)',
      '- LEAVE â the long operation is expected and progressing; no action.',
      `- NUDGE â \`kteam send ${target.config.id} <message>\` if it looks wedged but recoverable.`,
      `- RESUME â \`kteam resume ${target.config.id}\` if the turn is dead but the session should continue.`,
      `- KILL â \`kteam stop ${target.config.id}\` ONLY if the session is demonstrably burning time/tokens with no progress.`,
      '  (Your token can stop only this assigned session.)',
      '- NEEDS_HUMAN â the rare exception: use only when you are genuinely uncertain whether KILL would destroy needed work or cause irreversible harm. State that exact uncertainty; never use it merely because acting feels risky.',
      '',
      '## Rules',
      '- Do NOT touch any other session. No git writes, no repository edits, no new non-warden sessions.',
      `- Write your report to EXACTLY: ${reportPath}`,
      ...wardenReportInstructions(reportPath),
      '- The report MUST follow this machine-stable template (the Fleet UI parses lines 1 and 3):',
      '```',
      'Verdict: LEAVE|NUDGE|RESUME|KILL|NEEDS_HUMAN',
      '',
      `# Warden report â ${target.config.id} (teammate ${target.config.teammate ? `:${target.config.teammate}` : 'unknown'}, ${target.config.label ?? '-'})`,
      '',
      `- **Anomaly kind:** ${anomaly.kind}`,
      '',
      '## Summary',
      '- **Outcome:** <short reason for the verdict>',
      '',
      '<point-form evidence sections>',
      '```',
      '- Then run: kteam signal done',
    ].join('\n');
  }

  private async maybeEscalate(
    anomalies: WardenAnomaly[],
    fingerprint: string,
    sessions: SessionView[],
    force: boolean,
  ): Promise<{ spawned?: string; message?: string }> {
    const warden = this.wardenConfig;
    if (!force && !warden.enabled) return { message: 'escalation disabled (warden.enabled=false)' };
    if (anomalies.length === 0) return { message: 'no anomalies to escalate' };
    // "Live" excludes protected statuses (terminal + kill_failed): a warden whose
    // pane could not be killed must NOT block escalation forever â the spawn gap
    // below still rate-limits fresh wardens, so a wedged warden ages out.
    const liveWardens = sessions.filter(
      view => view.config.label === WARDEN_LABEL && !protectedStatuses.includes(view.state.status),
    );
    // Fleet-wide concurrency cap SHARED with assigned wardens: the sweep warden
    // draws down the same budget, so a full cap (default 1 = any live warden)
    // blocks escalation. This is what makes "one warden at a time" hold across
    // BOTH spawn sites.
    if (wardenSlotsFree(warden.maxAssignedWardens, liveWardens.length) <= 0)
      return {
        message: `warden concurrency cap reached (${liveWardens.length}/${Math.max(1, warden.maxAssignedWardens)} live)`,
      };
    const lastSpawnMs = this.wardenState.lastSpawnAt ? Date.parse(this.wardenState.lastSpawnAt) : 0;
    const gapMs = Math.max(0, warden.minSpawnGapMinutes * 60_000);
    if (!force && lastSpawnMs && Date.now() - lastSpawnMs < gapMs)
      return { message: `spawn gap not elapsed (last spawn ${this.wardenState.lastSpawnAt})` };
    // Suppression key qualified by the recovery generation (see sweepOnce).
    const spawnKey = `${this.wardenState.recoveryGeneration ?? 0}:${fingerprint}`;
    if (!force && spawnKey === this.wardenState.lastSpawnFingerprint)
      return { message: 'anomaly set unchanged since the last escalation' };
    // Account selection AFTER the cheap gates: exhaustion must NOT consume the
    // spawn gap or the suppression fingerprint (lastSpawnAt/lastSpawnFingerprint
    // stay untouched, unlike the failed-launch path below), so the very next
    // sweep after any account recovers escalates immediately.
    const account = await this.pickWardenAccount();
    if (!account) {
      await this.saveWardenState();
      return { message: 'every configured warden account is currently ineligible (exhausted)' };
    }
    const at = now();
    const reportPath = path.join(this.paths.wardenReports, `${at.replace(/[:.]/g, '-')}.md`);
    await mkdir(this.paths.wardenReports, { recursive: true, mode: 0o700 });
    const prompt = await this.buildWardenPrompt(anomalies, sessions, reportPath, at);
    const provenanceFile = provenancePath(reportPath);
    const writeProvenance = (spawnView: SessionView) =>
      atomicJson(provenanceFile, buildWardenSpawnProvenance(spawnView, account));
    const gateFirstTurnOnProvenance = async (spawnView: SessionView) => {
      try {
        await writeProvenance(spawnView);
      } catch (error) {
        throw new WardenProvenancePersistenceError(spawnView.config.id, reportPath, error);
      }
    };
    let view: SessionView;
    try {
      view = await this.start(
        {
          prompt,
          agent: account.wrapper,
          model: account.model,
          mode: 'auto',
          label: WARDEN_LABEL,
          name: 'warden-sweep',
          cwd: this.paths.home,
        },
        {
          beforeFirstTurn: gateFirstTurnOnProvenance,
          onBootstrapFailure: () => rm(provenanceFile, { force: true }),
        },
      );
    } catch (error) {
      const provenanceError = wardenProvenanceError(error);
      if (provenanceError) {
        this.wardenState.lastSpawnAt = at;
        await this.saveWardenState();
        this.emitTransient('fleet.warden_provenance_failed', {
          wardenId: provenanceError.wardenId,
          reportPath: provenanceError.reportPath,
          message: provenanceError.message,
        });
        return { message: provenanceError.message };
      }
      // The strike lands on the WRAPPER, so once demoted the next escalation
      // flows to the next configured account.
      this.recordWardenSpawnFailure(account.wrapper, error);
      // A FAILED launch still consumes the spawn gap (record lastSpawnAt) so a
      // persistently-broken wrapper can't be retried every sweep â but do NOT
      // record the suppression key, so a changed anomaly set (or the same set in
      // a later generation) can still escalate once the gap elapses.
      this.wardenState.lastSpawnAt = at;
      await this.saveWardenState();
      const message = `warden spawn failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emitTransient('fleet.warden_spawn_failed', { message, wrapper: account.wrapper });
      return { message };
    }
    // The wrapper launched successfully. A daemon-side provenance write error
    // must not strike it or make the live sweep warden invisible to state.
    await writeProvenance(view).catch(error => {
      this.emitTransient('fleet.warden_provenance_failed', {
        wardenId: view.config.id,
        reportPath,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.wardenState.failover = recordWardenSuccess(this.wardenState.failover ?? {}, account.wrapper);
    this.wardenState.lastSpawnAt = at;
    this.wardenState.lastSpawnFingerprint = spawnKey;
    await this.saveWardenState();
    this.emitTransient('fleet.warden_spawned', { sessionId: view.config.id, count: anomalies.length, reportPath });
    return { spawned: view.config.id };
  }

  private async buildWardenPrompt(
    anomalies: WardenAnomaly[],
    sessions: SessionView[],
    reportPath: string,
    at: string,
  ): Promise<string> {
    const anomalousIds = new Set(anomalies.flatMap(item => item.affectedSessionIds ?? [item.sessionId]));
    const perSession = sessions
      .filter(view => anomalousIds.has(view.config.id))
      .map(view => ({
        id: view.config.id,
        teammate: view.config.teammate,
        label: view.config.label,
        binary: view.config.binary,
        mode: view.config.mode,
        status: view.state.status,
        reason: view.state.reason,
        turn: view.state.turn,
        cwd: view.config.cwd,
        directory: view.directory,
        lastActivityAt: view.state.lastActivityAt,
        finishedAt: view.state.finishedAt,
        quota: view.state.quota,
      }));
    // For quota/rate-limited anomalies, precompute the usable same-kind failover
    // targets so the warden can `kteam migrate` without guessing which account is
    // free. Only probe usage when at least one such session is present.
    const quotaKinds = new Set<WardenAnomaly['kind']>(['quota_reset_passed']);
    const quotaViews = sessions.filter(
      view =>
        anomalousIds.has(view.config.id) &&
        (view.state.status === 'rate_limited' ||
          anomalies.some(item => item.sessionId === view.config.id && quotaKinds.has(item.kind))),
    );
    let migrateCandidates: Array<{ id: string; currentBinary: string; candidates: string[] }> = [];
    if (quotaViews.length > 0) {
      const usage = await this.fetchUsageAccounts();
      const agents = discoverAutoAgents(this.paths.kfleetBin);
      migrateCandidates = quotaViews.map(view => ({
        id: view.config.id,
        currentBinary: view.config.binary,
        candidates: rankFailoverCandidates({
          currentBinary: view.config.binary,
          harness: view.config.harness,
          agents,
          usage,
        }).slice(0, 5),
      }));
    }
    return [
      'You are the kteam FLEET WARDEN â layer-3 oversight for a team of autonomous coding agents.',
      `A deterministic sweep at ${at} found the anomalies below. Triage them and take only the SAFE, obvious recovery actions.`,
      '',
      '## ALLOWED actions',
      '- `kteam resume <id> [message]` a live session whose interruption is clearly transient (network, connection, timeout, overloaded, a dropped harness process). Read the session chat/turn files first.',
      '- `kteam send <id> <nudge>` a session that looks wedged but recoverable.',
      '- `kteam migrate <id> -a <wrapper>` a QUOTA/rate-limited session onto a usable same-kind account. Only pick a wrapper from that session\'s "Migrate candidates" list below (never guess) â the session keeps its conversation and continues on the new account.',
      "- Answer a question ONLY when its answer is unambiguous from that session's OWN chat.jsonl / turns/ files. If you must guess, do not answer.",
      '',
      '## FORBIDDEN â never do these',
      '- Do NOT remove (`kteam delete`) any session.',
      '- Stop only a session for which your warden capability authorizes `kteam stop`, and only with clear evidence that it is burning time/tokens with no progress.',
      '- Do NOT run any git operations, and do NOT edit any repository files.',
      '- Do NOT start any non-warden session.',
      '',
      '## Required output',
      `- Write a report to EXACTLY this path: ${reportPath}`,
      '- State the outcome and action per session; keep the report short.',
      '- Write one `## Anomaly: <session-id> â :<teammate> / <label>` section per anomaly record; repeat a session in separate sections when it has multiple anomaly kinds.',
      '- Put `- **Anomaly kind:** <kind>` inside EVERY anomaly section.',
      '- Put `Verdict: LEAVE|NUDGE|RESUME|KILL|NEEDS_HUMAN` inside EVERY anomaly section.',
      '- Put `- **Outcome:** <short reason>` directly under each verdict.',
      '- Never use one fleet-wide verdict as the verdict for multiple sessions.',
      '- Use NEEDS_HUMAN only for a genuine, explicit uncertainty about whether stopping would destroy needed work or cause irreversible harm. Otherwise act (or LEAVE) and log the outcome.',
      ...wardenReportInstructions(reportPath),
      '- When the sweep is done, run: `kteam signal done`.',
      '',
      '',
      '## Anomalies (deterministic detector output)',
      '```json',
      JSON.stringify(anomalies, null, 2),
      '```',
      '',
      '## Per-session status for the anomalous sessions',
      '```json',
      JSON.stringify(perSession, null, 2),
      '```',
      ...(migrateCandidates.length
        ? [
            '',
            '## Migrate candidates (usable same-kind accounts for quota/rate-limited sessions)',
            'If a candidate list is empty, do NOT migrate that session â leave it to wait for its quota reset.',
            '```json',
            JSON.stringify(migrateCandidates, null, 2),
            '```',
          ]
        : []),
      '',
      `The full anomaly file is at ${this.paths.wardenAnomalies}. Each session's durable directory (chat.jsonl, turns/, logs/) is listed above â read it before acting.`,
    ].join('\n');
  }

  private async saveWardenState(): Promise<void> {
    await atomicJson(this.paths.wardenState, this.wardenState);
  }

  /** Broadcast a transient event to live listeners without persisting it.
   *  Most are fleet-wide; a source adapter that must write a target session's
   *  durable board needs that real session id on the event envelope. */
  private emitTransient(type: string, payload: unknown, sessionId = 'fleet'): void {
    const event: KTeamEvent = {
      sequence: ++this.transientSequence,
      time: now(),
      sessionId,
      turn: 0,
      type,
      source: 'daemon',
      data: payload,
    };
    for (const listener of this.listeners) listener(event);
  }

  private async latestReport(): Promise<{ path: string; head: string } | undefined> {
    const files = await readdir(this.paths.wardenReports).catch(error => {
      if (isMissingPath(error)) return [] as string[];
      throw error;
    });
    const latest = files
      .filter(name => name.endsWith('.md'))
      .sort()
      .at(-1);
    if (!latest) return undefined;
    const file = path.join(this.paths.wardenReports, latest);
    const text = await readWardenReportFromDisk(file);
    return { path: file, head: text.split('\n').slice(0, 12).join('\n') };
  }

  async wrappers(): Promise<WrapperInfo[]> {
    return listWrappers(this.paths.kfleetBin);
  }

  async projects(): Promise<ProjectInfo[]> {
    return scanProjects(this.options.projectRoots ?? ['~/Workspace', '~/.config']);
  }

  /** Reconcile needs_human verdicts from recent warden reports into durable
   *  per-block requests. The scalar fields remain a short legacy/UI summary;
   *  exact suppression and Attention identity use the plural request list. */
  private async reconcileNeedsHuman(sessions: SessionView[]): Promise<void> {
    const verdicts = await this.wardenVerdicts().catch(() => [] as WardenVerdict[]);
    const byId = new Map(sessions.map(view => [view.config.id, view]));
    type NeedsHumanRequest = NonNullable<SessionState['needsHumanRequests']>[number];
    const requestKey = (request: Pick<NeedsHumanRequest, 'reportPath' | 'anomalyKind'>): string =>
      `${request.reportPath}\u0000${request.anomalyKind ?? ''}`;
    const wasAcknowledged = (
      acknowledged: SessionState['needsHumanAcknowledgedRequests'],
      request: Pick<NeedsHumanRequest, 'reportPath' | 'anomalyKind'>,
    ): boolean =>
      (acknowledged ?? []).some(
        item =>
          item.reportPath === request.reportPath &&
          (item.anomalyKind === undefined || item.anomalyKind === request.anomalyKind),
      );
    const requestsFrom = (state: SessionState, fallbackAt: string): NeedsHumanRequest[] => {
      const requests = [...(state.needsHumanRequests ?? [])];
      if (state.needsHuman && state.needsHumanReportPath) {
        const legacy: NeedsHumanRequest = {
          reason: state.needsHuman,
          reportPath: state.needsHumanReportPath,
          at: state.lastActivityAt ?? fallbackAt,
          ...(state.needsHumanKind ? { anomalyKind: state.needsHumanKind } : {}),
        };
        if (!requests.some(request => requestKey(request) === requestKey(legacy))) requests.push(legacy);
      }
      return requests;
    };
    for (const verdict of verdicts) {
      // Attention is a narrow exception: a report must explicitly use the
      // structured NEEDS_HUMAN verdict. Legacy prose may remain visible in
      // report history, but cannot turn into a durable human interruption.
      if (verdict.verdict !== 'needs_human' || verdict.explicitNeedsHuman !== true || !verdict.targetSession) continue;
      const view = byId.get(verdict.targetSession);
      if (!view) continue;
      const reason = verdict.reason ?? 'a warden concluded this session needs a human decision';
      const kind = verdict.anomalyKind;
      const request: NeedsHumanRequest = {
        reason,
        reportPath: verdict.reportPath,
        at: verdict.at,
        ...(kind ? { anomalyKind: kind } : {}),
      };
      if (wasAcknowledged(view.state.needsHumanAcknowledgedRequests, request)) continue;
      const existingRequests = requestsFrom(view.state, verdict.at);
      if (existingRequests.some(existing => requestKey(existing) === requestKey(request))) continue;
      let added = false;
      const persisted = await this.store
        .updateState<SessionState>(view.config.id, current => {
          if (wasAcknowledged(current.needsHumanAcknowledgedRequests, request)) return current;
          const currentRequests = requestsFrom(current, verdict.at);
          if (currentRequests.some(existing => requestKey(existing) === requestKey(request))) return current;
          const shouldUpdateSummary =
            current.needsHuman === undefined ||
            (current.needsHumanKind !== CODEX_PICKER_QUARANTINE_KIND &&
              parseWardenAnomalyKind(current.needsHumanKind) === undefined);
          added = true;
          return {
            ...current,
            ...(shouldUpdateSummary
              ? {
                  needsHuman: reason,
                  needsHumanKind: kind,
                  needsHumanReportPath: verdict.reportPath,
                }
              : {}),
            needsHumanRequests: [...currentRequests, request],
          };
        })
        .catch(() => undefined);
      if (!persisted || !added) continue;
      view.state.needsHuman = persisted.needsHuman;
      view.state.needsHumanKind = persisted.needsHumanKind;
      view.state.needsHumanReportPath = persisted.needsHumanReportPath;
      view.state.needsHumanRequests = persisted.needsHumanRequests;
      view.state.needsHumanAcknowledgedRequests = persisted.needsHumanAcknowledgedRequests;
      this.emitTransient(
        'fleet.needs_human',
        {
          sessionId: view.config.id,
          teammate: view.config.teammate,
          reason,
          reportPath: verdict.reportPath,
          anomalyKind: kind,
        },
        view.config.id,
      );
    }
  }

  /** A human acted on the session â clear the needs_human flag so the sweep
   *  resumes watching it. A Codex picker cleanup quarantine is different: a
   *  generic acknowledgement must not remove it until a caller has positively
   *  killed or replaced that pane. */
  private async clearNeedsHuman(id: string, options: { clearCodexPickerQuarantine?: boolean } = {}): Promise<void> {
    await this.store
      .updateState<SessionState>(id, current => {
        if (current.needsHuman === undefined && !(current.needsHumanRequests?.length ?? 0)) return current;
        if (current.needsHumanKind === CODEX_PICKER_QUARANTINE_KIND && !options.clearCodexPickerQuarantine)
          return current;
        const acknowledged = [...(current.needsHumanAcknowledgedRequests ?? [])];
        const remember = (reportPath: string | undefined, anomalyKind: string | undefined): void => {
          if (!reportPath) return;
          const candidate = { reportPath, ...(anomalyKind ? { anomalyKind } : {}) };
          const key = `${reportPath}\u0000${anomalyKind ?? ''}`;
          if (!acknowledged.some(item => `${item.reportPath}\u0000${item.anomalyKind ?? ''}` === key))
            acknowledged.push(candidate);
        };
        for (const request of current.needsHumanRequests ?? []) remember(request.reportPath, request.anomalyKind);
        remember(current.needsHumanReportPath, current.needsHumanKind);
        return {
          ...current,
          needsHuman: undefined,
          needsHumanKind: undefined,
          needsHumanReportPath: undefined,
          needsHumanRequests: undefined,
          needsHumanAcknowledgedRequests: acknowledged.slice(-200),
        };
      })
      .catch(() => undefined);
  }

  async wardenVerdicts(limit = 20): Promise<WardenVerdict[]> {
    return readWardenVerdictsFromDisk(this.paths, limit);
  }

  /** The cached `kfleet usage` feed, projected for the browser and keyed by
   *  wrapper binary.
   *
   *  Why an endpoint and not per-session state: session state only gains usage
   *  numbers when that session's monitor loop runs its 60s quota tick, so an
   *  idle/terminal session — and EVERY session for the first minute of its
   *  life — carries none, and a fleet list would render a sea of blanks next
   *  to a `kteam ps` that shows numbers. One feed the UI joins by binary is
   *  the same fact for every session, available immediately.
   *
   *  Never fabricates: before the first successful refresh this reports
   *  `stale: true` with no accounts, which the UI renders as "no data" rather
   *  than as 0%. */
  async usage(): Promise<UsageFeedView> {
    const accounts = await this.fetchUsageAccounts().catch(() => [] as AgentUsage[]);
    const at = this.usageFeed.snapshotAt();
    return {
      ...(at === undefined ? {} : { at: new Date(at).toISOString() }),
      stale: !this.usageFeed.hasSnapshot(),
      accounts: accounts.map(usageAccountView),
    };
  }

  async search(query: string, limit = 30): Promise<SearchResponse> {
    const q = (query ?? '').trim();
    if (!q) return { query: '', scanned: 0, results: [] };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) limit = 30;
    const MAX_SCAN = 150;
    // Fast reject: regex-test the raw file before parsing lines (most sessions
    // won't contain the term). Escaped so the query is a literal substring.
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    // Newest-first: search where the user most likely means.
    const sessions = (await this.list()).sort((a, b) => {
      const at = Date.parse(a.state.lastActivityAt ?? a.config.updatedAt ?? '') || 0;
      const bt = Date.parse(b.state.lastActivityAt ?? b.config.updatedAt ?? '') || 0;
      return bt - at;
    });
    const results: SearchResult[] = [];
    let scanned = 0;
    for (const v of sessions) {
      if (results.length >= limit || scanned >= MAX_SCAN) break;
      scanned++;
      // Chat lives in the HARNESS transcript now (chat_pointers). Fast-reject
      // against that file, exactly as this used to do against chat.jsonl, and
      // fall back to the legacy copy for pre-pointer sessions.
      const pointerCount = this.store.chatPointerCount(v.config.id);
      const legacyRaw = await readFile(path.join(sessionDir(this.paths, v.config.id), 'chat.jsonl'), 'utf8').catch(
        () => '',
      );
      const transcriptRaw = v.config.transcriptFile
        ? await readFile(v.config.transcriptFile, 'utf8').catch(() => '')
        : '';
      // Pointer sessions search the authoritative transcript directly. A
      // rebuilt-yet-empty pointer index also chooses it when there is no
      // legacy copy; a deleted harness file falls back to legacy history.
      const useTranscript = transcriptRaw.length > 0 && (pointerCount > 0 || legacyRaw.length === 0);
      const raw = useTranscript ? transcriptRaw : legacyRaw;
      if (!raw || !re.test(raw)) continue;
      const normalize =
        v.config.harness === 'codex'
          ? (line: string) => parseCodexTranscriptLine(line) as unknown[]
          : (line: string) => parseClaudeTranscriptLine(line) as unknown[];
      const records = raw
        .split('\n')
        .filter(Boolean)
        .flatMap(line => {
          try {
            return useTranscript ? normalize(line) : [JSON.parse(line) as unknown];
          } catch {
            return [];
          }
        });
      for (const m of searchRecords(records as Parameters<typeof searchRecords>[0], q, 3)) {
        results.push({
          sessionId: v.config.id,
          teammate: v.config.teammate ?? v.config.name,
          turn: m.turn,
          snippet: m.snippet,
          at: m.at,
        });
        if (results.length >= limit) break;
      }
    }
    return { query: q, scanned, results };
  }

  async wardenReport(reportPath: string): Promise<string> {
    // Validate: only files directly under the reports dir, no traversal.
    const dir = path.resolve(this.paths.wardenReports);
    const resolved = path.resolve(reportPath);
    if (path.dirname(resolved) !== dir || !resolved.endsWith('.md')) throw new Error('report not found');
    try {
      return await readWardenReportFromDisk(resolved);
    } catch (error) {
      if (isMissingPath(error)) throw new Error('report not found');
      throw error;
    }
  }

  async wardenStatus(): Promise<WardenStatusView> {
    let anomalies = this.lastSweep?.anomalies ?? [];
    let fingerprint = this.lastSweep?.fingerprint ?? '';
    let lastSweepAt = this.lastSweep?.at ?? this.wardenState.lastSweepAt;
    if (!this.lastSweep) {
      const disk = await readJsonIfPresent<{ at?: string; fingerprint?: string; anomalies?: WardenAnomaly[] }>(
        this.paths.wardenAnomalies,
      );
      if (disk) {
        anomalies = disk.anomalies ?? [];
        fingerprint = disk.fingerprint ?? '';
        lastSweepAt = disk.at ?? lastSweepAt;
      }
    }
    const liveWarden = (await this.list()).find(
      view => view.config.label === WARDEN_LABEL && !protectedStatuses.includes(view.state.status),
    )?.config.id;
    return {
      config: this.wardenConfig,
      lastSweepAt,
      anomalies,
      fingerprint,
      liveWarden,
      lastSpawnAt: this.wardenState.lastSpawnAt,
      lastReport: await this.latestReport(),
      failover: await this.wardenFailoverStatus(),
    };
  }

  /** Lightweight anomaly-only view for the in-process Attention baseline. It
   *  deliberately avoids wardenFailoverStatus(), which may refresh kfleet usage
   *  and must not hold daemon bootstrap on an external probe. */
  async wardenAnomalies(): Promise<WardenAnomaly[]> {
    if (this.lastSweep) return this.lastSweep.anomalies;
    const disk = await readJsonIfPresent<{ anomalies?: WardenAnomaly[] }>(this.paths.wardenAnomalies);
    return disk?.anomalies ?? [];
  }

  /** The failover block of wardenStatus: effective accounts with live health,
   *  the policy knobs, the last selection, and any exhaustion episode. */
  private async wardenFailoverStatus(): Promise<NonNullable<WardenStatusView['failover']>> {
    const config = this.wardenConfig;
    const failover = effectiveFailoverConfig(config);
    const usage = await this.fetchUsageAccounts().catch(() => [] as AgentUsage[]);
    const usageByBinary = new Map(usage.map(item => [item.binary, item]));
    let installed: string[] = [];
    try {
      installed = discoverAutoAgents(this.paths.kfleetBin);
    } catch {}
    const state = this.wardenState.failover ?? {};
    const nowMs = Date.now();
    const accounts = normalizeWardenAccounts(config).map(account => {
      const reason = ineligibilityReason(account, { installedAgents: installed, usage, state, nowMs });
      const record = usageByBinary.get(account.wrapper);
      const quota = record ? quotaFromUsage(record) : undefined;
      return {
        wrapper: account.wrapper,
        ...(account.model !== undefined ? { model: account.model } : {}),
        eligible: reason === undefined,
        ...(reason !== undefined ? { reason } : {}),
        ...(state.demotedUntil?.[account.wrapper] !== undefined
          ? { demotedUntil: state.demotedUntil[account.wrapper] }
          : {}),
        ...(state.strikes?.[account.wrapper] !== undefined ? { strikes: state.strikes[account.wrapper]!.count } : {}),
        ...(quota
          ? {
              quota: {
                ...(quota.fiveHourPercent !== undefined ? { fiveHourPercent: quota.fiveHourPercent } : {}),
                ...(quota.weeklyPercent !== undefined ? { weeklyPercent: quota.weeklyPercent } : {}),
                ...(quota.atLimit !== undefined ? { atLimit: quota.atLimit } : {}),
                ...(quota.authOk !== undefined ? { authOk: quota.authOk } : {}),
              },
            }
          : {}),
      };
    });
    return {
      policy: failover.policy,
      failureThreshold: failover.failureThreshold,
      cooldownMinutes: failover.cooldownMinutes,
      accounts,
      ...(state.lastSelection ? { lastSelection: state.lastSelection } : {}),
      ...(state.exhaustedSince !== undefined ? { exhaustedSince: state.exhaustedSince } : {}),
    };
  }

  async wardenConfigView(): Promise<WardenConfigView> {
    return this.describeWardenConfig(this.wardenConfig);
  }

  private describeWardenConfig(config: WardenConfig): WardenConfigView {
    const accounts = normalizeWardenAccounts(config);
    const warnings: string[] = [];
    let installed: string[] = [];
    try {
      installed = discoverAutoAgents(this.paths.kfleetBin);
    } catch {}
    if (installed.length > 0) {
      for (const account of accounts) {
        if (!installed.includes(account.wrapper))
          warnings.push(
            `wrapper ${account.wrapper} is not installed in ~/.kfleet/bin (it will be skipped until it appears)`,
          );
      }
    }
    if (accounts.length === 0) warnings.push('no warden accounts are configured');
    return { config, accounts, warnings };
  }

  /** Apply a partial warden-config update LIVE: validate + normalize, persist
   *  to daemon config.json (read-modify-write via atomicJson so non-warden keys
   *  survive untouched), swap the in-memory config, and re-arm the sweep timer
   *  when the interval changed. Unknown wrappers WARN, never reject — kfleet
   *  may be about to create them, and rejecting would order-couple two tools.
   *  Sweeps serialize on wardenSweepChain, so an in-flight sweep finishes under
   *  the old config and the next one reads the new. */
  async updateWardenConfig(patch: WardenConfigPatch): Promise<WardenConfigView> {
    const current = this.wardenConfig;
    const next: WardenConfig = {
      ...current,
      ...patch,
      failover: { ...effectiveFailoverConfig(current), ...(patch.failover ?? {}) },
      providerOutage: {
        ...defaultProviderOutageConfig(),
        ...(current.providerOutage ?? {}),
        ...(patch.providerOutage ?? {}),
      },
    };
    validateWardenConfigPatch(next);
    const onDisk = await readJson<Record<string, unknown>>(this.paths.daemonConfig).catch(
      () => ({}) as Record<string, unknown>,
    );
    await atomicJson(this.paths.daemonConfig, { ...onDisk, warden: next });
    const previousInterval = current.intervalMinutes;
    this.wardenConfigOverride = next;
    if (next.intervalMinutes !== previousInterval && this.wardenTimer !== undefined) {
      clearInterval(this.wardenTimer);
      const intervalMs = Math.max(60_000, next.intervalMinutes * 60_000);
      this.wardenTimer = setInterval(() => {
        void this.runSweep(false).catch(() => undefined);
      }, intervalMs);
    }
    this.emitTransient('warden.config_changed', { fields: Object.keys(patch) });
    return this.describeWardenConfig(next);
  }

  async wardenRun(spawn = false): Promise<WardenRunView> {
    return await this.runSweep(spawn);
  }
}

/** Reject a warden-config write that is structurally broken (wrong types /
 *  out-of-range numbers). Wrapper EXISTENCE is deliberately not validated here
 *  — that is a warning (see describeWardenConfig). */
function validateWardenConfigPatch(config: WardenConfig): void {
  const bad = (message: string) => {
    throw new Error(`invalid warden config: ${message}`);
  };
  if (typeof config.enabled !== 'boolean') bad('enabled must be a boolean');
  if (typeof config.wrapper !== 'string' || config.wrapper.trim() === '') bad('wrapper must be a non-empty string');
  if (config.accounts !== undefined) {
    if (!Array.isArray(config.accounts)) bad('accounts must be an array');
    for (const entry of config.accounts ?? []) {
      const wrapper = typeof entry === 'string' ? entry : entry?.wrapper;
      if (typeof wrapper !== 'string' || wrapper.trim() === '')
        bad('every accounts entry needs a non-empty wrapper name');
      if (typeof entry === 'object' && entry.model !== undefined && typeof entry.model !== 'string')
        bad('an account model override must be a string');
    }
  }
  const failover = config.failover;
  if (failover !== undefined) {
    if (failover.policy !== 'fallback' && failover.policy !== 'round_robin')
      bad("failover.policy must be 'fallback' or 'round_robin'");
    if (!Number.isFinite(failover.failureThreshold) || failover.failureThreshold < 1)
      bad('failover.failureThreshold must be a number >= 1');
    if (!Number.isFinite(failover.cooldownMinutes) || failover.cooldownMinutes < 0)
      bad('failover.cooldownMinutes must be a number >= 0');
  }
  const providerOutage = config.providerOutage;
  if (providerOutage !== undefined) {
    if (!Number.isFinite(providerOutage.minDistinctSessions) || providerOutage.minDistinctSessions < 2)
      bad('providerOutage.minDistinctSessions must be a number >= 2');
    if (!Number.isFinite(providerOutage.persistenceSweeps) || providerOutage.persistenceSweeps < 2)
      bad('providerOutage.persistenceSweeps must be a number >= 2');
    if (!Number.isFinite(providerOutage.tailLines) || providerOutage.tailLines < 8 || providerOutage.tailLines > 80)
      bad('providerOutage.tailLines must be a number between 8 and 80');
  }
  for (const [key, minimum] of [
    ['intervalMinutes', 1],
    ['unattendedMinutes', 1],
    ['minSpawnGapMinutes', 0],
    ['maxAssignedWardens', 1],
    ['assignedCooldownMinutes', 0],
    ['blessMinutes', 0],
  ] as const) {
    const value = config[key];
    if (!Number.isFinite(value) || (value as number) < minimum) bad(`${key} must be a number >= ${minimum}`);
  }
}
