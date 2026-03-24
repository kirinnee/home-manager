import * as fs from 'fs/promises';
import type { Config, Run, HistoryEntry, MetricSample } from '../types';
import { parseReviewerConfig } from '../types';
import type { StateService, TmuxService, Paths } from '../deps';
import { getDirHash, paths as defaultPaths } from '../deps';
import * as consensus from './consensus';
import * as iteration from './iteration';
import * as agents from '../agents/runner';

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

class ReviewerFailureError extends Error {
  constructor(
    public readonly binary: string,
    public readonly count: number,
    public readonly limit: number,
  ) {
    super(`Reviewer "${binary}" failed ${count} consecutive times (limit: ${limit})`);
    this.name = 'ReviewerFailureError';
  }
}

function isNoActiveRunError(error: unknown): boolean {
  return error instanceof Error && error.message === 'No active run';
}

export interface LoopResult {
  status: 'completed' | 'cancelled' | 'failed' | 'max_iterations' | 'conflict' | 'agent_failure';
  finalRun: Run;
  historyEntry: HistoryEntry;
  checkpointRan?: boolean;
}

export interface IterationResult {
  iteration: number;
  approved: boolean;
  implementerResult: agents.AgentResult;
  reviewerResults: agents.ReviewerResult[];
  checkpointResult?: agents.CheckpointerResult;
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
   * Run the main loop until consensus or max iterations
   */
  async run(): Promise<LoopResult> {
    // Check for existing run
    const existingRun = await this.state.loadRun();
    if (existingRun && existingRun.status === 'running') {
      throw new Error(
        `A run is already in progress (${existingRun.id}).\n` +
          `Use 'dev-loop attach' to view it, 'dev-loop status' to check status, or 'dev-loop cancel' to stop it.`,
      );
    }

    // If there's a stale completed run that wasn't archived, archive it now
    if (existingRun && existingRun.status !== 'running') {
      console.log(`Archiving previous run (${existingRun.id})...`);
      await this.state.archiveRun();
    }

    const config = await this.state.loadConfig();
    const run = await this.state.createRun('.kagent/spec.md');
    const dirHash = getDirHash(process.cwd());

    // Log config info
    const totalReviewers = config.reviewPhases.reduce((sum, phase) => sum + phase.length, 0);
    const phaseInfo = config.reviewPhases.length > 1 ? ` in ${config.reviewPhases.length} phases` : '';

    console.log(
      `DEV LOOP [${run.id}]: ${config.reviewPhases.flat().join(', ')} (${totalReviewers} reviewers${phaseInfo}), max ${config.maxIterations} iterations, conflict check after ${config.conflictCheckThreshold} failures`,
    );
    console.log(`  Implementer: ${this.agentRunner.getSelectedImplementer()}`);

    let currentRun = run;
    let specContent: string;
    let checkpointRan = false;

    try {
      // Load spec content once at the start
      try {
        specContent = await fs.readFile(run.spec, 'utf-8');
      } catch {
        throw new Error(`Spec file not found: ${run.spec}\nRun 'dev-loop init' to create it.`);
      }

      while (currentRun.iteration < config.maxIterations) {
        await this.assertRunActive();
        const iterResult = await this.runIteration(currentRun, config, dirHash, specContent);

        if (iterResult.approved) {
          // Reset consecutive failures on approval
          await this.state.resetConsecutiveFailures();
          await this.state.resetReviewerFailures();

          // Unanimous approval - complete
          const entry = await this.state.completeRun('completed', checkpointRan);
          console.log(`UNANIMOUS APPROVAL after ${iterResult.iteration} iteration(s)`);
          return {
            status: 'completed',
            finalRun: currentRun,
            historyEntry: entry,
            checkpointRan,
          };
        }

        // Increment consecutive failures since iteration was not approved
        const consecutiveFailures = await this.state.incrementConsecutiveFailures();
        console.log(`Consecutive failures: ${consecutiveFailures} / ${config.conflictCheckThreshold}`);

        // Check if we should run checkpointer
        if (consecutiveFailures >= config.conflictCheckThreshold) {
          console.log(`Conflict check threshold reached (${config.conflictCheckThreshold}), running checkpointer...`);
          checkpointRan = true;

          // Backup spec before checkpointer can modify it (for compression or auto-fix)
          await this.state.backupSpec(currentRun.id);

          // Reload run from state to get the correct iteration number
          const updatedRun = await this.state.loadRun();
          if (!updatedRun) {
            throw new CancelledError('Run was cancelled and archived', true);
          }
          currentRun = updatedRun;

          const checkpointResult = await this.runCheckpoint(currentRun, config, dirHash, specContent);

          switch (checkpointResult.outcome) {
            case 'conflict_found':
              // Conflict found that requires user decision - end loop with conflict status
              throw new ConflictError(checkpointResult.summary);

            case 'spec_auto_fixed':
              // Spec was auto-fixed - reload spec, reset failures, continue
              console.log('Spec was auto-fixed, reloading spec...');
              specContent = await this.state.loadSpec();
              await this.state.resetConsecutiveFailures();
              break;

            case 'spec_compressed':
              // Spec was compressed - reload spec, reset failures, continue
              console.log(`Spec was compressed (${checkpointResult.progressPercent}% progress), reloading spec...`);
              specContent = await this.state.loadSpec();
              await this.state.resetConsecutiveFailures();
              break;

            case 'no_action':
              // No action needed - just reset failures and continue
              console.log('No spec changes needed, continuing loop...');
              await this.state.resetConsecutiveFailures();
              break;
          }
        }

        // Update run for next iteration
        currentRun = (await this.state.loadRun()) ?? currentRun;
      }

      // Max iterations reached
      const entry = await this.state.completeRun('completed', checkpointRan);
      console.log(`Max iterations reached (${config.maxIterations})`);
      return {
        status: 'max_iterations',
        finalRun: currentRun,
        historyEntry: entry,
        checkpointRan,
      };
    } catch (error) {
      if (error instanceof AgentFailureError) {
        // Agent failure - write failure.md, record metric, exit
        await this.writeFailureMd(error.failureInfo);
        await this.state.completeRun('failed', checkpointRan);
        throw error; // Re-throw so CLI can handle exit code 3
      }

      if (error instanceof ReviewerFailureError) {
        console.log(`\n========================================`);
        console.log('REVIEWER FAILURE CAP REACHED');
        console.log('========================================');
        console.log(`Reviewer "${error.binary}" failed ${error.count} consecutive times (limit: ${error.limit})`);
        console.log('The model is likely broken (rate-limited, crashed, etc.).');
        console.log('Fix the reviewer configuration and restart: `dev-loop run`');
        console.log('========================================\n');

        await this.writeReviewerFailureMd(error);
        await this.state.completeRun('failed', checkpointRan);
        return {
          status: 'failed',
          finalRun: currentRun,
          historyEntry: (await this.state.loadHistoryEntry(currentRun.id))!,
          checkpointRan,
        };
      }

      if (error instanceof ConflictError) {
        // Conflict detected - complete with conflict status
        console.log('\n========================================');
        console.log('CONFLICT DETECTED');
        console.log('========================================');
        console.log(error.summary);
        console.log('\nA conflict.md file has been generated.');
        console.log('Please resolve the conflict and restart the loop.');
        console.log('========================================\n');

        const entry = await this.state.completeRun('conflict', checkpointRan);
        return {
          status: 'conflict',
          finalRun: currentRun,
          historyEntry: entry,
          checkpointRan,
        };
      }

      if (error instanceof CancelledError || isNoActiveRunError(error)) {
        let entry: HistoryEntry | null = null;
        const stillActive = await this.state.loadRun();
        if (stillActive) {
          entry = await this.state.completeRun('cancelled', checkpointRan);
        } else {
          const history = await this.state.listHistory();
          if (history.length > 0) {
            entry = history.find(h => h.id === currentRun.id) ?? history[0];
          }
        }
        if (!entry) {
          throw error;
        }
        return {
          status: 'cancelled',
          finalRun: currentRun,
          historyEntry: entry,
          checkpointRan,
        };
      }

      console.error('Loop error:', error instanceof Error ? error.message : error);
      if (error instanceof Error && error.stack) console.error(error.stack);
      const entry = await this.state.completeRun('failed', checkpointRan);
      return {
        status: 'failed',
        finalRun: currentRun,
        historyEntry: entry,
        checkpointRan,
      };
    }
  }

  /**
   * Assert the current run is still active
   */
  private async assertRunActive(): Promise<void> {
    const run = await this.state.loadRun();
    if (!run) {
      throw new CancelledError('Run was cancelled and archived', true);
    }
    if (run.status === 'cancelled') {
      throw new CancelledError('Run was cancelled');
    }
  }

  /**
   * Run a single iteration
   */
  async runIteration(run: Run, config: Config, dirHash: string, specContent: string): Promise<IterationResult> {
    await this.assertRunActive();
    const iterNum = await this.state.incrementIteration();

    console.log(`Iteration ${iterNum} / ${config.maxIterations}`);

    // Clear evidence, verdicts, and reviews from previous iteration
    await this.state.clearEvidence();
    await this.state.clearVerdicts(iterNum);
    await this.state.clearReviews();

    // Reload run to get updated iteration number
    const currentRun = await this.state.loadRun();
    if (!currentRun) {
      throw new CancelledError('Run was cancelled and archived', true);
    }

    // Build iteration data with updated run
    const iterData = iteration.buildIterationData(currentRun, config, currentRun.spec, specContent);

    await this.assertRunActive();

    // Phase: Implementing
    await this.state.updatePhase('implementing');

    const implResult = await this.agentRunner.runImplementer({
      runId: run.id,
      iteration: iterNum,
      dirHash,
      prompt: iterData.implementerPrompt,
      timeout: config.implementerTimeout,
    });

    // Handle implementer failure (before recording metric so error field is included)
    if (implResult.timedOut) {
      const metric: MetricSample = {
        labels: {
          loop: String(iterNum),
          phase: 'implementer',
          binary: implResult.binary,
          ordinal: '1',
        },
        durationMs: implResult.durationMs,
        inputTokens: implResult.inputTokens,
        outputTokens: implResult.outputTokens,
        error: 'timeout',
      };
      await this.state.appendMetricSample(run.id, metric);
      throw new AgentFailureError({
        binary: implResult.binary,
        error: 'timeout',
        loop: iterNum,
        iteration: iterNum,
      });
    }

    if (implResult.exitCode !== 0) {
      const metric: MetricSample = {
        labels: {
          loop: String(iterNum),
          phase: 'implementer',
          binary: implResult.binary,
          ordinal: '1',
        },
        durationMs: implResult.durationMs,
        inputTokens: implResult.inputTokens,
        outputTokens: implResult.outputTokens,
        error: `exit_code_${implResult.exitCode}`,
      };
      await this.state.appendMetricSample(run.id, metric);
      throw new AgentFailureError({
        binary: implResult.binary,
        error: `exited with code ${implResult.exitCode}`,
        loop: iterNum,
        iteration: iterNum,
      });
    }

    // Record implementer metric (success)
    const implMetric: MetricSample = {
      labels: {
        loop: String(iterNum),
        phase: 'implementer',
        binary: implResult.binary,
        ordinal: '1',
      },
      durationMs: implResult.durationMs,
      inputTokens: implResult.inputTokens,
      outputTokens: implResult.outputTokens,
    };
    await this.state.appendMetricSample(run.id, implMetric);

    await this.assertRunActive();

    // Read learnings if written
    const learnings = await this.state.readLearnings();
    if (learnings) {
      await this.state.addLearning(learnings);
    }

    // Phase: Reviewing
    await this.state.updatePhase('reviewing');

    // Run reviewers phase by phase
    const allReviewerResults = await this.runPhasedReviews(run, config, iterNum, dirHash, iterData);

    await this.assertRunActive();

    // Phase: Checking consensus
    await this.state.updatePhase('done');

    const verdictsList: consensus.VerdictResult[] = allReviewerResults.map(r => ({
      reviewerIndex: r.reviewerIndex,
      verdict: r.verdict,
      binary: r.binary,
      phase: r.phaseIndex,
      error: r.error,
    }));

    const consensusResult = consensus.checkConsensus(
      verdictsList,
      config.reviewPhases.length,
      // Count completed phases: if short-circuited, some phases didn't run
      Math.max(1, ...allReviewerResults.map(r => (r.phaseIndex ?? 0) + 1)),
    );

    console.log(`Consensus: ${consensus.formatConsensusResult(consensusResult)}`);

    // Display completion estimate (lowest among all reviewers)
    const estimates = allReviewerResults.map(r => r.completionEstimate).filter((e): e is number => e !== undefined);

    if (estimates.length > 0) {
      const lowestEstimate = Math.min(...estimates);
      const lowestEstimateReviewer = allReviewerResults.find(r => r.completionEstimate === lowestEstimate);
      const reviewerInfo = lowestEstimateReviewer ? ` (Reviewer ${lowestEstimateReviewer.reviewerIndex})` : '';

      // Draw progress bar
      const barWidth = 40;
      const filled = Math.round((lowestEstimate / 100) * barWidth);
      const empty = barWidth - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);

      console.log(`Progress: [${bar}] ${lowestEstimate}%${reviewerInfo}`);
    }

    return {
      iteration: iterNum,
      approved: consensusResult.approved,
      implementerResult: implResult,
      reviewerResults: allReviewerResults,
    };
  }

  /**
   * Run reviewers phase by phase with short-circuit on rejection.
   * Previous loop reviews are propagated per-reviewer based on previousReviewPropagation probability.
   */
  private async runPhasedReviews(
    run: Run,
    config: Config,
    iterNum: number,
    dirHash: string,
    iterData: iteration.IterationData,
  ): Promise<agents.ReviewerResult[]> {
    const allResults: agents.ReviewerResult[] = [];
    let globalReviewerIndex = 0;

    // Load previous iteration's reviews (if any) for propagation
    let previousReviews: string | undefined;
    if (iterNum > 1 && config.previousReviewPropagation > 0) {
      previousReviews = (await this.state.loadArchivedReviews(run.id, iterNum - 1)) ?? undefined;
      if (previousReviews) {
        console.log(
          `Loaded previous loop (${iterNum - 1}) reviews (propagation: ${(config.previousReviewPropagation * 100).toFixed(0)}%)`,
        );
      }
    }

    // First loop with firstLoopFullReview: run ALL reviewers across ALL phases in parallel
    const isFirstLoop = iterNum === 1;
    if (config.firstLoopFullReview && isFirstLoop && config.reviewPhases.length > 1) {
      console.log('First loop — running all reviewers in parallel across all phases');

      const allReviewers: Array<{
        config: ReturnType<typeof parseReviewerConfig>;
        phaseIndex: number;
        prompt: { reviewerIndex: number; prompt: string };
        sawPrev: boolean;
      }> = [];

      for (let phaseIdx = 0; phaseIdx < config.reviewPhases.length; phaseIdx++) {
        const phaseReviewers = config.reviewPhases[phaseIdx].map(parseReviewerConfig);
        for (let i = 0; i < phaseReviewers.length; i++) {
          const shouldSeePrevious = previousReviews && Math.random() < config.previousReviewPropagation;
          allReviewers.push({
            config: phaseReviewers[i],
            phaseIndex: phaseIdx,
            prompt: {
              reviewerIndex: globalReviewerIndex + i,
              prompt: iteration.buildReviewerPrompt({
                iteration: iterNum,
                reviewerIndex: globalReviewerIndex + i,
                specPath: run.spec,
                specContent: iterData.spec,
                previousReviews: shouldSeePrevious || undefined,
              }),
            },
            sawPrev: !!shouldSeePrevious,
          });
        }
        globalReviewerIndex += phaseReviewers.length;
      }

      // Run all reviewers in parallel
      const parallelResults = await Promise.all(
        allReviewers.map(r =>
          this.agentRunner.runReviewer({
            runId: run.id,
            iteration: iterNum,
            dirHash,
            reviewerIndex: r.prompt.reviewerIndex,
            binary: r.config.binary,
            prompt: r.prompt.prompt,
            timeout: config.reviewerTimeout,
            phaseIndex: r.phaseIndex,
            noVerdictAsFailure: r.config.noVerdictAsFailure,
          }),
        ),
      );

      // Record metrics
      for (const r of parallelResults) {
        const reviewerInfo = allReviewers.find(ar => ar.prompt.reviewerIndex === r.reviewerIndex);
        const metric: MetricSample = {
          labels: {
            loop: String(iterNum),
            phase: 'reviewer',
            binary: r.binary,
            ordinal: '1',
            phaseIdx: String(r.phaseIndex ?? 0),
            phaseSize: String(config.reviewPhases[r.phaseIndex ?? 0]?.length ?? 1),
            noVerdictFail: String(reviewerInfo?.config.noVerdictAsFailure ? 1 : 0),
            sawPrevReviews: String(reviewerInfo?.sawPrev ? 1 : 0),
          },
          durationMs: r.durationMs,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          error: r.error,
        };
        await this.state.appendMetricSample(run.id, metric);
      }

      allResults.push(...parallelResults);

      // Check per-reviewer failure caps
      for (let i = 0; i < parallelResults.length; i++) {
        const r = parallelResults[i];
        const reviewerInfo = allReviewers.find(ar => ar.prompt.reviewerIndex === r.reviewerIndex);
        if (!reviewerInfo) continue;

        if (r.error && reviewerInfo.config.noVerdictAsFailure) {
          const count = await this.state.incrementReviewerFailure(r.binary);
          if (count >= config.reviewerFailureLimit) {
            throw new ReviewerFailureError(r.binary, count, config.reviewerFailureLimit);
          }
        } else if (!r.error) {
          await this.state.resetReviewerFailure(r.binary);
        }
      }

      return allResults;
    }

    // Normal phased execution (subsequent loops, or single-phase configs)
    for (let phaseIdx = 0; phaseIdx < config.reviewPhases.length; phaseIdx++) {
      const phaseReviewers = config.reviewPhases[phaseIdx].map(parseReviewerConfig);

      // Build prompts for reviewers in this phase
      // Each reviewer independently gets previous reviews based on propagation probability
      const sawPrevReviewsFlags: boolean[] = [];
      const phasePrompts: Array<{ reviewerIndex: number; prompt: string }> = phaseReviewers.map((_, i) => {
        const shouldSeePrevious = previousReviews && Math.random() < config.previousReviewPropagation;
        sawPrevReviewsFlags.push(!!shouldSeePrevious);
        return {
          reviewerIndex: globalReviewerIndex + i,
          prompt: iteration.buildReviewerPrompt({
            iteration: iterNum,
            reviewerIndex: globalReviewerIndex + i,
            specPath: run.spec,
            specContent: iterData.spec,
            previousReviews: shouldSeePrevious || undefined,
          }),
        };
      });

      // Run reviewers in this phase in parallel
      const phaseResults = await this.agentRunner.runReviewersPhase({
        runId: run.id,
        iteration: iterNum,
        dirHash,
        phaseIndex: phaseIdx,
        reviewers: phaseReviewers,
        prompts: phasePrompts,
        timeout: config.reviewerTimeout,
      });

      // Record metrics for each reviewer in this phase
      for (let i = 0; i < phaseResults.length; i++) {
        const r = phaseResults[i];
        const metric: MetricSample = {
          labels: {
            loop: String(iterNum),
            phase: 'reviewer',
            binary: r.binary,
            ordinal: String(i + 1),
            phaseIdx: String(phaseIdx),
            phaseSize: String(phaseReviewers.length),
            noVerdictFail: String(phaseReviewers[i]?.noVerdictAsFailure ? 1 : 0),
            sawPrevReviews: String(sawPrevReviewsFlags[i] ? 1 : 0),
          },
          durationMs: r.durationMs,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          error: r.error,
        };
        await this.state.appendMetricSample(run.id, metric);
      }

      allResults.push(...phaseResults);
      globalReviewerIndex += phaseReviewers.length;

      // Check per-reviewer failure caps
      for (let i = 0; i < phaseResults.length; i++) {
        const r = phaseResults[i];
        if (r.error && phaseReviewers[i].noVerdictAsFailure) {
          const count = await this.state.incrementReviewerFailure(r.binary);
          if (count >= config.reviewerFailureLimit) {
            throw new ReviewerFailureError(r.binary, count, config.reviewerFailureLimit);
          }
        } else if (!r.error) {
          await this.state.resetReviewerFailure(r.binary);
        }
      }

      // Check if any reviewer in this phase rejected → short-circuit
      const anyRejected = phaseResults.some(r => r.verdict === 'rejected');
      if (anyRejected) {
        if (config.reviewPhases.length > 1) {
          console.log(
            `Phase ${phaseIdx} rejection → short-circuiting (skipping ${config.reviewPhases.length - phaseIdx - 1} remaining phase(s))`,
          );
        }
        break;
      }
    }

    return allResults;
  }

  /**
   * Run the checkpointer to detect conflicts, auto-fix spec, or compress spec
   */
  async runCheckpoint(
    run: Run,
    config: Config,
    dirHash: string,
    specContent: string,
  ): Promise<agents.CheckpointerResult> {
    await this.assertRunActive();

    // Phase: Checkpointing
    await this.state.updatePhase('reviewing');

    const checkpointResult = await this.agentRunner.runCheckpointer({
      runId: run.id,
      iteration: run.iteration,
      dirHash,
      specPath: run.spec,
      specContent,
      timeout: config.reviewerTimeout,
    });

    await this.assertRunActive();

    // Phase: Done
    await this.state.updatePhase('done');

    return checkpointResult;
  }

  /**
   * Write .kagent/failure.md with failure details
   */
  private async writeFailureMd(info: {
    binary: string;
    error: string;
    loop: number;
    iteration: number;
  }): Promise<void> {
    const content = `# Agent Failure

## What Failed
Implementer "${info.binary}" ${info.error}

## When
Loop ${info.loop}, iteration ${info.iteration}

## Next Steps
1. Investigate the log files in \`.kagent/logs/\`
2. Check if the spec is achievable
3. Fix any configuration issues
4. Remove this file and restart: \`dev-loop run\`
`;
    const { writeFile, mkdir } = await import('fs/promises');
    await mkdir('.kagent', { recursive: true });
    await writeFile(this.paths.failureMd, content, 'utf-8');
  }

  /**
   * Write .kagent/failure.md with reviewer failure cap details
   */
  private async writeReviewerFailureMd(error: ReviewerFailureError): Promise<void> {
    const content = `# Reviewer Failure Cap Reached

## What Failed
Reviewer "${error.binary}" failed ${error.count} consecutive times (limit: ${error.limit})

## Why
The reviewer model is likely broken — rate-limited, crashed, or misconfigured.
No valid verdict was produced ${error.count} times in a row.

## Next Steps
1. Check if the reviewer binary is working: run it manually
2. Check for rate limits or API key issues
3. Consider switching to a different reviewer model
4. Remove this file and restart: \`dev-loop run\`
`;
    const { writeFile, mkdir } = await import('fs/promises');
    await mkdir('.kagent', { recursive: true });
    await writeFile(this.paths.failureMd, content, 'utf-8');
  }
}
