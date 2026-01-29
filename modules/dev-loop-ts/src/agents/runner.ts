import * as fs from 'fs/promises';
import * as path from 'path';
import type { Session, Verdict, VerdictFile } from '../types';
import type { TmuxService, StateService } from '../deps';
import { generateId } from '../deps';
import * as verdicts from './verdicts';

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
}

export interface ReviewerResult extends AgentResult {
  reviewerIndex: number;
  binary: string;
  verdict: Verdict;
  reasoning: string;
}

// ============================================================================
// AgentRunner class (IO edge)
// ============================================================================

const LOGS_BASE_DIR = '.claude/dev-loop/logs';

export class AgentRunner {
  constructor(
    private tmux: TmuxService,
    private state: StateService,
    private implementerBinary: string = 'claude',
    private reviewerBinaries: string[] = ['claude-reviewer-zai'],
  ) {}

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

    // Create session record
    const sessionId = generateId();
    const tmuxSession = `devloop-${dirHash}-${runId}-${iteration}-impl`;

    const session: Session = {
      id: sessionId,
      iteration,
      role: 'implementer',
      binary: this.implementerBinary,
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
    // Use tee to duplicate output to both stdout and log file for debugging
    // Note: --verbose is required for --output-format stream-json
    const command = `cat "${promptFile}" | ${this.implementerBinary} --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | dev-loop stream`;

    // Run in tmux
    console.log(`Implementing in tmux: ${tmuxSession} (log: ${logFile})`);

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

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      learnings,
    };
  }

  /**
   * Run all reviewer agents in parallel
   */
  async runReviewers(params: {
    runId: string;
    iteration: number;
    dirHash: string;
    prompts: Array<{ reviewerIndex: number; prompt: string }>;
    timeout: number;
  }): Promise<ReviewerResult[]> {
    const { runId, iteration, dirHash, prompts, timeout } = params;

    console.log(`Running ${prompts.length} reviewers in parallel`);

    const results = await Promise.all(
      prompts.map(p =>
        this.runReviewer({
          runId,
          iteration,
          dirHash,
          reviewerIndex: p.reviewerIndex,
          prompt: p.prompt,
          timeout,
        }),
      ),
    );

    const approved = results.filter(r => r.verdict === 'approved').length;
    const rejected = results.filter(r => r.verdict === 'rejected').length;

    console.log(`Verdicts: ${approved} approved, ${rejected} rejected`);

    return results;
  }

  /**
   * Run a single reviewer agent
   */
  async runReviewer(params: {
    runId: string;
    iteration: number;
    dirHash: string;
    reviewerIndex: number;
    prompt: string;
    timeout: number;
  }): Promise<ReviewerResult> {
    const { runId, iteration, dirHash, reviewerIndex, prompt, timeout } = params;

    // Create session record
    const sessionId = generateId();
    const tmuxSession = `devloop-${dirHash}-${runId}-${iteration}-rev-${reviewerIndex}`;

    // Get the reviewer binary for this index (cycle through list if more reviewers than binaries)
    const reviewerBinary = this.reviewerBinaries[reviewerIndex % this.reviewerBinaries.length];

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
    // Use tee to duplicate output to both stdout and log file for debugging
    // Note: --verbose is required for --output-format stream-json
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
    const verdictPath = `.claude/dev-loop/current/verdicts/${iteration}-${reviewerIndex}.json`;
    const verdictContent = await this.safeReadFile(verdictPath);

    const reviewPath = `.claude/dev-loop/current/reviews/reviewer-${reviewerIndex}.md`;
    const reviewContent = await this.safeReadFile(reviewPath);

    const verdict = verdicts.determineVerdict({
      verdictFileContent: verdictContent,
      reviewFileContent: reviewContent,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });

    // Parse reasoning if available
    let reasoning = '';
    if (verdictContent) {
      const parsed = verdicts.parseVerdictFile(verdictContent);
      reasoning = parsed.reasoning;
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

    const icon = verdict === 'approved' ? '✓' : '✗';
    console.log(`  ${icon} Reviewer ${reviewerIndex} (${reviewerBinary}): ${verdict}`);

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
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

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
   * Creates: .claude/dev-loop/reviews/{runId}/review-{iteration}-{index}-{binary}.md
   *          .claude/dev-loop/reviews/{runId}/verdict-{iteration}-{index}-{binary}.json
   */
  private async copyReviewFiles(
    runId: string,
    iteration: number,
    reviewerIndex: number,
    binary: string,
    reviewContent: string | null,
    verdictContent: string | null,
  ): Promise<void> {
    const reviewsDir = `.claude/dev-loop/reviews/${runId}`;
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
