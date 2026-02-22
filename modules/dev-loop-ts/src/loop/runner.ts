import * as fs from 'fs/promises';
import type { Config, Run, HistoryEntry, VerdictFile } from '../types';
import type { StateService, TmuxService } from '../deps';
import { getDirHash } from '../deps';
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

function isNoActiveRunError(error: unknown): boolean {
  return error instanceof Error && error.message === 'No active run';
}

export interface LoopResult {
  status: 'completed' | 'cancelled' | 'failed' | 'max_iterations' | 'conflict';
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

    console.log(
      `DEV LOOP [${run.id}]: ${config.reviewers.length} reviewers (${config.reviewers.join(', ')}), max ${config.maxIterations} iterations, conflict check after ${config.conflictCheckThreshold} failures`,
    );

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
          // (runIteration increments iteration internally)
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
              // Backup was already made before checkpointer ran
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
   * Run a single iteration
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

  async runIteration(run: Run, config: Config, dirHash: string, specContent: string): Promise<IterationResult> {
    await this.assertRunActive();
    const iterNum = await this.state.incrementIteration();

    console.log(`Iteration ${iterNum} / ${config.maxIterations}`);

    // Clear evidence, verdicts, and reviews from previous iteration
    // Reviews are cleared so implementer only sees current iteration's feedback
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

    if (implResult.timedOut) {
      throw new Error('Implementer timed out');
    }

    await this.assertRunActive();

    // Read learnings if written
    const learnings = await this.state.readLearnings();
    if (learnings) {
      await this.state.addLearning(learnings);
    }

    // Phase: Reviewing
    await this.state.updatePhase('reviewing');

    const reviewerResults = await this.agentRunner.runReviewers({
      runId: run.id,
      iteration: iterNum,
      dirHash,
      prompts: iterData.reviewerPrompts,
      timeout: config.reviewerTimeout,
    });

    await this.assertRunActive();

    // Phase: Checking consensus
    await this.state.updatePhase('done');

    const verdicts: consensus.VerdictResult[] = reviewerResults.map(r => ({
      reviewerIndex: r.reviewerIndex,
      verdict: r.verdict,
      binary: r.binary,
    }));

    const consensusResult = consensus.checkConsensus(verdicts);

    console.log(`Consensus: ${consensus.formatConsensusResult(consensusResult)}`);

    // Display completion estimate (lowest among all reviewers)
    const estimates = reviewerResults.map(r => r.completionEstimate).filter((e): e is number => e !== undefined);

    if (estimates.length > 0) {
      const lowestEstimate = Math.min(...estimates);
      const lowestEstimateReviewer = reviewerResults.find(r => r.completionEstimate === lowestEstimate);
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
      reviewerResults,
    };
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
      timeout: config.reviewerTimeout, // Use reviewer timeout for checkpointer
    });

    await this.assertRunActive();

    // Phase: Done
    await this.state.updatePhase('done');

    return checkpointResult;
  }
}
