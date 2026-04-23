import * as fs from 'fs/promises';
import * as path from 'path';
import type { Config, Verdict, HarnessType } from '../types';
import { getPrimaryImplementer, selectImplementer } from '../types';
import type { TmuxService, StateService } from '../deps';
import { generateId, paths, getKloopHome } from '../deps';
import * as verdicts from './verdicts';
import {
  buildCheckpointerPrompt,
  buildSynthesizerPrompt,
  buildVerifierPrompt,
  buildReSynthesisPrompt,
} from './prompts';
import type {
  CheckpointerPromptVars,
  SynthesizerPromptVars,
  VerifierPromptVars,
  ReSynthesisPromptVars,
} from './prompts';
import { extractTokensFromLog, extractHarnessSessionId } from '../stream/parse';
import { formatAgentLaunch } from '../loop/format';
import type { ParsedBinary, ReviewerBinary } from '../types';
import { parseImplementerConfig, parseReviewerConfig, parseConflictCheckerConfig } from '../types';

// Path to kloop binary — use process.argv[1] (the running script) instead of
// import.meta.dir so it survives nix store path changes after rebuilds.
const KLOOP_BIN = `bun run ${process.argv[1]}`;

// ============================================================================
// Scratch Artifact Protocol types
// ============================================================================

export interface ScratchMeta {
  artifact: string;
  role: string;
  index?: number;
  runId: string;
  loop: number;
  phase?: number;
  timestamp: string;
}

export interface PromotionResult {
  promoted: number;
  skipped: number;
  errors: number;
}

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
 * Gemini: gemini-auto --yolo --output-format stream-json -p "$(cat "${promptFile}")" 2>&1 | tee "${logFile}" | kloop stream
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
    // -c sandbox_workspace_write.network_access=true: keep workspace-write FS
    // sandbox but allow network so installs (bun/npm/pip/etc.) work
    return `cat "${promptFile}" | ${binary} exec --full-auto --json --ephemeral --skip-git-repo-check -c sandbox_workspace_write.network_access=true 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;
  } else {
    // Gemini: no session ID injection, pipe prompt via stdin (avoids shell arg length limits)
    return `cat "${promptFile}" | ${binary} --yolo --output-format stream-json -p "" 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;
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
    // Flatten reviewer binaries from all phases (keep raw strings for now, parse when running)
    this.reviewerBinaries = config.reviewPhases.flat();
    // Parse checkpointer binary and harness
    const checkpointerConfig = parseConflictCheckerConfig(config.conflictChecker ?? getPrimaryImplementer(config));
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
    const implementerBinaryName = this.selectImplementer(iteration);
    const parsedImpl = parseImplementerConfig(implementerBinaryName);

    // Notify caller of selected binary before launch
    if (onStart) await onStart(parsedImpl.binary);

    // Runtime session identifiers
    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-impl`;

    // Write prompt to temp file
    const promptFile = await this.writePromptFile(sessionId, prompt);

    // Ensure implementer directory and write prompt.md
    const implDir = paths.loopImplementerPath(runId, iteration);
    const logFile = await this.ensureAgentDir(implDir);
    await fs.writeFile(path.join(implDir, 'prompt.md'), prompt, 'utf-8');

    // Build harness-aware command
    const command = buildAgentCommand({
      binary: parsedImpl.binary,
      harness: parsedImpl.harness,
      promptFile,
      sessionId,
      logFile,
    });

    // Run in tmux
    formatAgentLaunch('impl', 'implementer', parsedImpl.binary, tmuxSession, logFile);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    // Clean up prompt file
    await this.cleanupPromptFile(promptFile);

    // Promote any scratch files from the implementer (learnings, evidence)
    const scratchDir = path.join(process.cwd(), '.kloop', 'scratch');
    await this.promoteScratchFiles({ scratchDir });

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

    // Runtime session identifiers
    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-rev-${reviewerIndex}`;

    // Write prompt to temp file
    const promptFile = await this.writePromptFile(sessionId, prompt);

    // Ensure reviewer directory under reviews/ and write prompt.md
    const reviewsDir = paths.loopReviewsPath(runId, iteration);
    const reviewerDir = path.join(reviewsDir, `reviewer-${reviewerIndex}`);
    const logFile = await this.ensureAgentDir(reviewerDir);
    await fs.writeFile(path.join(reviewerDir, 'prompt.md'), prompt, 'utf-8');

    // Build harness-aware command
    const command = buildAgentCommand({
      binary,
      harness,
      promptFile,
      sessionId,
      logFile,
    });

    // Run in tmux
    formatAgentLaunch('reviewer', `rev-${reviewerIndex}`, binary, tmuxSession, logFile);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    // Promote any scratch files from this reviewer (verdict, review)
    const scratchDir = path.join(process.cwd(), '.kloop', 'scratch');
    await this.promoteScratchFiles({ scratchDir });

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

    // Copy review files to persistent storage
    await this.copyReviewFiles(runId, iteration, reviewerIndex, reviewContent, verdictContent);

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
      scratchDir: paths.scratchDir(process.cwd()),
    };

    const prompt = buildCheckpointerPrompt(
      this.config.prompts?.checkpointer,
      this.config.prompts?.checkpointerFull,
      checkpointerVars,
      this.config.compressSpec,
    );

    // Write prompt to temp file
    const promptFile = await this.writePromptFile(sessionId, prompt);

    // Ensure checkpointer directory and write prompt.md
    const checkpointerDir = paths.loopCheckpointerPath(runId, iteration);
    const logFile = await this.ensureAgentDir(checkpointerDir);
    await fs.writeFile(path.join(checkpointerDir, 'prompt.md'), prompt, 'utf-8');

    // Build harness-aware command
    const command = buildAgentCommand({
      binary,
      harness,
      promptFile,
      sessionId,
      logFile,
    });

    // Run in tmux
    formatAgentLaunch('checkpoint', 'checkpoint', binary, tmuxSession, logFile);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    // Promote any scratch files from the checkpointer (checkpoint-result, conflict)
    const scratchDir = path.join(process.cwd(), '.kloop', 'scratch');
    await this.promoteScratchFiles({ scratchDir });

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
    const implBinaryName = overrideBinary ?? this.config.synthesizer ?? getPrimaryImplementer(this.config);
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
      summaryOutputPath: this.pathsImpl.loopSynthesisPath(runId, iteration),
      learningsFile: this.pathsImpl.runLearnings(runId),
      evidenceDir: this.pathsImpl.loopEvidencePath(runId, iteration),
      scratchDir: paths.scratchDir(process.cwd()),
    };

    const prompt = buildSynthesizerPrompt(this.config.prompts?.synthesizer, synthVars);

    // Ensure synthesis directory
    const synthDir = this.pathsImpl.loopSynthesisPath(runId, iteration);
    const logFile = await this.ensureAgentDir(synthDir);
    await fs.writeFile(path.join(synthDir, 'prompt.md'), prompt, 'utf-8');

    const promptFile = await this.writePromptFile(sessionId, prompt);

    const command = buildAgentCommand({
      binary: parsed.binary,
      harness: parsed.harness,
      promptFile,
      sessionId,
      logFile,
    });

    formatAgentLaunch('synthesizer', 'synthesizer', parsed.binary, tmuxSession, logFile);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    await this.cleanupPromptFile(promptFile);

    // Promote any scratch files from the synthesizer (review-summary)
    const scratchDir = path.join(process.cwd(), '.kloop', 'scratch');
    await this.promoteScratchFiles({ scratchDir });

    // Check if review-summary.md was created
    const summaryPath = path.join(synthDir, 'review-summary.md');
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

    const implBinaryName = overrideBinary ?? this.config.synthesizer ?? getPrimaryImplementer(this.config);
    const parsed = parseImplementerConfig(implBinaryName);

    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-versynth`;

    const reSynthVars: ReSynthesisPromptVars = {
      specPath: this.pathsImpl.runSpec(runId),
      iteration: String(iteration),
      previousSummaryPath,
      verifyDir: this.pathsImpl.loopVerifyPath(runId, iteration),
      verdictsDir: this.pathsImpl.loopVerdictsPath(runId, iteration),
      summaryOutputPath: this.pathsImpl.loopSynthesisPath(runId, iteration),
      learningsFile: this.pathsImpl.runLearnings(runId),
      scratchDir: paths.scratchDir(process.cwd()),
    };

    const prompt = buildReSynthesisPrompt(this.config.prompts?.reSynthesizer, reSynthVars);

    const synthDir = this.pathsImpl.loopSynthesisPath(runId, iteration);
    const logFile = await this.ensureAgentDir(synthDir);
    await fs.writeFile(path.join(synthDir, 'prompt.md'), prompt, 'utf-8');

    const promptFile = await this.writePromptFile(sessionId, prompt);

    const command = buildAgentCommand({
      binary: parsed.binary,
      harness: parsed.harness,
      promptFile,
      sessionId,
      logFile,
    });

    formatAgentLaunch('resynthesizer', 'resynthesizer', parsed.binary, tmuxSession, logFile);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    await this.cleanupPromptFile(promptFile);

    // Promote any scratch files from the re-synthesizer (review-summary)
    const reSynthScratchDir = path.join(process.cwd(), '.kloop', 'scratch');
    await this.promoteScratchFiles({ scratchDir: reSynthScratchDir });

    const summaryPath = path.join(synthDir, 'review-summary.md');
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

    // Write prompt to temp file
    const promptFile = await this.writePromptFile(sessionId, prompt);

    // Verifier writes to verify/ directory
    const verifyDir = paths.loopVerifyPath(runId, iteration);
    const reviewerDir = path.join(verifyDir, `verifier-${reviewerIndex}`);
    const logFile = await this.ensureAgentDir(reviewerDir);
    await fs.writeFile(path.join(reviewerDir, 'prompt.md'), prompt, 'utf-8');

    const command = buildAgentCommand({
      binary,
      harness,
      promptFile,
      sessionId,
      logFile,
    });

    formatAgentLaunch('verifier', `verify-${reviewerIndex}`, binary, tmuxSession, logFile);

    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });

    // Promote any scratch files from the verifier (verdict)
    const scratchDir = path.join(process.cwd(), '.kloop', 'scratch');
    await this.promoteScratchFiles({ scratchDir });

    // Read verdict from the verify verdicts dir
    const verdictsDir = paths.loopVerdictsPath(runId, iteration);
    const verdictContent = await this.safeReadFile(path.join(verdictsDir, `verifier-${reviewerIndex}.json`));

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
  getVerifyPhases(): string[][] {
    return this.config.verifyPhases ?? [];
  }

  // -----------------------------------------------------------------------
  // Scratch Artifact Protocol
  // -----------------------------------------------------------------------

  /**
   * Promote scratch files from .kloop/scratch/ to their correct global paths.
   * Only promotes files that have a valid .meta companion (signals completion).
   */
  async promoteScratchFiles(params: { scratchDir: string }): Promise<PromotionResult> {
    const { scratchDir } = params;
    let promoted = 0,
      skipped = 0,
      errors = 0;

    // 1. List all .meta files in scratch dir
    const entries = await fs.readdir(scratchDir).catch(() => [] as string[]);
    const metaFiles = entries.filter(e => e.endsWith('.meta'));

    for (const metaFile of metaFiles) {
      const metaPath = path.join(scratchDir, metaFile);
      const contentFile = metaPath.replace(/\.meta$/, '');

      // 2. Read and validate metadata
      const metaContent = await this.safeReadFile(metaPath);
      if (!metaContent) {
        skipped++;
        continue;
      }

      let meta: ScratchMeta;
      try {
        meta = JSON.parse(metaContent);
      } catch {
        errors++;
        continue;
      }

      // 3. Check content file exists (incomplete writes have no content yet)
      const contentExists = await this.safeFileExists(contentFile);
      if (!contentExists) {
        skipped++;
        continue;
      }

      // 4. Resolve destination path from metadata + content filename
      const contentBasename = path.basename(contentFile);
      const destPath = this.resolveScratchDestination(meta, contentBasename);
      if (!destPath) {
        errors++;
        continue;
      }

      // 5. Ensure destination directory exists and copy
      try {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(contentFile, destPath);
        promoted++;
      } catch (err) {
        errors++;
        console.log(`Warning: failed to promote scratch file ${contentFile}: ${err}`);
      }
    }

    if (promoted > 0 || errors > 0) {
      console.log(`  scratch: promoted ${promoted}, skipped ${skipped}, errors ${errors}`);
    }

    return { promoted, skipped, errors };
  }

  /**
   * Resolve the destination path for a scratch file based on its metadata and filename.
   */
  private resolveScratchDestination(meta: ScratchMeta, contentBasename: string): string | null {
    const { artifact, role, index, runId, loop } = meta;
    const home = getKloopHome();

    if (artifact === 'verdict' && role === 'reviewer') {
      return path.join(home, runId, `loop-${loop}`, 'verdicts', `reviewer-${index ?? 0}.json`);
    }
    if (artifact === 'verdict' && role === 'verifier') {
      return path.join(home, runId, `loop-${loop}`, 'verdicts', `verifier-${index ?? 0}.json`);
    }
    if (artifact === 'review' && role === 'reviewer') {
      return path.join(home, runId, `loop-${loop}`, 'reviews', `reviewer-${index ?? 0}.md`);
    }
    if (artifact === 'evidence' && role === 'implementer') {
      // Derive qualifier from content filename: evidence-self-review.md -> self-review.md
      const qualifier = contentBasename.replace(/^evidence-/, '');
      return path.join(home, runId, `loop-${loop}`, 'evidence', qualifier);
    }
    if (artifact === 'learnings' && role === 'implementer') {
      return path.join(home, runId, 'learnings.md');
    }
    if (artifact === 'synthesis' && role === 'synthesizer') {
      return path.join(home, runId, `loop-${loop}`, 'synthesis', 'review-summary.md');
    }
    if (artifact === 'checkpoint' && role === 'checkpointer') {
      return path.join(home, runId, `loop-${loop}`, 'checkpointer', 'checkpoint-result.json');
    }
    if (artifact === 'conflict' && role === 'checkpointer') {
      return path.join(home, runId, 'conflict.md');
    }

    return null;
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
