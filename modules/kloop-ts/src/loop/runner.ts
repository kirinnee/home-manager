import * as fs from 'fs/promises';
import * as path from 'path';
import { parseRawConfig } from '../types';
import type { Config, Run, HistoryEntry } from '../types';
import { parseReviewerConfig, parseConflictCheckerConfig, parseImplementerConfig, selectImplementer } from '../types';
import type { StateService, TmuxService, Paths } from '../deps';
import { getDirHash, paths as defaultPaths, nextSpecVersion } from '../deps';
import * as consensus from './consensus';
import * as iteration from './iteration';
import * as agents from '../agents/runner';
import * as fmt from './format';
import { buildVerifierPrompt } from '../agents/prompts';
import type { VerifierPromptVars } from '../agents/prompts';

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

class CrashedError extends Error {
  constructor(
    public readonly binary: string,
    public readonly attempts: number,
  ) {
    super(`Implementer crashed after ${attempts} retries`);
    this.name = 'CrashedError';
  }
}

interface LoopResult {
  status: 'completed' | 'cancelled' | 'failed' | 'max_iterations' | 'conflict' | 'agent_failure' | 'crashed';
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
   * Prepare the loop workspace: promote any pending scratch files (crash recovery),
   * wipe the entire .kloop/ directory, then recreate .kloop/scratch/ for the
   * upcoming agent step.
   */
  private async prepareLoopWorkspace(runId: string): Promise<void> {
    const cwd = process.cwd();
    const kloopDir = path.join(cwd, '.kloop');
    const scratchDir = path.join(kloopDir, 'scratch');

    // 1. Recover: promote any pending scratch files (from a prior crash)
    if (await this.safeFileExists(scratchDir)) {
      await this.agentRunner.promoteScratchFiles({ scratchDir });
    }

    // 2. Wipe: delete the entire .kloop/ folder for a clean slate
    await fs.rm(kloopDir, { recursive: true, force: true });

    // 3. Recreate scratch dir for the upcoming agent step
    await fs.mkdir(scratchDir, { recursive: true });
  }

  private async safeFileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

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
    const config = parseRawConfig(YAML.parse(configContent));

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
    const specContentRef = { value: specContent };

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

        // Prepare loop workspace: promote pending scratch + wipe + recreate
        await this.prepareLoopWorkspace(runId);

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

        await fs.mkdir(this.paths.loopPath(runId, loopNum), { recursive: true });
        await fs.mkdir(this.paths.loopEvidencePath(runId, loopNum), { recursive: true });

        // Phase: Implementing
        run.iteration = loopNum;
        run.phase = 'implementing';

        // Build iteration data for prompts
        const iterData = iteration.buildIterationData(
          run,
          config,
          specPath,
          specContentRef.value,
          runId,
          loopNum,
          this.paths,
        );

        // Run implementer with retry on crash (exit code 1)
        const implResult = await this.runImplementerWithRetry(
          runId,
          loopNum,
          dirHash,
          iterData,
          config,
          agentRunner,
          writeEvent,
        );

        await this.writeEvidence(runId, loopNum);

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
            const cpResult = await this.runCheckpointGate(
              runId,
              loopNum,
              dirHash,
              specContentRef,
              config,
              implBinary,
              writeEvent,
              agentRunner,
            );
            checkpointRan = cpResult.checkpointRan;
            consecutiveFailures = cpResult.consecutiveFailures;
          }

          if (config.snapshot) await this.snapshotLoop(runId, loopNum);

          continue;
        }

        // Verify gate (loop 2+, if enabled)
        let verifyPassed = true;
        let verifyResults: agents.VerifierResult[] | null = null;
        if (config.verify && loopNum > 1) {
          fmt.formatVerifyStart();
          const verifyResult = await this.runVerifyGate(
            runId,
            agentRunner,
            config,
            loopNum,
            dirHash,
            iterData,
            writeEvent,
          );
          verifyPassed = verifyResult.passed;
          verifyResults = verifyResult.results;

          if (!verifyPassed) {
            await this.writeEvidence(runId, loopNum);

            // Verify failed — run re-synthesis and skip expensive reviewers
            let synthesisResult: agents.SynthesizerResult | null = null;
            if (config.synthesis) {
              synthesisResult = await this.runReSynthesisPhase(
                runId,
                agentRunner,
                config,
                loopNum,
                dirHash,
                iterData,
                writeEvent,
              );
            }

            // Write loop_end
            const loopDurationMs = Date.now() - loopStartTime;
            await writeEvent({
              type: 'loop_end',
              timestamp: new Date().toISOString(),
              loop: loopNum,
              durationMs: loopDurationMs,
            });

            await this.writeLoopSummary(
              runId,
              loopNum,
              implResult,
              [],
              loopDurationMs,
              config,
              verifyResults,
              synthesisResult,
            );
            await this.writeLoopMetrics(runId, loopNum, implResult, [], loopDurationMs);
            await this.writeLoopLearnings(runId, loopNum, implResult.learnings);

            // Increment consecutive failures and check threshold
            consecutiveFailures++;
            fmt.formatFailure(consecutiveFailures, config.conflictCheckThreshold);

            if (consecutiveFailures >= config.conflictCheckThreshold) {
              fmt.formatCheckpointStart();
              const cpResult = await this.runCheckpointGate(
                runId,
                loopNum,
                dirHash,
                specContentRef,
                config,
                implBinary,
                writeEvent,
                agentRunner,
              );
              checkpointRan = cpResult.checkpointRan;
              consecutiveFailures = cpResult.consecutiveFailures;
            }

            if (config.snapshot) await this.snapshotLoop(runId, loopNum);

            continue;
          }
        }

        // Phase: Reviewing
        run.phase = 'reviewing';

        // Determine review phases — re-rank by trouble score only after a checkpoint has run
        let reviewPhasesForRun = config.reviewPhases ?? [['claude-auto-zai']];
        if (config.rerankAfterCheckpoint && checkpointRan) {
          reviewPhasesForRun = this.getReorganizedPhases(config, runId, loopNum) ?? reviewPhasesForRun;
        }

        // Run reviewers phase by phase
        const allReviewerResults = await this.runPhasedReviewsForKloop(
          runId,
          agentRunner,
          config,
          loopNum,
          dirHash,
          iterData,
          writeEvent,
          reviewPhasesForRun,
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

        await this.writeEvidence(runId, loopNum);

        // Run synthesis after reviews (if enabled)
        let synthesisResult: agents.SynthesizerResult | null = null;
        if (config.synthesis) {
          synthesisResult = await this.runSynthesisPhase(runId, agentRunner, config, loopNum, dirHash, writeEvent);
        }

        // Write loop_end event
        const loopDurationMs = Date.now() - loopStartTime;
        await writeEvent({
          type: 'loop_end',
          timestamp: new Date().toISOString(),
          loop: loopNum,
          durationMs: loopDurationMs,
        });

        // Write summary files for this loop
        await this.writeLoopSummary(
          runId,
          loopNum,
          implResult,
          allReviewerResults,
          loopDurationMs,
          config,
          verifyResults,
          synthesisResult,
        );
        await this.writeLoopMetrics(runId, loopNum, implResult, allReviewerResults, loopDurationMs);

        await this.writeLoopLearnings(runId, loopNum, implResult.learnings);

        if (config.snapshot) await this.snapshotLoop(runId, loopNum);

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
          const cpResult = await this.runCheckpointGate(
            runId,
            loopNum,
            dirHash,
            specContentRef,
            config,
            implBinary,
            writeEvent,
            agentRunner,
          );
          checkpointRan = cpResult.checkpointRan;
          consecutiveFailures = cpResult.consecutiveFailures;
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

      if (error instanceof CrashedError) {
        await writeEvent({
          type: 'crashed',
          timestamp: new Date().toISOString(),
          exitCode: 1,
          signal: 'exit_code_1',
          message: error.message,
        });
        return {
          status: 'crashed',
          finalRun: run,
          historyEntry: await this.buildHistoryEntryFromRun(run, config, 'failed', checkpointRan),
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
    overridePhases?: string[][],
  ): Promise<agents.ReviewerResult[]> {
    const reviewPhases = overridePhases ?? config.reviewPhases ?? [['claude-auto-zai']];
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
    const scratchDir = this.paths.scratchDir(process.cwd());

    const prevSummaryPath =
      prevLoop !== null ? `${this.paths.loopSynthesisPath(runId, prevLoop)}/review-summary.md` : undefined;

    const allPrompts: Array<{ reviewerIndex: number; prompt: string; propagated: boolean }> = allReviewers.map(
      ({ globalIndex: idx }) => {
        const seesPrev = prevLoop !== null && Math.random() < (config.previousReviewPropagation ?? 0);
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
            archivedReviews: seesPrev && !config.synthesis ? this.paths.loopReviewsPath(runId, prevLoop) : null,
            previousSummaryPath: seesPrev && config.synthesis ? prevSummaryPath : undefined,
            scratchDir,
          }),
          propagated: seesPrev,
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

      // Build prompts — roll determines if reviewer sees any previous loop context
      const reviewsDir = this.paths.loopReviewsPath(runId, iterNum);
      const verdictsDir = this.paths.loopVerdictsPath(runId, iterNum);
      const evidenceDir = this.paths.loopEvidencePath(runId, iterNum);
      const learningsFile = this.paths.runLearnings(runId);
      const prevLoop = iterNum > 1 ? iterNum - 1 : null;
      const prevSummary =
        prevLoop !== null ? `${this.paths.loopSynthesisPath(runId, prevLoop)}/review-summary.md` : undefined;
      const seqScratchDir = this.paths.scratchDir(process.cwd());
      const phasePrompts: Array<{ reviewerIndex: number; prompt: string; propagated: boolean }> = phaseReviewers.map(
        (_, i) => {
          const seesPrev = prevLoop !== null && Math.random() < (config.previousReviewPropagation ?? 0);
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
              archivedReviews: seesPrev && !config.synthesis ? this.paths.loopReviewsPath(runId, prevLoop) : null,
              previousSummaryPath: seesPrev && config.synthesis ? prevSummary : undefined,
              scratchDir: seqScratchDir,
            }),
            propagated: seesPrev,
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
   * Run verify gate: cheap/fast models check if previous issues were fixed.
   * Returns { passed, results }.
   */
  /**
   * Run implementer with retry on crash (exit code 1).
   * On timeout or crash (exit 1), retry. On exhausted retries, throw CrashedError.
   * Each attempt emits implementer_start/implementer_end events.
   */
  private async runImplementerWithRetry(
    runId: string,
    loopNum: number,
    dirHash: string,
    iterData: iteration.IterationData,
    config: Config,
    agentRunner: agents.AgentRunner,
    writeEvent: (event: Record<string, unknown>) => Promise<void>,
  ): Promise<agents.ImplementerResult> {
    const maxRetries = config.implementerRetry?.maxRetries ?? 2;
    const backoffBaseMs = config.implementerRetry?.backoffBaseMs ?? 5000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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

      // Write implementer_end event with retry info
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
        ...(maxRetries > 0 ? { retryAttempt: attempt, maxRetries } : {}),
      });

      // Success — return
      if (implResult.exitCode === 0 && !implResult.timedOut) {
        return implResult;
      }

      // Non-retryable: any exit code other than 1 (crash) that isn't a timeout
      if (!implResult.timedOut && implResult.exitCode !== 1) {
        return implResult;
      }

      // Last attempt — no more retries
      if (attempt >= maxRetries) {
        throw new CrashedError(implResult.binary, attempt + 1);
      }

      // Retry with backoff
      const backoffMs = backoffBaseMs * Math.pow(2, attempt);
      const newBinary = selectImplementer(config, loopNum);
      fmt.formatImplementerRetry(attempt, maxRetries, backoffMs);

      await writeEvent({
        type: 'implementer_retry',
        timestamp: new Date().toISOString(),
        loop: loopNum,
        attempt,
        maxRetries,
        previousBinary: implResult.binary,
        newBinary,
        backoffMs,
      });

      // Wait (backoff does NOT count toward implementer timeout)
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

    // Should never reach here, but satisfy TypeScript
    throw new CrashedError('unknown', maxRetries + 1);
  }

  /**
   * Run re-synthesis phase: merge previous synthesis + verifier outputs into updated summary.
   * Used when verify gate fails.
   */
  private async runReSynthesisPhase(
    runId: string,
    agentRunner: agents.AgentRunner,
    config: Config,
    loopNum: number,
    dirHash: string,
    iterData: iteration.IterationData,
    writeEvent: (event: Record<string, unknown>) => Promise<void>,
  ): Promise<agents.SynthesizerResult | null> {
    if (!config.synthesis) return null;

    const previousSummaryPath =
      iterData.reviewSummaryPath ?? `${this.paths.loopSynthesisPath(runId, loopNum - 1)}/review-summary.md`;
    const binary = config.synthesizer;

    // Write synthesis_start event (reuses same event type)
    const implParsed = parseImplementerConfig(binary ?? Object.keys(config.implementers)[0]);
    await writeEvent({
      type: 'synthesis_start',
      timestamp: new Date().toISOString(),
      loop: loopNum,
      binary: implParsed.binary,
      harness: implParsed.harness,
    });

    fmt.formatReSynthesisStart();

    const result = await agentRunner.runReSynthesizer({
      runId,
      iteration: loopNum,
      dirHash,
      binary,
      previousSummaryPath,
      timeout: config.synthesisTimeout,
    });

    // Write synthesis_end event
    await writeEvent({
      type: 'synthesis_end',
      timestamp: new Date().toISOString(),
      loop: loopNum,
      binary: result.binary,
      harness: result.harness,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      error: result.timedOut ? 'timeout' : result.exitCode !== 0 ? `exit_code_${result.exitCode}` : undefined,
      summaryPath: result.summaryPath,
    });

    fmt.formatReSynthesisResult(result.summaryPath !== undefined, result.durationMs);

    return result;
  }

  private async runVerifyGate(
    runId: string,
    agentRunner: agents.AgentRunner,
    config: Config,
    iterNum: number,
    dirHash: string,
    iterData: iteration.IterationData,
    writeEvent: (event: Record<string, unknown>) => Promise<void>,
  ): Promise<{ passed: boolean; results: agents.VerifierResult[] }> {
    const verifyPhases = agentRunner.getVerifyPhases();
    if (verifyPhases.length === 0) return { passed: true, results: [] };

    const specPath = this.paths.runSpec(runId);
    const reviewsDir = this.paths.loopReviewsPath(runId, iterNum);
    const verdictsDir = this.paths.loopVerdictsPath(runId, iterNum);
    const evidenceDir = this.paths.loopEvidencePath(runId, iterNum);
    const learningsFile = this.paths.runLearnings(runId);
    const previousSummaryPath =
      iterData.reviewSummaryPath ?? `${this.paths.loopSynthesisPath(runId, iterNum - 1)}/review-summary.md`;

    let allResults: agents.VerifierResult[] = [];
    let globalReviewerIndex = 0;

    for (let phaseIdx = 0; phaseIdx < verifyPhases.length; phaseIdx++) {
      const phaseReviewers = (verifyPhases[phaseIdx] ?? []).map(parseReviewerConfig);

      await writeEvent({
        type: 'verify_phase_start',
        timestamp: new Date().toISOString(),
        loop: iterNum,
        phase: phaseIdx,
        reviewers: phaseReviewers.map(r => r.binary),
      });

      const phasePrompts: Array<{ reviewerIndex: number; prompt: string }> = phaseReviewers.map((_, i) => {
        const vars: VerifierPromptVars = {
          specPath,
          iteration: String(iterNum),
          previousSummaryPath,
          reviewsDir,
          verdictsDir,
          evidenceDir,
          learningsFile,
          verifierIndex: String(globalReviewerIndex + i),
          scratchDir: this.paths.scratchDir(process.cwd()),
        };
        return {
          reviewerIndex: globalReviewerIndex + i,
          prompt: buildVerifierPrompt(config.prompts?.verifier, vars),
        };
      });

      // Write verifier start events
      for (const rc of phaseReviewers) {
        await writeEvent({
          type: 'verifier_start',
          timestamp: new Date().toISOString(),
          loop: iterNum,
          phase: phaseIdx,
          reviewer: rc.binary,
          harness: rc.harness,
        });
      }

      const phaseResults = await agentRunner.runVerifierPhase({
        runId,
        iteration: iterNum,
        dirHash,
        phaseIndex: phaseIdx,
        reviewers: phaseReviewers,
        prompts: phasePrompts,
        timeout: config.verifyTimeout,
        onReviewerEnd: async (r: agents.VerifierResult) => {
          await writeEvent({
            type: 'verifier_end',
            timestamp: new Date().toISOString(),
            loop: iterNum,
            phase: phaseIdx,
            reviewer: r.binary,
            harness: r.harness,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
            error: r.error,
            verdict: r.verdict,
          });
        },
      });

      allResults.push(...phaseResults);
      globalReviewerIndex += phaseReviewers.length;

      const anyRejected = phaseResults.some(r => r.verdict === 'rejected');
      await writeEvent({
        type: 'verify_phase_end',
        timestamp: new Date().toISOString(),
        loop: iterNum,
        phase: phaseIdx,
        shortCircuited: anyRejected,
      });

      // Short-circuit on rejection
      if (anyRejected) {
        break;
      }
    }

    const passed = allResults.length > 0 && allResults.every(r => r.verdict === 'approved');
    fmt.formatVerifyResult(passed, allResults);

    return { passed, results: allResults };
  }

  /**
   * Run synthesis phase: compact all raw reviews into a summary.
   */
  private async runSynthesisPhase(
    runId: string,
    agentRunner: agents.AgentRunner,
    config: Config,
    loopNum: number,
    dirHash: string,
    writeEvent: (event: Record<string, unknown>) => Promise<void>,
  ): Promise<agents.SynthesizerResult | null> {
    if (!config.synthesis) return null;

    const previousSummaryPath =
      loopNum > 1 ? `${this.paths.loopSynthesisPath(runId, loopNum - 1)}/review-summary.md` : null;
    const binary = config.synthesizer;

    // Write synthesis_start event
    const implParsed = parseImplementerConfig(binary ?? Object.keys(config.implementers)[0]);
    await writeEvent({
      type: 'synthesis_start',
      timestamp: new Date().toISOString(),
      loop: loopNum,
      binary: implParsed.binary,
      harness: implParsed.harness,
    });

    fmt.formatSynthesisStart();

    const result = await agentRunner.runSynthesizer({
      runId,
      iteration: loopNum,
      dirHash,
      binary,
      previousSummaryPath,
      timeout: config.synthesisTimeout,
    });

    // Write synthesis_end event
    await writeEvent({
      type: 'synthesis_end',
      timestamp: new Date().toISOString(),
      loop: loopNum,
      binary: result.binary,
      harness: result.harness,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      error: result.timedOut ? 'timeout' : result.exitCode !== 0 ? `exit_code_${result.exitCode}` : undefined,
      summaryPath: result.summaryPath,
    });

    fmt.formatSynthesisResult(result.summaryPath !== undefined, result.durationMs);

    return result;
  }

  /**
   * Run checkpoint gate (shared between implementer failure and verify failure paths).
   * Returns updated consecutiveFailures and whether checkpoint ran.
   * Mutates specContent via the ref parameter.
   */
  private async runCheckpointGate(
    runId: string,
    loopNum: number,
    dirHash: string,
    specContentRef: { value: string },
    config: Config,
    implBinary: string,
    writeEvent: (event: Record<string, unknown>) => Promise<void>,
    agentRunner: agents.AgentRunner,
  ): Promise<{ checkpointRan: boolean; consecutiveFailures: number }> {
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
      specPath: this.paths.runSpec(runId),
      specContent: specContentRef.value,
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
        if (!config.compressSpec) {
          fmt.formatCheckpointOutcome('no_action');
          break;
        }
        fmt.formatCheckpointOutcome('spec_auto_fixed');
        specContentRef.value = await fs.readFile(this.paths.runSpec(runId), 'utf-8');
        await this.saveSpecVersion(runId, specContentRef.value);
        break;

      case 'spec_compressed':
        if (!config.compressSpec) {
          fmt.formatCheckpointOutcome('no_action');
          break;
        }
        fmt.formatCheckpointOutcome('spec_compressed', `${checkpointResult.progressPercent}% progress`);
        specContentRef.value = await fs.readFile(this.paths.runSpec(runId), 'utf-8');
        await this.saveSpecVersion(runId, specContentRef.value);
        break;

      case 'no_action':
        fmt.formatCheckpointOutcome('no_action');
        break;
    }

    return { checkpointRan: true, consecutiveFailures: 0 };
  }

  /**
   * Get re-organized review phases based on reviewer trouble scores.
   * Reviewers with highest trouble scores (rejections*10 + (100-avgCompletion)/10 + errors*5) go first.
   * Called only after a checkpoint has run; uses previous loop summaries for scoring.
   */
  private getReorganizedPhases(config: Config, runId: string, currentLoopNum: number): string[][] | null {
    if (!config.rerankAfterCheckpoint) return null;
    if (currentLoopNum <= 1) return null;

    const reviewPhases = config.reviewPhases ?? [['claude-auto-zai']];
    const flatReviewers = reviewPhases.flat();

    // Build trouble scores from previous loop summaries
    // Map: binary name -> { rejections, totalCompletion, errors, count }
    const reviewerStats = new Map<
      string,
      { rejections: number; totalCompletion: number; errors: number; count: number }
    >();

    for (let prevLoop = currentLoopNum - 1; prevLoop >= 1; prevLoop--) {
      try {
        const summaryPath = this.paths.loopSummaryJson(runId, prevLoop);
        const summaryContent = require('fs').readFileSync(summaryPath, 'utf-8');
        const summary = JSON.parse(summaryContent);
        if (summary.reviewPhases) {
          for (const phase of summary.reviewPhases) {
            for (const reviewer of phase.reviewers) {
              // Use binary name from summary (extracted from config string like "claude:claude:1" -> "claude")
              const binaryName = reviewer.binary;
              let stats = reviewerStats.get(binaryName);
              if (!stats) {
                stats = { rejections: 0, totalCompletion: 0, errors: 0, count: 0 };
                reviewerStats.set(binaryName, stats);
              }
              if (reviewer.verdict === 'rejected') stats.rejections += 1;
              if (reviewer.completionEstimate !== undefined) stats.totalCompletion += reviewer.completionEstimate;
              if (reviewer.error) stats.errors += 1;
              stats.count += 1;
            }
          }
        }
      } catch {
        // Summary not available for this loop
      }
    }

    if (reviewerStats.size === 0) return null;

    // Map from config string (e.g., "claude:claude:1") to trouble score
    const troubleScores = new Map<string, number>();
    const scoreDetails: fmt.RerankScore[] = [];
    for (const reviewerConfig of flatReviewers) {
      // Extract binary name from config string to match summary binary names
      const parsed = parseReviewerConfig(reviewerConfig);
      const binaryName = parsed.binary;
      const stats = reviewerStats.get(binaryName);
      if (stats) {
        const avgCompletion = stats.count > 0 ? stats.totalCompletion / stats.count : 100;
        const score = stats.rejections * 10 + (100 - avgCompletion) / 10 + stats.errors * 5;
        troubleScores.set(reviewerConfig, score);
        scoreDetails.push({
          reviewer: reviewerConfig,
          score: Math.round(score),
          rejections: stats.rejections,
          avgCompletion,
          errors: stats.errors,
          loopsSampled: stats.count,
        });
      }
    }

    // Sort reviewers by trouble score descending
    const sorted = [...flatReviewers].sort((a, b) => {
      const scoreA = troubleScores.get(a) ?? 0;
      const scoreB = troubleScores.get(b) ?? 0;
      return scoreB - scoreA;
    });

    // Distribute into same number of phases as original
    const numPhases = reviewPhases.length;
    const perPhase = Math.ceil(sorted.length / numPhases);
    const newPhases: string[][] = [];
    for (let i = 0; i < numPhases; i++) {
      newPhases.push(sorted.slice(i * perPhase, (i + 1) * perPhase));
    }

    // Sort score details to match final ordering
    scoreDetails.sort((a, b) => b.score - a.score);
    fmt.formatDynamicOrdering(newPhases, scoreDetails);

    return newPhases;
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
  private async writeLoopLearnings(runId: string, loopIndex: number, fallbackContent: string | null): Promise<void> {
    let learningsContent = fallbackContent;

    try {
      const currentLearnings = await fs.readFile(this.paths.runLearnings(runId), 'utf-8');
      learningsContent = currentLearnings;
    } catch {
      // Ignore missing run-level learnings file and fall back to implementer snapshot
    }

    if (!learningsContent?.trim()) return;

    const normalized = learningsContent.trimEnd();
    await fs.writeFile(
      this.paths.loopLearningMd(runId, loopIndex),
      `# Loop ${loopIndex} Learnings\n\n${normalized}\n`,
      'utf-8',
    );
  }

  private async writeLoopSummary(
    runId: string,
    loopIndex: number,
    implResult: agents.ImplementerResult,
    reviewerResults: agents.ReviewerResult[],
    durationMs: number,
    config: Config,
    verifyResults?: agents.VerifierResult[] | null,
    synthesisResult?: agents.SynthesizerResult | null,
  ): Promise<void> {
    const fsModule = await import('fs/promises');

    // Build summary JSON
    const summary: Record<string, unknown> = {
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

    // Persist verify data if available
    if (verifyResults && verifyResults.length > 0) {
      summary.verifyPhases = this.groupVerifiersByPhase(verifyResults);
    }

    // Persist synthesis data if available
    if (synthesisResult) {
      summary.synthesis = {
        binary: synthesisResult.binary,
        exitCode: synthesisResult.exitCode,
        durationMs: synthesisResult.durationMs,
        error: synthesisResult.timedOut
          ? 'timeout'
          : synthesisResult.exitCode !== 0
            ? `exit_code_${synthesisResult.exitCode}`
            : undefined,
        summaryPath: synthesisResult.summaryPath,
      };
    }

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

  private groupVerifiersByPhase(results: agents.VerifierResult[]): Array<{
    phase: number;
    reviewers: Array<{
      reviewerIndex: number;
      binary: string;
      harness?: string;
      exitCode: number;
      durationMs: number;
      verdict?: 'approved' | 'rejected';
      error?: string;
      issuesFixed?: string[];
      issuesRemaining?: string[];
    }>;
    shortCircuited: boolean;
  }> {
    const byPhase = new Map<number, agents.VerifierResult[]>();
    for (const r of results) {
      const phase = r.phaseIndex ?? 0;
      if (!byPhase.has(phase)) byPhase.set(phase, []);
      byPhase.get(phase)!.push(r);
    }

    return Array.from(byPhase.entries())
      .sort(([a], [b]) => a - b)
      .map(([phase, reviewers]) => ({
        phase,
        reviewers: reviewers.map(r => ({
          reviewerIndex: r.reviewerIndex,
          binary: r.binary,
          harness: r.harness,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          verdict: r.verdict,
          error: r.error,
          issuesFixed: r.issuesFixed,
          issuesRemaining: r.issuesRemaining,
        })),
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
   * Snapshot the working directory to archive for debugging.
   * Copies the entire workspace (minus node_modules, .git, .kloop) to archive/loop-{N}/.
   */
  private async snapshotLoop(runId: string, loopNum: number): Promise<void> {
    const archiveDir = this.paths.loopArchivePath(runId, loopNum);
    const cwd = process.cwd();

    await fs.mkdir(archiveDir, { recursive: true });

    await fs.cp(cwd, archiveDir, { recursive: true });

    fmt.formatSnapshot(loopNum, archiveDir);
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
