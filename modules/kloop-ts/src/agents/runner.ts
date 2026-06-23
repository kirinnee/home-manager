import * as fs from 'fs/promises';
import * as path from 'path';
import type { Config, Verdict, HarnessType } from '../types';
import { getPrimaryImplementer, selectImplementer, selectRoleAccount } from '../types';
import type { TmuxService, StateService } from '../deps';
import { generateId, paths, getKloopHome } from '../deps';
import * as verdicts from './verdicts';
import {
  buildCheckpointerPrompt,
  buildSynthesizerPrompt,
  buildVerifierPrompt,
  buildReSynthesisPrompt,
  buildSentinelInstruction,
} from './prompts';
import type {
  CheckpointerPromptVars,
  SynthesizerPromptVars,
  VerifierPromptVars,
  ReSynthesisPromptVars,
} from './prompts';
import { extractTokensFromLog, extractHarnessSessionId } from '../stream/parse';
import { formatAgentLaunch } from '../loop/format';
import type { ParsedBinary, ReviewerBinary, ReviewTypeEntry } from '../types';
import {
  parseImplementerConfig,
  parseReviewerConfig,
  parseConflictCheckerConfig,
  selectFromPool,
  reviewTypeLabel,
} from '../types';

// Path to kloop binary — use process.argv[1] (the running script) instead of
// import.meta.dir so it survives nix store path changes after rebuilds.
const KLOOP_BIN = `bun run ${process.argv[1]}`;

// Marker file an interactive-mode agent touches when fully done (per-agent dir).
const SENTINEL_NAME = '.kloop-done';

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
  harness: HarnessType;
  inputTokens?: number;
  outputTokens?: number;
  harnessSessionId?: string;
}

export interface ReviewerResult extends AgentResult {
  reviewerIndex: number;
  binary: string;
  harness: HarnessType;
  verdict: Verdict;
  reasoning: string;
  completionEstimate?: number;
  phaseIndex?: number; // which review phase this reviewer belongs to
  ordinal?: number; // 1-based position within the phase
  inputTokens?: number;
  outputTokens?: number;
  error?: string; // "timeout", "no_verdict", "exit_code_N"
  propagated?: boolean; // true if reviewer received previous loop reviews
  harnessSessionId?: string;
}

type CheckpointerOutcome = 'conflict_found' | 'spec_auto_fixed' | 'spec_compressed' | 'no_action';

interface CheckpointerResult extends AgentResult {
  outcome: CheckpointerOutcome;
  summary: string;
  progressPercent?: number;
  completedCriteria?: string[];
  remainingCriteria?: string[];
  harnessSessionId?: string;
}

export interface SynthesizerResult extends AgentResult {
  binary: string;
  harness: HarnessType;
  summaryPath?: string;
  inputTokens?: number;
  outputTokens?: number;
  harnessSessionId?: string;
}

export interface VerifierResult extends AgentResult {
  reviewerIndex: number;
  binary: string;
  harness: HarnessType;
  verdict: Verdict;
  reasoning: string;
  phaseIndex?: number;
  ordinal?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  issuesFixed?: string[];
  issuesRemaining?: string[];
  harnessSessionId?: string;
}

// ============================================================================
// Harness-aware command builder
// ============================================================================

/**
 * Build the agent command for a given harness type.
 *
 * Claude: cat "${promptFile}" | claude-auto-zai --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | kloop stream
 * Gemini: cat "${promptFile}" | GEMINI_CLI_TRUST_WORKSPACE=true gemini-auto --yolo --output-format stream-json -p "" 2>&1 | tee "${logFile}" | kloop stream
 * Codex:  cat "${promptFile}" | codex-auto exec --full-auto --json --ephemeral --skip-git-repo-check -c sandbox_workspace_write.network_access=true 2>&1 | tee "${logFile}" | kloop stream
 */
function buildAgentCommand(params: {
  binary: string;
  harness: HarnessType;
  promptFile: string;
  sessionId: string;
  logFile: string;
}): string {
  const { binary, harness, promptFile, sessionId, logFile } = params;

  if (harness === 'claude') {
    // Claude: injects kloop session ID as --session-id
    return `cat "${promptFile}" | ${binary} --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;
  } else if (harness === 'codex') {
    // Codex: exec subcommand, --full-auto, --json, --ephemeral, stdin prompt
    // --skip-git-repo-check: kloop workspaces may not be git repos
    // --add-dir "${getKloopHome()}": make the global kloop store writable so the
    // agent can write verdicts/reviews/evidence directly to ~/.kloop/{runId}/...
    // (the workspace-write sandbox otherwise blocks writes outside CWD)
    // -c sandbox_workspace_write.network_access=true: keep workspace-write FS
    // sandbox but allow network so installs (bun/npm/pip/etc.) work
    return `cat "${promptFile}" | ${binary} exec --full-auto --add-dir "${getKloopHome()}" --json --ephemeral --skip-git-repo-check -c sandbox_workspace_write.network_access=true 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;
  } else {
    // Gemini: no session ID injection, pipe prompt via stdin (avoids shell arg length limits)
    // GEMINI_CLI_TRUST_WORKSPACE=true bypasses the trust-folder prompt for headless runs
    return `cat "${promptFile}" | GEMINI_CLI_TRUST_WORKSPACE=true ${binary} --yolo --output-format stream-json -p "" 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;
  }
}

// ============================================================================
// AgentRunner class (IO edge)
// ============================================================================

export class AgentRunner {
  private reviewerBinaries: string[]; // flat list from all phases
  private checkpointerBinary: string;
  private checkpointerHarness: HarnessType;
  private pathsImpl: typeof paths;

  constructor(
    private tmux: TmuxService,
    private state: StateService,
    private config: Config,
    pathsOverride?: typeof paths,
  ) {
    this.pathsImpl = pathsOverride ?? paths;
    // Flatten reviewer type labels from all phases (display only)
    this.reviewerBinaries = config.reviewPhases.flat().map(e => reviewTypeLabel(e, config.poolProfiles));
    // Parse checkpointer binary and harness
    const checkpointerConfig = parseConflictCheckerConfig(
      selectRoleAccount(config.conflictChecker, config.poolProfiles) ?? getPrimaryImplementer(config),
    );
    this.checkpointerBinary = checkpointerConfig.binary;
    this.checkpointerHarness = checkpointerConfig.harness;
  }

  /**
   * Select an implementer binary using weighted random selection.
   * Called fresh before each implementer run so different iterations may use different binaries.
   */
  private selectImplementer(loopNum: number): string {
    return selectImplementer(this.config, loopNum);
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
    const logFile = path.join(agentDirPath, 'log');
    // A prior interactive run may have left `log` as a SYMLINK to Claude's own session
    // transcript (see service.ts updateInteractiveLog). Print-mode `tee "${logFile}"` would
    // follow that link and write the stream-json straight into the unrelated transcript,
    // corrupting it. Remove any stale link/file first (force: does not follow symlinks) so
    // tee always creates a fresh regular file.
    await fs.rm(logFile, { force: true });
    return logFile;
  }

  /** True when this run drives claude agents as interactive TUIs. Only claude harnesses. */
  private isInteractive(harness: HarnessType): boolean {
    return this.config.interactive === true && harness === 'claude';
  }

  /**
   * Dispatch a single agent into tmux — interactive (TUI + sentinel) or print (one-shot
   * pipeline). The print `command` is always passed and used only on the non-interactive
   * path. Centralizes the branch so every role behaves identically.
   */
  private async launch(p: {
    interactive: boolean;
    sentinelFile?: string;
    tmuxSession: string;
    binary: string;
    promptFile: string;
    sessionId: string;
    logFile: string;
    timeout: number;
    command: string;
    // Interactive-only fallback: if the agent produced this output file but never touched the
    // completion sentinel (so the session idled to timeout / died), the work IS done. Treat the
    // run as successful instead of failing/retrying — mirrors the reviewer's verdict-file fallback.
    outputFile?: string;
  }): Promise<{ exitCode: number; durationMs: number; timedOut: boolean }> {
    if (p.interactive && p.sentinelFile) {
      const result = await this.tmux.runInteractiveSession({
        sessionName: p.tmuxSession,
        binary: p.binary,
        promptFile: p.promptFile,
        sessionId: p.sessionId,
        cwd: process.cwd(),
        timeoutMins: p.timeout,
        sentinelFile: p.sentinelFile,
        logFile: p.logFile,
      });
      // Sentinel-independent completion: a missing sentinel but a real output file means the
      // agent finished its work and just skipped the final `touch`. Don't misclassify as failure.
      if ((result.timedOut || result.exitCode !== 0) && p.outputFile && (await this.safeFileExists(p.outputFile))) {
        return { exitCode: 0, durationMs: result.durationMs, timedOut: false };
      }
      return result;
    }
    return this.tmux.runInSession({
      sessionName: p.tmuxSession,
      command: p.command,
      cwd: process.cwd(),
      timeoutMins: p.timeout,
    });
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
    const implementerBinaryName = this.selectImplementer(iteration);
    const parsedImpl = parseImplementerConfig(implementerBinaryName);

    // Notify caller of selected binary before launch
    if (onStart) await onStart(parsedImpl.binary);

    // Runtime session identifiers
    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-impl`;

    // Ensure implementer directory (needed for the interactive sentinel + prompt.md)
    const implDir = paths.loopImplementerPath(runId, iteration);
    const logFile = await this.ensureAgentDir(implDir);

    // In interactive mode, append the completion-sentinel instruction to the prompt.
    const interactive = this.isInteractive(parsedImpl.harness);
    const sentinelFile = interactive ? path.join(implDir, SENTINEL_NAME) : undefined;
    const finalPrompt = sentinelFile ? prompt + buildSentinelInstruction(sentinelFile) : prompt;

    // Write prompt to temp file + human-readable prompt.md
    const promptFile = await this.writePromptFile(sessionId, finalPrompt);
    await fs.writeFile(path.join(implDir, 'prompt.md'), finalPrompt, 'utf-8');

    // Build harness-aware command (used only on the print-mode path)
    const command = buildAgentCommand({
      binary: parsedImpl.binary,
      harness: parsedImpl.harness,
      promptFile,
      sessionId,
      logFile,
    });

    // Run in tmux (interactive TUI or print pipeline)
    formatAgentLaunch('impl', 'implementer', parsedImpl.binary, tmuxSession, logFile);

    const result = await this.launch({
      interactive,
      sentinelFile,
      tmuxSession,
      binary: parsedImpl.binary,
      promptFile,
      sessionId,
      logFile,
      timeout,
      command,
    });

    // Clean up prompt file
    await this.cleanupPromptFile(promptFile);

    // Read learnings from global run dir
    let learnings = '';
    try {
      learnings = await fs.readFile(paths.runLearnings(runId), 'utf-8');
    } catch {
      // No learnings yet
    }

    // Extract token counts and harness session ID from log file
    const tokens = await extractTokensFromLog(logFile);
    const harnessSessionId =
      (await extractHarnessSessionId(logFile)) ?? (parsedImpl.harness === 'claude' ? sessionId : undefined);

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      learnings,
      binary: parsedImpl.binary,
      harness: parsedImpl.harness,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      harnessSessionId,
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
    reviewers: ReviewerBinary[];
    prompts: Array<{ reviewerIndex: number; prompt: string }>;
    timeout: number;
    onReviewerEnd?: (result: ReviewerResult) => Promise<void>;
  }): Promise<ReviewerResult[]> {
    const { runId, iteration, dirHash, phaseIndex, reviewers, prompts, timeout, onReviewerEnd } = params;

    console.log(`  review phase ${phaseIndex} — ${reviewers.map(r => r.binary).join(', ')}`);

    const results = await Promise.all(
      prompts.map(async (p, ordinal) => {
        const reviewer = reviewers[ordinal] ?? reviewers[0];
        const result = await this.runReviewer({
          runId,
          iteration,
          dirHash,
          reviewerIndex: p.reviewerIndex,
          binary: reviewer.binary,
          harness: reviewer.harness,
          prompt: p.prompt,
          timeout,
          phaseIndex,
          ordinal: ordinal + 1,
          noVerdictAsFailure: reviewer.noVerdictAsFailure,
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
    // Legacy flat path (no lens matrix): one account per type, pool-selected.
    const allReviewers = this.config.reviewPhases
      .flat()
      .map(e => parseReviewerConfig(selectFromPool(e, this.config.poolProfiles)));
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
    binary: string;
    harness: HarnessType;
    prompt: string;
    timeout: number;
    phaseIndex?: number;
    ordinal?: number;
    noVerdictAsFailure?: boolean;
  }): Promise<ReviewerResult> {
    const {
      runId,
      iteration,
      dirHash,
      reviewerIndex,
      binary,
      harness,
      prompt,
      timeout,
      phaseIndex,
      ordinal,
      noVerdictAsFailure,
    } = params;

    // Stable paths across retries
    const reviewsDir = paths.loopReviewsPath(runId, iteration);
    const reviewerDir = path.join(reviewsDir, `reviewer-${reviewerIndex}`);
    await fs.mkdir(reviewerDir, { recursive: true });

    // Interactive mode: append the completion-sentinel instruction (stable across retries).
    const interactive = this.isInteractive(harness);
    const sentinelFile = interactive ? path.join(reviewerDir, SENTINEL_NAME) : undefined;
    const launchPrompt = sentinelFile ? prompt + buildSentinelInstruction(sentinelFile) : prompt;
    await fs.writeFile(path.join(reviewerDir, 'prompt.md'), launchPrompt, 'utf-8');

    const verdictsDir = paths.loopVerdictsPath(runId, iteration);
    await fs.mkdir(verdictsDir, { recursive: true });
    const verdictFilePath = path.join(verdictsDir, `reviewer-${reviewerIndex}.json`);
    const reviewFilePath = path.join(reviewsDir, `reviewer-${reviewerIndex}.md`);

    // Retry policy — ONLY retries when no parseable verdict is produced (transport
    // failure, crash, timeout). A real approve/reject verdict is never retried.
    const maxRetries = this.config.reviewerRetry?.maxRetries ?? 2;
    const backoffBaseMs = this.config.reviewerRetry?.backoffBaseMs ?? 5000;

    let sessionId = '';
    let tmuxSession = '';
    let logFile = '';
    let promptFile = '';
    let result: { exitCode: number; durationMs: number; timedOut: boolean } = {
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
    };
    let verdictContent: string | null = null;
    let reviewContent: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Clean slate: remove any pre-existing verdict/review at the target paths so a
      // stale file (from a re-entered run or a prior crashed attempt) can never be
      // misread as this attempt's output.
      await fs.rm(verdictFilePath, { force: true });
      await fs.rm(reviewFilePath, { force: true });

      // Fresh runtime identifiers per attempt
      sessionId = generateId();
      tmuxSession = `kloop-${runId}-${iteration}-rev-${reviewerIndex}${attempt > 0 ? `-r${attempt}` : ''}`;
      promptFile = await this.writePromptFile(sessionId, launchPrompt);
      logFile = await this.ensureAgentDir(reviewerDir);

      // Build harness-aware command (used only on the print-mode path)
      const command = buildAgentCommand({
        binary,
        harness,
        promptFile,
        sessionId,
        logFile,
      });

      // Run in tmux (interactive TUI or print pipeline)
      formatAgentLaunch('reviewer', `rev-${reviewerIndex}`, binary, tmuxSession, logFile);

      result = await this.launch({
        interactive,
        sentinelFile,
        tmuxSession,
        binary,
        promptFile,
        sessionId,
        logFile,
        outputFile: verdictFilePath,
        timeout,
        command,
      });

      // Read verdict + review from their persistent directories
      verdictContent = await this.safeReadFile(verdictFilePath);
      reviewContent = await this.safeReadFile(reviewFilePath);

      // Did the reviewer produce a real, parseable verdict?
      const verdictProduced =
        (verdictContent !== null && verdicts.parseVerdictFile(verdictContent).verdict !== null) ||
        (reviewContent !== null && verdicts.parseVerdictFromText(reviewContent) !== null);

      if (verdictProduced || attempt >= maxRetries) {
        break;
      }

      // No verdict — almost always a transport failure (stream disconnect / crash /
      // timeout). Back off and retry rather than scoring it as a rejection.
      await this.cleanupPromptFile(promptFile);
      const backoffMs = backoffBaseMs * Math.pow(2, attempt);
      const reason = result.timedOut
        ? 'timed out'
        : result.exitCode !== 0
          ? `exited ${result.exitCode}`
          : 'produced no verdict';
      console.log(
        `  ↻ reviewer ${reviewerIndex} (${binary})${phaseIndex !== undefined ? ` (phase ${phaseIndex})` : ''} ${reason} — retry ${attempt + 1}/${maxRetries} (backoff ${Math.round(backoffMs / 1000)}s)`,
      );
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

    let error: string | undefined;
    const verdict = this.determineReviewerVerdict({
      verdictFileContent: verdictContent,
      reviewFileContent: reviewContent,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      reviewerBinary: binary,
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

    // Clean up prompt file
    await this.cleanupPromptFile(promptFile);

    // Extract token counts and harness session ID from log file
    const tokens = await extractTokensFromLog(logFile);
    const harnessSessionId = (await extractHarnessSessionId(logFile)) ?? (harness === 'claude' ? sessionId : undefined);

    const icon = verdict === 'approved' ? '✓' : '✗';
    console.log(
      `  ${icon} Reviewer ${reviewerIndex} (${binary})${phaseIndex !== undefined ? ` (phase ${phaseIndex})` : ''}: ${verdict}${completionEstimate !== undefined ? ` (${completionEstimate}%)` : ''}`,
    );

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      reviewerIndex,
      binary,
      harness,
      verdict,
      reasoning,
      completionEstimate,
      phaseIndex,
      ordinal,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      error,
      harnessSessionId,
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

    // Runtime session identifiers
    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-checkpoint`;

    const binary = this.checkpointerBinary;
    const harness = this.checkpointerHarness;

    // Build checkpointer prompt via template substitution
    const checkpointerVars: CheckpointerPromptVars = {
      specPath,
      iteration: String(iteration),
      reviewsDir: paths.loopReviewsPath(runId, iteration),
      archivedReviewsPattern: `${paths.runPath(runId)}/loop-*/reviews/reviewer-*.md`,
      archivedSummariesPattern: `${paths.runPath(runId)}/loop-*/synthesis/review-summary.md`,
      conflictFile: `${paths.runPath(runId)}/conflict.md`,
      checkpointResultFile: `${paths.loopCheckpointerPath(runId, iteration)}/checkpoint-result.json`,
    };

    const prompt = buildCheckpointerPrompt(
      this.config.prompts?.checkpointer,
      this.config.prompts?.checkpointerFull,
      checkpointerVars,
      this.config.compressSpec,
    );

    // Ensure checkpointer directory (needed for the interactive sentinel + prompt.md)
    const checkpointerDir = paths.loopCheckpointerPath(runId, iteration);
    const logFile = await this.ensureAgentDir(checkpointerDir);

    // Interactive mode: append the completion-sentinel instruction.
    const interactive = this.isInteractive(harness);
    const sentinelFile = interactive ? path.join(checkpointerDir, SENTINEL_NAME) : undefined;
    const finalPrompt = sentinelFile ? prompt + buildSentinelInstruction(sentinelFile) : prompt;

    // Write prompt to temp file + human-readable prompt.md
    const promptFile = await this.writePromptFile(sessionId, finalPrompt);
    await fs.writeFile(path.join(checkpointerDir, 'prompt.md'), finalPrompt, 'utf-8');

    // Clean slate: remove any pre-existing result so a stale file (from a re-entered run) can't
    // be misread as this run's output — required for the interactive sentinel-independent fallback.
    const checkpointResultPath = `${checkpointerDir}/checkpoint-result.json`;
    await fs.rm(checkpointResultPath, { force: true });

    // Build harness-aware command (used only on the print-mode path)
    const command = buildAgentCommand({
      binary,
      harness,
      promptFile,
      sessionId,
      logFile,
    });

    // Run in tmux (interactive TUI or print pipeline)
    formatAgentLaunch('checkpoint', 'checkpoint', binary, tmuxSession, logFile);

    const result = await this.launch({
      interactive,
      sentinelFile,
      tmuxSession,
      binary,
      promptFile,
      sessionId,
      logFile,
      outputFile: checkpointResultPath,
      timeout,
      command,
    });

    // Read checkpoint result file from checkpointer directory
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

    // Extract harness session ID from log file
    const harnessSessionId = (await extractHarnessSessionId(logFile)) ?? (harness === 'claude' ? sessionId : undefined);

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
      harnessSessionId,
    };
  }

  /**
   * Run the synthesizer agent to compact reviews into a summary.
   */
  async runSynthesizer(params: {
    runId: string;
    iteration: number;
    dirHash: string;
    binary?: string;
    previousSummaryPath: string | null;
    timeout: number;
  }): Promise<SynthesizerResult> {
    const { runId, iteration, dirHash, binary: overrideBinary, previousSummaryPath, timeout } = params;

    // Use synthesizer binary from config, first implementer as fallback, or override
    const implBinaryName =
      overrideBinary ??
      selectRoleAccount(this.config.synthesizer, this.config.poolProfiles) ??
      getPrimaryImplementer(this.config);
    const parsed = parseImplementerConfig(implBinaryName);

    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-synth`;

    // Build prompt
    const synthVars: SynthesizerPromptVars = {
      specPath: this.pathsImpl.runSpec(runId),
      iteration: String(iteration),
      reviewsDir: this.pathsImpl.loopReviewsPath(runId, iteration),
      verdictsDir: this.pathsImpl.loopVerdictsPath(runId, iteration),
      previousSummaryPath: previousSummaryPath ?? '',
      summaryOutputPath: `${this.pathsImpl.loopSynthesisPath(runId, iteration)}/review-summary.md`,
      learningsFile: this.pathsImpl.runLearnings(runId),
      evidenceDir: this.pathsImpl.loopEvidencePath(runId, iteration),
    };

    const prompt = buildSynthesizerPrompt(this.config.prompts?.synthesizer, synthVars);

    // Ensure synthesis directory
    const synthDir = this.pathsImpl.loopSynthesisPath(runId, iteration);
    const logFile = await this.ensureAgentDir(synthDir);

    // Interactive mode: append the completion-sentinel instruction.
    const interactive = this.isInteractive(parsed.harness);
    const sentinelFile = interactive ? path.join(synthDir, SENTINEL_NAME) : undefined;
    const finalPrompt = sentinelFile ? prompt + buildSentinelInstruction(sentinelFile) : prompt;
    await fs.writeFile(path.join(synthDir, 'prompt.md'), finalPrompt, 'utf-8');

    const promptFile = await this.writePromptFile(sessionId, finalPrompt);

    // Clean slate: remove any pre-existing summary so a stale file (from a re-entered run) can't
    // be misread as this run's output — required for the interactive sentinel-independent fallback.
    const summaryPath = path.join(synthDir, 'review-summary.md');
    await fs.rm(summaryPath, { force: true });

    const command = buildAgentCommand({
      binary: parsed.binary,
      harness: parsed.harness,
      promptFile,
      sessionId,
      logFile,
    });

    formatAgentLaunch('synthesizer', 'synthesizer', parsed.binary, tmuxSession, logFile);

    const result = await this.launch({
      interactive,
      sentinelFile,
      tmuxSession,
      binary: parsed.binary,
      promptFile,
      sessionId,
      logFile,
      outputFile: summaryPath,
      timeout,
      command,
    });

    await this.cleanupPromptFile(promptFile);

    // Check if review-summary.md was created
    const summaryExists = await this.safeFileExists(summaryPath);

    const tokens = await extractTokensFromLog(logFile);
    const harnessSessionId = await extractHarnessSessionId(logFile);

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      binary: parsed.binary,
      harness: parsed.harness,
      summaryPath: summaryExists ? summaryPath : undefined,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      harnessSessionId,
    };
  }

  /**
   * Run re-synthesizer: merge previous synthesis + verifier outputs into updated summary.
   * Used when verify gate fails — lighter than full synthesis.
   */
  async runReSynthesizer(params: {
    runId: string;
    iteration: number;
    dirHash: string;
    binary?: string;
    previousSummaryPath: string;
    timeout: number;
  }): Promise<SynthesizerResult> {
    const { runId, iteration, dirHash, binary: overrideBinary, previousSummaryPath, timeout } = params;

    const implBinaryName =
      overrideBinary ??
      selectRoleAccount(this.config.synthesizer, this.config.poolProfiles) ??
      getPrimaryImplementer(this.config);
    const parsed = parseImplementerConfig(implBinaryName);

    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-versynth`;

    const reSynthVars: ReSynthesisPromptVars = {
      specPath: this.pathsImpl.runSpec(runId),
      iteration: String(iteration),
      previousSummaryPath,
      verifyDir: this.pathsImpl.loopVerifyPath(runId, iteration),
      verdictsDir: this.pathsImpl.loopVerdictsPath(runId, iteration),
      summaryOutputPath: `${this.pathsImpl.loopSynthesisPath(runId, iteration)}/review-summary.md`,
      learningsFile: this.pathsImpl.runLearnings(runId),
    };

    const prompt = buildReSynthesisPrompt(this.config.prompts?.reSynthesizer, reSynthVars);

    const synthDir = this.pathsImpl.loopSynthesisPath(runId, iteration);
    const logFile = await this.ensureAgentDir(synthDir);

    // Interactive mode: append the completion-sentinel instruction.
    const interactive = this.isInteractive(parsed.harness);
    const sentinelFile = interactive ? path.join(synthDir, SENTINEL_NAME) : undefined;
    const finalPrompt = sentinelFile ? prompt + buildSentinelInstruction(sentinelFile) : prompt;
    await fs.writeFile(path.join(synthDir, 'prompt.md'), finalPrompt, 'utf-8');

    const promptFile = await this.writePromptFile(sessionId, finalPrompt);

    // Clean slate: remove any pre-existing summary so a stale file (from a re-entered run) can't
    // be misread as this run's output — required for the interactive sentinel-independent fallback.
    // (previousSummaryPath comes from a prior loop's dir, so this never deletes the input.)
    const summaryPath = path.join(synthDir, 'review-summary.md');
    await fs.rm(summaryPath, { force: true });

    const command = buildAgentCommand({
      binary: parsed.binary,
      harness: parsed.harness,
      promptFile,
      sessionId,
      logFile,
    });

    formatAgentLaunch('resynthesizer', 'resynthesizer', parsed.binary, tmuxSession, logFile);

    const result = await this.launch({
      interactive,
      sentinelFile,
      tmuxSession,
      binary: parsed.binary,
      promptFile,
      sessionId,
      logFile,
      outputFile: summaryPath,
      timeout,
      command,
    });

    await this.cleanupPromptFile(promptFile);

    const summaryExists = await this.safeFileExists(summaryPath);

    const tokens = await extractTokensFromLog(logFile);
    const harnessSessionId = await extractHarnessSessionId(logFile);

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      binary: parsed.binary,
      harness: parsed.harness,
      summaryPath: summaryExists ? summaryPath : undefined,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      harnessSessionId,
    };
  }

  /**
   * Run verify phases (cheap/fast models validate previous issues were fixed).
   * Short-circuits on rejection.
   */
  async runVerifierPhase(params: {
    runId: string;
    iteration: number;
    dirHash: string;
    phaseIndex: number;
    reviewers: ReviewerBinary[];
    prompts: Array<{ reviewerIndex: number; prompt: string }>;
    timeout: number;
    onReviewerEnd?: (result: VerifierResult) => Promise<void>;
  }): Promise<VerifierResult[]> {
    const { runId, iteration, dirHash, phaseIndex, reviewers, prompts, timeout, onReviewerEnd } = params;

    console.log(`  verify phase ${phaseIndex} — ${reviewers.map(r => r.binary).join(', ')}`);

    const results = await Promise.all(
      prompts.map(async (p, ordinal) => {
        const reviewer = reviewers[ordinal] ?? reviewers[0];
        const result = await this.runVerifier({
          runId,
          iteration,
          dirHash,
          reviewerIndex: p.reviewerIndex,
          binary: reviewer.binary,
          harness: reviewer.harness,
          prompt: p.prompt,
          timeout,
          phaseIndex,
          ordinal: ordinal + 1,
        });
        if (onReviewerEnd) {
          await onReviewerEnd(result);
        }
        return result;
      }),
    );

    const approved = results.filter(r => r.verdict === 'approved').length;
    const rejected = results.filter(r => r.verdict === 'rejected').length;
    console.log(`Verify phase ${phaseIndex} verdicts: ${approved} approved, ${rejected} rejected`);

    return results;
  }

  /**
   * Run a single verifier agent.
   */
  private async runVerifier(params: {
    runId: string;
    iteration: number;
    dirHash: string;
    reviewerIndex: number;
    binary: string;
    harness: HarnessType;
    prompt: string;
    timeout: number;
    phaseIndex?: number;
    ordinal?: number;
  }): Promise<VerifierResult> {
    const { runId, iteration, dirHash, reviewerIndex, binary, harness, prompt, timeout, phaseIndex, ordinal } = params;

    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-verify-${reviewerIndex}`;

    // Verifier writes to verify/ directory
    const verifyDir = paths.loopVerifyPath(runId, iteration);
    const reviewerDir = path.join(verifyDir, `verifier-${reviewerIndex}`);
    const logFile = await this.ensureAgentDir(reviewerDir);

    // Interactive mode: append the completion-sentinel instruction.
    const interactive = this.isInteractive(harness);
    const sentinelFile = interactive ? path.join(reviewerDir, SENTINEL_NAME) : undefined;
    const finalPrompt = sentinelFile ? prompt + buildSentinelInstruction(sentinelFile) : prompt;

    // Write prompt to temp file + human-readable prompt.md
    const promptFile = await this.writePromptFile(sessionId, finalPrompt);
    await fs.writeFile(path.join(reviewerDir, 'prompt.md'), finalPrompt, 'utf-8');
    // Ensure the verdicts dir exists — the verifier writes its verdict JSON there directly
    const verdictsDir = paths.loopVerdictsPath(runId, iteration);
    await fs.mkdir(verdictsDir, { recursive: true });

    // Clean slate: remove any pre-existing verdict at the target path so a stale file
    // (from a re-entered run) can never be misread as this verifier's output.
    const verdictPath = path.join(verdictsDir, `verifier-${reviewerIndex}.json`);
    await fs.rm(verdictPath, { force: true });

    const command = buildAgentCommand({
      binary,
      harness,
      promptFile,
      sessionId,
      logFile,
    });

    formatAgentLaunch('verifier', `verify-${reviewerIndex}`, binary, tmuxSession, logFile);

    const result = await this.launch({
      interactive,
      sentinelFile,
      tmuxSession,
      binary,
      promptFile,
      sessionId,
      logFile,
      outputFile: verdictPath,
      timeout,
      command,
    });

    // Read verdict from the verify verdicts dir
    const verdictContent = await this.safeReadFile(verdictPath);

    let error: string | undefined;
    let verdict: Verdict = 'rejected';
    let reasoning = '';
    let issuesFixed: string[] | undefined;
    let issuesRemaining: string[] | undefined;

    if (verdictContent) {
      const parsed = verdicts.parseVerdictFile(verdictContent);
      if (parsed.verdict) {
        verdict = parsed.verdict;
      }
      reasoning = parsed.reasoning;
      issuesFixed = parsed.issuesFixed;
      issuesRemaining = parsed.issuesRemaining;
    } else if (result.timedOut || result.exitCode !== 0) {
      error = result.timedOut ? 'timeout' : `exit_code_${result.exitCode}`;
    }

    await this.cleanupPromptFile(promptFile);

    const tokens = await extractTokensFromLog(logFile);
    const harnessSessionId = await extractHarnessSessionId(logFile);

    const icon = verdict === 'approved' ? '\u2713' : '\u2717';
    console.log(
      `  ${icon} Verifier ${reviewerIndex} (${binary})${phaseIndex !== undefined ? ` (phase ${phaseIndex})` : ''}: ${verdict}`,
    );

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      reviewerIndex,
      binary,
      harness,
      verdict,
      reasoning,
      phaseIndex,
      ordinal,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      error,
      issuesFixed,
      issuesRemaining,
      harnessSessionId,
    };
  }

  /**
   * Get the verify phases from config.
   */
  getVerifyPhases(): ReviewTypeEntry[][] {
    return this.config.verifyPhases ?? [];
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

  private async safeFileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Copy review files to their proper directories (reviews/ and verdicts/)
   */
}
