import { appendFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { AttachmentStore, type StoredAttachment } from './attachments';
import {
  startClaudeTranscriptWatcher,
  type ClaudeNormalizedEvent,
  type ClaudeTranscriptWatcher,
} from './claude-transcript';
import {
  startCodexTranscriptWatcher,
  type CodexNormalizedEvent,
  type CodexTranscriptWatcher,
} from './codex-transcript';
import {
  contextWindowForModel,
  discoverAutoAgents,
  inferHarness,
  modelHint,
  shellSafeSessionName,
  startWaitMsFor,
} from './core';
import { listWrappers, scanProjects, type ProjectInfo, type WrapperInfo } from './fleet-inventory';
import { currentActor } from './actor-context';
import { parseWardenReports, type WardenVerdict } from './warden-verdicts';
import {
  discoverCodexSession,
  codexSessionIds,
  resolveBinary,
  wrapperHome,
  wrapperModel,
  claudeTranscriptPath,
} from './harness';
import type { WardenConfig } from './daemon-config';
import { atomicJson, now, readJson, run, writeTextAtomic } from './io';
import { NAME_WINDOW_MS, pickTeammateName, sessionName } from './names';
import type { KTeamPaths } from './paths';
import { configFile, markerFile, sessionDir, stateFile, turnLog, turnPrompt } from './paths';
import type {
  AttachmentView,
  KTeamService,
  SearchResponse,
  SearchResult,
  SessionView,
  WardenRunView,
  WardenStatusView,
} from './service';
import { searchRecords } from './transcript-search';
import {
  detectAnomalies,
  fingerprintAnomalies,
  WAITING_BACKSTOP_MS,
  WARDEN_LABEL,
  type WardenAnomaly,
  type WardenSessionView,
} from './warden-detect';
import { rankFailoverCandidates, selectFailoverCandidate } from './failover';
import type { AgentUsage } from './core';
import { EventStore, type JsonValue, type SessionEvent } from './storage';
import {
  contextPercentUsed,
  backgroundTerminalCount,
  foldStallLiveness,
  paneActivityLine,
  paneShowsActiveWork,
  TmuxController,
  type StallLivenessState,
} from './tmux-controller';
import { reflexAssess, renderLivenessYaml, susFindings, type LivenessLedger } from './liveness';
import type {
  KTeamEvent,
  SendDisposition,
  SendRequest,
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
   *  async work — without this they each start one, doubling every event and
   *  leaking the loser (which nothing ever stops). */
  transcriptStarting?: Promise<void>;
  loop?: Promise<void>;
  /** Interrupts the loop's current sleep so a freshly queued send is
   *  considered immediately instead of after the full tick. */
  wake?: () => void;
}
interface StoredEnvelope {
  source?: KTeamEvent['source'];
  turn?: number;
  payload?: unknown;
  globalSequence?: number;
}
interface SessionManagerOptions {
  healthIntervalSeconds: number;
  quotaUrl: string;
  transcriptReconcileSeconds: number;
  publicUrl: string;
  projectRoots: string[];
  warden: WardenConfig;
  contextWindows?: Record<string, number>;
  /** Invoked when the daemon decides its own index is unhealable and a clean
   *  restart is the only repair. The entrypoint owns HOW (and WHETHER — only a
   *  process a service manager will re-spawn may exit); the manager only
   *  decides WHEN. Returns false when it declined, so the manager can say so. */
  onSelfRestart?: () => boolean | Promise<boolean>;
}
interface WardenRuntimeState {
  lastSweepAt?: string;
  lastSpawnAt?: string;
  /** The escalation-suppression key of the last spawn: the anomaly fingerprint
   *  qualified by `recoveryGeneration` (`<gen>:<fingerprint>`). Qualifying by the
   *  generation means an anomaly set that RECURS after a clean recovery escalates
   *  again instead of being suppressed as "unchanged". */
  lastSpawnFingerprint?: string;
  /** Fingerprint of the most recent sweep — used to detect the non-empty→empty
   *  transition that marks a recovery. */
  lastFingerprint?: string;
  /** Bumped every time the fleet goes from having anomalies to having none. */
  recoveryGeneration?: number;
  /** Live assigned-warden records, keyed by TARGET session id. The api-server
   *  consults these (via wardenMayStop) to let the warden token stop ONLY
   *  sessions under an active assignment. `capability` is the unguessable
   *  secret minted at spawn and exported only into that warden's pane —
   *  authorization compares capabilities, never client-chosen identities. */
  assignments?: Record<string, { wardenId: string; spawnedAt: string; capability: string }>;
  /** Per-target cooldown after an assigned warden finished (verdict given):
   *  no respawn for the same session within assignedCooldownMinutes. */
  assignedCooldowns?: Record<string, string>;
}
interface WardenSweep {
  at: string;
  anomalies: WardenAnomaly[];
  fingerprint: string;
}
interface ResumeGuard {
  status: SessionStatus;
  retryAttempt?: number;
}
interface QuotaWaiter {
  abort: AbortController;
  promise: Promise<void>;
}

class ResumeCancelled extends Error {}

const terminalStatuses: SessionStatus[] = ['completed', 'failed', 'stalled', 'stopped'];
const protectedStatuses: SessionStatus[] = [...terminalStatuses, 'kill_failed'];
const waitingStatuses: SessionStatus[] = ['waiting', 'awaiting_question', 'awaiting_user', 'rate_limited'];
/** Statuses a session can hold BEFORE its tmux pane has ever been created.
 *  In these the absence of a pane means "not launched yet", never "crashed". */
const preLaunchStatuses: SessionStatus[] = ['created', 'starting'];
/** How far back a FLEET-WIDE replay cursor may reach. The cross-session feed
 *  is a live stream, not an archive: a client asking for the whole fleet from
 *  sequence 0 would page through every event ever recorded. Per-session
 *  replay stays complete — only the fleet feed is windowed. */
const GLOBAL_BACKLOG_MAX = 5_000;
/** A self-check tick this late means the event loop stopped running: the
 *  timer interval is 60 s, so three missed ticks is unambiguous. */
const WEDGE_GAP_MS = 180_000;
/** A terminal session whose journal keeps growing this long after finishedAt
 *  is still doing work nothing supervises (and `ps` cannot show). */
const TERMINAL_ACTIVITY_GRACE_MS = 60_000;
/** Consecutive consistency passes that failed to heal the index before a
 *  clean self-restart is requested. */
const INCOHERENT_RESTART_THRESHOLD = 3;
/** Minimum wall-clock gap between two self-restarts, across process lifetimes. */
const SELF_RESTART_COOLDOWN_MS = 30 * 60_000;
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
/** How long a queued first launch is given before the self-check stops
 *  excluding it and repairs (or fails) it like any other session. */
const LAUNCH_GRACE_MS = 10 * 60_000;
/** How many sessions the boot-time global-sequence migration walks (newest
 *  first). The fleet feed is a recent window, and any older session heals on
 *  its first replay — so boot pays for the useful end only, not for every
 *  journal ever written. */
const GLOBAL_BACKFILL_SESSIONS = 50;
/** How often a declared wait publishes a heartbeat, so "parked" never looks
 *  the same as "gone" to a lead reading the event stream. */
const WAITING_HEARTBEAT_MS = 300_000;

/** True when the reflex layer and the turn ceiling must stand down: a declared
 *  wait, a waiting status, or an interrupted turn. `state.waiting` — not the
 *  status — is the authority for a park, because transcript records recompute
 *  the status every few seconds. */
export function lifecycleSuspended(state: SessionState): boolean {
  return state.waiting !== undefined || waitingStatuses.includes(state.status) || state.status === 'interrupted';
}

/** The turn ceiling, with declared-wait time credited back: a babysitter parked
 *  for three hours has not been RUNNING for three hours. */
export function turnCeilingMs(config: Pick<SessionConfig, 'timeoutSeconds'>, state: SessionState): number {
  return (config.timeoutSeconds + (state.waitingCreditSeconds ?? 0)) * 1000;
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
  // Only a real ISO-8601 DATE is accepted here. Date.parse is far looser —
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

export class SessionManager implements KTeamService {
  private readonly tmux: TmuxController;
  private readonly attachments: AttachmentStore;
  private readonly monitors = new Map<string, MonitorHandle>();
  private readonly listeners = new Set<(event: KTeamEvent) => void>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly deleting = new Set<string>();
  private readonly autoContinued = new Set<string>();
  /** One-shot flags for done-markers deferred while the pane is still working. */
  private readonly doneDeferred = new Set<string>();
  /** Sessions whose FIRST launch is still queued behind the bootstrap chain.
   *  Their tmux session does not exist yet, so a monitor started for them
   *  would read a dead pane and mark a launching session `failed` — and a
   *  terminal status suppresses every later patch, including the launch's own
   *  `session.running`. Bounded `start`/`--detach` make this window routine.
   *
   *  Registered BEFORE the `starting` transition on purpose: transition()
   *  awaits emit(), which rides the global event queue, and under a launch
   *  storm that queue ran 10+ seconds behind. Registering after it left a
   *  window where the session was persisted as `starting` but unknown to this
   *  map — the self-check then "repaired" it with a monitor that read a pane
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
  /** id → when this declared wait last published a heartbeat. */
  private readonly waitingHeartbeats = new Map<string, number>();
  /** TUI bootstrap (launch + first inject) serialized ACROSS sessions: rapid
   *  concurrent starts race the injector — only the first survives, the rest
   *  land typed-but-never-started. */
  private bootstrapChain: Promise<void> = Promise.resolve();
  private readonly quotaWaiters = new Map<string, QuotaWaiter>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private globalSequence = 0;
  private globalEventQueue: Promise<void> = Promise.resolve();
  private closed = false;
  /** Fleet warden (layer-3 oversight): a periodic deterministic sweep plus,
   *  when enabled, rate-limited LLM escalation. */
  private wardenTimer?: ReturnType<typeof setInterval>;
  /** Armed in create(), independent of bootstrap — the watchdog for the
   *  silent-partial-boot class. */
  private selfCheckTimer?: ReturnType<typeof setInterval>;
  /** True once the boot import finished: the consistency check is meaningless
   *  before it (everything on disk is legitimately unindexed). */
  private indexImported = false;
  /** When the self-check last ran; its lateness is the wedge detector. */
  private lastSelfCheckAt = 0;
  /** Consecutive consistency passes that left `ps` incomplete. */
  private consecutiveIncoherentChecks = 0;
  private selfRestartRequested = false;
  /** An unhealable index has already been reported (once per daemon). */
  private selfRestartAnnounced = false;
  private wardenState: WardenRuntimeState = {};
  private lastSweep?: WardenSweep;
  private lastEmittedFingerprint = '';
  /** Serializes sweeps so a forced `warden run` never races the interval. */
  private wardenSweepChain: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly paths: KTeamPaths,
    private readonly store: EventStore,
    private readonly options: SessionManagerOptions,
  ) {
    this.tmux = new TmuxController(paths, options.publicUrl);
    this.attachments = new AttachmentStore({ rootDir: paths.home });
  }

  static async create(paths: KTeamPaths, options: SessionManagerOptions): Promise<SessionManager> {
    await mkdir(paths.daemon, { recursive: true, mode: 0o700 });
    // Open WITHOUT the disk import: the journal scan (even incremental) must
    // never hold the API bind hostage. bootstrap() runs it after listen.
    const store = await EventStore.open({ home: paths.home, databasePath: paths.database, importExisting: false });
    const manager = new SessionManager(paths, store, options);
    // Self-check timer armed HERE — independent of bootstrap, so it survives
    // any bootstrap failure and flags the residue (the class the user had to
    // spot by eyeballing a timestamp on 2026-07-23).
    manager.selfCheckTimer = setInterval(() => void manager.selfCheck().catch(() => undefined), 60_000);
    return manager;
  }

  /** Detect the silent-partial-boot class: active sessions without a monitor,
   *  and a warden sweep that stopped happening (timer dead or wedged). Emits
   *  a fleet.self_check_failed transient and — where safe — repairs by
   *  starting the missing monitors and re-arming the warden. */
  private async selfCheck(): Promise<void> {
    if (this.closed) return;
    // The timer's OWN lateness is the wedge detector: this interval fires
    // every 60 s, so a multi-minute gap means the event loop was starved (the
    // 2026-07-23 incident: 23:26:46Z → 23:37:55Z, no timers, no accepts).
    // Nothing the daemon believes about the fleet survives that gap
    // unverified, so a wedge always forces a full consistency pass.
    const tickAt = Date.now();
    const gapMs = this.lastSelfCheckAt === 0 ? 0 : tickAt - this.lastSelfCheckAt;
    this.lastSelfCheckAt = tickAt;
    const wedged = gapMs >= WEDGE_GAP_MS;
    if (wedged) {
      const gapSeconds = Math.round(gapMs / 1000);
      console.error(
        `kteamd self-check: event loop was starved for ${gapSeconds}s (timer gap) — verifying index against session directories`,
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
        // …but only while the launch is plausibly still queued. A bootstrap
        // that never finishes (one hung tmux command holds the whole chain)
        // must not hide its session from repair forever.
        !this.launchingRecently(view.config.id),
    );
    const lastSweepMs = this.wardenState.lastSweepAt ? Date.parse(this.wardenState.lastSweepAt) : 0;
    const sweepStale =
      this.wardenTimer === undefined ||
      (lastSweepMs > 0 &&
        Date.now() - lastSweepMs > Math.max(120_000, this.options.warden.intervalMinutes * 60_000 * 3));
    if (unmonitored.length === 0 && !sweepStale) return;
    this.emitTransient('fleet.self_check_failed', {
      unmonitoredRunning: unmonitored.map(view => view.config.id),
      wardenTimerArmed: this.wardenTimer !== undefined,
      wardenLastSweepAt: this.wardenState.lastSweepAt,
      bootstrapErrors: this.bootstrapErrors,
    });
    console.error(
      `kteamd self-check: ${unmonitored.length} running session(s) without a monitor` +
        `${sweepStale ? '; warden sweep stale/dead' : ''} — repairing`,
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
   *  the authority. After the 2026-07-23 wedge the two disagreed — sessions
   *  were missing from `ps` while their journals kept growing — and only a
   *  full daemon restart restored coherence.
   *
   *  This is that reconciliation, made routine: membership is compared every
   *  tick (cheap), and a deep pass (per-session state + zombie detection)
   *  runs after a wedge or whenever membership drifted. Everything found is
   *  repaired in place — reindex the row, re-adopt the session with a live
   *  monitor — and only a discrepancy that SURVIVES repair escalates to a
   *  clean self-restart, so restarts stay a last resort (they cost every live
   *  pane in the fleet). */
  private async consistencyCheck(deep: boolean): Promise<ConsistencyReport> {
    const report: ConsistencyReport = { missingFromIndex: [], staleRows: [], zombies: [], repaired: [] };
    // Never race the boot import. Until it finishes, EVERY session directory
    // legitimately looks "missing from the index" — repairing against that
    // would duplicate the import's work and, three passes in, restart a daemon
    // that was merely still booting (a permanent boot loop).
    if (!this.indexImported) return report;
    const onDisk = await this.store.sessionIdsOnDisk();
    const onDiskSet = new Set(onDisk);
    const indexed = this.store.listSessions();
    const indexedIds = new Set(indexed.map(item => item.id));
    for (const id of onDisk) if (!indexedIds.has(id)) report.missingFromIndex.push(id);
    if (deep || report.missingFromIndex.length > 0) {
      for (const item of indexed) {
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
        `${report.zombies.length} terminal-but-active — repairing`,
    );
    for (const id of [...report.missingFromIndex, ...report.staleRows]) {
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
    for (const id of report.zombies) {
      // ONCE per session per daemon lifetime. The re-adopt itself would
      // otherwise re-trigger its own detector — the readopt event lands in the
      // journal whose mtime IS the zombie test, and a monitor over a dead pane
      // exits immediately — so an unguarded repair loops forever.
      if (this.monitors.has(id) || this.readoptedZombies.has(id)) continue;
      this.readoptedZombies.add(id);
      await this.startMonitor(id).then(
        () => report.repaired.push(id),
        error => console.error(`kteamd consistency: re-adopt of ${id} failed: ${String(error)}`),
      );
    }
    // Verify the repair rather than trusting it: membership that is STILL
    // wrong after reindexing means the index cannot be healed in place.
    const stillMissing = (await this.store.sessionIdsOnDisk()).filter(id => !this.store.getSession(id));
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
   *  declared finished — the "done-marked but still writing events" shape. */
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
   *  quiescent close — never a hard exit that abandons in-flight writes. */
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
    const headline =
      `kteamd: session index is unhealable after ${this.consecutiveIncoherentChecks} passes ` +
      `(${unhealable.length} session(s) invisible to ps) — `;
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
        sessions: unhealable.slice(0, 20),
        consecutive: this.consecutiveIncoherentChecks,
        ...data,
      });
    };
    if (cooling) {
      announceOnce(
        `NOT restarting: a self-restart already happened within ${Math.round(SELF_RESTART_COOLDOWN_MS / 60_000)}m — this needs a human`,
        { supervised: true, cooling: true },
      );
      return;
    }
    this.selfRestartRequested = true;
    // Stamp BEFORE handing over: the handler drains and exits, so a stamp
    // written after it may never land — and an unstamped restart loses the
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
   *  API socket is listening — early requests see a possibly-partial index
   *  (which only grows) rather than a connection refused. */
  /** Errors collected during bootstrap — surfaced via /v1/health so a partial
   *  boot can never be silent again (2026-07-23 06:23 incident: bootstrap
   *  died quietly mid-recover, 4 running sessions unmonitored, warden timer
   *  never armed, nothing logged). */
  readonly bootstrapErrors: string[] = [];

  async bootstrap(): Promise<void> {
    // Partition-tolerant and LOUD: each phase runs even if an earlier one
    // threw; every failure is logged AND kept for the health endpoint. The
    // self-check timer (armed in create(), independent of this chain) watches
    // for the residue: unmonitored running sessions, dead warden timer.
    const phase = async (name: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        const message = `bootstrap phase ${name} failed: ${error instanceof Error ? error.message : String(error)}`;
        this.bootstrapErrors.push(message);
        console.error(`kteamd: ${message}`);
      }
    };
    await phase('import', () => this.store.importFromDisk());
    // Set even when the phase FAILED: a partial index is exactly what the
    // consistency check should repair — it just must not race the import.
    this.indexImported = true;
    await phase('global-sequence', () => this.initializeGlobalSequence());
    await phase('recover', () => this.recover());
    await phase('warden', () => this.startWarden());
    await phase('global-sequence-backfill', () => this.backfillGlobalSequences());
    if (this.bootstrapErrors.length > 0) {
      this.emitTransient('fleet.bootstrap_errors', { errors: this.bootstrapErrors });
    }
  }

  /** One-time migration for index rows written before events carried an
   *  indexed global sequence. Newest session first — the useful end of the
   *  fleet feed is correct within seconds — and one session per turn of the
   *  loop, so the migration never starves the event loop it exists to
   *  protect. */
  private async backfillGlobalSequences(limit = GLOBAL_BACKFILL_SESSIONS): Promise<void> {
    let migrated = 0;
    while (!this.closed && migrated < limit) {
      const next = this.store.nextSessionNeedingGlobalBackfill();
      if (next === undefined) break;
      await this.store.backfillGlobalSequence(next);
      migrated += 1;
      await Bun.sleep(5);
    }
    if (migrated > 0)
      console.log(
        `kteamd: global-sequence backfill covered ${migrated} recent session(s)` +
          `${this.store.nextSessionNeedingGlobalBackfill() ? '; older ones heal on first replay' : ''}`,
      );
  }

  async close(): Promise<void> {
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
    await Promise.allSettled([...this.queues.values(), this.globalEventQueue]);
    this.store.close();
  }

  async health(): Promise<Record<string, unknown>> {
    const sessions = await this.list();
    const active = sessions.filter(item => !terminalStatuses.includes(item.state.status));
    // Self-check surface (2026-07-23 silent-bootstrap incident): the operator
    // must be able to see — and the sweep must be able to flag — a partial
    // boot without eyeballing timestamps.
    const unmonitoredRunning = active.filter(item => !this.monitors.has(item.config.id)).length;
    const lastSweepMs = this.wardenState.lastSweepAt ? Date.parse(this.wardenState.lastSweepAt) : 0;
    return {
      ok: this.bootstrapErrors.length === 0 && unmonitoredRunning === 0,
      version: '0.2.0',
      pid: process.pid,
      home: this.paths.home,
      sessions: sessions.length,
      running: active.length,
      monitors: this.monitors.size,
      unmonitoredRunning,
      wardenLastSweepSeconds: lastSweepMs > 0 ? Math.floor((Date.now() - lastSweepMs) / 1000) : null,
      wardenTimerArmed: this.wardenTimer !== undefined,
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

  /** Canonicalize a session reference: an exact id passes through; otherwise try
   *  it as a teammate name (case-insensitive) among sessions created within the
   *  name window — most recent wins. Unknown refs pass through so the caller's
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

  /** Assign a fresh teammate callsign, avoiding names used within the window. */
  private assignTeammateName(): string {
    const recent: string[] = [];
    const lastUsedAt = new Map<string, number>();
    const cutoff = Date.now() - NAME_WINDOW_MS;
    for (const item of this.store.listSessions()) {
      const config = item.config as SessionConfig | undefined;
      if (!config?.teammate) continue;
      const name = config.teammate.toLowerCase();
      const created = Date.parse(config.createdAt) || 0;
      if (created >= cutoff) recent.push(name);
      lastUsedAt.set(name, Math.max(lastUsedAt.get(name) ?? 0, created));
    }
    return pickTeammateName(recent, lastUsedAt);
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

  async start(request: StartSessionRequest): Promise<SessionView> {
    const prompt = request.prompt?.trim();
    if (!prompt) throw new Error('prompt is required');
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
    const mode = request.mode ?? 'auto';
    if (mode !== 'auto' && mode !== 'interactive') throw new Error('mode must be auto or interactive');
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
    // start route outright — this is the server-side backstop.)
    const forcedWarden = await this.hasWardenAncestor(parentView?.config.id);
    const label = forcedWarden ? WARDEN_LABEL : request.label?.trim() || parentView?.config.label || undefined;
    // Model resolution: explicit request wins, else the wrapper's kfleet default
    // (KTEAM_MODEL). A default is always fed in when kfleet declares one, so the
    // per-account default model can't silently drift; undefined => no --model.
    const model = request.model?.trim() || (await wrapperModel(wrapper));

    // Preflight 1 — duplicate guard: a client retrying start after a transient
    // error must not spawn a second live session for the same work. An
    // identical (binary, cwd, prompt) session started in the last 10 minutes
    // that is still live IS that earlier request succeeding server-side.
    for (const existing of await this.list()) {
      if (
        existing.config.binary === binary &&
        existing.config.cwd === cwd &&
        !terminalStatuses.includes(existing.state.status) &&
        Date.now() - Date.parse(existing.config.createdAt) < 600_000 &&
        (await readFile(existing.config.originalPromptFile, 'utf8').catch(() => '')).trim() === prompt
      ) {
        throw new Error(
          `an identical session is already live: ${existing.config.id} (${existing.state.status}); ` +
            'the earlier start succeeded — use it, or stop it first',
        );
      }
    }
    // Preflight 2 — quota/auth: launching on an exhausted or logged-out
    // account burns a session that can only no-op. Fail fast, wrapper named.
    const preflightQuota = await this.fetchQuota({ binary } as SessionConfig);
    if (preflightQuota?.atLimit === true) {
      const reset = preflightQuota.resetAt ? ` (resets ${new Date(preflightQuota.resetAt).toISOString()})` : '';
      throw new Error(`wrapper ${binary} is at its usage limit${reset}; pick another account`);
    }
    if (preflightQuota?.authOk === false) {
      throw new Error(`wrapper ${binary} is not logged in (kfleet usage reports auth failure); run kfleet login`);
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
          throw new Error('initial image exceeds the 20 MiB decoded limit');
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
      name: sessionName(request.name ?? prompt.split(/\s+/).slice(0, 5).join('-')),
      teammate: this.assignTeammateName(),
      label,
      parent: parentView?.config.id,
      binary,
      harness,
      modelHint: modelHint(binary),
      model,
      mode,
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
    };
    const systemPrompt = this.systemPrompt(config);
    await Promise.all([
      this.store.writeConfig(id, config),
      this.store.writeState(id, state),
      writeFile(config.systemPromptFile, systemPrompt, { mode: 0o600 }),
      writeFile(config.originalPromptFile, `${assignedPrompt}\n`, { mode: 0o600 }),
      writeFile(turnPrompt(this.paths, id, 1), `${systemPrompt}\n# Assigned task\n\n${assignedPrompt}\n`, {
        mode: 0o600,
      }),
      writeFile(turnLog(this.paths, id, 1), '', { mode: 0o600 }),
      writeFile(path.join(directory, 'chat.jsonl'), '', { mode: 0o600 }),
      writeFile(path.join(directory, 'channel', 'inbox.jsonl'), '', { mode: 0o600 }),
      writeFile(path.join(directory, 'channel', 'outbox.jsonl'), '', { mode: 0o600 }),
    ]);
    // Claim the launch window BEFORE anything that awaits the event queue.
    // `emit`/`transition` can sit behind a 10-second global queue during a
    // launch storm, and everything that protects a launching session keys off
    // this map — registering it later left the session visible as `starting`
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
    // the daemon went on to create the session anyway — a launch reported as
    // failed that a retry then duplicated. So the REQUEST is bounded here: the
    // session is already persisted and its bootstrap keeps running in the
    // background, and the caller gets a real view of a 'starting' session
    // instead of an open socket and a timeout.
    const bootstrap = this.bootstrapSession(id, config).finally(() => {
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
    await this.awaitBootstrap(id, bootstrap, request.detach === true ? 0 : startWaitMsFor(binary, START_WAIT_MS));
    return await this.get(id);
  }

  /** Wait for a launch, but only for `waitMs`. A bootstrap that fails inside
   *  the window throws (callers keep today's fast-failure semantics); one that
   *  is merely SLOW is announced and left running in the background. */
  private async awaitBootstrap(id: string, bootstrap: Promise<void>, waitMs: number): Promise<void> {
    let bootstrapError: unknown;
    const guarded = bootstrap.catch(error => {
      bootstrapError = error;
    });
    const settled = await Promise.race([guarded.then(() => true), Bun.sleep(waitMs).then(() => false)]);
    if (settled) {
      if (bootstrapError !== undefined) throw bootstrapError;
      return;
    }
    // A backgrounded launch is PENDING, never failed: the session keeps its
    // `starting` status and the bootstrap resolves it (session.launch_settled
    // → running, or the normal failure path with the real reason).
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
            : `launch still in progress after ${Math.round(waitMs / 1000)}s (bootstrap queue); it continues in the background`,
      },
      'daemon',
    ).catch(() => undefined);
  }

  /** Launch the TUI, inject turn 1, and hand the session to its monitor. Any
   *  failure is recorded ON THE SESSION (status + reason) before it is
   *  rethrown, so a caller that already gave up still leaves durable evidence. */
  private async bootstrapSession(id: string, config: SessionConfig): Promise<void> {
    try {
      // send() re-verifies prompt readiness right before typing — launch()'s
      // readiness can go stale if a late startup splash repaints the pane,
      // and a prompt injected into a booting TUI lands as a no-op turn.
      const queuedAt = Date.now();
      await this.serializedBootstrap(async () => {
        await this.launchWithRetry(config);
        // The pane demonstrably EXISTS from here on. Durable, because it is
        // what tells a monitor apart from "the tmux session does not exist
        // yet" — the state a pre-launch monitor used to misread as a crash.
        await this.store.updateState<SessionState>(id, current => ({ ...current, launchedAt: now() }));
        await this.tmux.send(config, this.promptInstruction(id, 1));
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
        // while it was still queued — otherwise the healthy teammate stays
        // `failed` forever and every control action refuses it.
        { force: true },
      );
      await this.startMonitor(id);
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
      // A GENUINE launch failure still fails, with the real reason — this is
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
            `${Math.round(CONTROL_LAUNCH_WAIT_MS / 1000)}s); it is pending, not failed — retry once \`kteam ps\` shows it running`,
        );
      }
      const probe = await this.get(id);
      const paneProbe = await this.tmux.state(probe.config.tmuxSession);
      if (terminalStatuses.includes(probe.state.status) || !paneProbe.alive || paneProbe.dead) {
        return await this.reviveWithMessage(id, request);
      }
    }
    const outcome = await this.serialized(id, async () => {
      const view = await this.get(id);
      // Authoritative re-check under the lock: a session that reached a
      // terminal status while we waited must take the resume path (its live
      // pane, if any, is an unmonitored leftover — never type into it).
      // resume() takes the lock itself, so signal the caller instead.
      if (terminalStatuses.includes(view.state.status)) return { kind: 'revive' as const };
      const paneState = await this.tmux.state(view.config.tmuxSession);
      if (!paneState.alive || paneState.dead) return { kind: 'revive' as const };
      if (view.state.status === 'awaiting_question')
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
          await this.tmux.waitReady(view.config.tmuxSession, 10_000).catch(() => undefined);
          const after = await this.tmux.state(view.config.tmuxSession);
          if (!after.alive || after.dead) return { kind: 'revive' as const };
          if (after.promptReady) busy = false;
        } else {
          // The busy verdict is otherwise re-validated right before typing:
          // if the pane turned prompt-ready in the probe→lock window, fall
          // through to the tracked delivered path instead of typing into an
          // idle composer and mis-reporting 'queued' (an Enter at an idle
          // prompt SUBMITS — that would be an untracked ghost turn).
          const recheck = await this.tmux.state(view.config.tmuxSession);
          if (!recheck.alive || recheck.dead) return { kind: 'revive' as const };
          if (recheck.promptReady) busy = false;
        }
      }
      if (busy) {
        // Busy session: type the message into the TUI's NATIVE queue (both
        // harnesses hold text typed mid-turn and auto-submit it at the next
        // boundary — verified 2026-07-23, fixtures *-native-queue.txt). The
        // send is recorded DURABLY in state.pendingNativeSends first; the
        // turn advances only when the transcript's chat.user boundary is
        // correlated (correlateNativeSend), so a queued message can never
        // run as an untracked ghost turn.
        const queuedMessage = request.message?.trim();
        if (!queuedMessage && !request.attachmentIds?.length) throw new Error('message or attachment is required');
        const attachmentBlock = await this.attachments.buildImageReferenceBlock(id, request.attachmentIds ?? []);
        const payload = [queuedMessage, attachmentBlock].filter(Boolean).join('\n\n');
        const entry = {
          id: crypto.randomUUID(),
          at: now(),
          message: payload,
          attachmentIds: request.attachmentIds ?? [],
        };
        // Durable BEFORE the keystrokes: a daemon crash between type-in and
        // consumption must leave evidence to recover/report from.
        await this.store.updateState<SessionState>(id, current => ({
          ...current,
          pendingNativeSends: [...(current.pendingNativeSends ?? []), entry],
        }));
        try {
          await this.tmux.typeIntoQueue(view.config.tmuxSession, payload);
        } catch (error) {
          await this.store.updateState<SessionState>(id, current => ({
            ...current,
            pendingNativeSends: (current.pendingNativeSends ?? []).filter(item => item.id !== entry.id),
          }));
          throw error;
        }
        await appendFile(
          path.join(view.directory, 'channel', 'inbox.jsonl'),
          `${JSON.stringify({ at: now(), type: 'message', queued: true, queueId: entry.id, message: queuedMessage, attachmentIds: request.attachmentIds ?? [] })}\n`,
        );
        await this.emit(
          id,
          'control.send_queued',
          { queueId: entry.id, message: queuedMessage, attachmentIds: request.attachmentIds ?? [], native: true },
          'client',
        );
        return { kind: 'queued' as const };
      }
      await this.deliverToIdlePrompt(id, view, request);
      return { kind: 'delivered' as const };
    });
    if (outcome.kind === 'revive') return await this.reviveWithMessage(id, request);
    return { ...(await this.get(id)), disposition: outcome.kind };
  }

  /** Terminal/dead-pane send: relaunch through resume() with the message as
   *  the next tracked turn. */
  private async reviveWithMessage(
    id: string,
    request: SendRequest,
  ): Promise<SessionView & { disposition: SendDisposition }> {
    const message = request.message?.trim();
    const attachmentBlock = await this.attachments.buildImageReferenceBlock(id, request.attachmentIds ?? []);
    const complete = [message, attachmentBlock].filter(Boolean).join('\n\n');
    if (!complete) throw new Error('message or attachment is required');
    return { ...(await this.resume(id, complete)), disposition: 'revived' };
  }

  /** Tracked idle-prompt delivery: write the turn artifacts, advance the turn,
   *  inject (direct or via the turn-file instruction), and transition. Runs
   *  UNDER the session lock (callers hold it). */
  private async deliverToIdlePrompt(id: string, view: SessionView, request: SendRequest): Promise<void> {
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
      // resume context) — direct only changes what gets TYPED.
      const direct = this.isDirectPayload(complete, view.config);
      await writeFile(turnPrompt(this.paths, id, turn), `${complete}\n`, { mode: 0o600 });
      await appendFile(
        path.join(view.directory, 'channel', 'inbox.jsonl'),
        `${JSON.stringify({ at: now(), type: 'message', turn, message, attachmentIds: request.attachmentIds ?? [] })}\n`,
      );
      const config = await this.store.updateConfig<SessionConfig>(id, current => ({
        ...current,
        turn,
        updatedAt: now(),
      }));
      await rm(markerFile(this.paths, id, 'needs-help'), { force: true });
      await this.emit(
        id,
        'control.send',
        { message, attachmentIds: request.attachmentIds ?? [], ...(direct ? { direct: true } : {}) },
        'client',
        turn,
      );
      await this.tmux.send(config, direct ? complete : this.promptInstruction(id, turn));
      // Markers written between the send request and the prompt landing
      // (tmux.send can still block briefly on late startup dialogs) belong to
      // the PREVIOUS turn — e.g. the agent's `signal done` racing this send.
      // Clear them now that the new turn's prompt has actually landed, else
      // the monitor reports a false `completed` for a turn that is just
      // starting (observed live: geoffrey, 2026-07-21). The old busy-QUEUE
      // gate is gone (native TUI queueing), which shrank this race window
      // from minutes to seconds — but not to zero.
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
    }
  }

  /** F4 auto-revive guard: if a control action left the pane DEAD (e.g. a
   *  keystroke the TUI interpreted as quit), recover it once through the
   *  normal resume path and record that it happened. Runs OUTSIDE the session
   *  lock — resume() takes it itself. */
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
      if (view) {
        const pane = await this.tmux.state(view.config.tmuxSession);
        if (!pane.alive || pane.dead) {
          await this.emit(id, 'control.autorevive', { action, error: String(error) }, 'daemon').catch(() => undefined);
          return await this.resume(id, reviveMessage);
        }
      }
      throw error;
    }
  }

  async answer(id: string, labels: string[], other?: string, responses?: string[]): Promise<SessionView> {
    id = this.resolveRef(id);
    await this.clearNeedsHuman(id);
    return await this.withAutoRevive(id, 'answer', () =>
      this.serialized(id, async () => {
        const view = await this.get(id);
        if (view.state.status !== 'awaiting_question')
          throw new Error('session is not waiting on a structured question');
        await this.emit(
          id,
          'interaction.answer',
          { toolUseId: view.state.pendingQuestion?.toolUseId, labels, other, responses },
          'client',
        );
        await this.tmux.answerQuestion(view.config, view.state, labels, other, responses);
        await this.transition(
          id,
          {
            status: 'running',
            health: 'healthy',
            pendingQuestion: undefined,
            promptReady: false,
            startedAt: now(),
            lastActivityAt: now(),
            turnCompleted: false,
            nudgedAt: undefined,
          },
          'turn.resumed',
        );
        return await this.get(id);
      }),
    );
  }

  async interrupt(id: string): Promise<SessionView> {
    id = this.resolveRef(id);
    return await this.withAutoRevive(id, 'interrupt', () =>
      this.serialized(id, async () => {
        const view = await this.get(id);
        await this.emit(id, 'control.interrupt.requested', {}, 'client');
        await this.tmux.interrupt(view.config);
        await this.transition(
          id,
          { status: 'interrupted', health: 'idle', promptReady: true, reason: 'interrupted by client' },
          'control.interrupted',
        );
        return await this.get(id);
      }),
    );
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
      await this.transition(
        id,
        { status: 'stopped', health: 'idle', reason, finishedAt: now(), promptReady: false },
        'session.stopped',
      );
      return await this.get(id);
    });
  }

  async resume(id: string, message?: string, guard?: ResumeGuard): Promise<SessionView> {
    id = this.resolveRef(id);
    // Same pending-not-refused contract as send(): wait for an in-flight first
    // launch instead of rejecting outright. A resume that lands mid-launch and
    // succeeds anyway would fight the bootstrap for the same tmux name.
    if (this.launchingRecently(id) && !(await this.awaitLaunchSettled(id, CONTROL_LAUNCH_WAIT_MS))) {
      throw new Error(
        `session ${id} is still launching (queued behind the bootstrap chain for ` +
          `${Math.round(CONTROL_LAUNCH_WAIT_MS / 1000)}s); it is pending, not failed — retry once \`kteam ps\` shows it running`,
      );
    }
    // Automatic retries are not a human action; only explicit resumes clear.
    if (!guard) await this.clearNeedsHuman(id);
    if (!guard) this.cancelRetry(id);
    let startMonitorAfterUnlock = false;
    const resumed = await this.serialized(id, async () => {
      const automaticRetry = guard?.status === 'retrying';
      let view = await this.get(id);
      if (view.state.status === 'kill_failed')
        throw new Error('the previous tmux kill failed; use stop again before resume');
      if (
        guard &&
        (view.state.status !== guard.status ||
          (guard.retryAttempt !== undefined && view.state.retryAttempt !== guard.retryAttempt))
      ) {
        throw new ResumeCancelled(`resume guard changed from ${guard.status}`);
      }
      const paneState = await this.tmux.state(view.config.tmuxSession);
      if (paneState.alive && !paneState.dead) {
        // A TERMINAL session's leftover live pane (daemon-restart re-adoption,
        // reconciled completion) is unmonitored — injecting into it loses the
        // message. Kill it and fall through to a tracked relaunch; only a
        // genuinely NON-terminal session takes the plain-send shortcut.
        if (!terminalStatuses.includes(view.state.status)) {
          if (!message) throw new Error('session is already running');
          return await this.sendUnlocked(view, message);
        }
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
      const turn = view.config.turn + 1;
      const prompt = message?.trim() || 'Continue the assigned task from where you stopped.';
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
          await this.tmux.send(config, this.promptInstruction(id, turn));
        });
        this.autoContinued.delete(id);
        this.doneDeferred.delete(id);
        await this.transition(
          id,
          {
            status: 'running',
            health: 'healthy',
            promptReady: false,
            lastActivityAt: now(),
            turnCompleted: false,
          },
          'session.resumed',
        );
        // A watcher immediately replays persisted transcript bytes through the
        // same per-session queue. Starting it while this queue is held would
        // deadlock resume against its own transcript callback.
        startMonitorAfterUnlock = true;
      } catch (error) {
        await this.tmux.snapshot(config, true).catch(() => '');
        await this.stopTmuxWithEvidence(config, 'failed resume cleanup');
        const attempt = view.state.retryAttempt ?? 0;
        if (automaticRetry && attempt < (config.retry?.transientAttempts ?? 0)) {
          const nextAttempt = attempt + 1;
          await this.transition(
            id,
            {
              status: 'retrying',
              health: 'crashed',
              reason: String(error),
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
              reason: String(error),
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
  }

  /** Continue an existing session on a DIFFERENT same-kind account. kfleet pools
   *  harness session state across accounts of one kind (~/.kfleet/shared/<kind>),
   *  so any claude wrapper can `--resume` a conversation another claude wrapper
   *  started (same for codex↔codex). We validate the target, stop the old pane,
   *  rewrite the config to the new wrapper (binary/home/model — keeping the
   *  harnessSessionId, teammate, label, parent), then relaunch through the normal
   *  resume path under the new wrapper. Cross-KIND migration is unsupported. */
  async migrate(id: string, agent: string, model?: string): Promise<SessionView> {
    id = this.resolveRef(id);
    this.cancelRetry(id);
    // Abort (never drain) the quota waiter: failover calls migrate from INSIDE
    // that waiter's own promise, so draining would self-deadlock. The waiter's
    // status guard turns any stale wake into a no-op once we relaunch.
    await this.cancelQuotaWaiter(id);
    const view = await this.get(id);
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
    // Resolve ONLY within the kfleet bin (the discoverAutoAgents source) — never
    // the daemon's $PATH — so a caller (incl. a warden) cannot migrate a session
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
    const at = now();
    // Snapshot the ORIGINAL account so a failed relaunch can be rolled back —
    // the config must never be left pointing at a wrapper that never launched.
    const original = {
      binary: view.config.binary,
      harness: view.config.harness,
      modelHint: view.config.modelHint,
      model: view.config.model,
      harnessHome: view.config.harnessHome,
      transcriptFile: view.config.transcriptFile,
    };
    // Journal the intent BEFORE stopping the pane: a crash between here and a
    // successful relaunch leaves a durable `migration` marker (plus this event)
    // rather than a silently half-migrated config.
    await this.store.updateConfig<SessionConfig>(id, current => ({ ...current, migration: { from, to: agent, at } }));
    await this.emit(id, 'session.migrating', { from, to: agent, model: nextModel, at }, 'daemon');
    // Stop the old pane and its monitor before relaunching under the new account.
    await this.stopMonitor(id, true);
    const paneState = await this.tmux.state(view.config.tmuxSession);
    if (paneState.alive) await this.stopTmuxWithEvidence(view.config, `migrate ${from} -> ${agent}`);
    const migrated = await this.store.updateConfig<SessionConfig>(id, current => ({
      ...current,
      binary: agent,
      harness,
      modelHint: modelHint(agent),
      model: nextModel,
      harnessHome,
      updatedAt: now(),
    }));
    // Claude transcripts live under the new home; repoint the watched file so the
    // monitor tails the right JSONL after relaunch (codex rediscovers on resume).
    if (migrated.harness === 'claude') {
      const transcriptFile = claudeTranscriptPath(migrated);
      await this.store.updateConfig<SessionConfig>(id, current => ({ ...current, transcriptFile }));
    }
    await this.emit(id, 'session.migrated', { from, to: agent, model: nextModel }, 'daemon');
    try {
      const resumed = await this.resume(
        id,
        'You have been migrated to a different account mid-task due to quota/auth issues on the previous one. ' +
          'Re-read your latest turn file and continue exactly where you left off.',
      );
      // Relaunch succeeded — the transition is complete, clear the staged marker.
      await this.store.updateConfig<SessionConfig>(id, current => ({ ...current, migration: undefined }));
      return resumed;
    } catch (error) {
      if (error instanceof ResumeCancelled) {
        // A newer operation superseded this relaunch and now owns the config;
        // just drop our staged marker and let it proceed.
        await this.store
          .updateConfig<SessionConfig>(id, current => ({ ...current, migration: undefined }))
          .catch(() => undefined);
        throw error;
      }
      // Relaunch failed: roll the config back to the original account so the
      // session never points at a wrapper that never launched, and record the
      // full story in the failure reason.
      const detail = error instanceof Error ? error.message : String(error);
      await this.store
        .updateConfig<SessionConfig>(id, current => ({
          ...current,
          ...original,
          migration: undefined,
          updatedAt: now(),
        }))
        .catch(() => undefined);
      const reason = `migration to ${agent} failed: ${detail}; session restored to ${from} (stopped)`;
      await this.transition(
        id,
        { status: 'failed', reason, finishedAt: now(), health: 'crashed' },
        'session.failed',
      ).catch(() => undefined);
      throw new Error(reason);
    }
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
      await this.store.rebuildIndex();
    } finally {
      this.deleting.delete(id);
      if (restartMonitor && !this.closed) await this.startMonitor(id).catch(() => undefined);
    }
  }

  /** True only when markers/done.json certifies the given CURRENT turn. A
   *  marker without a turn (pre-upgrade) or from an older turn is stale
   *  evidence and must not complete newer work. */
  private doneMarkerForTurn(id: string, turn: number | undefined): boolean {
    try {
      const marker = JSON.parse(readFileSync(markerFile(this.paths, id, 'done'), 'utf8')) as { turn?: number };
      return typeof marker.turn === 'number' && marker.turn === turn;
    } catch {
      return false;
    }
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
        // queue time, so a daemon death in the queue→delivery window would
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
   *  keeping the session visibly alive — heartbeats keep flowing, the
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
    const waiting = {
      since: now(),
      ...(until ? { until } : {}),
      ...(options.condition ? { condition: options.condition } : {}),
    };
    const detail = [options.condition ?? message, until ? `until ${until}` : 'open-ended'].filter(Boolean).join(' — ');
    await this.transition(
      id,
      { status: 'waiting', health: 'waiting', reason: `waiting: ${detail}`, waiting },
      'session.waiting',
      { until: until ?? null, condition: options.condition ?? null },
    );
    return await this.get(id);
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
        // tick nudge — or kill — the teammate the daemon just woke.
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
   *  (the wait is a pause, not an ending — nothing here ever kills). */
  private async serviceWaiting(view: SessionView): Promise<void> {
    const id = view.config.id;
    const waiting = view.state.waiting;
    if (!waiting) return;
    const sinceMs = Date.parse(waiting.since);
    const elapsedSeconds = Number.isFinite(sinceMs) ? Math.round((Date.now() - sinceMs) / 1000) : 0;
    // An open-ended wait still ENDS. Without a backstop a park would suspend
    // the idle kill and the ceiling forever, so a teammate that declared a
    // wait and then died quietly would become immortal — the park-loop this
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
      // from a blank-but-healthy screen — callers scripting around `kteam
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
    // captures live tmux UNDER THE SESSION LOCK — on a busy session that
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
    // Rows indexed before the global-sequence column existed are invisible to
    // these queries; heal the requested session on demand (bounded to one
    // session — the fleet-wide walk is a background bootstrap phase).
    if (id !== undefined && this.store.sessionNeedsGlobalBackfill(id)) await this.store.backfillGlobalSequence(id);
    // Both branches are INDEX-BOUNDED: the old implementation loaded every
    // event of every session into memory, mapped it, and sorted it before
    // slicing — one fleet-wide connect wedged the daemon for minutes and grew
    // its heap into the gigabytes (2026-07-23 wedge/listener-flap incident).
    if (after < 0) return this.store.tailGlobal(-after, id).map(event => this.fromStored(event));
    const backlogFloor = id === undefined ? Math.max(0, this.store.latestGlobalSequence() - GLOBAL_BACKLOG_MAX) : 0;
    let cursor = Math.max(after, backlogFloor);
    // A short page is how every caller detects end-of-backlog, so a page
    // whose rows did not all RESOLVE (torn journal line, missing file) must
    // be topped up instead of returned short — otherwise one bad line
    // truncates the rest of a replay.
    const events: KTeamEvent[] = [];
    while (events.length < limit) {
      const page = this.store.replayGlobal(cursor, limit - events.length, id);
      if (page.rows === 0) break;
      cursor = page.cursor;
      for (const event of page.events) events.push(this.fromStored(event));
    }
    return events;
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

  private async recover(): Promise<void> {
    for (const session of await this.list()) {
      try {
        await this.recoverSession(session);
      } catch (error) {
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

  private async recoverSession(session: SessionView): Promise<void> {
    {
      // Race guard: the API listens BEFORE bootstrap finishes, so a client
      // can start()/resume() a session while recover() walks the list. Such
      // a session already has a live monitor — adoption bookkeeping here
      // would fight the fresh launch (double monitors, spurious snapshots).
      if (this.monitors.has(session.config.id)) return;
      const paneState = await this.tmux.state(session.config.tmuxSession);
      if (session.state.status === 'kill_failed') {
        if (paneState.alive) {
          await this.tmux.snapshot(session.config, true);
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
          await this.stopTmuxWithEvidence(session.config, 'terminal session survived daemon restart');
        }
        return;
      }
      if (paneState.alive && !paneState.dead) {
        // A1: with KillMode=process the tmux server (and this pane) survives a
        // daemon restart — RE-ADOPT it: keep the session's status, restart its
        // monitor, and record the adoption. Never snapshot-and-kill a live,
        // healthy pane here.
        await this.transition(
          session.config.id,
          { status: session.state.status === 'starting' ? 'running' : session.state.status, health: 'healthy' },
          'daemon.readopted',
          { promptReady: paneState.promptReady },
        );
        await this.startMonitor(session.config.id);
        if (session.state.status === 'rate_limited' && session.config.retry?.waitForQuotaReset !== false) {
          this.scheduleQuotaWaiter(session.config.id);
        }
        return;
      }
      if (paneState.alive) {
        await this.tmux.snapshot(session.config, true);
        await this.stopTmuxWithEvidence(session.config, 'dead pane cleanup during daemon restart');
      }
      if (session.state.status === 'rate_limited' && session.config.retry?.waitForQuotaReset !== false) {
        this.scheduleQuotaWaiter(session.config.id);
      } else if (session.state.status === 'retrying' && (session.state.retryAttempt ?? 0) > 0) {
        this.scheduleTransientRetry(session.config.id, session.state.retryAttempt!);
      } else if (this.doneMarkerForTurn(session.config.id, session.state.turn ?? session.config.turn)) {
        // The teammate signalled done for THIS turn but the pane died before
        // the status flipped (or the daemon restart interleaved). The work
        // FINISHED — marking it failed here would invite the warden to resume
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
    // that stretch ran with NO monitor tick — no pane snapshots, no
    // heartbeat.json, no liveness.yaml, no stall reflex, no turn ceiling —
    // while `monitors.has(id)` made the self-check call it healthy
    // (2026-07-24: confirmed on every session created after the 23:49 restart).
    // The loop's own first act is reading state, so it needs nothing from the
    // watcher; a codex session arms its transcript from inside the loop.
    handle.loop = this.monitorLoop(id, handle.abort.signal);
    void handle.loop.catch(() => undefined);
    await this.startTranscriptWatcher(id, view, handle);
  }

  /** Attach the harness transcript tail to a monitor handle. Separate from
   *  startMonitor so the tick loop can be armed first — see the comment there. */
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
        onEvents: async (events, cursor) => await this.handleClaudeEvents(id, events, cursor.endOffset),
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
      // done marker) by the time this resolves — its cleanup stops
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
          updatedAt: now(),
        }));
        await this.emit(id, 'transcript.discovered', { file, harnessSessionId }, 'watcher');
      },
      onEvents: async (events, cursor) => await this.handleCodexEvents(id, events, cursor.endOffset),
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
    const stopping = monitor.transcript?.stop();
    if (drain) {
      const pending: Promise<void>[] = [];
      if (stopping) pending.push(stopping);
      if (monitor.loop) pending.push(monitor.loop);
      await Promise.allSettled(pending);
    } else void stopping?.catch(() => undefined);
  }

  private async monitorLoop(id: string, signal: AbortSignal): Promise<void> {
    let paneHash = '';
    let diffHash = '';
    let promptStable = 0;
    let lastQuotaCheck = 0;
    let reinjectedTurn = -1;
    // F6: the last turn whose pane visibly showed active work. A turn that
    // demonstrably RAN but produced no correlated transcript (e.g. GLM canary,
    // 2026-07-19) is a transcript-correlation gap, not a lost prompt — it must
    // not be reinjected or failed as turn-never-started.
    let activeWorkTurn = -1;
    // A6: recognized work vocabulary with advancing counters across polls is
    // full liveness — a long silent thinking block writes no transcript bytes
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
          if (existsSync(markerFile(this.paths, id, 'done'))) {
            // A done marker written while the pane still shows an ACTIVE turn
            // (spinner/token counter) means the teammate declared victory
            // early — deliverables may not exist yet. Defer completion until
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
            // A pane that has NEVER been launched is not a crashed pane. Until
            // the bootstrap runs `tmux new-session`, `tmux.state` reports the
            // same "not alive" as a dead harness — and a monitor started into
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
              // without reaching tmux). That IS a real failure — say what it
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
            if (!terminalStatuses.includes(view.state.status)) {
              await this.tmux.snapshot(view.config, true);
              const exitEvidence = { at: now(), alive: pane.alive, dead: pane.dead, exitCode: pane.exitCode };
              await Promise.all([
                atomicJson(path.join(view.directory, 'checks', 'exit.json'), exitEvidence),
                atomicJson(markerFile(this.paths, id, 'process-exit'), exitEvidence),
              ]);
              const quota = await this.fetchQuota(view.config, signal);
              // Classify from the final visible screen, not the full scrollback:
              // task text and tool output routinely mention rate limits, quotas,
              // HTTP codes, and network errors, and must not steer classification.
              const lower = (
                pane.visiblePane.trim() ? pane.visiblePane : pane.pane.split('\n').slice(-60).join('\n')
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
                    exitCode: pane.exitCode,
                    quota,
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
                    exitCode: pane.exitCode,
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
                    : `interactive ${view.config.harness} exited ${pane.exitCode ?? 'unknown'}`;
                await this.transition(
                  id,
                  {
                    status: 'failed',
                    health: 'crashed',
                    reason,
                    exitCode: pane.exitCode,
                    finishedAt: now(),
                    promptReady: false,
                  },
                  'session.crashed',
                );
              }
            }
            return;
          }

          const nextPaneHash = Bun.hash(pane.pane).toString(16);
          if (nextPaneHash !== paneHash) {
            paneHash = nextPaneHash;
            await this.tmux.snapshot(view.config);
            await writeFile(turnLog(this.paths, id, view.config.turn), pane.pane, { mode: 0o600 });
            // Pane parse is only the FALLBACK: once a transcript usage record
            // has set contextPercent, the harness's own accounting wins (the
            // statusline can change shape any time — the 1M-suffix breakage).
            const paneContext = contextPercentUsed(pane.visiblePane);
            const contextPercent = view.state.contextPercent === undefined ? paneContext : undefined;
            const effectiveContext = view.state.contextPercent ?? paneContext;
            const contextTurnedHigh =
              effectiveContext !== undefined && effectiveContext >= 85 && (view.state.contextPercent ?? 0) < 85;
            // The harness's own spinner line ("✻ Lollygagging… (34s · 2.1k
            // tokens)") — the chat UI's received-and-thinking indicator.
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
              },
            );
            // Sessions past ~85% context wedge silently (prompts queue, never
            // process). Surface it once so the lead can rotate the teammate.
            if (contextTurnedHigh) await this.emit(id, 'context.high', { contextPercent }, 'watcher');
            view = await this.get(id);
          }

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
              !existsSync(markerFile(this.paths, id, 'done'))
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
          // Subprocess life-sign, two sources: a live child under the pane
          // while a tool.use is open (gated — harness TUIs keep idle helper
          // children), or the codex "N background terminal(s) running" footer.
          const subprocessAlive =
            ((view.state.openTools?.length ?? 0) > 0 && (await this.tmux.subprocessAlive(view.config.tmuxSession))) ||
            backgroundTerminalCount(pane.visiblePane) > 0;
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
          // `state.waiting` — not the status — is the authority for a declared
          // wait: transcript records recompute status every few seconds
          // (running/thinking/tool_running), so gating only on the status let
          // the very tool_result of `kteam signal waiting` erase the park and
          // hand the session straight back to the nudge, the stall kill, and
          // the automode auto-continue.
          const waiting = lifecycleSuspended(view.state);
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
          // the prompt was lost or the TUI booted logged-out — both previously
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
          // growth, ANY pane change, and subprocess activity — it only catches
          // totally-frozen agents. Zero life-signs for nudgeAfterSeconds → one
          // nudge per episode (interrupt + continue message); still zero at
          // killAfterSeconds → kill. Alive-but-weird cases (long silent think,
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
              susThinkingSeconds: Math.max(60, this.options.warden.susThinkingSeconds),
              susSubprocessSeconds: Math.max(60, this.options.warden.susSubprocessSeconds),
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
        this.monitors.delete(id);
        await monitor.transcript?.stop();
      }
    }
  }

  /** Correlate a transcript chat.user record against the durable
   *  pendingNativeSends queue (runs under the session lock, called by both
   *  transcript handlers BEFORE they process the batch). A match means the
   *  TUI consumed a natively-queued message at a turn boundary: atomically
   *  advance the turn (config + state), materialize the turn file, re-scope
   *  markers, reset the liveness episode, and emit the consumption event —
   *  exactly the bookkeeping a tracked send performs at injection time.
   *  Matching is by normalized text prefix, oldest entry first; duplicates or
   *  replayed transcript batches cannot double-advance because the entry is
   *  removed with the same state update that records the consumption. */
  private async correlateNativeSends(
    id: string,
    view: SessionView,
    events: ReadonlyArray<{ type: string; data: unknown }>,
  ): Promise<void> {
    const pending = view.state.pendingNativeSends ?? [];
    if (pending.length === 0) return;
    const normalize = (value: string) => value.replace(/\s+/g, '');
    const userTexts = events
      .filter(event => event.type === 'chat.user')
      .map(event => normalize(String((event.data as { text?: string }).text ?? '')));
    if (userTexts.length === 0) return;
    // One transcript user event consumes AT MOST one pending entry: two queued
    // sends sharing a message (or an 80-char prefix) must each wait for their
    // own boundary — a single "continue" record must never advance two turns
    // and delete both entries.
    const consumedTexts = new Set<number>();
    for (const entry of [...pending]) {
      const probe = normalize(entry.message).slice(0, 80);
      if (!probe) continue;
      const matchIndex = userTexts.findIndex((text, index) => !consumedTexts.has(index) && text.includes(probe));
      if (matchIndex === -1) continue;
      consumedTexts.add(matchIndex);
      const turn = view.config.turn + 1;
      await writeFile(turnPrompt(this.paths, id, turn), `${entry.message}\n`, { mode: 0o600 });
      view.config = await this.store.updateConfig<SessionConfig>(id, current => ({
        ...current,
        turn,
        updatedAt: now(),
      }));
      // Markers written during the previous turn must not complete this one.
      await Promise.all(['done', 'needs-help'].map(name => rm(markerFile(this.paths, id, name), { force: true })));
      this.autoContinued.delete(id);
      this.doneDeferred.delete(id);
      await this.store.updateState<SessionState>(id, current => ({
        ...current,
        turn,
        startedAt: now(),
        turnCompleted: false,
        promptReady: false,
        reason: undefined,
        nudgedAt: undefined,
        pendingNativeSends: (current.pendingNativeSends ?? []).filter(item => item.id !== entry.id),
      }));
      await this.emit(
        id,
        'control.send_consumed',
        { queueId: entry.id, turn, message: entry.message.slice(0, 200) },
        'daemon',
        turn,
      );
      view = await this.get(id);
    }
  }

  /** Native sends still pending when a session hits a terminal state were
   *  never consumed — the pane died/completed with text in the composer or
   *  queue. Surface the loss LOUDLY (event + state.reason); the recovery path
   *  is status-based revive, which re-sends the recorded message. */
  private async reportLostNativeSends(id: string): Promise<void> {
    const view = await this.get(id).catch(() => undefined);
    const pending = view?.state.pendingNativeSends ?? [];
    if (!view || pending.length === 0) return;
    await this.store
      .updateState<SessionState>(id, current => ({
        ...current,
        pendingNativeSends: [],
        reason: `${current.reason ? `${current.reason}; ` : ''}${pending.length} native-queued send(s) not consumed before the session ended (recover with: kteam send — the messages are in channel/inbox.jsonl)`,
      }))
      .catch(() => undefined);
    await this.emit(
      id,
      'control.send_lost',
      { entries: pending.map(entry => ({ queueId: entry.id, at: entry.at, message: entry.message.slice(0, 200) })) },
      'daemon',
      undefined,
      true,
    ).catch(() => undefined);
  }

  private async handleClaudeEvents(
    id: string,
    events: readonly ClaudeNormalizedEvent[],
    offset: number,
  ): Promise<void> {
    await this.serialized(id, async () => {
      let view = await this.get(id);
      await this.correlateNativeSends(id, view, events);
      view = await this.get(id);
      let autoQuestion = false;
      for (const event of events) {
        await appendFile(path.join(view.directory, 'chat.jsonl'), `${JSON.stringify(event)}\n`);
        await this.emit(id, event.type, event.data, 'claude', view.config.turn);
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
      // Transcript-based context accounting (turn-020): the harness's own
      // usage records are ground truth; the pane statusline is only a
      // fallback. Last usage event in the batch wins.
      const usageEvent = [...events].reverse().find(event => event.type === 'context.usage') as
        | { data: { contextTokens: number; model?: string; contextWindow?: number } }
        | undefined;
      const contextPercentFromUsage = usageEvent
        ? Math.round(
            (usageEvent.data.contextTokens /
              (usageEvent.data.contextWindow ??
                contextWindowForModel(usageEvent.data.model ?? view.config.model, this.options.contextWindows))) *
              100,
          )
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
            if (pendingQuestion?.toolUseId === event.data.toolUseId) pendingQuestion = undefined;
            status = openTools.size ? 'tool_running' : 'running';
          } else if (event.type === 'interaction.question') {
            pendingQuestion = { toolUseId: event.data.toolUseId, questions: event.data.questions };
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
            pendingQuestion = undefined;
            turnCompleted = true;
            status = 'running';
          } else if (event.type.startsWith('chat.')) {
            if (event.type === 'chat.user') turnCompleted = false;
            status = 'running';
          }
        }
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
          // Ground truth for the MODEL column: the wrapper alias (`opus` on a
          // GLM account) is only what was requested — this is what answered.
          ...(usageEvent?.data.model ? { observedModel: usageEvent.data.model } : {}),
          retryAttempt: madeProgress ? 0 : current.retryAttempt,
          lastTranscriptAt: now(),
          lastActivityAt: now(),
          promptReady: terminal ? current.promptReady : false,
        };
      });
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

  private async handleCodexEvents(id: string, events: readonly CodexNormalizedEvent[], offset: number): Promise<void> {
    await this.serialized(id, async () => {
      let view = await this.get(id);
      await this.correlateNativeSends(id, view, events);
      view = await this.get(id);
      let autoQuestion = false;
      for (const event of events) {
        await appendFile(path.join(view.directory, 'chat.jsonl'), `${JSON.stringify(event)}\n`);
        await this.emit(id, event.type, event.data, 'codex', view.config.turn);
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
      const contextPercentFromUsage = usageEvent
        ? Math.round(
            (usageEvent.data.contextTokens /
              (usageEvent.data.contextWindow ??
                contextWindowForModel(usageEvent.data.model ?? view.config.model, this.options.contextWindows))) *
              100,
          )
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
          if (event.type === 'turn.started') {
            turnCompleted = false;
            status = 'running';
          } else if (event.type === 'turn.completed' || event.type === 'turn.aborted') {
            // See the Claude handler: a finished turn must clear open tools so
            // unmatched tool ids cannot wedge the idle detector.
            openTools.clear();
            pendingQuestion = undefined;
            turnCompleted = true;
            status = 'running';
          } else if (event.type === 'tool.use') {
            openTools.add(event.data.toolUseId);
            status = 'tool_running';
            turnCompleted = false;
            lastToolStartedAt = now();
          } else if (event.type === 'tool.result') {
            openTools.delete(event.data.toolUseId);
            if (pendingQuestion?.toolUseId === event.data.toolUseId) pendingQuestion = undefined;
            status = openTools.size ? 'tool_running' : 'running';
          } else if (event.type === 'chat.assistant.reasoning') {
            status = 'thinking';
            turnCompleted = false;
          } else if (event.type === 'interaction.question') {
            pendingQuestion = { toolUseId: event.data.toolUseId, questions: event.data.questions };
            status = view.config.mode === 'interactive' ? 'awaiting_question' : 'running';
            turnCompleted = false;
          } else if (event.type.startsWith('chat.')) {
            if (event.type === 'chat.user') turnCompleted = false;
            status = 'running';
          }
        }
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
          // Ground truth for the MODEL column: the wrapper alias (`opus` on a
          // GLM account) is only what was requested — this is what answered.
          ...(usageEvent?.data.model ? { observedModel: usageEvent.data.model } : {}),
          retryAttempt: madeProgress ? 0 : current.retryAttempt,
          lastTranscriptAt: now(),
          lastActivityAt: now(),
          promptReady: terminal ? current.promptReady : false,
        };
      });
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
    options: { force?: boolean } = {},
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
      // kill, pane death), and once terminal every later patch is suppressed —
      // so a park left set here would be permanent: `kteam wait` would never
      // return and the warden would report an overdue wait on a dead session
      // forever.
      if (patch.status !== undefined && protectedStatuses.includes(patch.status)) next.waiting = undefined;
      if (!preserveTerminal && !preserveKillFailure) return next;
      suppressed = true;
      return current;
    });
    if (suppressed) return;
    await this.emit(id, eventType, { status: state.status, health: state.health, ...eventData }, 'daemon', state.turn);
    // Busy-time sends live in the TUI's NATIVE queue; a completing turn
    // normally consumes them at the boundary (correlateNativeSends). If the
    // session ends with entries still pending, the message died with the
    // pane/queue — surface the loss loudly so the caller can re-send
    // (status-based revive is the recovery path).
    if (patch.status !== undefined && terminalStatuses.includes(patch.status)) {
      setTimeout(() => void this.reportLostNativeSends(id).catch(() => undefined), 0);
    }
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
    // scope. Captured synchronously — the append runs on a deferred queue where
    // the AsyncLocalStorage context would no longer be current.
    const effectiveSource = currentActor() ?? source;
    let resolveEvent!: (event: KTeamEvent) => void;
    let rejectEvent!: (error: unknown) => void;
    const result = new Promise<KTeamEvent>((resolve, reject) => {
      resolveEvent = resolve;
      rejectEvent = reject;
    });
    const operation = this.globalEventQueue
      .catch(() => undefined)
      .then(async () => {
        let resolvedTurn = turn;
        if (resolvedTurn === undefined)
          resolvedTurn = (await this.store.readState<SessionState>(id).catch(() => ({ turn: 0 }) as SessionState)).turn;
        const globalSequence = ++this.globalSequence;
        await atomicJson(path.join(this.paths.daemon, 'global-sequence.json'), { sequence: globalSequence, at: now() });
        const stored = await this.store.append(id, type, {
          source: effectiveSource,
          turn: resolvedTurn,
          payload,
          globalSequence,
        } as unknown as JsonValue);
        const event = this.fromStored(stored);
        for (const listener of this.listeners) listener(event);
        resolveEvent(event);
      })
      .catch(rejectEvent);
    this.globalEventQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private fromStored(event: SessionEvent): KTeamEvent {
    const envelope = event.data as unknown as StoredEnvelope;
    return {
      sequence: envelope.globalSequence ?? event.sequence,
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
      let newlyExhausted = false;
      let recoveredWithoutRetry = false;
      let readyToResume = false;
      let inactive = false;
      const state = await this.store.updateState<SessionState>(id, current => {
        if (protectedStatuses.includes(current.status)) {
          inactive = true;
          return current;
        }
        newlyExhausted = quota.atLimit === true && current.status !== 'rate_limited';
        recoveredWithoutRetry =
          quota.atLimit === false && current.status === 'rate_limited' && config.retry?.waitForQuotaReset === false;
        readyToResume =
          quota.atLimit === false && current.status === 'rate_limited' && config.retry?.waitForQuotaReset !== false;
        return {
          ...current,
          quota,
          status: quota.atLimit
            ? 'rate_limited'
            : recoveredWithoutRetry
              ? config.mode === 'interactive' && current.promptReady
                ? 'awaiting_user'
                : 'running'
              : current.status,
          health: quota.atLimit
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
      if (newlyExhausted) await this.emit(id, 'quota.exhausted', quota, 'watcher');
      if (quota.atLimit && config.retry?.waitForQuotaReset !== false) this.scheduleQuotaWaiter(id);
      if (readyToResume) this.scheduleQuotaWaiter(id);
      if (recoveredWithoutRetry) await this.emit(id, 'quota.available', { ...quota, status: state.status }, 'watcher');
    } catch {}
  }

  private async fetchQuota(config: SessionConfig, signal?: AbortSignal): Promise<SessionState['quota'] | undefined> {
    try {
      const timeout = AbortSignal.timeout(3_000);
      const response = await fetch(this.options.quotaUrl, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as {
        accounts?: Array<{
          binary?: string;
          atLimit?: boolean;
          authOk?: boolean;
          fiveHourPercent?: number;
          weeklyPercent?: number;
          fiveHourResetAt?: number;
          weeklyResetAt?: number;
        }>;
      };
      const account = payload.accounts?.find(item => item.binary === config.binary);
      if (!account) return undefined;
      const resets = [account.fiveHourResetAt, account.weeklyResetAt].filter(
        (value): value is number => typeof value === 'number',
      );
      return {
        atLimit: account.atLimit,
        authOk: account.authOk,
        fiveHourPercent: account.fiveHourPercent,
        weeklyPercent: account.weeklyPercent,
        ...(resets.length ? { resetAt: Math.min(...resets) } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /** The full per-account usage feed (same endpoint as fetchQuota), used to pick
   *  a failover target. Empty on any failure — failover then just no-ops and the
   *  session keeps waiting for its own quota to reset. */
  private async fetchUsageAccounts(signal?: AbortSignal): Promise<AgentUsage[]> {
    try {
      const timeout = AbortSignal.timeout(3_000);
      const response = await fetch(this.options.quotaUrl, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) return [];
      const payload = (await response.json()) as { accounts?: AgentUsage[] };
      return payload.accounts ?? [];
    } catch {
      return [];
    }
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
    if (typeof resetAt !== 'number' || resetAt - Date.now() < 30 * 60_000) return false;
    const usage = await this.fetchUsageAccounts(signal);
    if (signal.aborted || this.deleting.has(id)) return false;
    // Positive-confirmation gate: automatic failover happens with no human in the
    // loop, so it must NOT fire on a mere rate_limited status. Require the usage
    // feed to confirm the CURRENT account is genuinely at its limit, and only
    // migrate to a candidate with confirmed headroom. Absent/unknown usage data
    // (empty feed, account not scored) is treated as "not confirmed" → no
    // failover, and the session keeps waiting for its own quota to reset.
    const currentUsage = usage.find(item => item.binary === view.config.binary);
    if (currentUsage?.atLimit !== true) return false;
    const candidate = selectFailoverCandidate({
      currentBinary: view.config.binary,
      harness: view.config.harness,
      agents: discoverAutoAgents(this.paths.kfleetBin),
      usage,
      requireConfirmedUsage: true,
    });
    if (!candidate) return false;
    await this.emit(id, 'account.failover', { from: view.config.binary, to: candidate, resetAt }, 'watcher').catch(
      () => undefined,
    );
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
      if (quota && quota.atLimit === false) {
        const latest = await this.get(id).catch(() => undefined);
        if (!latest || latest.state.status !== 'rate_limited' || signal.aborted) return;
        await this.emit(id, 'quota.available', quota, 'watcher');
        await this.resume(id, 'The account quota is available again. Continue from the persisted conversation.', {
          status: 'rate_limited',
        }).catch(async error => {
          if (!(error instanceof ResumeCancelled))
            await this.emit(id, 'retry.failed', { message: String(error) }, 'watcher');
        });
        return;
      }
      const delay = quota?.resetAt ? Math.max(5_000, Math.min(60_000, quota.resetAt - Date.now())) : 60_000;
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
          status: 'retrying',
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

  private async stopManagedSession(config: SessionConfig, reason: string): Promise<void> {
    await this.stopMonitor(config.id);
    try {
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
        // suppressed — a park left set here could never be cleared again.
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
    // suite or a deploy was indistinguishable from a dead one — nudged at
    // 180 s, stall-killed at 300 s, and reaped by the 4 h turn ceiling.
    const waitRule =
      '9. If you must wait on an EXTERNAL condition (a long suite, a deploy, a scheduled window), declare it: ' +
      'kteam signal waiting --until <45m|2h|ISO> --on "<what you are waiting for>". That suspends the idle nudge, ' +
      'the stall kill, and the turn ceiling while heartbeats keep you visible; the daemon wakes you at the deadline. ' +
      '--until is optional (an open-ended park is fine), but EVERY wait is force-woken after 4 hours. ' +
      'Run kteam signal working when the condition resolves. This is legal in automode — it asks nobody for anything. ' +
      'Never park instead of finishing: it is for waiting, not for idling.';
    // Rule 8 exists because a teammate once ran `bun add` at a repo root: bun
    // created a root package.json/node_modules that shadowed a nested package's
    // deps and broke tooling fleet-wide until a human cleaned it up.
    return `# kteam teammate contract\n\n${interaction}\n\nYour durable coordination directory is ${directory}.\n\nRules:\n1. Work only on the assigned task and respect repository instructions.\n2. Do not manage tmux or the daemon.\n3. Keep useful session-only artifacts under the coordination directory.\n4. When the assigned task is genuinely complete, write ${directory}/summary.md and run: kteam signal done\n5. Never claim completion without the done marker.\n6. Preserve unrelated user changes.\n${helpRule}\n8. Run \`bun add\`/\`bun install\` (and other package-manager installs) ONLY from inside the target package directory — cd there in the same command or use absolute paths. NEVER run them at the repository root: that creates a root package.json/node_modules that shadows nested packages and breaks their tooling.\n${waitRule}\n`;
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
    manifest: { id: string; filename: string; mime: string; size: number; hash: string; time: string };
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
   *  single fresh pane reliably recovers — without this, the whole session
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

  /** Run a TUI bootstrap (launch + first inject) exclusively — see bootstrapChain. */
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

  private async initializeGlobalSequence(): Promise<void> {
    const persisted = await readFile(path.join(this.paths.daemon, 'global-sequence.json'), 'utf8')
      .then(value => JSON.parse(value) as { sequence?: number })
      .catch(() => ({}) as { sequence?: number });
    let maximum = Number.isSafeInteger(persisted.sequence) ? persisted.sequence! : 0;
    for (const session of this.store.listSessions()) {
      for (const event of this.store.replay(session.id, { afterSequence: 0, limit: 100_000 })) {
        const envelope = event.data as unknown as StoredEnvelope;
        if (typeof envelope.globalSequence === 'number') maximum = Math.max(maximum, envelope.globalSequence);
      }
    }
    this.globalSequence = maximum;
  }

  // ── Fleet warden (layer 3) ────────────────────────────────────────────────

  /** Load durable warden state and arm the periodic deterministic sweep. The
   *  detection sweep is always-on and free; LLM escalation inside it is gated on
   *  warden.enabled. */
  private async startWarden(): Promise<void> {
    this.wardenState = await readJson<WardenRuntimeState>(this.paths.wardenState).catch(() => ({}));
    const intervalMs = Math.max(60_000, this.options.warden.intervalMinutes * 60_000);
    this.wardenTimer = setInterval(() => {
      void this.runSweep(false).catch(() => undefined);
    }, intervalMs);
    // A boot-time sweep so anomalies.json and `warden status` are populated
    // without waiting a full interval; escalation still respects its own gate.
    void this.runSweep(false).catch(() => undefined);
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
    const sessions = await this.list();
    const views: WardenSessionView[] = sessions.map(view => ({
      config: view.config,
      state: view.state,
      hasLiveMonitor: this.monitors.has(view.config.id),
      hasDoneMarker: this.doneMarkerForTurn(view.config.id, view.state.turn ?? view.config.turn),
    }));
    // One knob (`unattendedMinutes`) drives both the idle-question threshold and
    // the recent-terminal-wreckage window — an old failure that nobody handled
    // within the window ages out rather than nagging forever.
    const unattendedMs = Math.max(60_000, this.options.warden.unattendedMinutes * 60_000);
    const detected = detectAnomalies(views, Date.now(), {
      unattendedMs,
      terminalWindowMs: unattendedMs,
      susThinkingSeconds: Math.max(60, this.options.warden.susThinkingSeconds),
      susSubprocessSeconds: Math.max(60, this.options.warden.susSubprocessSeconds),
    });
    // Reconcile fresh needs_human verdicts from warden reports into session
    // state, then SUPPRESS re-triage of a flagged session's same anomaly
    // class: a needs_human session already reached the human — an identical
    // report every sweep is noise (lacey, 2026-07-23). The flag clears when a
    // human acts (answer/resume/stop).
    await this.reconcileNeedsHuman(sessions);
    const flagged = new Map(
      sessions
        .filter(view => view.state.needsHuman !== undefined)
        .map(view => [view.config.id, view.state.needsHumanKind]),
    );
    const anomalies = detected.anomalies.filter(
      item => !flagged.has(item.sessionId) || (flagged.get(item.sessionId) ?? item.kind) !== item.kind,
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

  /** Reconcile + spawn per-session assigned wardens for sus anomalies. Caps
   *  concurrency, dedupes against live assignments, and applies a per-target
   *  cooldown after a finished assignment. Returns spawned warden ids. */
  private async spawnAssignedWardens(
    susAnomalies: WardenAnomaly[],
    sessions: SessionView[],
    force: boolean,
  ): Promise<string[]> {
    const warden = this.options.warden;
    if (susAnomalies.length === 0) return [];
    if (!force && !warden.enabled) return [];
    const byId = new Map(sessions.map(view => [view.config.id, view]));
    // Reconcile: drop assignments whose warden session is gone/terminal, and
    // start the cooldown clock for the target at that moment.
    const assignments = { ...(this.wardenState.assignments ?? {}) };
    const cooldowns = { ...(this.wardenState.assignedCooldowns ?? {}) };
    for (const [targetId, record] of Object.entries(assignments)) {
      const wardenView = byId.get(record.wardenId);
      if (!wardenView || protectedStatuses.includes(wardenView.state.status)) {
        delete assignments[targetId];
        cooldowns[targetId] = now();
      }
    }
    const cooldownMs = Math.max(0, warden.assignedCooldownMinutes * 60_000);
    const spawned: string[] = [];
    for (const anomaly of susAnomalies) {
      // `assignments` already includes wardens spawned earlier in THIS loop,
      // so its size alone is the live count — adding spawned.length again
      // double-counted them and underfilled the cap (review P3).
      if (Object.keys(assignments).length >= Math.max(1, warden.maxAssignedWardens)) break;
      const targetId = anomaly.sessionId;
      if (assignments[targetId]) continue; // a warden for it is already live
      const cooledAt = cooldowns[targetId] ? Date.parse(cooldowns[targetId]!) : 0;
      if (!force && cooledAt && Date.now() - cooledAt < cooldownMs) continue;
      const target = byId.get(targetId);
      if (!target || protectedStatuses.includes(target.state.status)) continue;
      const at = now();
      const reportPath = path.join(this.paths.wardenReports, `${at.replace(/[:.]/g, '-')}-${targetId}.md`);
      await mkdir(this.paths.wardenReports, { recursive: true, mode: 0o700 });
      // Unguessable per-assignment capability: exported only into THIS
      // warden's pane; the api-server authorizes `stop <target>` by comparing
      // capabilities, so another warden holding the shared scoped token
      // cannot spoof its way to someone else's target (review P1).
      const capability = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`;
      try {
        const view = await this.start({
          prompt: this.buildAssignedWardenPrompt(anomaly, target, reportPath),
          agent: warden.wrapper,
          model: warden.model,
          mode: 'auto',
          label: WARDEN_LABEL,
          name: `warden:${target.config.teammate ?? targetId}`,
          cwd: this.paths.home,
          stopCapability: capability,
        });
        assignments[targetId] = { wardenId: view.config.id, spawnedAt: at, capability };
        spawned.push(view.config.id);
        this.emitTransient('fleet.warden_assigned', {
          wardenId: view.config.id,
          targetId,
          kind: anomaly.kind,
          reportPath,
        });
      } catch (error) {
        cooldowns[targetId] = at; // broken wrapper: don't retry every sweep
        this.emitTransient('fleet.warden_spawn_failed', {
          targetId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.wardenState.assignments = assignments;
    this.wardenState.assignedCooldowns = cooldowns;
    await this.saveWardenState();
    return spawned;
  }

  /** True when `capability` matches the secret minted for `targetId`'s
   *  active assignment — the ONLY case the warden-scoped token may stop a
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
              'Judge whether that is expected for the task (build, test suite, long migration…) and whether the process is',
              'actually PROGRESSING: is its output growing (turn logs, files in the cwd), is it consuming CPU (`ps`), are',
              'artifacts appearing? A legitimate long task should show movement between two looks a minute apart.',
            ]
          : [
              'The session has been waiting on an unanswered question for a long time.',
              'Read its pending question and its own chat.jsonl/turns: answer with `kteam answer` ONLY when the answer is',
              'unambiguous from its own context; otherwise state precisely what a human must decide in the report.',
            ];
    return [
      `You are an ASSIGNED kteam warden for exactly one session: ${target.config.id} (teammate ${target.config.teammate ?? '-'}).`,
      'It was flagged sus (alive but weird) by the fleet sweep. Investigate THIS session only and deliver one verdict.',
      '',
      '## The anomaly',
      '```json',
      JSON.stringify(anomaly, null, 2),
      '```',
      '',
      '## What to understand first',
      `- The live liveness ledger: ${target.directory}/liveness.yaml (rewritten every monitor tick — seconds since conversation/tokens/thinking/subprocess/pane life-signs plus the current nudge/kill/sus triggers). Read it twice a minute apart.`,
      `- The task and conversation so far: read ${target.directory}/prompt.md, chat.jsonl, and turns/ + logs/.`,
      `- Live pane: \`kteam snapshot ${target.config.id}\` (twice, a minute apart — compare).`,
      `- Recent events: \`kteam events ${target.config.id} --after -50\`.`,
      `- The workspace: read-only \`git -C ${target.config.cwd} diff --stat\` and file timestamps.`,
      ...kindHelp.map(line => `- ${line}`),
      '',
      '## Verdict (exactly one; state it and the evidence in the report)',
      '- LEAVE — the long operation is expected and progressing; no action.',
      `- NUDGE — \`kteam send ${target.config.id} <message>\` if it looks wedged but recoverable.`,
      `- RESUME — \`kteam resume ${target.config.id}\` if the turn is dead but the session should continue.`,
      `- KILL — \`kteam stop ${target.config.id}\` ONLY if the session is demonstrably burning time/tokens with no progress.`,
      '  (Your token can stop only this assigned session.)',
      '',
      '## Rules',
      '- Do NOT touch any other session. No git writes, no repository edits, no new non-warden sessions.',
      `- Write your report to EXACTLY: ${reportPath}`,
      '- The report MUST follow this machine-stable template (the Fleet UI parses lines 1 and 3):',
      '```',
      'Verdict: LEAVE|NUDGE|RESUME|KILL',
      '',
      `# Warden report — ${target.config.id} (teammate ${target.config.teammate ?? '-'}, ${target.config.label ?? '-'})`,
      '',
      '## Summary',
      '<one- or two-sentence reason for the verdict>',
      '',
      '<free-form evidence sections>',
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
    const warden = this.options.warden;
    if (!force && !warden.enabled) return { message: 'escalation disabled (warden.enabled=false)' };
    if (anomalies.length === 0) return { message: 'no anomalies to escalate' };
    // "Live" excludes protected statuses (terminal + kill_failed): a warden whose
    // pane could not be killed must NOT block escalation forever — the spawn gap
    // below still rate-limits fresh wardens, so a wedged warden ages out.
    const live = sessions.find(
      view => view.config.label === WARDEN_LABEL && !protectedStatuses.includes(view.state.status),
    );
    if (live) return { message: `a warden session is already live (${live.config.id})` };
    const lastSpawnMs = this.wardenState.lastSpawnAt ? Date.parse(this.wardenState.lastSpawnAt) : 0;
    const gapMs = Math.max(0, warden.minSpawnGapMinutes * 60_000);
    if (!force && lastSpawnMs && Date.now() - lastSpawnMs < gapMs)
      return { message: `spawn gap not elapsed (last spawn ${this.wardenState.lastSpawnAt})` };
    // Suppression key qualified by the recovery generation (see sweepOnce).
    const spawnKey = `${this.wardenState.recoveryGeneration ?? 0}:${fingerprint}`;
    if (!force && spawnKey === this.wardenState.lastSpawnFingerprint)
      return { message: 'anomaly set unchanged since the last escalation' };
    const at = now();
    const reportPath = path.join(this.paths.wardenReports, `${at.replace(/[:.]/g, '-')}.md`);
    await mkdir(this.paths.wardenReports, { recursive: true, mode: 0o700 });
    const prompt = await this.buildWardenPrompt(anomalies, sessions, reportPath, at);
    try {
      const view = await this.start({
        prompt,
        agent: warden.wrapper,
        model: warden.model,
        mode: 'auto',
        label: WARDEN_LABEL,
        name: 'warden-sweep',
        cwd: this.paths.home,
      });
      this.wardenState.lastSpawnAt = at;
      this.wardenState.lastSpawnFingerprint = spawnKey;
      await this.saveWardenState();
      this.emitTransient('fleet.warden_spawned', { sessionId: view.config.id, count: anomalies.length, reportPath });
      return { spawned: view.config.id };
    } catch (error) {
      // A FAILED launch still consumes the spawn gap (record lastSpawnAt) so a
      // persistently-broken wrapper can't be retried every sweep — but do NOT
      // record the suppression key, so a changed anomaly set (or the same set in
      // a later generation) can still escalate once the gap elapses.
      this.wardenState.lastSpawnAt = at;
      await this.saveWardenState();
      const message = `warden spawn failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emitTransient('fleet.warden_spawn_failed', { message });
      return { message };
    }
  }

  private async buildWardenPrompt(
    anomalies: WardenAnomaly[],
    sessions: SessionView[],
    reportPath: string,
    at: string,
  ): Promise<string> {
    const anomalousIds = new Set(anomalies.map(item => item.sessionId));
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
      'You are the kteam FLEET WARDEN — layer-3 oversight for a team of autonomous coding agents.',
      `A deterministic sweep at ${at} found the anomalies below. Triage them and take only the SAFE, obvious recovery actions.`,
      '',
      '## ALLOWED actions',
      '- `kteam resume <id> [message]` a stalled/failed session whose failure reason is clearly transient (network, connection, timeout, overloaded, a dropped harness process). Read the session chat/turn files first.',
      '- `kteam send <id> <nudge>` a session that looks wedged but recoverable.',
      '- `kteam migrate <id> -a <wrapper>` a QUOTA/rate-limited session onto a usable same-kind account. Only pick a wrapper from that session\'s "Migrate candidates" list below (never guess) — the session keeps its conversation and continues on the new account.',
      "- Answer a question ONLY when its answer is unambiguous from that session's OWN chat.jsonl / turns/ files. If you must guess, do not answer.",
      '',
      '## FORBIDDEN — never do these',
      '- Do NOT stop or remove (`kteam stop`/`kteam delete`) any session.',
      '- Do NOT run any git operations, and do NOT edit any repository files.',
      '- Do NOT start any non-warden session.',
      '',
      '## Required output',
      `- Write a report to EXACTLY this path: ${reportPath}`,
      '  It must state: what you found, what you did (per session), and what still needs a human.',
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
            'If a candidate list is empty, do NOT migrate that session — leave it to wait for its quota reset.',
            '```json',
            JSON.stringify(migrateCandidates, null, 2),
            '```',
          ]
        : []),
      '',
      `The full anomaly file is at ${this.paths.wardenAnomalies}. Each session's durable directory (chat.jsonl, turns/, logs/) is listed above — read it before acting.`,
    ].join('\n');
  }

  private async saveWardenState(): Promise<void> {
    await atomicJson(this.paths.wardenState, this.wardenState);
  }

  /** Broadcast a fleet-level (non-session) event to live listeners without
   *  persisting it — transient by design (the anomaly file is the durable copy). */
  private emitTransient(type: string, payload: unknown): void {
    const event: KTeamEvent = {
      sequence: ++this.globalSequence,
      time: now(),
      sessionId: 'fleet',
      turn: 0,
      type,
      source: 'daemon',
      data: payload,
    };
    for (const listener of this.listeners) listener(event);
  }

  private async latestReport(): Promise<{ path: string; head: string } | undefined> {
    const files = await readdir(this.paths.wardenReports).catch(() => [] as string[]);
    const latest = files
      .filter(name => name.endsWith('.md'))
      .sort()
      .at(-1);
    if (!latest) return undefined;
    const file = path.join(this.paths.wardenReports, latest);
    const text = await readFile(file, 'utf8').catch(() => '');
    return { path: file, head: text.split('\n').slice(0, 12).join('\n') };
  }

  async wrappers(): Promise<WrapperInfo[]> {
    return listWrappers(this.paths.kfleetBin);
  }

  async projects(): Promise<ProjectInfo[]> {
    return scanProjects(this.options.projectRoots ?? ['~/Workspace', '~/.config']);
  }

  /** Reconcile needs_human verdicts from recent warden reports into durable
   *  session state: set `needsHuman` (reason) + `needsHumanKind` (the anomaly
   *  class fingerprint used for sweep dedupe) and emit a transient
   *  fleet.needs_human ONCE per flagging. Cheap: reads only the recent
   *  reports already parsed by wardenVerdicts(). */
  private async reconcileNeedsHuman(sessions: SessionView[]): Promise<void> {
    const verdicts = await this.wardenVerdicts().catch(() => [] as WardenVerdict[]);
    const byId = new Map(sessions.map(view => [view.config.id, view]));
    for (const verdict of verdicts) {
      if (verdict.verdict !== 'needs_human' || !verdict.targetSession) continue;
      const view = byId.get(verdict.targetSession);
      if (!view || view.state.needsHuman !== undefined) continue;
      const reason = verdict.reason ?? 'a warden concluded this session needs a human decision';
      // The anomaly kind at flag time keys the dedupe: a NEW anomaly class on
      // the same session still surfaces.
      const kind = this.lastSweep?.anomalies.find(item => item.sessionId === view.config.id)?.kind;
      await this.store
        .updateState<SessionState>(view.config.id, current => ({
          ...current,
          needsHuman: reason,
          ...(kind ? { needsHumanKind: kind } : {}),
        }))
        .catch(() => undefined);
      view.state.needsHuman = reason;
      view.state.needsHumanKind = kind;
      this.emitTransient('fleet.needs_human', {
        sessionId: view.config.id,
        teammate: view.config.teammate,
        reason,
        reportPath: verdict.reportPath,
      });
    }
  }

  /** A human acted on the session — clear the needs_human flag so the sweep
   *  resumes watching it. Called from answer/resume/stop. */
  private async clearNeedsHuman(id: string): Promise<void> {
    await this.store
      .updateState<SessionState>(id, current =>
        current.needsHuman === undefined ? current : { ...current, needsHuman: undefined, needsHumanKind: undefined },
      )
      .catch(() => undefined);
  }

  async wardenVerdicts(): Promise<WardenVerdict[]> {
    const dir = this.paths.wardenReports;
    const names = (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.md'));
    // Read only the most recent reports (by mtime) — bounded work.
    const stats = await Promise.all(
      names.map(async name => {
        const p = path.join(dir, name);
        const s = await stat(p).catch(() => undefined);
        return s ? { path: p, mtimeMs: s.mtimeMs } : undefined;
      }),
    );
    const recent = stats
      .filter((x): x is { path: string; mtimeMs: number } => x !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 40);
    const files = await Promise.all(
      recent.map(async r => ({
        path: r.path,
        mtimeMs: r.mtimeMs,
        content: await readFile(r.path, 'utf8').catch(() => ''),
      })),
    );
    return parseWardenReports(files.filter(f => f.content));
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
      const raw = await readFile(path.join(sessionDir(this.paths, v.config.id), 'chat.jsonl'), 'utf8').catch(() => '');
      if (!raw || !re.test(raw)) continue;
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
    return readFile(resolved, 'utf8').catch(() => {
      throw new Error('report not found');
    });
  }

  async wardenStatus(): Promise<WardenStatusView> {
    let anomalies = this.lastSweep?.anomalies ?? [];
    let fingerprint = this.lastSweep?.fingerprint ?? '';
    let lastSweepAt = this.lastSweep?.at ?? this.wardenState.lastSweepAt;
    if (!this.lastSweep) {
      const disk = await readJson<{ at?: string; fingerprint?: string; anomalies?: WardenAnomaly[] }>(
        this.paths.wardenAnomalies,
      ).catch(() => undefined);
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
      config: this.options.warden,
      lastSweepAt,
      anomalies,
      fingerprint,
      liveWarden,
      lastSpawnAt: this.wardenState.lastSpawnAt,
      lastReport: await this.latestReport(),
    };
  }

  async wardenRun(spawn = false): Promise<WardenRunView> {
    return await this.runSweep(spawn);
  }
}
