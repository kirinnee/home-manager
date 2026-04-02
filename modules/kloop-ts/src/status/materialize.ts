import * as YAML from 'yaml';
import type { FsService, Paths } from '../deps';
import { paths as defaultPaths } from '../deps';
import type {
  MaterializedStatus,
  MaterializedLoop,
  MaterializedReviewPhase,
  MaterializedAgentState,
  MaterializedCheckpoint,
  KloopEvent,
  KloopRunStatus,
  Config,
} from '../types';
import { EVENT_TYPES } from '../types';

// ============================================================================
// Materialize: WAL → status.yaml
// ============================================================================

/**
 * Main entry point. Reads status.yaml, replays any new events, writes back.
 * Returns the up-to-date MaterializedStatus.
 */
export async function materialize(
  runId: string,
  fs: FsService,
  paths: Paths = defaultPaths,
  pid?: number,
): Promise<MaterializedStatus> {
  const statusPath = paths.runStatus(runId);
  const eventsPath = paths.runEvents(runId);

  // 1. Load existing status (or create empty)
  let status = await loadStatus(statusPath, runId, fs);

  // 2. Read events from cursor onward
  const allLines = await readEventLines(eventsPath, fs);
  const newStart = status.lastEventIndex;

  if (newStart < allLines.length) {
    // Replay new events
    for (let i = newStart; i < allLines.length; i++) {
      const line = allLines[i].trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line) as KloopEvent;
        applyEvent(status, event);
        status.lastEventIndex = i + 1;
        status.lastEventAt = event.timestamp;
      } catch {
        // Skip malformed lines
        status.lastEventIndex = i + 1;
      }
    }

    // Persist updated status
    await writeStatus(statusPath, status, fs);
  }

  // 3. Check PID liveness (crash detection) — don't persist this
  if (status.status === 'running' && pid !== undefined) {
    try {
      process.kill(pid, 0);
    } catch {
      status.status = 'crashed';
      status.exitCode = 1;
      status.exitReason = 'process terminated (SIGINT/SIGTERM or crash)';
      markRunningAgentsInterrupted(status, status.lastEventAt);
    }
  }

  // 4. Consistency: if run is terminal, ensure no agents are still marked running
  // (handles stale status.yaml from before markRunningAgentsInterrupted existed)
  if (status.status !== 'running' && status.status !== 'pending') {
    markRunningAgentsInterrupted(status, status.lastEventAt);
  }

  return status;
}

/**
 * Enrich status with data from verdict files and loop summaries.
 * This is NOT persisted — computed fresh on each read for live data.
 */
export async function enrich(
  status: MaterializedStatus,
  runId: string,
  fs: FsService,
  paths: Paths = defaultPaths,
): Promise<MaterializedStatus> {
  // Deep clone to avoid mutating the persisted status
  const enriched = structuredClone(status);

  for (const loop of enriched.loops) {
    // Enrich reviewers with verdict files
    let globalIdx = 0;
    for (const phase of loop.reviewPhases) {
      for (const reviewer of phase.reviewers) {
        // Read verdict file if we don't already have verdict from event
        if (!reviewer.verdict) {
          const verdictPath = paths.loopVerdictsPath(runId, loop.loop) + `/reviewer-${globalIdx}.json`;
          try {
            const data = await fs.readJson<{ approved?: boolean; completionEstimate?: number }>(verdictPath);
            if (data) {
              reviewer.verdict = data.approved === true ? 'approved' : data.approved === false ? 'rejected' : undefined;
              if (data.completionEstimate !== undefined) {
                reviewer.completionEstimate = data.completionEstimate;
              }
            }
          } catch {
            /* not available yet */
          }
        }
        globalIdx++;
      }
    }

    // Enrich with loop summary (tokens) for completed loops
    if (loop.completedAt) {
      const summaryPath = paths.loopSummaryJson(runId, loop.loop);
      try {
        const summary = await fs.readJson<{
          implementer?: { inputTokens?: number; outputTokens?: number };
          reviewPhases?: Array<{
            reviewers: Array<{ reviewerIndex: number; inputTokens?: number; outputTokens?: number }>;
          }>;
        }>(summaryPath);
        if (summary) {
          // Enrich implementer tokens
          if (loop.implementer && summary.implementer) {
            loop.implementer.inputTokens = summary.implementer.inputTokens;
            loop.implementer.outputTokens = summary.implementer.outputTokens;
          }
          // Enrich reviewer tokens
          if (summary.reviewPhases) {
            for (const sp of summary.reviewPhases) {
              for (const sr of sp.reviewers) {
                // Find matching reviewer by globalIndex
                let gIdx = 0;
                for (const phase of loop.reviewPhases) {
                  for (const reviewer of phase.reviewers) {
                    if (gIdx === sr.reviewerIndex) {
                      reviewer.inputTokens = sr.inputTokens;
                      reviewer.outputTokens = sr.outputTokens;
                    }
                    gIdx++;
                  }
                }
              }
            }
          }
        }
      } catch {
        /* summary not available */
      }
    }
  }

  return enriched;
}

// ============================================================================
// Event Application (pure state fold)
// ============================================================================

function applyEvent(status: MaterializedStatus, event: KloopEvent): void {
  switch (event.type) {
    case EVENT_TYPES.RUN_START:
      status.status = 'running';
      status.startedAt = event.timestamp;
      status.config = event.config;
      status.failureThreshold = event.config?.conflictCheckThreshold ?? 3;
      break;

    case EVENT_TYPES.LOOP_START: {
      const loop: MaterializedLoop = {
        loop: event.loop,
        startedAt: event.timestamp,
        implementer: {
          binary: event.implementer,
          status: 'pending',
        },
        reviewPhases: [],
      };
      status.loops.push(loop);
      break;
    }

    case EVENT_TYPES.IMPLEMENTER_START: {
      const loop = currentLoop(status);
      if (loop?.implementer) {
        loop.implementer.status = 'running';
        loop.implementer.startedAt = event.timestamp;
        loop.implementer.binary = event.binary;
        if ('harness' in event && event.harness) {
          loop.implementer.harness = event.harness;
        }
      }
      break;
    }

    case EVENT_TYPES.IMPLEMENTER_END: {
      const loop = findLoop(status, event.loop);
      if (loop?.implementer) {
        loop.implementer.status = event.exitCode === 0 ? 'completed' : 'error';
        loop.implementer.completedAt = event.timestamp;
        loop.implementer.exitCode = event.exitCode;
        loop.implementer.durationMs = event.durationMs;
        if ('harness' in event && event.harness) {
          loop.implementer.harness = event.harness;
        }
        if ('error' in event && event.error) {
          loop.implementer.error = event.error;
        }
      }
      break;
    }

    case EVENT_TYPES.REVIEW_PHASE_START: {
      const loop = findLoop(status, event.loop);
      if (loop) {
        const phase: MaterializedReviewPhase = {
          phase: event.phase,
          startedAt: event.timestamp,
          reviewers: event.reviewers.map(binary => ({
            binary,
            status: 'pending',
          })),
        };
        loop.reviewPhases.push(phase);
      }
      break;
    }

    case EVENT_TYPES.REVIEWER_START: {
      const reviewer = findReviewer(status, event.loop, event.phase, event.reviewer);
      if (reviewer) {
        reviewer.status = 'running';
        reviewer.startedAt = event.timestamp;
        if ('harness' in event && event.harness) reviewer.harness = event.harness;
      }
      break;
    }

    case EVENT_TYPES.REVIEWER_END: {
      const reviewer = findReviewer(status, event.loop, event.phase, event.reviewer);
      if (reviewer) {
        reviewer.status = event.exitCode === 0 ? 'completed' : 'error';
        reviewer.completedAt = event.timestamp;
        reviewer.exitCode = event.exitCode;
        reviewer.durationMs = event.durationMs;
        if (event.error) reviewer.error = event.error;
        if (event.verdict) reviewer.verdict = event.verdict;
        if (event.completionEstimate !== undefined) reviewer.completionEstimate = event.completionEstimate;
        if (event.propagated !== undefined) reviewer.propagated = event.propagated;
        if ('harness' in event && event.harness) reviewer.harness = event.harness;
      }
      break;
    }

    case EVENT_TYPES.REVIEW_PHASE_END: {
      const loop = findLoop(status, event.loop);
      const phase = loop?.reviewPhases.find(p => p.phase === event.phase);
      if (phase) {
        phase.completedAt = event.timestamp;
        phase.shortCircuited = event.shortCircuited;
      }
      break;
    }

    case EVENT_TYPES.CHECKPOINT_START: {
      const loop = findLoop(status, event.loop);
      if (loop) {
        loop.checkpoint = {
          binary: event.binary,
          status: 'running',
          startedAt: event.timestamp,
        };
      }
      break;
    }

    // Handle both legacy 'checkpoint' and new 'checkpoint_end'
    case EVENT_TYPES.CHECKPOINT:
    case EVENT_TYPES.CHECKPOINT_END: {
      const loop = findLoop(status, event.loop);
      if (loop) {
        const existing = loop.checkpoint;
        loop.checkpoint = {
          binary: existing?.binary,
          status: 'completed',
          startedAt: existing?.startedAt ?? event.timestamp,
          completedAt: event.timestamp,
          outcome: event.outcome,
          summary: event.summary,
          progressPercent: 'progressPercent' in event ? event.progressPercent : undefined,
          durationMs: 'durationMs' in event ? event.durationMs : undefined,
          exitCode: 'exitCode' in event ? event.exitCode : undefined,
        };
      }
      break;
    }

    case EVENT_TYPES.LOOP_END: {
      const loop = findLoop(status, event.loop);
      if (loop) {
        loop.completedAt = event.timestamp;
        loop.durationMs = event.durationMs;
      }
      break;
    }

    // Terminal events
    case EVENT_TYPES.COMPLETED:
      status.status = 'completed';
      status.exitCode = event.exitCode;
      status.exitReason = event.reason;
      break;

    case EVENT_TYPES.CANCEL:
      status.status = 'cancelled';
      status.exitReason = event.reason;
      break;

    case EVENT_TYPES.STOP:
      status.status = 'cancelled';
      status.exitReason = event.reason;
      break;

    case EVENT_TYPES.ERROR:
      status.status = 'error';
      status.exitCode = 1;
      status.exitReason = event.message;
      break;

    case EVENT_TYPES.CONFLICT:
      status.status = 'conflict';
      status.exitCode = 2;
      status.exitReason = event.summary;
      break;

    case EVENT_TYPES.AGENT_FAILURE:
      status.status = 'agent_failure';
      status.exitCode = 3;
      status.exitReason = event.message;
      break;

    case EVENT_TYPES.CRASHED:
      status.status = 'crashed';
      status.exitCode = event.exitCode;
      status.exitReason = event.message;
      break;
  }

  // On terminal events, mark any still-running/pending agents as interrupted
  const terminalTypes: string[] = [
    EVENT_TYPES.COMPLETED,
    EVENT_TYPES.CANCEL,
    EVENT_TYPES.STOP,
    EVENT_TYPES.ERROR,
    EVENT_TYPES.CONFLICT,
    EVENT_TYPES.AGENT_FAILURE,
    EVENT_TYPES.CRASHED,
  ];
  if (terminalTypes.includes(event.type)) {
    markRunningAgentsInterrupted(status, event.timestamp);
  }

  // Track consecutive failures: reset on LOOP_END if loop was approved,
  // increment on LOOP_END if not approved (no COMPLETED event before next loop)
  // Simpler: track via checkpoint events
  if (event.type === EVENT_TYPES.LOOP_END) {
    // If the loop ended and the run is still going, this loop was rejected
    status.consecutiveFailures++;
  }
  if (event.type === EVENT_TYPES.COMPLETED && status.exitReason === 'consensus') {
    // Consensus reached — the last loop was approved, don't count it
    status.consecutiveFailures = Math.max(0, status.consecutiveFailures - 1);
  }
  if (event.type === EVENT_TYPES.CHECKPOINT || event.type === EVENT_TYPES.CHECKPOINT_END) {
    if (
      'outcome' in event &&
      (event.outcome === 'spec_auto_fixed' || event.outcome === 'spec_compressed' || event.outcome === 'no_action')
    ) {
      // Checkpoint resolved — reset failures
      status.consecutiveFailures = 0;
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function markRunningAgentsInterrupted(status: MaterializedStatus, timestamp: string): void {
  for (const loop of status.loops) {
    if (loop.implementer && (loop.implementer.status === 'running' || loop.implementer.status === 'pending')) {
      loop.implementer.status = 'error';
      loop.implementer.error = 'interrupted';
      loop.implementer.completedAt = timestamp;
      if (loop.implementer.startedAt) {
        loop.implementer.durationMs = new Date(timestamp).getTime() - new Date(loop.implementer.startedAt).getTime();
      }
    }
    for (const phase of loop.reviewPhases) {
      for (const reviewer of phase.reviewers) {
        if (reviewer.status === 'running' || reviewer.status === 'pending') {
          reviewer.status = 'error';
          reviewer.error = 'interrupted';
          reviewer.completedAt = timestamp;
          if (reviewer.startedAt) {
            reviewer.durationMs = new Date(timestamp).getTime() - new Date(reviewer.startedAt).getTime();
          }
        }
      }
    }
    if (loop.checkpoint?.status === 'running') {
      loop.checkpoint.status = 'completed';
      loop.checkpoint.completedAt = timestamp;
      loop.checkpoint.outcome = 'no_action';
    }
  }
}

function currentLoop(status: MaterializedStatus): MaterializedLoop | undefined {
  return status.loops[status.loops.length - 1];
}

function findLoop(status: MaterializedStatus, loopNum: number): MaterializedLoop | undefined {
  return status.loops.find(l => l.loop === loopNum);
}

function findReviewer(
  status: MaterializedStatus,
  loopNum: number,
  phaseNum: number,
  binary: string,
): MaterializedAgentState | undefined {
  const loop = findLoop(status, loopNum);
  const phase = loop?.reviewPhases.find(p => p.phase === phaseNum);
  return phase?.reviewers.find(r => r.binary === binary);
}

async function loadStatus(statusPath: string, runId: string, fs: FsService): Promise<MaterializedStatus> {
  try {
    if (await fs.exists(statusPath)) {
      const content = await fs.readFile(statusPath);
      const parsed = YAML.parse(content);
      if (parsed && typeof parsed.lastEventIndex === 'number') {
        return parsed as MaterializedStatus;
      }
    }
  } catch {
    /* corrupt or missing — rebuild from scratch */
  }

  return {
    lastEventIndex: 0,
    runId,
    workspace: '',
    status: 'pending',
    startedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    consecutiveFailures: 0,
    failureThreshold: 3,
    loops: [],
  };
}

async function writeStatus(statusPath: string, status: MaterializedStatus, fs: FsService): Promise<void> {
  // Strip config — it's loaded from config.yaml on the fly by CLI commands
  const { config, ...rest } = status;
  const content = YAML.stringify(rest, { lineWidth: 0 });
  await fs.writeFile(statusPath, content);
}

async function readEventLines(eventsPath: string, fs: FsService): Promise<string[]> {
  try {
    if (!(await fs.exists(eventsPath))) return [];
    const content = await fs.readFile(eventsPath);
    // Split on newlines, filter empty trailing line
    return content.split('\n').filter(l => l.trim());
  } catch {
    return [];
  }
}

// ============================================================================
// Convenience: derive KloopRunState from MaterializedStatus (backward compat)
// ============================================================================

export function toRunState(status: MaterializedStatus): {
  runId: string;
  workspace: string;
  status: KloopRunStatus;
  exitCode?: number;
  exitReason?: string;
  currentLoop: number;
  currentPhase?: string;
  startedAt: string;
  lastEventAt: string;
  config?: Config;
} {
  const lastLoop = status.loops[status.loops.length - 1];
  let currentPhase: string | undefined;

  if (lastLoop) {
    if (lastLoop.completedAt) {
      currentPhase = 'completed';
    } else if (lastLoop.checkpoint?.status === 'running') {
      currentPhase = 'checkpointing';
    } else if (lastLoop.reviewPhases.length > 0) {
      currentPhase = 'reviewing';
    } else if (lastLoop.implementer?.status === 'running' || lastLoop.implementer?.status === 'pending') {
      currentPhase = 'implementing';
    } else if (lastLoop.implementer?.status === 'completed' || lastLoop.implementer?.status === 'error') {
      // Implementer done but no review phase yet — could be about to start reviewing or checkpointing
      currentPhase = 'reviewing';
    }
  }

  // For terminal statuses, don't show a phase
  if (status.status !== 'running' && status.status !== 'pending') {
    currentPhase = undefined;
  }

  return {
    runId: status.runId,
    workspace: status.workspace,
    status: status.status,
    exitCode: status.exitCode,
    exitReason: status.exitReason,
    currentLoop: lastLoop?.loop ?? 0,
    currentPhase,
    startedAt: status.startedAt,
    lastEventAt: status.lastEventAt,
    config: status.config,
  };
}
