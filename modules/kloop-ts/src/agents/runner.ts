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
import { extractTokensFromLog, extractHarnessSessionId, extractModelFromLog } from '../stream/parse';
import { formatAgentLaunch } from '../loop/format';
import type { ParsedBinary, ReviewerBinary, ReviewTypeEntry } from '../types';
import {
  parseImplementerConfig,
  parseReviewerConfig,
  parseConflictCheckerConfig,
  selectFromPool,
  reviewTypeLabel,
  implementerCandidates,
} from '../types';
import { UsageGate } from '../usage/gate';

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
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
  inputTokens?: number;
  outputTokens?: number;
  harnessSessionId?: string;
}

export interface ReviewerResult extends AgentResult {
  reviewerIndex: number;
  binary: string;
  harness: HarnessType;
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
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
  retryAttempt?: number; // 0-indexed attempt that produced this result (0 = first try)
  retryMax?: number; // configured retry budget
}

type CheckpointerOutcome = 'conflict_found' | 'spec_auto_fixed' | 'spec_compressed' | 'no_action';

interface CheckpointerResult extends AgentResult {
  binary: string;
  harness: HarnessType;
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
  outcome: CheckpointerOutcome;
  summary: string;
  progressPercent?: number;
  completedCriteria?: string[];
  remainingCriteria?: string[];
  harnessSessionId?: string;
  retryAttempt?: number; // 0-indexed attempt that produced this result (0 = first try)
  retryMax?: number; // configured retry budget
}

export interface SynthesizerResult extends AgentResult {
  binary: string;
  harness: HarnessType;
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
  summaryPath?: string;
  inputTokens?: number;
  outputTokens?: number;
  harnessSessionId?: string;
  retryAttempt?: number; // 0-indexed attempt that produced this result (0 = first try)
  retryMax?: number; // configured retry budget
}

export interface VerifierResult extends AgentResult {
  reviewerIndex: number;
  binary: string;
  harness: HarnessType;
  model?: string; // harness-reported model actually used (e.g. claude-opus-4-8)
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
  retryAttempt?: number; // 0-indexed attempt that produced this result (0 = first try)
  retryMax?: number; // configured retry budget
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

/**
 * True when `content` is a checkpoint-result file with a recognized outcome — i.e. the
 * checkpointer produced a real result. Used to decide whether to retry: a missing or
 * unparseable file (transport failure / crash) is retried; a real result never is.
 */
function isParseableCheckpointResult(content: string | null): boolean {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content);
    return (
      parsed?.outcome === 'conflict_found' ||
      parsed?.outcome === 'spec_auto_fixed' ||
      parsed?.outcome === 'spec_compressed' ||
      parsed?.outcome === 'no_action'
    );
  } catch {
    return false;
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
  /** Usage-aware account selection (no-op unless config.requireUsageLeft). Shared with
   *  LoopRunner so reviewer/synth/checkpoint pools filter against the same snapshot. */
  readonly gate: UsageGate;

  constructor(
    private tmux: TmuxService,
    private state: StateService,
    private config: Config,
    pathsOverride?: typeof paths,
    gate?: UsageGate,
  ) {
    this.pathsImpl = pathsOverride ?? paths;
    this.gate = gate ?? UsageGate.fromConfig(config);
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
    return selectImplementer(this.config, loopNum, this.gate.weight);
  }

  /**
   * Re-pick an account from a pool entry for a retry (plain weighted-random, may repeat).
   * For a single-account entry this returns that same account. Returns the resolved binary
   * and its harness so a rerolled account with a different harness is launched correctly.
   * Returns null when no pool entry is available (caller keeps the current account).
   */
  private rerollAccount(entry: ReviewTypeEntry | undefined): { binary: string; harness: HarnessType } | null {
    if (entry == null) return null;
    const parsed = parseReviewerConfig(selectFromPool(entry, this.config.poolProfiles, this.gate.weight));
    return { binary: parsed.binary, harness: parsed.harness };
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

  /** A binary kteamd can manage: a kfleet auto wrapper (claude-auto-… or codex-auto-…). */
  private kteamEligible(binary: string): boolean {
    return this.config.agentBackend === 'kteam' && /^(claude|codex)-auto-/.test(path.basename(binary));
  }

  /**
   * Dispatch one agent through a detached kteam session and block until it
   * reaches a terminal state. kteamd owns the TUI (auth/quota preflight,
   * startup dialogs, prompt-landing verification, stall + login-wall
   * fail-fast); kloop keeps its own contract: the agent still writes kloop's
   * output/sentinel files, and the harness transcript is mirrored to logFile.
   */
  private async launchViaKteam(p: {
    binary: string;
    promptFile: string;
    logFile: string;
    timeout: number;
    tmuxSession: string;
    outputFile?: string;
  }): Promise<{ exitCode: number; durationMs: number; timedOut: boolean }> {
    const startTime = Date.now();
    const prompt = await fs.readFile(p.promptFile, 'utf-8');
    const { CLAUDECODE: _, ...env } = process.env;
    const kteam = async (args: string[], timeoutMs: number) => {
      const proc = Bun.spawn(['kteam', ...args], { stdout: 'pipe', stderr: 'pipe', env });
      const killer = setTimeout(() => proc.kill(), timeoutMs);
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      clearTimeout(killer);
      return { exitCode, stdout, stderr };
    };
    const started = await kteam(
      [
        'start',
        '--json',
        '-a',
        p.binary,
        '--name',
        p.tmuxSession.slice(0, 48),
        '--cwd',
        process.cwd(),
        '--timeout',
        String(Math.max(60, Math.round(p.timeout * 60))),
        prompt,
      ],
      180_000,
    );
    if (started.exitCode !== 0) {
      throw new Error(`kteam start failed for ${p.binary}: ${(started.stderr || started.stdout).trim()}`);
    }
    const view = JSON.parse(started.stdout) as { config: { id: string } };
    const id = view.config.id;
    const deadlineMs = startTime + p.timeout * 60_000 + 120_000;
    let status = 'running';
    while (Date.now() < deadlineMs) {
      const waited = await kteam(['wait', id, '--json', '--timeout', '60'], 90_000);
      const state = (() => {
        try {
          return JSON.parse(waited.stdout.trim().split('\n').at(-1) ?? '{}') as { status?: string };
        } catch {
          return {};
        }
      })();
      status = state.status ?? status;
      // Mirror the durable chat log so kloop's log tooling (tokens, model,
      // harness session id, `kloop view`) keeps working under kteam.
      const chat = await kteam(['logs', id], 30_000);
      if (chat.exitCode === 0 && chat.stdout) await fs.writeFile(p.logFile, chat.stdout, 'utf-8').catch(() => {});
      if (waited.exitCode !== 124 && status !== 'running' && status !== 'starting') break;
    }
    const durationMs = Date.now() - startTime;
    if (status === 'completed') return { exitCode: 0, durationMs, timedOut: false };
    // An output file on disk trumps the session verdict (mirrors the sentinel
    // fallback on the tmux path): the work happened even if the wrap-up died.
    if (p.outputFile && (await this.safeFileExists(p.outputFile))) return { exitCode: 0, durationMs, timedOut: false };
    if (status === 'stopped' || Date.now() >= deadlineMs) return { exitCode: 124, durationMs, timedOut: true };
    return { exitCode: 1, durationMs, timedOut: false };
  }

  /**
   * Dispatch a single agent — via kteam (default: kteamd-managed detached session),
   * interactive tmux (TUI + sentinel), or print (one-shot pipeline). The print
   * `command` is always passed and used only on the non-interactive tmux path.
   * Centralizes the branch so every role behaves identically.
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
    if (this.kteamEligible(p.binary)) {
      return this.launchViaKteam({
        binary: p.binary,
        promptFile: p.promptFile,
        logFile: p.logFile,
        timeout: p.timeout,
        tmuxSession: p.tmuxSession,
        outputFile: p.outputFile,
      });
    }
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

    // Usage-aware selection: refresh the snapshot and, if every candidate implementer
    // account is at its usage limit, block until one resets (no-op unless enabled).
    await this.gate.awaitCapacity(implementerCandidates(this.config));

    // Select an implementer binary fresh for each run (weighted random, usage-filtered)
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

    // Extract token counts, harness session ID, and model from log file
    const tokens = await extractTokensFromLog(logFile);
    const harnessSessionId =
      (await extractHarnessSessionId(logFile)) ?? (parsedImpl.harness === 'claude' ? sessionId : undefined);
    const model = await extractModelFromLog(logFile);

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      learnings,
      binary: parsedImpl.binary,
      harness: parsedImpl.harness,
      model,
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
    reviewers: Array<ReviewerBinary & { pool?: ReviewTypeEntry }>;
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
          pool: reviewer.pool,
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
    // Legacy flat path (no lens matrix): one account per type, pool-selected. Carry the
    // type entry so a retry can re-roll a different account from the same pool.
    const allReviewers = this.config.reviewPhases
      .flat()
      .map(e => ({ ...parseReviewerConfig(selectFromPool(e, this.config.poolProfiles, this.gate.weight)), pool: e }));
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
    pool?: ReviewTypeEntry; // when set, retries re-roll a (possibly different) account from this pool
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
      pool,
    } = params;

    // Stable paths across retries
    const reviewsDir = paths.loopReviewsPath(runId, iteration);
    const reviewerDir = path.join(reviewsDir, `reviewer-${reviewerIndex}`);
    await fs.mkdir(reviewerDir, { recursive: true });

    const verdictsDir = paths.loopVerdictsPath(runId, iteration);
    await fs.mkdir(verdictsDir, { recursive: true });
    const verdictFilePath = path.join(verdictsDir, `reviewer-${reviewerIndex}.json`);
    const reviewFilePath = path.join(reviewsDir, `reviewer-${reviewerIndex}.md`);

    // Retry policy — ONLY retries when no parseable verdict is produced (transport
    // failure, crash, timeout). A real approve/reject verdict is never retried.
    const maxRetries = this.config.reviewerRetry?.maxRetries ?? 2;
    const backoffBaseMs = this.config.reviewerRetry?.backoffBaseMs ?? 5000;

    // Account in use — may change between attempts when a pool re-roll lands elsewhere.
    let curBinary = binary;
    let curHarness = harness;
    let sessionId = '';
    let tmuxSession = '';
    let logFile = '';
    let promptFile = '';
    let attemptUsed = 0;
    let result: { exitCode: number; durationMs: number; timedOut: boolean } = {
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
    };
    let verdictContent: string | null = null;
    let reviewContent: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attemptUsed = attempt;
      // Per-attempt setup keyed off the CURRENT account: a re-rolled account can use a
      // different harness, which changes interactive mode + the sentinel instruction.
      const interactive = this.isInteractive(curHarness);
      const sentinelFile = interactive ? path.join(reviewerDir, SENTINEL_NAME) : undefined;
      const launchPrompt = sentinelFile ? prompt + buildSentinelInstruction(sentinelFile) : prompt;
      await fs.writeFile(path.join(reviewerDir, 'prompt.md'), launchPrompt, 'utf-8');

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
        binary: curBinary,
        harness: curHarness,
        promptFile,
        sessionId,
        logFile,
      });

      // Run in tmux (interactive TUI or print pipeline)
      formatAgentLaunch('reviewer', `rev-${reviewerIndex}`, curBinary, tmuxSession, logFile);

      result = await this.launch({
        interactive,
        sentinelFile,
        tmuxSession,
        binary: curBinary,
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
      // Re-roll the account for the next attempt (plain weighted; a single-account pool
      // or no pool keeps the same account).
      const next = this.rerollAccount(pool);
      if (next) {
        curBinary = next.binary;
        curHarness = next.harness;
      }
      console.log(
        `  ↻ reviewer ${reviewerIndex} (${curBinary})${phaseIndex !== undefined ? ` (phase ${phaseIndex})` : ''} ${reason} — retry ${attempt + 1}/${maxRetries} (backoff ${Math.round(backoffMs / 1000)}s)`,
      );
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

    let error: string | undefined;
    const verdict = this.determineReviewerVerdict({
      verdictFileContent: verdictContent,
      reviewFileContent: reviewContent,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      reviewerBinary: curBinary,
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

    // Extract token counts, harness session ID, and model from log file
    const tokens = await extractTokensFromLog(logFile);
    const harnessSessionId =
      (await extractHarnessSessionId(logFile)) ?? (curHarness === 'claude' ? sessionId : undefined);
    const model = await extractModelFromLog(logFile);

    const icon = verdict === 'approved' ? '✓' : '✗';
    console.log(
      `  ${icon} Reviewer ${reviewerIndex} (${curBinary})${phaseIndex !== undefined ? ` (phase ${phaseIndex})` : ''}: ${verdict}${completionEstimate !== undefined ? ` (${completionEstimate}%)` : ''}`,
    );

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      reviewerIndex,
      binary: curBinary,
      harness: curHarness,
      model,
      verdict,
      reasoning,
      completionEstimate,
      phaseIndex,
      ordinal,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      error,
      harnessSessionId,
      retryAttempt: attemptUsed,
      retryMax: maxRetries,
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
    binary?: string;
  }): Promise<CheckpointerResult> {
    const { runId, iteration, dirHash, specPath, timeout } = params;

    // Build checkpointer prompt via template substitution (stable across retries)
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
    await fs.mkdir(checkpointerDir, { recursive: true });

    const checkpointResultPath = `${checkpointerDir}/checkpoint-result.json`;

    // Retry policy — ONLY retries when no parseable result JSON is produced (transport
    // failure, crash, timeout). A real outcome is never retried.
    const maxRetries = this.config.checkpointerRetry?.maxRetries ?? 2;
    const backoffBaseMs = this.config.checkpointerRetry?.backoffBaseMs ?? 5000;

    // Account in use — may change between attempts when a pool re-roll lands elsewhere.
    const initial = params.binary ? parseConflictCheckerConfig(params.binary) : undefined;
    let curBinary = initial?.binary ?? this.checkpointerBinary;
    let curHarness = initial?.harness ?? this.checkpointerHarness;
    let sessionId = '';
    let tmuxSession = '';
    let logFile = '';
    let promptFile = '';
    let attemptUsed = 0;
    let result: { exitCode: number; durationMs: number; timedOut: boolean } = {
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
    };
    let checkpointResultContent: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attemptUsed = attempt;
      // Per-attempt setup keyed off the CURRENT account: a re-rolled account can use a
      // different harness, which changes interactive mode + the sentinel instruction.
      const interactive = this.isInteractive(curHarness);
      const sentinelFile = interactive ? path.join(checkpointerDir, SENTINEL_NAME) : undefined;
      const finalPrompt = sentinelFile ? prompt + buildSentinelInstruction(sentinelFile) : prompt;
      await fs.writeFile(path.join(checkpointerDir, 'prompt.md'), finalPrompt, 'utf-8');

      // Clean slate: remove any pre-existing result so a stale file (from a re-entered run
      // or a prior crashed attempt) can't be misread as this attempt's output.
      await fs.rm(checkpointResultPath, { force: true });

      sessionId = generateId();
      tmuxSession = `kloop-${runId}-${iteration}-checkpoint${attempt > 0 ? `-r${attempt}` : ''}`;
      promptFile = await this.writePromptFile(sessionId, finalPrompt);
      logFile = await this.ensureAgentDir(checkpointerDir);

      // Build harness-aware command (used only on the print-mode path)
      const command = buildAgentCommand({
        binary: curBinary,
        harness: curHarness,
        promptFile,
        sessionId,
        logFile,
      });

      // Run in tmux (interactive TUI or print pipeline)
      formatAgentLaunch('checkpoint', 'checkpoint', curBinary, tmuxSession, logFile);

      result = await this.launch({
        interactive,
        sentinelFile,
        tmuxSession,
        binary: curBinary,
        promptFile,
        sessionId,
        logFile,
        outputFile: checkpointResultPath,
        timeout,
        command,
      });

      // Read checkpoint result file from checkpointer directory
      checkpointResultContent = await this.safeReadFile(checkpointResultPath);

      // Did the checkpointer produce a parseable result with a recognized outcome?
      const resultProduced = isParseableCheckpointResult(checkpointResultContent);

      if (resultProduced || attempt >= maxRetries) {
        break;
      }

      // No usable result — almost always a transport failure. Back off and retry.
      await this.cleanupPromptFile(promptFile);
      const backoffMs = backoffBaseMs * Math.pow(2, attempt);
      const reason = result.timedOut
        ? 'timed out'
        : result.exitCode !== 0
          ? `exited ${result.exitCode}`
          : 'produced no result';
      // Re-roll the account for the next attempt (plain weighted; a single-account pool
      // or no pool keeps the same account).
      const next = this.rerollAccount(this.config.conflictChecker);
      if (next) {
        curBinary = next.binary;
        curHarness = next.harness;
      }
      console.log(
        `  ↻ checkpointer (${curBinary}) ${reason} — retry ${attempt + 1}/${maxRetries} (backoff ${Math.round(backoffMs / 1000)}s)`,
      );
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

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

    // Extract harness session ID and model from log file
    const harnessSessionId =
      (await extractHarnessSessionId(logFile)) ?? (curHarness === 'claude' ? sessionId : undefined);
    const model = await extractModelFromLog(logFile);

    // Clean up prompt file
    await this.cleanupPromptFile(promptFile);

    const outcomeDisplay: Record<CheckpointerOutcome, string> = {
      conflict_found: 'CONFLICT DETECTED',
      spec_auto_fixed: 'SPEC AUTO-FIXED',
      spec_compressed: 'SPEC COMPRESSED',
      no_action: 'No action needed',
    };

    console.log(
      `Checkpoint (${curBinary})${model ? ` [${model}]` : ''}: ${outcomeDisplay[outcome]}${progressPercent !== undefined ? ` (${progressPercent}% progress)` : ''}`,
    );
    console.log(`  Summary: ${summary}`);

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      binary: curBinary,
      harness: curHarness,
      model,
      outcome,
      summary,
      progressPercent,
      completedCriteria,
      remainingCriteria,
      harnessSessionId,
      retryAttempt: attemptUsed,
      retryMax: maxRetries,
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

    // Build prompt (stable across retries)
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
    await fs.mkdir(synthDir, { recursive: true });

    const summaryPath = path.join(synthDir, 'review-summary.md');

    // Retry policy — ONLY retries when no summary file is produced (transport failure,
    // crash, timeout). A successfully written summary is never retried.
    const maxRetries = this.config.synthesizerRetry?.maxRetries ?? 2;
    const backoffBaseMs = this.config.synthesizerRetry?.backoffBaseMs ?? 5000;
    // Re-roll source: the synthesizer pool, unless a fixed binary was forced (overrideBinary).
    const rerollEntry = overrideBinary == null ? this.config.synthesizer : undefined;

    // Account in use — may change between attempts when a pool re-roll lands elsewhere.
    let curBinary = parsed.binary;
    let curHarness = parsed.harness;
    let sessionId = '';
    let tmuxSession = '';
    let logFile = '';
    let promptFile = '';
    let attemptUsed = 0;
    let result: { exitCode: number; durationMs: number; timedOut: boolean } = {
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
    };
    let summaryExists = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attemptUsed = attempt;
      // Per-attempt setup keyed off the CURRENT account: a re-rolled account can use a
      // different harness, which changes interactive mode + the sentinel instruction.
      const interactive = this.isInteractive(curHarness);
      const sentinelFile = interactive ? path.join(synthDir, SENTINEL_NAME) : undefined;
      const finalPrompt = sentinelFile ? prompt + buildSentinelInstruction(sentinelFile) : prompt;
      await fs.writeFile(path.join(synthDir, 'prompt.md'), finalPrompt, 'utf-8');

      // Clean slate: remove any pre-existing summary so a stale file (from a re-entered run
      // or a prior crashed attempt) can't be misread as this attempt's output.
      await fs.rm(summaryPath, { force: true });

      // Fresh runtime identifiers per attempt
      sessionId = generateId();
      tmuxSession = `kloop-${runId}-${iteration}-synth${attempt > 0 ? `-r${attempt}` : ''}`;
      promptFile = await this.writePromptFile(sessionId, finalPrompt);
      logFile = await this.ensureAgentDir(synthDir);

      const command = buildAgentCommand({
        binary: curBinary,
        harness: curHarness,
        promptFile,
        sessionId,
        logFile,
      });

      formatAgentLaunch('synthesizer', 'synthesizer', curBinary, tmuxSession, logFile);

      result = await this.launch({
        interactive,
        sentinelFile,
        tmuxSession,
        binary: curBinary,
        promptFile,
        sessionId,
        logFile,
        outputFile: summaryPath,
        timeout,
        command,
      });

      // Did the synthesizer write a summary file?
      summaryExists = await this.safeFileExists(summaryPath);

      if (summaryExists || attempt >= maxRetries) {
        break;
      }

      // No summary — almost always a transport failure. Back off and retry.
      await this.cleanupPromptFile(promptFile);
      const backoffMs = backoffBaseMs * Math.pow(2, attempt);
      const reason = result.timedOut
        ? 'timed out'
        : result.exitCode !== 0
          ? `exited ${result.exitCode}`
          : 'produced no summary';
      // Re-roll the account for the next attempt (plain weighted; a single-account pool,
      // no pool, or a forced override keeps the same account).
      const next = this.rerollAccount(rerollEntry);
      if (next) {
        curBinary = next.binary;
        curHarness = next.harness;
      }
      console.log(
        `  ↻ synthesizer (${curBinary}) ${reason} — retry ${attempt + 1}/${maxRetries} (backoff ${Math.round(backoffMs / 1000)}s)`,
      );
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

    await this.cleanupPromptFile(promptFile);

    const tokens = await extractTokensFromLog(logFile);
    const harnessSessionId = await extractHarnessSessionId(logFile);
    const model = await extractModelFromLog(logFile);

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      binary: curBinary,
      harness: curHarness,
      model,
      summaryPath: summaryExists ? summaryPath : undefined,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      harnessSessionId,
      retryAttempt: attemptUsed,
      retryMax: maxRetries,
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
    await fs.mkdir(synthDir, { recursive: true });

    // (previousSummaryPath comes from a prior loop's dir, so clearing this never deletes the input.)
    const summaryPath = path.join(synthDir, 'review-summary.md');

    // Retry policy — ONLY retries when no summary file is produced (transport failure,
    // crash, timeout). A successfully written summary is never retried.
    const maxRetries = this.config.synthesizerRetry?.maxRetries ?? 2;
    const backoffBaseMs = this.config.synthesizerRetry?.backoffBaseMs ?? 5000;
    // Re-roll source: the synthesizer pool, unless a fixed binary was forced (overrideBinary).
    const rerollEntry = overrideBinary == null ? this.config.synthesizer : undefined;

    // Account in use — may change between attempts when a pool re-roll lands elsewhere.
    let curBinary = parsed.binary;
    let curHarness = parsed.harness;
    let sessionId = '';
    let tmuxSession = '';
    let logFile = '';
    let promptFile = '';
    let attemptUsed = 0;
    let result: { exitCode: number; durationMs: number; timedOut: boolean } = {
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
    };
    let summaryExists = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attemptUsed = attempt;
      // Per-attempt setup keyed off the CURRENT account (a re-rolled account may use a
      // different harness). Re-synthesis shares synthDir with synthesis; use a distinct
      // prompt filename so it doesn't overwrite the synthesizer's prompt.md.
      const interactive = this.isInteractive(curHarness);
      const sentinelFile = interactive ? path.join(synthDir, SENTINEL_NAME) : undefined;
      const finalPrompt = sentinelFile ? prompt + buildSentinelInstruction(sentinelFile) : prompt;
      await fs.writeFile(path.join(synthDir, 'prompt.re-synthesis.md'), finalPrompt, 'utf-8');

      await fs.rm(summaryPath, { force: true });

      sessionId = generateId();
      tmuxSession = `kloop-${runId}-${iteration}-versynth${attempt > 0 ? `-r${attempt}` : ''}`;
      promptFile = await this.writePromptFile(sessionId, finalPrompt);
      logFile = await this.ensureAgentDir(synthDir);

      const command = buildAgentCommand({
        binary: curBinary,
        harness: curHarness,
        promptFile,
        sessionId,
        logFile,
      });

      formatAgentLaunch('resynthesizer', 'resynthesizer', curBinary, tmuxSession, logFile);

      result = await this.launch({
        interactive,
        sentinelFile,
        tmuxSession,
        binary: curBinary,
        promptFile,
        sessionId,
        logFile,
        outputFile: summaryPath,
        timeout,
        command,
      });

      summaryExists = await this.safeFileExists(summaryPath);

      if (summaryExists || attempt >= maxRetries) {
        break;
      }

      await this.cleanupPromptFile(promptFile);
      const backoffMs = backoffBaseMs * Math.pow(2, attempt);
      const reason = result.timedOut
        ? 'timed out'
        : result.exitCode !== 0
          ? `exited ${result.exitCode}`
          : 'produced no summary';
      // Re-roll the account for the next attempt (plain weighted; a single-account pool,
      // no pool, or a forced override keeps the same account).
      const next = this.rerollAccount(rerollEntry);
      if (next) {
        curBinary = next.binary;
        curHarness = next.harness;
      }
      console.log(
        `  ↻ re-synthesizer (${curBinary}) ${reason} — retry ${attempt + 1}/${maxRetries} (backoff ${Math.round(backoffMs / 1000)}s)`,
      );
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

    await this.cleanupPromptFile(promptFile);

    const tokens = await extractTokensFromLog(logFile);
    const harnessSessionId = await extractHarnessSessionId(logFile);
    const model = await extractModelFromLog(logFile);

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      binary: curBinary,
      harness: curHarness,
      model,
      summaryPath: summaryExists ? summaryPath : undefined,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      harnessSessionId,
      retryAttempt: attemptUsed,
      retryMax: maxRetries,
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
    reviewers: Array<ReviewerBinary & { pool?: ReviewTypeEntry }>;
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
          pool: reviewer.pool,
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
    pool?: ReviewTypeEntry; // when set, retries re-roll a (possibly different) account from this pool
  }): Promise<VerifierResult> {
    const { runId, iteration, dirHash, reviewerIndex, binary, harness, prompt, timeout, phaseIndex, ordinal, pool } =
      params;

    // Verifier writes to verify/ directory
    const verifyDir = paths.loopVerifyPath(runId, iteration);
    const reviewerDir = path.join(verifyDir, `verifier-${reviewerIndex}`);
    await fs.mkdir(reviewerDir, { recursive: true });
    // Ensure the verdicts dir exists — the verifier writes its verdict JSON there directly
    const verdictsDir = paths.loopVerdictsPath(runId, iteration);
    await fs.mkdir(verdictsDir, { recursive: true });
    const verdictPath = path.join(verdictsDir, `verifier-${reviewerIndex}.json`);

    // Retry policy — ONLY retries when no parseable verdict is produced (transport failure,
    // crash, timeout). A real approve/reject verdict is never retried.
    const maxRetries = this.config.verifierRetry?.maxRetries ?? 2;
    const backoffBaseMs = this.config.verifierRetry?.backoffBaseMs ?? 5000;

    // Account in use — may change between attempts when a pool re-roll lands elsewhere.
    let curBinary = binary;
    let curHarness = harness;
    let sessionId = '';
    let tmuxSession = '';
    let logFile = '';
    let promptFile = '';
    let attemptUsed = 0;
    let result: { exitCode: number; durationMs: number; timedOut: boolean } = {
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
    };
    let verdictContent: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attemptUsed = attempt;
      // Per-attempt setup keyed off the CURRENT account: a re-rolled account can use a
      // different harness, which changes interactive mode + the sentinel instruction.
      const interactive = this.isInteractive(curHarness);
      const sentinelFile = interactive ? path.join(reviewerDir, SENTINEL_NAME) : undefined;
      const finalPrompt = sentinelFile ? prompt + buildSentinelInstruction(sentinelFile) : prompt;
      await fs.writeFile(path.join(reviewerDir, 'prompt.md'), finalPrompt, 'utf-8');

      // Clean slate: remove any pre-existing verdict so a stale file (from a re-entered run
      // or a prior crashed attempt) can never be misread as this attempt's output.
      await fs.rm(verdictPath, { force: true });

      sessionId = generateId();
      tmuxSession = `kloop-${runId}-${iteration}-verify-${reviewerIndex}${attempt > 0 ? `-r${attempt}` : ''}`;
      promptFile = await this.writePromptFile(sessionId, finalPrompt);
      logFile = await this.ensureAgentDir(reviewerDir);

      const command = buildAgentCommand({
        binary: curBinary,
        harness: curHarness,
        promptFile,
        sessionId,
        logFile,
      });

      formatAgentLaunch('verifier', `verify-${reviewerIndex}`, curBinary, tmuxSession, logFile);

      result = await this.launch({
        interactive,
        sentinelFile,
        tmuxSession,
        binary: curBinary,
        promptFile,
        sessionId,
        logFile,
        outputFile: verdictPath,
        timeout,
        command,
      });

      // Read verdict from the verify verdicts dir
      verdictContent = await this.safeReadFile(verdictPath);

      // Did the verifier produce a real, parseable verdict?
      const verdictProduced = verdictContent !== null && verdicts.parseVerdictFile(verdictContent).verdict !== null;

      if (verdictProduced || attempt >= maxRetries) {
        break;
      }

      // No verdict — almost always a transport failure. Back off and retry.
      await this.cleanupPromptFile(promptFile);
      const backoffMs = backoffBaseMs * Math.pow(2, attempt);
      const reason = result.timedOut
        ? 'timed out'
        : result.exitCode !== 0
          ? `exited ${result.exitCode}`
          : 'produced no verdict';
      // Re-roll the account for the next attempt (plain weighted; a single-account pool
      // or no pool keeps the same account).
      const next = this.rerollAccount(pool);
      if (next) {
        curBinary = next.binary;
        curHarness = next.harness;
      }
      console.log(
        `  ↻ verifier ${reviewerIndex} (${curBinary})${phaseIndex !== undefined ? ` (phase ${phaseIndex})` : ''} ${reason} — retry ${attempt + 1}/${maxRetries} (backoff ${Math.round(backoffMs / 1000)}s)`,
      );
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

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
    const model = await extractModelFromLog(logFile);

    const icon = verdict === 'approved' ? '\u2713' : '\u2717';
    console.log(
      `  ${icon} Verifier ${reviewerIndex} (${curBinary})${model ? ` [${model}]` : ''}${phaseIndex !== undefined ? ` (phase ${phaseIndex})` : ''}: ${verdict}`,
    );

    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      reviewerIndex,
      binary: curBinary,
      harness: curHarness,
      model,
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
      retryAttempt: attemptUsed,
      retryMax: maxRetries,
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
