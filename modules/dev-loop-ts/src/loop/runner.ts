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

export interface LoopResult {
  status: 'completed' | 'cancelled' | 'failed' | 'max_iterations';
  finalRun: Run;
  historyEntry: HistoryEntry;
}

export interface IterationResult {
  iteration: number;
  approved: boolean;
  implementerResult: agents.AgentResult;
  reviewerResults: agents.ReviewerResult[];
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
    const run = await this.state.createRun('.claude/dev-loop/spec.md');
    const dirHash = getDirHash(process.cwd());

    console.log(
      `DEV LOOP [${run.id}]: ${config.reviewers.length} reviewers (${config.reviewers.join(', ')}), max ${config.maxIterations} iterations`,
    );

    let currentRun = run;

    try {
      while (currentRun.iteration < config.maxIterations) {
        const iterResult = await this.runIteration(currentRun, config, dirHash);

        if (iterResult.approved) {
          // Unanimous approval - complete
          const entry = await this.state.completeRun('completed');
          console.log(`UNANIMOUS APPROVAL after ${iterResult.iteration} iteration(s)`);
          return {
            status: 'completed',
            finalRun: currentRun,
            historyEntry: entry,
          };
        }

        // Update run for next iteration
        currentRun = (await this.state.loadRun()) ?? currentRun;
      }

      // Max iterations reached
      const entry = await this.state.completeRun('completed');
      console.log(`Max iterations reached (${config.maxIterations})`);
      return {
        status: 'max_iterations',
        finalRun: currentRun,
        historyEntry: entry,
      };
    } catch (error) {
      console.error('Loop error:', error instanceof Error ? error.message : error);
      if (error instanceof Error && error.stack) console.error(error.stack);
      const entry = await this.state.completeRun('failed');
      return {
        status: 'failed',
        finalRun: currentRun,
        historyEntry: entry,
      };
    }
  }

  /**
   * Run a single iteration
   */
  async runIteration(run: Run, config: Config, dirHash: string): Promise<IterationResult> {
    const iterNum = await this.state.incrementIteration();

    console.log(`Iteration ${iterNum} / ${config.maxIterations}`);

    // Clear evidence, verdicts, and reviews from previous iteration
    // Reviews are cleared so implementer only sees current iteration's feedback
    await this.state.clearEvidence();
    await this.state.clearVerdicts(iterNum);
    await this.state.clearReviews();

    // Reload run to get updated iteration number
    const currentRun = await this.state.loadRun();
    if (!currentRun) throw new Error('Run not found after increment');

    // Load spec content
    let specContent: string;
    try {
      specContent = await fs.readFile(currentRun.spec, 'utf-8');
    } catch {
      throw new Error(`Spec file not found: ${currentRun.spec}\nRun 'dev-loop init' to create it.`);
    }

    // Build iteration data with updated run
    const iterData = iteration.buildIterationData(currentRun, config, currentRun.spec, specContent);

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

    // Phase: Checking consensus
    await this.state.updatePhase('done');

    const verdicts: consensus.VerdictResult[] = reviewerResults.map(r => ({
      reviewerIndex: r.reviewerIndex,
      verdict: r.verdict,
      binary: r.binary,
    }));

    const consensusResult = consensus.checkConsensus(verdicts);

    console.log(`Consensus: ${consensus.formatConsensusResult(consensusResult)}`);

    return {
      iteration: iterNum,
      approved: consensusResult.approved,
      implementerResult: implResult,
      reviewerResults,
    };
  }
}
