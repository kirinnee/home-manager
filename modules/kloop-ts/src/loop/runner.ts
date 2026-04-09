import * as fs from 'fs/promises';
import * as path from 'path';
import type { Config, Run, HistoryEntry } from '../types';
import { parseReviewerConfig, parseConflictCheckerConfig, parseImplementerConfig } from '../types';
import type { StateService, TmuxService, Paths } from '../deps';
import { getDirHash, paths as defaultPaths, nextSpecVersion } from '../deps';
import * as consensus from './consensus';
import * as iteration from './iteration';
import * as agents from '../agents/runner';
import * as fmt from './format';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}

function formatTokensShort(input?: number, output?: number): string {
  const total = (input ?? 0) + (output ?? 0);
  if (total < 1000) return `${total}`;
  return `${(total / 1000).toFixed(1)}k`;
}

// ============================================================================
// LoopResult types
// ============================================================================

class CancelledError extends Error {
  constructor(
    message: string,
    public readonly archived: boolean = false,
  ) {
    super(message);
    this.name = 'CancelledError';
  }
}

class ConflictError extends Error {
  constructor(public readonly summary: string) {
    super(`Conflict detected: ${summary}`);
    this.name = 'ConflictError';
  }
}

class AgentFailureError extends Error {
  constructor(public readonly failureInfo: { binary: string; error: string; loop: number; iteration: number }) {
    super(
      `Agent failure: ${failureInfo.binary} ${failureInfo.error} in loop ${failureInfo.loop}, iteration ${failureInfo.iteration}`,
    );
    this.name = 'AgentFailureError';
  }
}

interface LoopResult {
  status: 'completed' | 'cancelled' | 'failed' | 'max_iterations' | 'conflict' | 'agent_failure';
  finalRun: Run;
  historyEntry: HistoryEntry;
  checkpointRan?: boolean;
}

// ============================================================================
// LoopRunner class (IO edge)
// ============================================================================

export class LoopRunner {
  constructor(
    private state: StateService,
    private tmux: TmuxService,
    private agentRunner: agents.AgentRunner,
    private paths: Paths = defaultPaths,
  ) {}

  /**
   * Run with explicit run ID (for kloop global storage).
   * This is the entry point for `kloop run <id>`.
   *
   * Note: PID lock acquisition and workspace uniqueness checks are done
   * in the CLI run command handler before calling this method.
   */
  async runWithId(runId: string): Promise<LoopResult> {
    const YAML = await import('yaml');
    const { appendFile } = await import('fs/promises');

    // Load config from global storage (YAML)
    const configPath = this.paths.runConfig(runId);
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = YAML.parse(configContent) as Config;

    // Load spec from global storage
    const specPath = this.paths.runSpec(runId);
    let specContent: string;
    try {
      specContent = await fs.readFile(specPath, 'utf-8');
    } catch {
      throw new Error(`Spec file not found: ${specPath}`);
    }

    // Save initial spec as spec-1.md (versioned history)
    const initialVersion = await nextSpecVersion(runId);
    await fs.writeFile(this.paths.runSpecVersioned(runId, initialVersion), specContent, 'utf-8');
    // Ensure spec.md is a copy of the latest
    await fs.writeFile(specPath, specContent, 'utf-8');

    const dirHash = getDirHash(process.cwd());
    const implBinary = config.implementers ? Object.keys(config.implementers)[0] : 'claude';

    fmt.formatHeader(runId, config, process.cwd());

    // Create agent runner with loaded config
    const agentRunner = new agents.AgentRunner(this.tmux, this.state, config);

    let loopNum = 0;
    let consecutiveFailures = 0;
    let checkpointRan = false;
    let learnings: string[] = [];

    // Create a minimal Run object for compatibility with existing code
    const run: Run = {
      id: runId,
      spec: specPath,
      status: 'running',
      iteration: 0,
      phase: 'implementing',
      startedAt: new Date().toISOString(),
      learnings: [],
      consecutiveFailures: 0,
    };

    // Helper: write event to events.jsonl
    const writeEvent = async (event: Record<string, unknown>) => {
      const line = JSON.stringify(event) + '\n';
      await appendFile(this.paths.runEvents(runId), line, 'utf-8');
    };

    try {
      while (loopNum < config.maxIterations) {
        loopNum++;

        // Write loop_start event
        await writeEvent({
          type: 'loop_start',
          timestamp: new Date().toISOString(),
          loop: loopNum,
          implementer: implBinary,
        });

        const loopStartTime = Date.now();

        console.log('');
        fmt.formatIterationStart(loopNum, config.maxIterations);

        // Phase: Implementing
        run.iteration = loopNum;
        run.phase = 'implementing';

        // Build iteration data for prompts
        const iterData = iteration.buildIterationData(run, config, specPath, specContent, runId, loopNum, this.paths);

        // Run implementer
        const implResult = await agentRunner.runImplementer({
          runId,
          iteration: loopNum,
          dirHash,
          prompt: iterData.implementerPrompt,
          timeout: config.implementerTimeout,
          onStart: async binary => {
            await writeEvent({
              type: 'implementer_start',
              timestamp: new Date().toISOString(),
              loop: loopNum,
              binary,
              harness: parseImplementerConfig(binary).harness,
            });
          },
        });

        fmt.formatImplementerResult(implResult.binary, implResult.exitCode, implResult.durationMs);

        // Write implementer_end event
        const implError = implResult.timedOut
          ? 'timeout'
          : implResult.exitCode !== 0
            ? `exit_code_${implResult.exitCode}`
            : undefined;
        await writeEvent({
          type: 'implementer_end',
          timestamp: new Date().toISOString(),
          loop: loopNum,
          binary: implResult.binary,
          harness: implResult.harness,
          exitCode: implResult.exitCode,
          durationMs: implResult.durationMs,
          ...(implError ? { error: implError } : {}),
        });

        // Handle implementer failure — count as failed iteration, continue looping
        if (implResult.timedOut || implResult.exitCode !== 0) {
          const implError = implResult.timedOut ? 'timeout' : `exit_code_${implResult.exitCode}`;
          fmt.formatImplementerFailure(implError);

          // Write loop_end for this failed iteration
          const loopDurationMs = Date.now() - loopStartTime;
          await writeEvent({
            type: 'loop_end',
            timestamp: new Date().toISOString(),
            loop: loopNum,
            durationMs: loopDurationMs,
          });

          // Increment consecutive failures
          consecutiveFailures++;
          fmt.formatFailure(consecutiveFailures, config.conflictCheckThreshold);

          // Check conflict threshold (same as rejected review path)
          if (consecutiveFailures >= config.conflictCheckThreshold) {
            fmt.formatCheckpointStart();
            checkpointRan = true;

            const cpBinary = config.conflictChecker ?? implBinary;
            const cpParsed = parseConflictCheckerConfig(cpBinary);
            await writeEvent({
              type: 'checkpoint_start',
              timestamp: new Date().toISOString(),
              loop: loopNum,
              binary: cpParsed.binary,
              harness: cpParsed.harness,
            });

            const checkpointResult = await agentRunner.runCheckpointer({
              runId,
              iteration: loopNum,
              dirHash,
              specPath,
              specContent,
              timeout: config.reviewerTimeout,
            });

            await writeEvent({
              type: 'checkpoint_end',
              timestamp: new Date().toISOString(),
              loop: loopNum,
              outcome: checkpointResult.outcome,
              summary: checkpointResult.summary,
              progressPercent: checkpointResult.progressPercent,
              durationMs: checkpointResult.durationMs,
              exitCode: checkpointResult.exitCode,
            });

            switch (checkpointResult.outcome) {
              case 'conflict_found':
                await writeEvent({
                  type: 'conflict',
                  timestamp: new Date().toISOString(),
                  exitCode: 2,
                  summary: checkpointResult.summary,
                });
                await this.writeConflictMd(runId, checkpointResult.summary);
                throw new ConflictError(checkpointResult.summary);
              case 'spec_auto_fixed':
              case 'spec_compressed':
                if (!config.compressSpec) {
                  // Compression disabled — treat as no_action
                  break;
                }
                // Reload spec
                specContent = await fs.readFile(specPath, 'utf-8');
                // Save versioned spec copy
                await this.saveSpecVersion(runId, specContent);
                break;
              case 'no_action':
                break;
            }

            fmt.formatCheckpointOutcome(checkpointResult.outcome, checkpointResult.summary);
          }

          continue;
        }

        // Read learnings
        if (implResult.learnings) {
          learnings.push(...implResult.learnings.split('\n').filter((l: string) => l.trim()));
        }

        // Phase: Reviewing
        run.phase = 'reviewing';

        // Run reviewers phase by phase
        const allReviewerResults = await this.runPhasedReviewsForKloop(
          runId,
          agentRunner,
          config,
          loopNum,
          dirHash,
          iterData,
          writeEvent,
        );

        // Check consensus
        const verdictsList: consensus.VerdictResult[] = allReviewerResults.map(r => ({
          reviewerIndex: r.reviewerIndex,
          verdict: r.verdict,
          binary: r.binary,
          phase: r.phaseIndex,
          error: r.error,
        }));

        const consensusResult = consensus.checkConsensus(
          verdictsList,
          config.reviewPhases?.length ?? 1,
          Math.max(1, ...allReviewerResults.map(r => (r.phaseIndex ?? 0) + 1)),
        );

        fmt.formatConsensus(consensusResult.approved, verdictsList);

        // Display progress bar
        const estimates = allReviewerResults.map(r => r.completionEstimate).filter((e): e is number => e !== undefined);
        fmt.formatProgress(estimates, allReviewerResults);

        // Write loop_end event
        const loopDurationMs = Date.now() - loopStartTime;
        await writeEvent({
          type: 'loop_end',
          timestamp: new Date().toISOString(),
          loop: loopNum,
          durationMs: loopDurationMs,
        });

        // Write summary files for this loop
        await this.writeLoopSummary(runId, loopNum, implResult, allReviewerResults, loopDurationMs, config);
        await this.writeLoopMetrics(runId, loopNum, implResult, allReviewerResults, loopDurationMs);
        await this.writeEvidence(runId, loopNum);

        // Update learnings
        if (learnings.length > 0) {
          const learningsContent = learnings.map(l => `- ${l}`).join('\n');
          await fs.writeFile(
            this.paths.loopLearningMd(runId, loopNum),
            `# Loop ${loopNum} Learnings\n\n${learningsContent}\n`,
            'utf-8',
          );
          // Also update run-level learnings
          await fs.writeFile(this.paths.runLearnings(runId), learningsContent, 'utf-8');
        }

        if (consensusResult.approved) {
          // Write completed event
          await writeEvent({
            type: 'completed',
            timestamp: new Date().toISOString(),
            exitCode: 0,
            reason: 'consensus',
          });

          fmt.formatApproval(loopNum);
          return {
            status: 'completed',
            finalRun: run,
            historyEntry: await this.buildHistoryEntryFromRun(run, config, 'completed', checkpointRan),
            checkpointRan,
          };
        }

        // Increment consecutive failures
        consecutiveFailures++;
        fmt.formatFailure(consecutiveFailures, config.conflictCheckThreshold);

        // Check conflict threshold
        if (consecutiveFailures >= config.conflictCheckThreshold) {
          fmt.formatCheckpointStart();
          checkpointRan = true;

          const cpBinary = config.conflictChecker ?? implBinary;
          await writeEvent({
            type: 'checkpoint_start',
            timestamp: new Date().toISOString(),
            loop: loopNum,
            binary: cpBinary,
          });

          const checkpointResult = await agentRunner.runCheckpointer({
            runId,
            iteration: loopNum,
            dirHash,
            specPath,
            specContent,
            timeout: config.reviewerTimeout,
          });

          // Write checkpoint_end event
          await writeEvent({
            type: 'checkpoint_end',
            timestamp: new Date().toISOString(),
            loop: loopNum,
            outcome: checkpointResult.outcome,
            summary: checkpointResult.summary,
            progressPercent: checkpointResult.progressPercent,
            durationMs: checkpointResult.durationMs,
            exitCode: checkpointResult.exitCode,
          });

          switch (checkpointResult.outcome) {
            case 'conflict_found':
              await writeEvent({
                type: 'conflict',
                timestamp: new Date().toISOString(),
                exitCode: 2,
                summary: checkpointResult.summary,
              });
              // Write conflict.md to run directory
              await this.writeConflictMd(runId, checkpointResult.summary);
              throw new ConflictError(checkpointResult.summary);

            case 'spec_auto_fixed':
              if (!config.compressSpec) {
                fmt.formatCheckpointOutcome('no_action');
                consecutiveFailures = 0;
                break;
              }
              fmt.formatCheckpointOutcome('spec_auto_fixed');
              specContent = await fs.readFile(specPath, 'utf-8');
              await this.saveSpecVersion(runId, specContent);
              consecutiveFailures = 0;
              break;

            case 'spec_compressed':
              if (!config.compressSpec) {
                fmt.formatCheckpointOutcome('no_action');
                consecutiveFailures = 0;
                break;
              }
              fmt.formatCheckpointOutcome('spec_compressed', `${checkpointResult.progressPercent}% progress`);
              specContent = await fs.readFile(specPath, 'utf-8');
              await this.saveSpecVersion(runId, specContent);
              consecutiveFailures = 0;
              break;

            case 'no_action':
              fmt.formatCheckpointOutcome('no_action');
              consecutiveFailures = 0;
              break;
          }
        }
      }

      // Max iterations reached
      await writeEvent({
        type: 'completed',
        timestamp: new Date().toISOString(),
        exitCode: 0,
        reason: 'max_iterations',
      });

      fmt.formatMaxIterations(config.maxIterations);
      return {
        status: 'max_iterations',
        finalRun: run,
        historyEntry: await this.buildHistoryEntryFromRun(run, config, 'completed', checkpointRan),
        checkpointRan,
      };
    } catch (error) {
      if (error instanceof AgentFailureError) {
        await this.writeFailureMd(runId, error.failureInfo);
        return {
          status: 'agent_failure',
          finalRun: run,
          historyEntry: await this.buildHistoryEntryFromRun(run, config, 'failed', checkpointRan),
          checkpointRan,
        };
      }

      if (error instanceof ConflictError) {
        fmt.formatConflict(error.summary);
        return {
          status: 'conflict',
          finalRun: run,
          historyEntry: await this.buildHistoryEntryFromRun(run, config, 'conflict', checkpointRan),
          checkpointRan,
        };
      }

      // Generic error
      await writeEvent({
        type: 'error',
        timestamp: new Date().toISOString(),
        exitCode: 1,
        message: error instanceof Error ? error.message : String(error),
      });

      return {
        status: 'failed',
        finalRun: run,
        historyEntry: await this.buildHistoryEntryFromRun(run, config, 'failed', checkpointRan),
        checkpointRan,
      };
    }
  }

  /**
   * Run phased reviews for kloop mode (writes events).
   *
   * When firstLoopFullReview is true AND iterNum === 1, all reviewers across
   * all phases run in a single parallel batch — no phase gating or short-circuit.
   * When false (or only one phase), the traditional sequential phase model is
   * used: each phase runs in parallel, and a rejection short-circuits
   * remaining phases.
   */
  private async runPhasedReviewsForKloop(
    runId: string,
    agentRunner: agents.AgentRunner,
    config: Config,
    iterNum: number,
    dirHash: string,
    iterData: iteration.IterationData,
    writeEvent: (event: Record<string, unknown>) => Promise<void>,
  ): Promise<agents.ReviewerResult[]> {
    const reviewPhases = config.reviewPhases ?? [['claude-auto-zai']];
    const specPath = this.paths.runSpec(runId);

    // When firstLoopFullReview is enabled on the first iteration, flatten all
    // phases into one parallel batch (no phase gating or short-circuit)
    if (iterNum === 1 && config.firstLoopFullReview && reviewPhases.length > 1) {
      return this.runFlattenedReviews(runId, agentRunner, config, iterNum, dirHash, specPath, reviewPhases, writeEvent);
    }

    // Traditional sequential phase model
    return this.runSequentialPhasedReviews(
      runId,
      agentRunner,
      config,
      iterNum,
      dirHash,
      specPath,
      reviewPhases,
      writeEvent,
    );
  }

  /**
   * Run all reviewers from all phases in a single parallel batch.
   * No phase gating — every reviewer runs at once regardless of verdicts.
   */
  private async runFlattenedReviews(
    runId: string,
    agentRunner: agents.AgentRunner,
    config: Config,
    iterNum: number,
    dirHash: string,
    specPath: string,
    reviewPhases: string[][],
    writeEvent: (event: Record<string, unknown>) => Promise<void>,
  ): Promise<agents.ReviewerResult[]> {
    const allReviewers: Array<{
      parsed: ReturnType<typeof parseReviewerConfig>;
      originalPhase: number;
      globalIndex: number;
    }> = [];
    let globalIndex = 0;

    for (let phaseIdx = 0; phaseIdx < reviewPhases.length; phaseIdx++) {
      for (const entry of reviewPhases[phaseIdx] ?? []) {
        allReviewers.push({ parsed: parseReviewerConfig(entry), originalPhase: phaseIdx, globalIndex });
        globalIndex++;
      }
    }

    // Write review_phase_start events for each original phase so the
    // materializer creates phase records that reviewer events can attach to.
    const reviewersByPhase = new Map<number, typeof allReviewers>();
    for (const r of allReviewers) {
      if (!reviewersByPhase.has(r.originalPhase)) reviewersByPhase.set(r.originalPhase, []);
      reviewersByPhase.get(r.originalPhase)!.push(r);
    }
    for (const [phase, reviewers] of [...reviewersByPhase.entries()].sort(([a], [b]) => a - b)) {
      await writeEvent({
        type: 'review_phase_start',
        timestamp: new Date().toISOString(),
        loop: iterNum,
        phase,
        reviewers: reviewers.map(r => r.parsed.binary),
      });
    }

    // Build prompts for all reviewers
    const reviewsDir = this.paths.loopReviewsPath(runId, iterNum);
    const verdictsDir = this.paths.loopVerdictsPath(runId, iterNum);
    const evidenceDir = this.paths.loopEvidencePath(runId, iterNum);
    const learningsFile = this.paths.runLearnings(runId);
    const prevLoop = iterNum > 1 ? iterNum - 1 : null;

    const allPrompts: Array<{ reviewerIndex: number; prompt: string; propagated: boolean }> = allReviewers.map(
      ({ globalIndex: idx }) => {
        const seesPrevReviews = prevLoop !== null && Math.random() < (config.previousReviewPropagation ?? 0);
        const archivedReviews = seesPrevReviews ? this.paths.loopReviewsPath(runId, prevLoop) : null;
        return {
          reviewerIndex: idx,
          prompt: iteration.buildReviewerPrompt(config.prompts?.reviewer, {
            specPath,
            iteration: String(iterNum),
            reviewerIndex: String(idx),
            reviewsDir,
            verdictsDir,
            evidenceDir,
            learningsFile,
            archivedReviews,
          }),
          propagated: seesPrevReviews,
        };
      },
    );

    // Write reviewer_start events for all reviewers
    for (const { parsed, originalPhase } of allReviewers) {
      await writeEvent({
        type: 'reviewer_start',
        timestamp: new Date().toISOString(),
        loop: iterNum,
        phase: originalPhase,
        reviewer: parsed.binary,
        harness: parsed.harness,
      });
    }

    // Run all reviewers in parallel
    const allResults = await agentRunner.runReviewersPhase({
      runId,
      iteration: iterNum,
      dirHash,
      phaseIndex: 0,
      reviewers: allReviewers.map(r => r.parsed),
      prompts: allPrompts,
      timeout: config.reviewerTimeout,
      onReviewerEnd: async (r: agents.ReviewerResult) => {
        const promptMeta = allPrompts.find(p => p.reviewerIndex === r.reviewerIndex);
        const propagated = promptMeta?.propagated ?? false;
        r.propagated = propagated;
        // Use originalPhase for the event so downstream grouping is correct
        const entry = allReviewers.find(e => e.globalIndex === r.reviewerIndex);
        const originalPhase = entry?.originalPhase ?? 0;
        await writeEvent({
          type: 'reviewer_end',
          timestamp: new Date().toISOString(),
          loop: iterNum,
          phase: originalPhase,
          reviewer: r.binary,
          harness: r.harness,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          error: r.error,
          verdict: r.verdict,
          completionEstimate: r.completionEstimate,
          propagated,
        });
      },
    });

    // Stamp each result with its original phase for correct grouping downstream
    for (const r of allResults) {
      const entry = allReviewers.find(e => e.globalIndex === r.reviewerIndex);
      if (entry) {
        r.phaseIndex = entry.originalPhase;
      }
    }

    // Print results grouped by original phase
    const byPhase = new Map<number, agents.ReviewerResult[]>();
    for (const r of allResults) {
      const phase = r.phaseIndex ?? 0;
      if (!byPhase.has(phase)) byPhase.set(phase, []);
      byPhase.get(phase)!.push(r);
    }

    for (const [phase, results] of [...byPhase.entries()].sort(([a], [b]) => a - b)) {
      fmt.formatReviewPhaseStart(
        phase,
        results.map(r => r.binary),
      );
      for (const r of results) {
        fmt.formatReviewerResult(r.reviewerIndex, r.binary, r.verdict, r.completionEstimate, r.durationMs);
      }
    }

    // Write review_phase_end for each original phase (no short-circuit)
    for (const phase of [...reviewersByPhase.keys()].sort((a, b) => a - b)) {
      await writeEvent({
        type: 'review_phase_end',
        timestamp: new Date().toISOString(),
        loop: iterNum,
        phase,
        shortCircuited: false,
      });
    }

    return allResults;
  }

  /**
   * Traditional sequential phase model: each phase runs in parallel,
   * rejection short-circuits remaining phases.
   */
  private async runSequentialPhasedReviews(
    runId: string,
    agentRunner: agents.AgentRunner,
    config: Config,
    iterNum: number,
    dirHash: string,
    specPath: string,
    reviewPhases: string[][],
    writeEvent: (event: Record<string, unknown>) => Promise<void>,
  ): Promise<agents.ReviewerResult[]> {
    const allResults: agents.ReviewerResult[] = [];
    let globalReviewerIndex = 0;

    for (let phaseIdx = 0; phaseIdx < reviewPhases.length; phaseIdx++) {
      const phaseReviewers = (reviewPhases[phaseIdx] ?? []).map(parseReviewerConfig);

      // Write review_phase_start event
      await writeEvent({
        type: 'review_phase_start',
        timestamp: new Date().toISOString(),
        loop: iterNum,
        phase: phaseIdx,
        reviewers: phaseReviewers.map(r => r.binary),
      });

      // Build prompts with per-reviewer propagation roll
      const reviewsDir = this.paths.loopReviewsPath(runId, iterNum);
      const verdictsDir = this.paths.loopVerdictsPath(runId, iterNum);
      const evidenceDir = this.paths.loopEvidencePath(runId, iterNum);
      const learningsFile = this.paths.runLearnings(runId);
      const prevLoop = iterNum > 1 ? iterNum - 1 : null;
      const phasePrompts: Array<{ reviewerIndex: number; prompt: string; propagated: boolean }> = phaseReviewers.map(
        (_, i) => {
          // Per-reviewer probability roll for seeing previous loop's reviews
          const seesPrevReviews = prevLoop !== null && Math.random() < (config.previousReviewPropagation ?? 0);
          const archivedReviews = seesPrevReviews ? this.paths.loopReviewsPath(runId, prevLoop) : null;
          return {
            reviewerIndex: globalReviewerIndex + i,
            prompt: iteration.buildReviewerPrompt(config.prompts?.reviewer, {
              specPath,
              iteration: String(iterNum),
              reviewerIndex: String(globalReviewerIndex + i),
              reviewsDir,
              verdictsDir,
              evidenceDir,
              learningsFile,
              archivedReviews,
            }),
            propagated: seesPrevReviews,
          };
        },
      );

      // Write reviewer_start events for all reviewers before launching
      for (const rc of phaseReviewers) {
        await writeEvent({
          type: 'reviewer_start',
          timestamp: new Date().toISOString(),
          loop: iterNum,
          phase: phaseIdx,
          reviewer: rc.binary,
          harness: rc.harness,
        });
      }

      // Run reviewers in this phase (parallel) — write reviewer_end as each completes
      const phaseResults = await agentRunner.runReviewersPhase({
        runId,
        iteration: iterNum,
        dirHash,
        phaseIndex: phaseIdx,
        reviewers: phaseReviewers,
        prompts: phasePrompts,
        timeout: config.reviewerTimeout,
        onReviewerEnd: async (r: agents.ReviewerResult) => {
          // Find the propagated flag for this reviewer from phasePrompts
          const promptMeta = phasePrompts.find(p => p.reviewerIndex === r.reviewerIndex);
          const propagated = promptMeta?.propagated ?? false;
          r.propagated = propagated;
          await writeEvent({
            type: 'reviewer_end',
            timestamp: new Date().toISOString(),
            loop: iterNum,
            phase: phaseIdx,
            reviewer: r.binary,
            harness: r.harness,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
            error: r.error,
            verdict: r.verdict,
            completionEstimate: r.completionEstimate,
            propagated,
          });
        },
      });

      allResults.push(...phaseResults);
      globalReviewerIndex += phaseReviewers.length;

      // Print reviewer results
      fmt.formatReviewPhaseStart(
        phaseIdx,
        phaseReviewers.map(r => r.binary),
      );
      for (const r of phaseResults) {
        fmt.formatReviewerResult(r.reviewerIndex, r.binary, r.verdict, r.completionEstimate, r.durationMs);
      }

      // Write review_phase_end event
      const anyRejected = phaseResults.some(r => r.verdict === 'rejected');
      await writeEvent({
        type: 'review_phase_end',
        timestamp: new Date().toISOString(),
        loop: iterNum,
        phase: phaseIdx,
        shortCircuited: anyRejected,
      });

      // Short-circuit on rejection
      if (anyRejected) {
        if (reviewPhases.length > 1) {
          fmt.formatPhaseShortCircuit(phaseIdx, reviewPhases.length - phaseIdx - 1);
        }
        break;
      }
    }

    return allResults;
  }

  /**
   * Write evidence files: diff.patch and files.json
   */
  private async writeEvidence(runId: string, loopIndex: number): Promise<void> {
    const { execSync } = await import('child_process');
    const fsModule = await import('fs/promises');

    const evidenceDir = this.paths.loopEvidencePath(runId, loopIndex);
    await fsModule.mkdir(evidenceDir, { recursive: true });

    const workspace = process.cwd();

    // Generate diff.patch — diff of all tracked changes
    try {
      const diff = execSync('git diff HEAD', { cwd: workspace, encoding: 'utf-8', timeout: 30000 });
      if (diff.trim()) {
        await fsModule.writeFile(path.join(evidenceDir, 'diff.patch'), diff, 'utf-8');
      }
    } catch {
      // No diff available (e.g., no git repo or no changes)
    }

    // Generate files.json — list of changed files with content
    try {
      // Get list of changed files (modified + added, not deleted)
      const diffNameOnly = execSync('git diff HEAD --name-only --diff-filter=ACMR', {
        cwd: workspace,
        encoding: 'utf-8',
        timeout: 30000,
      });
      const changedFiles = diffNameOnly
        .trim()
        .split('\n')
        .filter(f => f.trim());

      if (changedFiles.length > 0) {
        const filesData: Array<{ path: string; content: string | null }> = [];
        for (const filePath of changedFiles.slice(0, 50)) {
          try {
            const fullPath = path.join(workspace, filePath);
            const content = await fsModule.readFile(fullPath, 'utf-8');
            filesData.push({ path: filePath, content });
          } catch {
            filesData.push({ path: filePath, content: null });
          }
        }

        await fsModule.writeFile(path.join(evidenceDir, 'files.json'), JSON.stringify(filesData, null, 2), 'utf-8');
      }
    } catch {
      // No file list available
    }
  }

  /**
   * Write summary files for a loop
   */
  private async writeLoopSummary(
    runId: string,
    loopIndex: number,
    implResult: agents.ImplementerResult,
    reviewerResults: agents.ReviewerResult[],
    durationMs: number,
    config: Config,
  ): Promise<void> {
    const fsModule = await import('fs/promises');

    // Build summary JSON
    const summary = {
      loop: loopIndex,
      durationMs,
      implementer: {
        binary: implResult.binary,
        harness: implResult.harness,
        exitCode: implResult.exitCode,
        durationMs: implResult.durationMs,
        inputTokens: implResult.inputTokens,
        outputTokens: implResult.outputTokens,
      },
      reviewPhases: this.groupReviewersByPhase(reviewerResults),
    };

    await fsModule.mkdir(this.paths.loopPath(runId, loopIndex), { recursive: true });
    await fsModule.writeFile(this.paths.loopSummaryJson(runId, loopIndex), JSON.stringify(summary, null, 2), 'utf-8');

    // Build summary markdown
    let md = `# Loop ${loopIndex} Summary\n\n`;
    md += `**Implementer:** ${implResult.binary} (${formatDuration(implResult.durationMs)})\n`;
    md += `**Result:** ${implResult.exitCode === 0 ? 'Approved' : 'Failed'}\n\n`;

    const phases = this.groupReviewersByPhase(reviewerResults);
    for (const phase of phases) {
      md += `## Review Phase ${phase.phase}\n`;
      md += `| Reviewer | Verdict | Time | Tokens | Completion |\n`;
      md += `| -------- | ------- | ---- | ------ | ---------- |\n`;
      for (const r of phase.reviewers) {
        const verdict = r.verdict === 'approved' ? 'Approved' : 'Rejected';
        const tokens = formatTokensShort(r.inputTokens, r.outputTokens);
        const completion = r.completionEstimate !== undefined ? `${r.completionEstimate}%` : '-';
        md += `| ${r.binary} | ${verdict} | ${formatDuration(r.durationMs)} | ${tokens} | ${completion} |\n`;
      }
      md += '\n';
    }

    await fsModule.writeFile(this.paths.loopSummaryMd(runId, loopIndex), md, 'utf-8');
  }

  /**
   * Write metrics for a loop
   */
  private async writeLoopMetrics(
    runId: string,
    loopIndex: number,
    implResult: agents.ImplementerResult,
    reviewerResults: agents.ReviewerResult[],
    _loopDurationMs: number,
  ): Promise<void> {
    const fsModule = await import('fs/promises');
    const metricsPath = this.paths.loopMetrics(runId, loopIndex);

    const lines: string[] = [];

    // Implementer metrics
    lines.push(
      JSON.stringify({
        ts: new Date().toISOString(),
        agent: 'implementer',
        event: 'end',
        binary: implResult.binary,
        harness: implResult.harness,
        inputTokens: implResult.inputTokens ?? 0,
        outputTokens: implResult.outputTokens ?? 0,
        durationMs: implResult.durationMs,
      }),
    );

    // Reviewer metrics
    for (const r of reviewerResults) {
      lines.push(
        JSON.stringify({
          ts: new Date().toISOString(),
          agent: `reviewer-${r.reviewerIndex}`,
          event: 'end',
          binary: r.binary,
          harness: r.harness,
          phaseIdx: r.phaseIndex ?? 0,
          verdict: r.verdict,
          completionEstimate: r.completionEstimate,
          inputTokens: r.inputTokens ?? 0,
          outputTokens: r.outputTokens ?? 0,
          durationMs: r.durationMs,
          error: r.error,
          propagated: r.propagated ?? false,
        }),
      );
    }

    await fsModule.writeFile(metricsPath, lines.join('\n') + '\n', 'utf-8');
  }

  private groupReviewersByPhase(results: agents.ReviewerResult[]): Array<{
    phase: number;
    reviewers: agents.ReviewerResult[];
    shortCircuited: boolean;
  }> {
    const byPhase = new Map<number, agents.ReviewerResult[]>();
    for (const r of results) {
      const phase = r.phaseIndex ?? 0;
      if (!byPhase.has(phase)) byPhase.set(phase, []);
      byPhase.get(phase)!.push(r);
    }

    return Array.from(byPhase.entries())
      .sort(([a], [b]) => a - b)
      .map(([phase, reviewers]) => ({
        phase,
        reviewers,
        shortCircuited: reviewers.some(r => r.verdict === 'rejected'),
      }));
  }

  private async buildHistoryEntryFromRun(
    run: Run,
    config: Config,
    status: 'completed' | 'cancelled' | 'failed' | 'conflict',
    checkpointRan: boolean,
  ): Promise<HistoryEntry> {
    return {
      id: run.id,
      spec: run.spec,
      config,
      status,
      iterations: run.iteration,
      startedAt: run.startedAt,
      completedAt: new Date().toISOString(),
      summary: [],
      checkpointRan,
    };
  }

  /**
   * Write conflict.md to the run directory
   */
  private async writeConflictMd(runId: string, summary: string): Promise<void> {
    const fsModule = await import('fs/promises');
    const content = `# Conflict Detected

${summary}

## Next Steps
1. Review the conflict details above
2. Resolve the underlying issues
3. Restart the run with: kloop run ${runId}
`;
    await fsModule.writeFile(path.join(this.paths.runPath(runId), 'conflict.md'), content, 'utf-8');
  }

  /**
   * Save a versioned copy of the spec (spec-N.md) and update spec.md.
   * After this, spec.md always contains the latest and spec-1.md..spec-N.md
   * contain the full history of specs generated by the checkpointer.
   */
  private async saveSpecVersion(runId: string, specContent: string): Promise<void> {
    const version = await nextSpecVersion(runId);
    await fs.writeFile(this.paths.runSpecVersioned(runId, version), specContent, 'utf-8');
    // Keep spec.md as the latest copy
    await fs.writeFile(this.paths.runSpec(runId), specContent, 'utf-8');
  }

  /**
   * Write failure.md with failure details
   */
  private async writeFailureMd(
    runId: string | undefined,
    info: {
      binary: string;
      error: string;
      loop: number;
      iteration: number;
    },
  ): Promise<void> {
    const content = `# Agent Failure

## What Failed
Implementer "${info.binary}" ${info.error}

## When
Loop ${info.loop}, iteration ${info.iteration}

## Next Steps
1. Investigate the log files in \`~/.kloop/{runId}/loop-{L}/\`
2. Check if the spec is achievable
3. Fix any configuration issues
4. Remove this file and restart: \`kloop run <id>\`
`;
    const { writeFile, mkdir } = await import('fs/promises');
    const failurePath = runId ? path.join(this.paths.runPath(runId), 'failure.md') : this.paths.failureMd;
    await mkdir(path.dirname(failurePath), { recursive: true });
    await writeFile(failurePath, content, 'utf-8');
  }
}
