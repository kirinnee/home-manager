import * as fs from 'fs/promises';
import * as path from 'path';
import type { Config, Session, Verdict, ReviewerConfig } from '../types';
import { getPrimaryImplementer, selectImplementer, parseReviewerConfig } from '../types';
import type { TmuxService, StateService } from '../deps';
import { generateId, paths } from '../deps';
import * as verdicts from './verdicts';
import { buildCheckpointerPrompt } from './prompts';
import type { CheckpointerPromptVars } from './prompts';
import { extractTokensFromLog } from '../stream/parse';
import { formatAgentLaunch } from '../loop/format';

// Path to kloop binary — use process.argv[1] (the running script) instead of
// import.meta.dir so it survives nix store path changes after rebuilds.
const KLOOP_BIN = `bun run ${process.argv[1]}`;

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
  propagated?: boolean; // true if reviewer received previous loop reviews
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
   * Ensure an agent directory exists and return the path to its log file.
   */
  private async ensureAgentDir(agentDirPath: string): Promise<string> {
    await fs.mkdir(agentDirPath, { recursive: true });
    return path.join(agentDirPath, 'log');
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
    onStart?: (binary: string) => Promise<void>;
  }): Promise<ImplementerResult> {
    const { runId, iteration, dirHash, prompt, timeout, onStart } = params;

    // Select an implementer binary fresh for each run (weighted random)
    const implementerBinary = this.selectImplementer();

    // Notify caller of selected binary before launch
    if (onStart) await onStart(implementerBinary);

    // Create session record
    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-impl`;

    const session: Session = {
      id: sessionId,
      iteration,
      role: 'implementer',
      binary: implementerBinary,
      tmuxSession,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    // Write prompt to temp file
    const promptFile = await this.writePromptFile(sessionId, prompt);

    // Ensure implementer directory and write prompt.md
    const implDir = paths.loopImplementerPath(runId, iteration);
    const logFile = await this.ensureAgentDir(implDir);
    await fs.writeFile(path.join(implDir, 'prompt.md'), prompt, 'utf-8');

    // Build command with stream-json output piped through formatter
    const command = `cat "${promptFile}" | ${implementerBinary} --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;

    // Run in tmux
    formatAgentLaunch('impl', 'implementer', implementerBinary, tmuxSession, logFile);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    // Update session
    session.status = result.timedOut ? 'error' : 'completed';
    session.completedAt = new Date().toISOString();

    // Clean up prompt file
    await this.cleanupPromptFile(promptFile);

    // Read learnings from global run dir
    let learnings = '';
    try {
      learnings = await fs.readFile(paths.runLearnings(runId), 'utf-8');
    } catch {
      // No learnings yet
    }

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
    onReviewerEnd?: (result: ReviewerResult) => Promise<void>;
  }): Promise<ReviewerResult[]> {
    const { runId, iteration, dirHash, phaseIndex, reviewers, prompts, timeout, onReviewerEnd } = params;

    console.log(`  review phase ${phaseIndex} — ${reviewers.map(r => r.binary).join(', ')}`);

    const results = await Promise.all(
      prompts.map(async (p, ordinal) => {
        const result = await this.runReviewer({
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
        });
        // Notify caller as soon as this reviewer finishes (real-time event emission)
        if (onReviewerEnd) {
          await onReviewerEnd(result);
        }
        return result;
      }),
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
    const tmuxSession = `kloop-${runId}-${iteration}-rev-${reviewerIndex}`;

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

    // Write prompt to temp file
    const promptFile = await this.writePromptFile(sessionId, prompt);

    // Ensure reviewer directory under reviews/ and write prompt.md
    const reviewsDir = paths.loopReviewsPath(runId, iteration);
    const reviewerDir = path.join(reviewsDir, `reviewer-${reviewerIndex}`);
    const logFile = await this.ensureAgentDir(reviewerDir);
    await fs.writeFile(path.join(reviewerDir, 'prompt.md'), prompt, 'utf-8');

    // Build command with stream-json output piped through formatter
    const command = `cat "${promptFile}" | ${reviewerBinary} --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;

    // Run in tmux
    formatAgentLaunch('reviewer', `rev-${reviewerIndex}`, reviewerBinary, tmuxSession, logFile);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    // Determine verdict — read from verdicts/ directory
    const verdictsDir = paths.loopVerdictsPath(runId, iteration);
    const verdictContent = await this.safeReadFile(path.join(verdictsDir, `reviewer-${reviewerIndex}.json`));

    const reviewContent = await this.safeReadFile(path.join(reviewsDir, `reviewer-${reviewerIndex}.md`));

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

    // Copy review files to persistent storage
    await this.copyReviewFiles(runId, iteration, reviewerIndex, reviewContent, verdictContent);

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
    const { runId, iteration, dirHash, specPath, timeout } = params;

    // Create session record
    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-checkpoint`;

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

    // Build checkpointer prompt via template substitution
    const checkpointerVars: CheckpointerPromptVars = {
      specPath,
      iteration: String(iteration),
      reviewsDir: paths.loopReviewsPath(runId, iteration),
      archivedReviewsPattern: `${paths.runPath(runId)}/loop-*/reviews/reviewer-*.md`,
      conflictFile: `${paths.runPath(runId)}/conflict.md`,
      checkpointResultFile: `${paths.loopCheckpointerPath(runId, iteration)}/checkpoint-result.json`,
    };

    const prompt = buildCheckpointerPrompt(this.config.prompts?.checkpointer, checkpointerVars);

    // Write prompt to temp file
    const promptFile = await this.writePromptFile(sessionId, prompt);

    // Ensure checkpointer directory and write prompt.md
    const checkpointerDir = paths.loopCheckpointerPath(runId, iteration);
    const logFile = await this.ensureAgentDir(checkpointerDir);
    await fs.writeFile(path.join(checkpointerDir, 'prompt.md'), prompt, 'utf-8');

    // Build command - use checkpointer binary (defaults to implementer binary)
    const command = `cat "${promptFile}" | ${binary} --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;

    // Run in tmux
    formatAgentLaunch('checkpoint', 'checkpoint', binary, tmuxSession, logFile);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    // Read checkpoint result file from checkpointer directory
    const checkpointResultPath = `${checkpointerDir}/checkpoint-result.json`;
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
      } catch {
        // If we can't parse, assume no action to allow loop to continue
        console.log('Warning: Could not parse checkpoint result, assuming no action');
      }
    }

    // Update session
    session.status = result.timedOut ? 'error' : 'completed';
    session.completedAt = new Date().toISOString();

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
    const tmpDir = '/tmp/kloop/prompts';
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
   * Copy review files to their proper directories (reviews/ and verdicts/)
   */
  private async copyReviewFiles(
    runId: string,
    iteration: number,
    reviewerIndex: number,
    reviewContent: string | null,
    verdictContent: string | null,
  ): Promise<void> {
    const reviewsDir = paths.loopReviewsPath(runId, iteration);
    const verdictsDir = paths.loopVerdictsPath(runId, iteration);

    await fs.mkdir(reviewsDir, { recursive: true });
    await fs.mkdir(verdictsDir, { recursive: true });

    if (reviewContent) {
      await fs.writeFile(path.join(reviewsDir, `reviewer-${reviewerIndex}.md`), reviewContent, 'utf-8');
    }

    if (verdictContent) {
      await fs.writeFile(path.join(verdictsDir, `reviewer-${reviewerIndex}.json`), verdictContent, 'utf-8');
    }
  }
}
