import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  Config,
  Session,
  Verdict,
  VerdictFile,
  CheckpointerOutcome,
  CheckpointerResult,
  MetricSample,
  ReviewerConfig,
} from '../types';
import { getPrimaryImplementer, selectImplementer, parseReviewerConfig } from '../types';
import { getPrimaryImplementer, selectImplementer } from '../types';
import type { TmuxService, StateService } from '../deps';
import { generateId } from '../deps';
import * as verdicts from './verdicts';
import { buildCheckpointerPrompt } from './prompts';
import { extractTokensFromLog } from '../stream/parse';

// ============================================================================
// Agent Result types
// ============================================================================

export interface AgentResult {
  sessionId: string;
  tmuxSession: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
}

export interface ImplementerResult extends AgentResult {
  learnings: string | null;
  binary: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ReviewerResult extends AgentResult {
  reviewerIndex: number;
  binary: string;
  verdict: Verdict;
  reasoning: string;
  completionEstimate?: number;
  phaseIndex?: number; // which review phase this reviewer belongs to
  ordinal?: number; // 1-based position within the phase
  inputTokens?: number;
  outputTokens?: number;
  error?: string; // "timeout", "no_verdict", "exit_code_N"
}

export type CheckpointerOutcome = 'conflict_found' | 'spec_auto_fixed' | 'spec_compressed' | 'no_action';

export interface CheckpointerResult extends AgentResult {
  outcome: CheckpointerOutcome;
  summary: string;
  progressPercent?: number;
  completedCriteria?: string[];
  remainingCriteria?: string[];
}

// ============================================================================
// AgentRunner class (IO edge)
// ============================================================================

const LOGS_BASE_DIR = '.kagent/logs';

export class AgentRunner {
  private reviewerBinaries: string[]; // flat list from all phases
  private checkpointerBinary: string;

  constructor(
    private tmux: TmuxService,
    private state: StateService,
    private config: Config,
  ) {
    // Flatten reviewer binaries from all phases
    this.reviewerBinaries = config.reviewPhases.flat();
    this.checkpointerBinary = config.conflictChecker ?? getPrimaryImplementer(config);
  }

  /**
   * Select an implementer binary using weighted random selection.
   * Called fresh before each implementer run so different iterations may use different binaries.
   */
  private selectImplementer(): string {
    return selectImplementer(this.config);
  }

  /**
   * Get the implementer binary that would be selected (for display purposes).
   * Note: each actual run calls selectImplementer() independently.
   */
  getSelectedImplementer(): string {
    return getPrimaryImplementer(this.config);
  }

  /**
   * Get logs directory for a run
   */
  private getLogsDir(runId: string): string {
    return path.join(LOGS_BASE_DIR, runId);
  }

  /**
   * Ensure logs directory exists for a run
   */
  private async ensureLogsDir(runId: string): Promise<void> {
    await fs.mkdir(this.getLogsDir(runId), { recursive: true });
  }

  /**
   * Get log file path for a session
   */
  private getLogPath(runId: string, type: 'impl' | 'rev', iteration: number, reviewerIndex?: number): string {
    const logsDir = this.getLogsDir(runId);
    if (type === 'rev' && reviewerIndex !== undefined) {
      return path.join(logsDir, `rev-${iteration}-${reviewerIndex}.log`);
    }
    return path.join(logsDir, `impl-${iteration}.log`);
  }

  /**
   * Run the implementer agent
   */
  async runImplementer(params: {
    runId: string;
    iteration: number;
    dirHash: string;
    prompt: string;
    timeout: number;
  }): Promise<ImplementerResult> {
    const { runId, iteration, dirHash, prompt, timeout } = params;

    // Select an implementer binary fresh for each run (weighted random)
    const implementerBinary = this.selectImplementer();

    // Create session record
    const sessionId = generateId();
    const tmuxSession = `devloop-${dirHash}-${runId}-${iteration}-impl`;

    const session: Session = {
      id: sessionId,
      iteration,
      role: 'implementer',
      binary: implementerBinary,
      tmuxSession,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    await this.state.saveSession(session);

    // Write prompt to temp file
    const promptFile = await this.writePromptFile(sessionId, prompt);

    // Ensure logs directory exists
    await this.ensureLogsDir(runId);
    const logFile = this.getLogPath(runId, 'impl', iteration);

    // Build command with stream-json output piped through formatter
    const command = `cat "${promptFile}" | ${implementerBinary} --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | dev-loop stream`;

    // Run in tmux
    console.log(`Implementing in tmux: ${tmuxSession} (binary: ${implementerBinary}, log: ${logFile})`);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    // Update session
    session.status = result.timedOut ? 'error' : 'completed';
    session.completedAt = new Date().toISOString();
    await this.state.saveSession(session);

    // Clean up prompt file
    await this.cleanupPromptFile(promptFile);

    // Read learnings if written
    const learnings = await this.state.readLearnings();

    // Extract token counts from log file
    const tokens = await extractTokensFromLog(logFile);

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      learnings,
      binary: implementerBinary,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
    };
  }

  /**
   * Run all reviewers in a single phase in parallel
   */
  async runReviewersPhase(params: {
    runId: string;
    iteration: number;
    dirHash: string;
    phaseIndex: number;
    reviewers: ReviewerConfig[];
    prompts: Array<{ reviewerIndex: number; prompt: string }>;
    timeout: number;
  }): Promise<ReviewerResult[]> {
    const { runId, iteration, dirHash, phaseIndex, reviewers, prompts, timeout } = params;

    console.log(`Running phase ${phaseIndex} reviewers (${reviewers.map(r => r.binary).join(', ')}) in parallel`);

    const results = await Promise.all(
      prompts.map((p, ordinal) =>
        this.runReviewer({
          runId,
          iteration,
          dirHash,
          reviewerIndex: p.reviewerIndex,
          binary: reviewers[ordinal]?.binary ?? reviewers[0].binary,
          prompt: p.prompt,
          timeout,
          phaseIndex,
          ordinal: ordinal + 1,
          noVerdictAsFailure: reviewers[ordinal]?.noVerdictAsFailure ?? true,
        }),
      ),
    );

    const approved = results.filter(r => r.verdict === 'approved').length;
    const rejected = results.filter(r => r.verdict === 'rejected').length;

    console.log(`Phase ${phaseIndex} verdicts: ${approved} approved, ${rejected} rejected`);

    return results;
  }

  /**
   * Run all reviewer agents (legacy flat mode, wraps into single phase)
   */
  async runReviewers(params: {
    runId: string;
    iteration: number;
    dirHash: string;
    prompts: Array<{ reviewerIndex: number; prompt: string }>;
    timeout: number;
  }): Promise<ReviewerResult[]> {
    const { runId, iteration, dirHash, prompts, timeout } = params;
    const allReviewers = this.config.reviewPhases.flat().map(parseReviewerConfig);
    return this.runReviewersPhase({
      runId,
      iteration,
      dirHash,
      phaseIndex: 0,
      reviewers: allReviewers,
      prompts,
      timeout,
    });
  }

  /**
   * Run a single reviewer agent
   */
  async runReviewer(params: {
    runId: string;
    iteration: number;
    dirHash: string;
    reviewerIndex: number;
    binary?: string;
    prompt: string;
    timeout: number;
    phaseIndex?: number;
    ordinal?: number;
    noVerdictAsFailure?: boolean;
  }): Promise<ReviewerResult> {
    const { runId, iteration, dirHash, reviewerIndex, prompt, timeout, phaseIndex, ordinal, noVerdictAsFailure } =
      params;

    // Get the reviewer binary
    const reviewerBinary = params.binary ?? this.reviewerBinaries[reviewerIndex % this.reviewerBinaries.length];

    // Create session record
    const sessionId = generateId();
    const tmuxSession = `devloop-${dirHash}-${runId}-${iteration}-rev-${reviewerIndex}`;

    const session: Session = {
      id: sessionId,
      iteration,
      role: 'reviewer',
      reviewerIndex,
      binary: reviewerBinary,
      tmuxSession,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    await this.state.saveSession(session);

    // Write prompt to temp file
    const promptFile = await this.writePromptFile(sessionId, prompt);

    // Ensure logs directory exists
    await this.ensureLogsDir(runId);
    const logFile = this.getLogPath(runId, 'rev', iteration, reviewerIndex);

    // Build command with stream-json output piped through formatter
    const command = `cat "${promptFile}" | ${reviewerBinary} --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | dev-loop stream`;

    // Run in tmux
    console.log(`  Reviewer ${reviewerIndex} (${reviewerBinary}) in tmux: ${tmuxSession} (log: ${logFile})`);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    // Determine verdict
    const verdictPath = `.kagent/current/verdicts/${iteration}-${reviewerIndex}.json`;
    const verdictContent = await this.safeReadFile(verdictPath);

    const reviewPath = `.kagent/current/reviews/reviewer-${reviewerIndex}.md`;
    const reviewContent = await this.safeReadFile(reviewPath);

    let error: string | undefined;
    const verdict = this.determineReviewerVerdict({
      verdictFileContent: verdictContent,
      reviewFileContent: reviewContent,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      reviewerBinary,
      phaseIndex,
      noVerdictAsFailure: noVerdictAsFailure ?? true,
      onError: msg => {
        error = msg;
      },
    });

    // Parse reasoning and completion estimate if available
    let reasoning = '';
    let completionEstimate: number | undefined;
    if (verdictContent) {
      const parsed = verdicts.parseVerdictFile(verdictContent);
      reasoning = parsed.reasoning;
      completionEstimate = parsed.completionEstimate;
    }

    // Update session
    session.status = result.timedOut ? 'error' : 'completed';
    session.completedAt = new Date().toISOString();
    session.verdict = verdict;
    await this.state.saveSession(session);

    // Copy review files to persistent storage
    await this.copyReviewFiles(runId, iteration, reviewerIndex, reviewerBinary, reviewContent, verdictContent);

    // Clean up prompt file
    await this.cleanupPromptFile(promptFile);

    // Extract token counts from log file
    const tokens = await extractTokensFromLog(logFile);

    const icon = verdict === 'approved' ? '✓' : '✗';
    console.log(
      `  ${icon} Reviewer ${reviewerIndex} (${reviewerBinary})${phaseIndex !== undefined ? ` (phase ${phaseIndex})` : ''}: ${verdict}${completionEstimate !== undefined ? ` (${completionEstimate}%)` : ''}`,
    );

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      reviewerIndex,
      binary: reviewerBinary,
      verdict,
      reasoning,
      completionEstimate,
      phaseIndex,
      ordinal,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      error,
    };
  }

  /**
   * Run the checkpointer agent
   */
  async runCheckpointer(params: {
    runId: string;
    iteration: number;
    dirHash: string;
    specPath: string;
    specContent: string;
    timeout: number;
  }): Promise<CheckpointerResult> {
    const { runId, iteration, dirHash, specPath, specContent, timeout } = params;

    // Create session record
    const sessionId = generateId();
    const tmuxSession = `devloop-${dirHash}-${runId}-${iteration}-checkpoint`;

    const binary = this.checkpointerBinary;

    const session: Session = {
      id: sessionId,
      iteration,
      role: 'checkpointer',
      binary,
      tmuxSession,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    await this.state.saveSession(session);

    // Build checkpointer prompt
    const prompt = buildCheckpointerPrompt({
      iteration,
      specPath,
      specContent,
      runId,
    });

    // Write prompt to temp file
    const promptFile = await this.writePromptFile(sessionId, prompt);

    // Ensure logs directory exists
    await this.ensureLogsDir(runId);
    const logFile = path.join(this.getLogsDir(runId), `checkpoint-${iteration}.log`);

    // Build command - use checkpointer binary (defaults to implementer binary)
    const command = `cat "${promptFile}" | ${binary} --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | dev-loop stream`;

    // Run in tmux
    console.log(`Checkpointer in tmux: ${tmuxSession} (log: ${logFile})`);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    // Read checkpoint result file
    const checkpointResultPath = `.kagent/current/checkpoint-result.json`;
    const checkpointResultContent = await this.safeReadFile(checkpointResultPath);

    let outcome: CheckpointerOutcome = 'no_action';
    let summary = 'Unable to determine checkpoint status';
    let progressPercent: number | undefined;
    let completedCriteria: string[] | undefined;
    let remainingCriteria: string[] | undefined;

    if (checkpointResultContent) {
      try {
        const parsed = JSON.parse(checkpointResultContent);
        if (
          parsed.outcome === 'conflict_found' ||
          parsed.outcome === 'spec_auto_fixed' ||
          parsed.outcome === 'spec_compressed' ||
          parsed.outcome === 'no_action'
        ) {
          outcome = parsed.outcome;
        }
        summary = parsed.summary ?? 'No summary provided';
        progressPercent = parsed.progressPercent;
        completedCriteria = parsed.completedCriteria;
        remainingCriteria = parsed.remainingCriteria;

        // Save checkpoint result to state (with iteration for history tracking)
        await this.state.saveCheckpointResult(
          {
            outcome,
            summary,
            progressPercent,
            completedCriteria,
            remainingCriteria,
          },
          iteration,
        );
      } catch {
        // If we can't parse, assume no action to allow loop to continue
        console.log('Warning: Could not parse checkpoint result, assuming no action');
      }
    }

    // Update session
    session.status = result.timedOut ? 'error' : 'completed';
    session.completedAt = new Date().toISOString();
    await this.state.saveSession(session);

    // Clean up prompt file
    await this.cleanupPromptFile(promptFile);

    const outcomeDisplay: Record<CheckpointerOutcome, string> = {
      conflict_found: 'CONFLICT DETECTED',
      spec_auto_fixed: 'SPEC AUTO-FIXED',
      spec_compressed: 'SPEC COMPRESSED',
      no_action: 'No action needed',
    };

    console.log(
      `Checkpoint: ${outcomeDisplay[outcome]}${progressPercent !== undefined ? ` (${progressPercent}% progress)` : ''}`,
    );
    console.log(`  Summary: ${summary}`);

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outcome,
      summary,
      progressPercent,
      completedCriteria,
      remainingCriteria,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Determine reviewer verdict with error logging
   */
  private determineReviewerVerdict(params: {
    verdictFileContent: string | null;
    reviewFileContent: string | null;
    exitCode: number;
    timedOut: boolean;
    reviewerBinary: string;
    phaseIndex?: number;
    noVerdictAsFailure: boolean;
    onError: (msg: string) => void;
  }): Verdict {
    const {
      verdictFileContent,
      reviewFileContent,
      exitCode,
      timedOut,
      reviewerBinary,
      phaseIndex,
      noVerdictAsFailure,
      onError,
    } = params;

    const phaseStr = phaseIndex !== undefined ? ` (phase ${phaseIndex})` : '';

    // Try to parse verdict file first (regardless of exit code)
    if (verdictFileContent) {
      const parsed = verdicts.parseVerdictFile(verdictFileContent);
      if (parsed.verdict) {
        return parsed.verdict;
      }
    }

    // No verdict file - check review text
    if (reviewFileContent) {
      const fromText = verdicts.parseVerdictFromText(reviewFileContent);
      if (fromText) {
        return fromText;
      }
    }

    // No verdict found — determine behavior based on reviewer config
    // :1 (noVerdictAsFailure=true): any abnormal exit or missing verdict = rejection
    // :0 (noVerdictAsFailure=false): abnormal exit or missing verdict = approval
    if (noVerdictAsFailure) {
      const reason = timedOut ? 'timed out' : exitCode !== 0 ? `exited with code ${exitCode}` : 'produced no verdict';
      console.log(`\u26a0 Reviewer "${reviewerBinary}"${phaseStr} ${reason} \u2014 treating as rejection`);
      onError(timedOut ? 'timeout' : exitCode !== 0 ? `exit_code_${exitCode}` : 'no_verdict');
      return 'rejected';
    } else {
      const reason = timedOut ? 'timed out' : exitCode !== 0 ? `exited with code ${exitCode}` : 'produced no verdict';
      console.log(`\u26a0 Reviewer "${reviewerBinary}"${phaseStr} ${reason} \u2014 treating as approval`);
      return 'approved';
    }
  }

  private async writePromptFile(sessionId: string, prompt: string): Promise<string> {
    const tmpDir = '/tmp/dev-loop/prompts';
    await fs.mkdir(tmpDir, { recursive: true });
    const promptFile = path.join(tmpDir, `prompt-${sessionId}.txt`);
    await fs.writeFile(promptFile, prompt, 'utf-8');
    return promptFile;
  }

  private async cleanupPromptFile(promptFile: string): Promise<void> {
    try {
      await fs.unlink(promptFile);
    } catch {}
  }

  private async safeReadFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Copy review files to persistent storage
   */
  private async copyReviewFiles(
    runId: string,
    iteration: number,
    reviewerIndex: number,
    binary: string,
    reviewContent: string | null,
    verdictContent: string | null,
  ): Promise<void> {
    const reviewsDir = `.kagent/reviews/${runId}`;
    await fs.mkdir(reviewsDir, { recursive: true });

    // Sanitize binary name for filename
    const binaryName = binary.replace(/[^a-zA-Z0-9_-]/g, '_');

    if (reviewContent) {
      const reviewFile = path.join(reviewsDir, `review-${iteration}-${reviewerIndex}-${binaryName}.md`);
      await fs.writeFile(reviewFile, reviewContent, 'utf-8');
    }

    if (verdictContent) {
      const verdictFile = path.join(reviewsDir, `verdict-${iteration}-${reviewerIndex}-${binaryName}.json`);
      await fs.writeFile(verdictFile, verdictContent, 'utf-8');
    }
  }
}
