import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { logDim, logWarn } from '../util/format';
import { sessionDir } from './artifacts';
import { checkLock } from './lock';
import { appendEvent, readLog } from './log';
import { readPlanManifest } from './manifests';
import type { LogEntry } from './types';

// ============================================================================
// Types
// ============================================================================

export interface TaskStatus {
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  logRef: number;
}

/** Active plan context during implementation phase */
export interface ActivePlan {
  name: string;
  planIndex: number;
  maxPlans: number;
  kloopRunId: string | null;
  rewriteDecision: string | null;
  attempt: number;
}

/** Polish phase state for PR delivery visibility */
export interface PolishState {
  deliveryKind: 'pr' | 'ticket';
  prNumber: number | null;
  prUrl: string | null;
  pushCycle: number;
  kloopRunId: string | null;
  lastPollState: 'mergeable' | 'pending' | 'blocked' | null;
  lastPollAt: string | null;
  lastEvalSummary: {
    autoResolved: number;
    totalEvalUnits: number;
    replies: number;
    resolves: number;
    codeFixes: number;
    ambiguous: number;
  } | null;
  ttyReason: string | null;
}

/** Per-phase summary for overall progress visibility */
export interface PhaseSummary {
  status: 'pending' | 'active' | 'completed';
  currentStep: string | null;
}

/** Implementation phase summary with plan progress */
export interface ImplPhaseSummary extends PhaseSummary {
  planProgress: string | null;
}

/** Polish phase summary with poll state */
export interface PolishPhaseSummary extends PhaseSummary {
  pollState: string | null;
}

export interface SessionStatus {
  // Replay metadata
  walCursor: number;
  walTimestamp: string;

  // Current position
  phase: string;
  version: number;
  state: string;
  stateStatus: 'pending' | 'running' | 'completed' | 'failed';

  // Checkpoint
  lastCheckpoint: string | null;
  checkpointRef: number;

  // Process
  pid: number | null;
  running: boolean;
  startedAt: string | null;

  // Step execution type and turn tracking
  stepType: 'tty' | 'llm' | 'code' | null;
  userTurn: boolean | null;

  // Parallel sub-tasks
  tasks: Record<string, TaskStatus>;

  // Completed steps for current cycle (resume logic)
  completedSteps: string[];
  completedPlans: number[];

  // Phase-specific context (survives crash recovery)
  context: {
    planIndex?: number;
    maxPlans?: number;
    prNumber?: number;
    prUrl?: string;
    pushCycle?: number;
    attempt?: number;
    deliveryKind?: 'pr' | 'ticket';
    rewriteDecision?: string;
    ticketFeedback?: boolean;
    rolloverRecommendation?: {
      shouldRollover: boolean;
      reason?: string;
      signals?: Record<string, unknown>;
    };
    rolloverFromPr?: number;
    reportedFailedRunIds?: number[];
    lastPhase2Version?: number;
    ttyReason?: string;
  };

  // Kloop run IDs per plan (plan name -> list of run IDs)
  planRuns: Record<string, string[]>;

  // Active plan context (implementation phase)
  activePlan: ActivePlan | null;

  // Polish phase state
  polishState: PolishState | null;

  // All plans from manifest
  allPlans: Array<{
    ordinal: number;
    file: string;
    completed: boolean;
    commitSha: string | null;
  }>;

  // Per-phase summary
  phases: {
    plan: PhaseSummary;
    implementation: ImplPhaseSummary;
    polish: PolishPhaseSummary;
  };

  // Stats
  stats: {
    totalReplies: number;
    totalResolved: number;
    pushCycles: number;
  };
}

// ============================================================================
// Checkpoint Definitions
// ============================================================================

export const CHECKPOINTS: Record<string, Set<string>> = {
  plan: new Set(['pull_ticket', 'write_spec', 'finalize_spec', 'finalize_plans']),
  implementation: new Set(['clear_loop', 'commit', 'next_plan', 'completed']),
  polish: new Set(['commit_pending', 'prereview', 'push', 'create_pr', 'poll', 'feedback_check', 'completed']),
};

/** Ordered step names per phase for display purposes */
export const PHASE_STEPS: Record<string, string[]> = {
  plan: ['pull_ticket', 'triage', 'write_spec', 'finalize_spec', 'write_plans', 'finalize_plans'],
  implementation: ['clear_loop', 'setup_run', 'running', 'resolve', 'amend_plans', 'commit', 'next_plan', 'completed'],
  polish: [
    'commit_pending',
    'prereview',
    'push',
    'create_pr',
    'poll',
    'ensure_branch',
    'eval',
    'act',
    'tty_resolve',
    'write_fix',
    'run_fix',
    'feedback_check',
    'completed',
  ],
};

function isCheckpoint(phase: string, state: string): boolean {
  return CHECKPOINTS[phase]?.has(state) ?? false;
}

// ============================================================================
// Lifecycle events — excluded from state tracking
// ============================================================================

const LIFECYCLE_EVENTS = new Set([
  'init:started',
  'init:completed',
  'init:failed',
  'init:cancelled',
  'start:started',
  'start:completed',
  'stop:started',
  'stop:completed',
  'phase_start:forced',
  'start_ticket:called',
  'crash:detected',
  'reset:started',
  'reset:cleanup',
  'reset:completed',
  'subtask:started',
  'subtask:completed',
  'subtask:failed',
  'context:updated',
]);

function isLifecycleEvent(event: string): boolean {
  return LIFECYCLE_EVENTS.has(event);
}

// ============================================================================
// Phase mapping
// ============================================================================

function phaseFromEvent(event: string): string {
  if (event.startsWith('phase1')) return 'plan';
  if (event.startsWith('phase2')) return 'implementation';
  if (event.startsWith('phase3')) return 'polish';
  return 'none';
}

// ============================================================================
// Initial status
// ============================================================================

function initialStatus(): SessionStatus {
  return {
    walCursor: 0,
    walTimestamp: '',
    phase: 'none',
    version: 0,
    state: 'none',
    stateStatus: 'pending',
    lastCheckpoint: null,
    checkpointRef: 0,
    pid: null,
    running: false,
    startedAt: null,
    stepType: null,
    userTurn: null,
    tasks: {},
    completedSteps: [],
    completedPlans: [],
    context: {},
    planRuns: {},
    activePlan: null,
    polishState: null,
    allPlans: [],
    phases: {
      plan: { status: 'pending', currentStep: null },
      implementation: {
        status: 'pending',
        currentStep: null,
        planProgress: null,
      },
      polish: { status: 'pending', currentStep: null, pollState: null },
    },
    stats: { totalReplies: 0, totalResolved: 0, pushCycles: 0 },
  };
}

// ============================================================================
// applyEvent reducer
// ============================================================================

function applyEvent(status: SessionStatus, entry: LogEntry, index: number): void {
  status.walCursor = index + 1;
  status.walTimestamp = entry.ts;

  const { event } = entry;

  // Phase start
  if (/^phase\d:started$/.test(event)) {
    const newPhase = phaseFromEvent(event);
    status.phase = newPhase;
    status.version = entry.version ?? status.version;
    status.completedSteps = [];
    status.completedPlans = [];
    status.tasks = {};
    status.lastCheckpoint = null;
    status.checkpointRef = 0;

    // Bug fix #1: Reset phase-specific context fields on phase transitions
    if (newPhase === 'plan') {
      // Bug fix #6: Clear planRuns on new epoch (revisit_spec / amend_spec)
      status.planRuns = {};
      // Bug fix #7: Clear ALL context except deliveryKind on revisit_spec
      const deliveryKind = status.context.deliveryKind;
      status.context = { deliveryKind };
      status.activePlan = null;
      status.polishState = null;
    } else if (newPhase === 'implementation') {
      // Reset phase2-specific context
      status.context.rewriteDecision = undefined;
      status.context.attempt = undefined;
      status.activePlan = null;
      status.polishState = null;
    } else if (newPhase === 'polish') {
      // Reset phase3-specific context
      status.context.pushCycle = undefined;
      status.context.prNumber = undefined;
      status.context.prUrl = undefined;
      status.context.ttyReason = undefined;
      status.activePlan = null;
      // Initialize polishState
      status.polishState = {
        deliveryKind: (status.context.deliveryKind as 'pr' | 'ticket') ?? 'pr',
        prNumber: null,
        prUrl: null,
        pushCycle: 0,
        kloopRunId: null,
        lastPollState: null,
        lastPollAt: null,
        lastEvalSummary: null,
        ttyReason: null,
      };
    }
  }

  // Phase complete — clear ephemeral state
  if (/^phase\d:completed$/.test(event)) {
    const completedPhase = phaseFromEvent(event);
    if (completedPhase === 'implementation') {
      status.activePlan = null;
    }
    if (completedPhase === 'polish') {
      status.polishState = null;
    }
  }

  // Per-plan cycle reset (phase2 loops per plan)
  if (event === 'clear_loop:started' && entry.metadata?.planIndex != null) {
    status.completedSteps = [];
    const planIndex = entry.metadata.planIndex as number;
    status.context.planIndex = planIndex;
    const maxPlans = status.context.maxPlans ?? 0;
    status.activePlan = {
      name: `plan-${planIndex + 1}`,
      planIndex,
      maxPlans,
      kloopRunId: null,
      rewriteDecision: null,
      attempt: (status.context.attempt as number) ?? 1,
    };
  }

  // Plan completion tracking
  if (event === 'commit:completed' && status.context.planIndex != null) {
    if (!status.completedPlans.includes(status.context.planIndex)) {
      status.completedPlans.push(status.context.planIndex);
    }
  }

  // Track kloop run IDs per plan
  if (event === 'setup_run:completed' && entry.metadata?.kloopRunId) {
    const plan = (entry.plan as string) ?? `plan-${(status.context.planIndex ?? 0) + 1}`;
    const runId = entry.metadata.kloopRunId as string;
    if (!status.planRuns[plan]) {
      status.planRuns[plan] = [];
    }
    status.planRuns[plan].push(runId);
    // Update activePlan kloopRunId (create if missing, e.g. after crash recovery)
    if (status.activePlan) {
      if (status.activePlan.name === plan) {
        status.activePlan.kloopRunId = runId;
      }
    } else {
      const planIndex = status.context.planIndex ?? 0;
      status.activePlan = {
        name: plan,
        planIndex,
        maxPlans: (status.context.maxPlans as number) ?? 0,
        kloopRunId: runId,
        rewriteDecision: null,
        attempt: (status.context.attempt as number) ?? 1,
      };
    }
  }

  // Update activePlan when running completes (kloop finished)
  if (event === 'running:completed' && status.activePlan) {
    status.activePlan.kloopRunId = null;
  }

  // Track rewrite decision in activePlan
  if (event === 'resolve:completed' && entry.metadata?.rewriteDecision && status.activePlan) {
    status.activePlan.rewriteDecision = entry.metadata.rewriteDecision as string;
  }

  // Update activePlan on next_plan
  if (event === 'next_plan:completed' && status.activePlan && entry.metadata?.to) {
    const to = entry.metadata.to as string;
    if (to !== 'done') {
      const match = to.match(/^plan-(\d+)$/);
      if (match) {
        const newPlanIndex = parseInt(match[1], 10) - 1;
        status.activePlan.planIndex = newPlanIndex;
        status.activePlan.name = to;
        status.activePlan.kloopRunId = null;
        status.activePlan.rewriteDecision = null;
      }
    }
  }

  // State started (skip lifecycle/meta events)
  if (event.endsWith(':started') && !isLifecycleEvent(event)) {
    const name = event.replace(':started', '');
    status.state = name;
    status.stateStatus = 'running';
    // Set stepType from metadata, derive initial userTurn
    const st = (entry.metadata?.stepType as string) ?? null;
    status.stepType = st as SessionStatus['stepType'];
    status.userTurn = st === 'tty' ? true : st ? false : null;
  }

  // State completed (skip lifecycle/meta events)
  if (event.endsWith(':completed') && !isLifecycleEvent(event)) {
    const name = event.replace(':completed', '');
    if (name === status.state) {
      status.stateStatus = 'completed';
    }
    status.stepType = null;
    status.userTurn = null;
    if (!status.completedSteps.includes(name)) {
      status.completedSteps.push(name);
    }
    if (isCheckpoint(status.phase, name)) {
      status.lastCheckpoint = name;
      status.checkpointRef = index + 1;
    }
    // Clear parallel tasks when parent state completes
    if (Object.keys(status.tasks).length > 0) {
      status.tasks = {};
    }
  }

  // Session run start
  if (event === 'start:started') {
    status.running = true;
    status.pid = (entry.metadata?.pid as number) ?? null;
    status.startedAt = entry.ts;
    if (entry.metadata?.phase) {
      status.phase = entry.metadata.phase as string;
    }
  }

  // Session run end
  if (event === 'start:completed' || event === 'stop:completed') {
    status.running = false;
    status.pid = null;
    status.stepType = null;
    status.userTurn = null;
  }

  // Subtask events
  if (event === 'subtask:started' && entry.metadata?.task) {
    const task = entry.metadata.task as string;
    status.tasks[task] = {
      status: 'running',
      startedAt: entry.ts,
      logRef: index,
    };
  }
  if (event === 'subtask:completed' && entry.metadata?.task) {
    const task = entry.metadata.task as string;
    if (status.tasks[task]) {
      status.tasks[task].status = 'completed';
      status.tasks[task].completedAt = entry.ts;
      status.tasks[task].logRef = index;
    }
  }
  if (event === 'subtask:failed' && entry.metadata?.task) {
    const task = entry.metadata.task as string;
    if (status.tasks[task]) {
      status.tasks[task].status = 'failed';
      status.tasks[task].failedAt = entry.ts;
      status.tasks[task].logRef = index;
    }
  }

  // Context updates — also track polish-specific fields
  if (event === 'context:updated' && entry.metadata) {
    const { task, parent, error, ...contextFields } = entry.metadata;
    Object.assign(status.context, contextFields);

    // Update polishState from context changes
    if (status.polishState) {
      if (contextFields.prNumber != null) status.polishState.prNumber = contextFields.prNumber as number;
      if (contextFields.prUrl != null) status.polishState.prUrl = contextFields.prUrl as string;
      if (contextFields.pushCycle != null) status.polishState.pushCycle = contextFields.pushCycle as number;
      if (contextFields.ttyReason != null) status.polishState.ttyReason = contextFields.ttyReason as string;
      if (contextFields.deliveryKind != null)
        status.polishState.deliveryKind = contextFields.deliveryKind as 'pr' | 'ticket';
    }
  }

  // Track polish poll state from poll:completed
  if (event === 'poll:completed' && status.polishState) {
    const pollState = entry.metadata?.pollState as string | undefined;
    if (pollState) {
      status.polishState.lastPollState = pollState as 'mergeable' | 'pending' | 'blocked';
      status.polishState.lastPollAt = entry.ts;
    }
  }

  // Track polish eval summary from eval:completed
  if (event === 'eval:completed' && status.polishState) {
    status.polishState.lastEvalSummary = {
      autoResolved: (entry.metadata?.autoResolved as number) ?? 0,
      totalEvalUnits: (entry.metadata?.totalEvalUnits as number) ?? 0,
      replies: (entry.metadata?.replies as number) ?? 0,
      resolves: (entry.metadata?.resolves as number) ?? 0,
      codeFixes: (entry.metadata?.codeFixes as number) ?? 0,
      ambiguous: (entry.metadata?.ambiguous as number) ?? 0,
    };
  }

  // Track polish kloop run from write_fix:completed
  if (event === 'write_fix:completed' && entry.metadata?.kloopRunId && status.polishState) {
    status.polishState.kloopRunId = entry.metadata.kloopRunId as string;
  }

  // Clear polish kloop run when run_fix completes
  if (event === 'run_fix:completed' && status.polishState) {
    status.polishState.kloopRunId = null;
  }

  // Reset — roll back to checkpoint (resume from the next state after it)
  if (event === 'reset:completed' && entry.metadata?.checkpoint) {
    const checkpoint = entry.metadata.checkpoint as string;
    status.state = checkpoint;
    status.stateStatus = 'completed';
    status.tasks = {};
    status.activePlan = null;
    status.polishState = null;
    const idx = status.completedSteps.indexOf(checkpoint);
    if (idx >= 0) {
      status.completedSteps = status.completedSteps.slice(0, idx + 1);
    }
    status.lastCheckpoint = checkpoint;
    status.running = false;
    status.pid = null;
  }

  // Stats accumulation
  if (entry.metadata) {
    if (entry.metadata.replies != null) status.stats.totalReplies = entry.metadata.replies as number;
    if (entry.metadata.resolved != null) status.stats.totalResolved = entry.metadata.resolved as number;
    if (entry.metadata.pushCycle != null) status.stats.pushCycles = entry.metadata.pushCycle as number;
  }
}

// ============================================================================
// YAML I/O
// ============================================================================

function statusPath(sessionId: string): string {
  return `${process.env.HOME}/.kautopilot/${sessionId}/status.yaml`;
}

function readStatusYaml(sessionId: string): SessionStatus | null {
  const path = statusPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return YAML.parse(raw) as SessionStatus;
  } catch {
    return null;
  }
}

function writeStatusYaml(sessionId: string, status: SessionStatus): void {
  const path = statusPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const content = YAML.stringify(status, { lineWidth: 120 });
  // Atomic write: temp file + rename
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ============================================================================
// ensureStatus — lazy incremental replay
// ============================================================================

export function ensureStatus(sessionId: string): SessionStatus {
  const log = readLog(sessionId);
  const existing = readStatusYaml(sessionId);

  if (existing && existing.walCursor >= log.length) {
    const status = { ...initialStatus(), ...existing };
    computeDerivedFields(status, sessionId);
    return status;
  }

  // Incremental replay from cursor, or full replay if missing
  // Merge with initialStatus() so new fields get their defaults when
  // reading status.yaml from a session created before those fields existed.
  const status = existing ? { ...initialStatus(), ...existing } : initialStatus();
  const startIdx = existing ? existing.walCursor : 0;

  for (let i = startIdx; i < log.length; i++) {
    applyEvent(status, log[i], i);
  }

  computeDerivedFields(status, sessionId);
  writeStatusYaml(sessionId, status);
  return status;
}

// ============================================================================
// Derived field computation
// ============================================================================

/**
 * Compute fields that depend on external data (plan manifest) or are
 * summary views of the replayed state (phases summary).
 */
function computeDerivedFields(status: SessionStatus, sessionId: string): void {
  // allPlans — from plan manifest
  const manifest = readPlanManifest(sessionId, status.version);
  if (manifest) {
    status.allPlans = manifest.plans.map(p => ({
      ordinal: p.ordinal,
      file: p.file,
      completed: p.completed,
      commitSha: p.commitSha ?? null,
    }));
  } else {
    status.allPlans = [];
  }

  // phases summary
  const phaseOrder: Array<'plan' | 'implementation' | 'polish'> = ['plan', 'implementation', 'polish'];
  const currentPhaseIdx = phaseOrder.indexOf(status.phase as 'plan' | 'implementation' | 'polish');

  for (const p of phaseOrder) {
    const pIdx = phaseOrder.indexOf(p);
    if (
      pIdx < currentPhaseIdx ||
      (pIdx === currentPhaseIdx && status.stateStatus === 'completed' && status.phase === p)
    ) {
      // Completed phase
      if (p === 'implementation') {
        status.phases.implementation = {
          status: 'completed',
          currentStep: null,
          planProgress: null,
        };
      } else if (p === 'polish') {
        status.phases.polish = {
          status: 'completed',
          currentStep: null,
          pollState: null,
        };
      } else {
        status.phases.plan = { status: 'completed', currentStep: null };
      }
    } else if (p === status.phase) {
      // Active phase
      const step = status.stateStatus === 'running' ? status.state : null;
      if (p === 'implementation') {
        const planProgress = status.activePlan
          ? `${status.activePlan.planIndex + 1}/${status.activePlan.maxPlans}`
          : status.context.maxPlans != null
            ? `${(status.context.planIndex ?? 0) + 1}/${status.context.maxPlans}`
            : null;
        status.phases.implementation = {
          status: 'active',
          currentStep: step,
          planProgress,
        };
      } else if (p === 'polish') {
        status.phases.polish = {
          status: 'active',
          currentStep: step,
          pollState: status.polishState?.lastPollState ?? null,
        };
      } else {
        status.phases.plan = { status: 'active', currentStep: step };
      }
    } else {
      // Pending phase
      if (p === 'implementation') {
        status.phases.implementation = {
          status: 'pending',
          currentStep: null,
          planProgress: null,
        };
      } else if (p === 'polish') {
        status.phases.polish = {
          status: 'pending',
          currentStep: null,
          pollState: null,
        };
      } else {
        status.phases.plan = { status: 'pending', currentStep: null };
      }
    }
  }
}

/**
 * Get the current kloop run ID from either activePlan or polishState.
 * Convenience accessor for CLI commands.
 */
export function getCurrentKloopRunId(status: SessionStatus): string | null {
  return status.activePlan?.kloopRunId ?? status.polishState?.kloopRunId ?? null;
}

// ============================================================================
// Direct status mutations (for live updates outside the WAL)
// ============================================================================

/**
 * Atomically update userTurn in status.yaml.
 * Called from turn-watcher during TTY steps — safe because the main process
 * is blocked on `await proc.exited`, so only the watcher callback writes.
 */
export function updateUserTurn(sessionId: string, userTurn: boolean): void {
  const raw = readStatusYaml(sessionId);
  if (!raw) return;
  const status = { ...initialStatus(), ...raw };
  if (status.userTurn === userTurn) return; // no-op
  status.userTurn = userTurn;
  writeStatusYaml(sessionId, status);
}

// ============================================================================
// Cleanup functions
// ============================================================================

type CleanupFn = (sessionId: string, version: number, worktree: string, ticketId: string) => string[];

const CLEANUP: Record<string, CleanupFn> = {
  gather_context: (_sid, v, wt, tid) => {
    const dir = join(wt, 'spec', tid, `v${v}`, 'understanding');
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
      return [`removed ${dir}`];
    }
    return [];
  },
  running: (sid, _v, _wt, _tid) => {
    return cancelKloopIfAlive(sid);
  },
  run_fix: (sid, _v, _wt, _tid) => {
    return cancelKloopIfAlive(sid);
  },
  ensure_branch: (_sid, _v, wt, _tid) => {
    return abortRebaseIfNeeded(wt);
  },
};

function cancelKloopIfAlive(sessionId: string): string[] {
  // Check for kloop lock file and kill if alive
  const kloopLock = join(sessionDir(sessionId), 'tmp', 'kloop.pid');
  if (existsSync(kloopLock)) {
    try {
      const pid = parseInt(readFileSync(kloopLock, 'utf-8').trim(), 10);
      process.kill(pid, 0); // check alive
      process.kill(pid, 'SIGTERM');
      return [`killed kloop PID ${pid}`];
    } catch {
      // Not alive or can't kill
    }
  }
  return [];
}

function abortRebaseIfNeeded(worktree: string): string[] {
  const rebaseDir = join(worktree, '.git', 'rebase-merge');
  const rebaseApply = join(worktree, '.git', 'rebase-apply');
  if (existsSync(rebaseDir) || existsSync(rebaseApply)) {
    try {
      Bun.spawnSync({ cmd: ['git', 'rebase', '--abort'], cwd: worktree });
      return ['aborted in-progress rebase'];
    } catch {
      // Ignore
    }
  }
  return [];
}

function runCleanup(state: string, sessionId: string, version: number, worktree: string, ticketId: string): string[] {
  const fn = CLEANUP[state];
  return fn ? fn(sessionId, version, worktree, ticketId) : [];
}

// ============================================================================
// Crash recovery
// ============================================================================

/**
 * Detect a crashed session and recover to last checkpoint.
 * Call BEFORE acquiring lock in start.ts.
 * Returns true if recovery was performed.
 */
export function detectAndRecoverCrash(sessionId: string, worktree: string, ticketId: string = 'local'): boolean {
  const status = ensureStatus(sessionId);

  // Only recover if status says running but no lock is held
  if (!status.running) return false;
  const lock = checkLock(sessionId);
  if (lock.locked) return false;

  // Dead process detected
  const crashedState = status.state;
  const crashedPid = status.pid;
  const checkpoint = status.lastCheckpoint;
  const version = status.version;

  appendEvent(sessionId, {
    ts: new Date().toISOString(),
    event: 'crash:detected',
    version,
    metadata: {
      pid: crashedPid,
      state: crashedState,
      checkpoint,
    },
  });

  // Run cleanup for the crashed state
  const actions = runCleanup(crashedState, sessionId, version, worktree, ticketId);

  appendEvent(sessionId, {
    ts: new Date().toISOString(),
    event: 'reset:started',
    version,
    metadata: {
      from: crashedState,
      to: checkpoint ?? 'none',
      reason: 'crash_recovery',
    },
  });

  if (actions.length > 0) {
    appendEvent(sessionId, {
      ts: new Date().toISOString(),
      event: 'reset:cleanup',
      version,
      metadata: { state: crashedState, actions },
    });
  }

  appendEvent(sessionId, {
    ts: new Date().toISOString(),
    event: 'reset:completed',
    version,
    metadata: { checkpoint: checkpoint ?? 'none' },
  });

  // Re-materialize status with the new reset events
  ensureStatus(sessionId);

  if (checkpoint) {
    logWarn(`Crash detected (PID ${crashedPid} in ${crashedState}) — reset to checkpoint: ${checkpoint}`);
  } else {
    logWarn(`Crash detected (PID ${crashedPid} in ${crashedState}) — reset to phase start (no checkpoint)`);
  }
  if (actions.length > 0) {
    logDim(`  Cleanup: ${actions.join(', ')}`);
  }

  return true;
}
