import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { initDir, sessionDir } from '../core/artifacts';
import { ensureGlobalConfig, resolveConfig, resolvedConfigPath } from '../core/config';
import { deleteSession, getSessionByWorktree } from '../core/db';
import { extractOrg, getGitRoot, getRemoteUrl, getWorktree, normalizeGitRoot } from '../core/git';
import { generateSessionId } from '../core/id';
import { getActiveInitForWorktree, updateInitOutcome, upsertInitAttempt } from '../core/init-db';
import { acquireInitLock, checkInitLock, releaseInitLock } from '../core/init-lock';
import { detectAndRecoverInitCrash, ensureInitStatus } from '../core/init-status';
import { checkLock } from '../core/lock';
import { appendInitEvent } from '../core/log';
import { confirmAction } from '../llm/inquirer';
import { runInitStateMachine } from '../phases/init/index';
import type { InitContext } from '../phases/init/states';
import { logDim, logField, logInfo, logOk, logWarn } from '../util/format';

export function createInitCommand(): Command {
  return new Command('init')
    .argument('[ticketId]', 'Ticket ID (e.g. PE-1234)')
    .option('--local', 'Local mode (TTY handoff to generate spec + plans)')
    .option('--reset', 'Remove existing session and re-initialize')
    .option('--config <path>', 'Path to custom config file')
    .action(async (ticketId: string | undefined, opts: { local?: boolean; reset?: boolean; config?: string }) => {
      try {
        await runInit(ticketId, opts);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

export async function runInit(
  ticketId: string | undefined,
  opts: { local?: boolean; reset?: boolean; config?: string },
  cwd?: string,
): Promise<void> {
  const workDir = cwd || process.cwd();

  // 1. Detect git root and worktree
  const gitRootPath = getGitRoot(workDir);
  const worktree = getWorktree(workDir);
  const remoteUrl = getRemoteUrl(workDir);
  const gitRootHost = normalizeGitRoot(remoteUrl);
  const org = extractOrg(gitRootHost);

  // 2. Check per-worktree uniqueness (spec section 2.3)

  // 2a. Check for existing runtime session
  const existingSession = getSessionByWorktree(gitRootPath, worktree);
  if (existingSession) {
    const lockInfo = checkLock(existingSession.id);
    if (lockInfo.locked) {
      throw new Error(`Session is already running (PID ${lockInfo.pid}). Use \`kautopilot stop\` first.`);
    }

    if (existingSession.state !== 'init' && !opts.reset) {
      throw new Error(
        `Session already initialized (${existingSession.id}). Use \`kautopilot start\` or \`kautopilot init --reset\`.`,
      );
    }

    if (opts.reset) {
      const confirmed = await confirmAction(`Remove existing session ${existingSession.id} and re-initialize?`, false);
      if (!confirmed) {
        console.log('Cancelled.');
        process.exit(0);
      }

      // Retire old runtime session: remove DB row and directory (spec section 2.3, 8.7)
      const oldSessionDir = sessionDir(existingSession.id);
      deleteSession(existingSession.id);
      if (existsSync(oldSessionDir)) {
        rmSync(oldSessionDir, { recursive: true, force: true });
      }
      logOk(`Retired old session ${existingSession.id}. Starting fresh init.`);
    }
  }

  // 2b. Check for active init attempt
  const activeInit = getActiveInitForWorktree(gitRootPath, worktree);
  let resumeInitId: string | null = null;

  if (activeInit) {
    const initLock = checkInitLock(activeInit.id);
    if (initLock.locked) {
      throw new Error(`Init is already running for this worktree (${activeInit.id}, PID ${initLock.pid}).`);
    }

    // Recover crashed init (non-terminal — preserves progress for resume)
    detectAndRecoverInitCrash(activeInit.id);

    // Check if this attempt has resumable progress
    const status = ensureInitStatus(activeInit.id);
    if (!status.outcome && status.completedStates.length > 0 && !opts.reset) {
      // Has progress — offer resume
      const doResume = await confirmAction(
        `Previous init attempt ${activeInit.id} has progress (completed: ${status.completedStates.join(', ')}). Resume?`,
        true,
      );
      if (doResume) {
        resumeInitId = activeInit.id;
      } else {
        // Emit durable WAL event before updating DB (spec section 8.4)
        appendInitEvent(activeInit.id, {
          ts: new Date().toISOString(),
          event: 'init:abandoned',
          metadata: { reason: 'user_declined_resume', pid: process.pid },
        });
        updateInitOutcome(activeInit.id, 'abandoned');
        logDim(`Marked previous init attempt ${activeInit.id} as abandoned.`);
      }
    } else if (!status.outcome) {
      // No progress or --reset — mark abandoned silently
      appendInitEvent(activeInit.id, {
        ts: new Date().toISOString(),
        event: 'init:abandoned',
        metadata: { reason: 'reset_or_no_progress', pid: process.pid },
      });
      updateInitOutcome(activeInit.id, 'abandoned');
      logDim(`Marked previous init attempt ${activeInit.id} as abandoned.`);
    }
  }

  // 3. Create fresh init attempt or resume existing
  const initId = resumeInitId ?? generateSessionId();

  if (!resumeInitId) {
    const now = new Date().toISOString();
    const iDir = initDir(initId);
    mkdirSync(iDir, { recursive: true });

    // Register in init tracking DB (spec section 2.2 — never rewrite old attempts)
    upsertInitAttempt({
      id: initId,
      repo_path: gitRootPath,
      worktree,
      git_root: remoteUrl,
      git_root_host: gitRootHost,
      org: org || null,
      outcome: null,
      promoted_session_id: null,
      created_at: now,
      updated_at: now,
    });
  }

  // 4. Resolve config
  ensureGlobalConfig();
  const pickedConfigPath = resolvedConfigPath(org, opts.config);
  const config = resolveConfig(org, opts.config);

  if (!resumeInitId) {
    const initConfigDest = `${initDir(initId)}/config.yaml`;
    const initConfigSourceDest = `${initDir(initId)}/config.source.txt`;
    if (pickedConfigPath && existsSync(pickedConfigPath)) {
      copyFileSync(pickedConfigPath, initConfigDest);
      writeFileSync(initConfigSourceDest, `${pickedConfigPath}\n`);
    } else {
      writeFileSync(initConfigDest, '# resolved from built-in defaults\n');
      writeFileSync(initConfigSourceDest, '(built-in defaults)\n');
    }
  }

  logInfo(`${resumeInitId ? 'Resuming' : 'Init attempt'}: ${initId}`);
  logField('Worktree', worktree);

  // 5. Acquire init lock
  acquireInitLock(initId);

  try {
    // 6. Build init context
    const ctx: InitContext = {
      initId,
      config,
      workDir,
      gitRootPath,
      worktree,
      remoteUrl,
      gitRootHost,
      org,
      forceLocal: opts.local || false,
      ticketIdArg: ticketId,
    };

    // 7. Run init state machine (resumes from WAL for existing attempts)
    const completed = await runInitStateMachine(ctx);

    if (!completed) {
      logWarn('Init interrupted. Run `kautopilot init` to resume or `kautopilot init --reset` to restart.');
    }
  } finally {
    releaseInitLock(initId);
  }
}
