import { Command } from 'commander';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { generateSessionId } from '../core/id';
import { upsertSession, getSessionByWorktree, deleteSession } from '../core/db';
import { writeConfig, ensureGlobalConfig, resolveConfig } from '../core/config';
import { appendEvent } from '../core/log';
import { checkLock, acquireLock, releaseLock } from '../core/lock';
import {
  getGitRoot,
  getWorktree,
  getRemoteUrl,
  normalizeGitRoot,
  extractOrg,
  getCurrentBranch,
  createBranch,
  isOnMain,
} from '../core/git';
import { spawnPrintRaw } from '../llm/spawn';
import { getDefaultBinary, getAgentPrompt } from '../core/agents';
import { confirmAction } from '../llm/inquirer';
import { sessionDir, snapshotPath, ensureArtifactDir } from '../core/artifacts';
import { loadOrgScripts, verifyCriticalScripts, promptSetupScripts, promptSaveOrg } from '../core/scripts';
import { logField, logOk, logWarn, logInfo, logHeading, logDim } from '../util/format';

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

  // 2. Check if session already exists for this worktree
  const existing = getSessionByWorktree(gitRootPath, worktree);
  if (existing) {
    const lockInfo = checkLock(existing.id);
    if (lockInfo.locked) {
      throw new Error(`Session is already running (PID ${lockInfo.pid}). Use \`kautopilot stop\` first.`);
    }

    if (existing.state === 'init') {
      logWarn(`Found incomplete init (${existing.id}). Cleaning up and re-initializing.`);
      rmSync(sessionDir(existing.id), { recursive: true, force: true });
      deleteSession(existing.id);
    } else if (!opts.reset) {
      throw new Error(
        `Session already initialized (${existing.id}). Use \`kautopilot start\` or \`kautopilot init --reset\`.`,
      );
    } else {
      const confirmed = await confirmAction(`Remove existing session ${existing.id} and re-initialize?`, false);
      if (!confirmed) {
        console.log('Cancelled.');
        process.exit(0);
      }
      rmSync(sessionDir(existing.id), { recursive: true, force: true });
      deleteSession(existing.id);
      logOk(`Removed session ${existing.id}.`);
    }
  }

  // 3. Generate session ID
  const id = generateSessionId();
  const now = new Date().toISOString();

  // 4. Create session directory and config
  const sDir = sessionDir(id);
  mkdirSync(sDir, { recursive: true });
  ensureGlobalConfig();
  const config = resolveConfig(org, opts.config);
  config.repo.org = org;
  config.repo.ticketSystem = null;
  writeConfig(id, config);

  // 4b. Write DB entry early (state: 'init') so aborted inits are detectable
  upsertSession({
    id,
    repo_path: gitRootPath,
    worktree,
    git_root: remoteUrl,
    git_root_host: gitRootHost,
    ticket_id: null,
    branch: null,
    local: 0,
    state: 'init',
    created_at: now,
    updated_at: now,
  });

  // 5. Scripts: try org first, then LLM for any missing
  const scriptsDir = join(sDir, 'scripts');
  const effectiveOrg = org || 'default';
  const currentBranch = getCurrentBranch(workDir);

  if (opts.local) {
    // Local mode: no scripts needed
    logInfo('Scripts skipped (local mode)');
  } else {
    const { found, missing } = loadOrgScripts(scriptsDir, effectiveOrg);

    if (missing.length > 0) {
      // Some or all scripts missing — LLM creates them
      const ok = await promptSetupScripts(scriptsDir, missing, effectiveOrg, id);
      if (!ok) {
        process.exit(1);
      }

      // Offer to save as org (only if we have a real org, not 'default')
      if (org && org !== 'default') {
        await promptSaveOrg(scriptsDir, org, id);
      }
    } else {
      // All scripts loaded from org — verify they work
      const verifyResult = verifyCriticalScripts(scriptsDir, currentBranch);
      if (!verifyResult.extractTicketId || !verifyResult.getTicketOk) {
        logWarn('Copied org scripts did not pass verification.');
        const { selectOption } = await import('../llm/inquirer');
        const fix = await selectOption<'retry' | 'continue' | 'regenerate'>(
          'Critical scripts are not working. What would you like to do?',
          [
            { value: 'retry', label: 'Retry', hint: 'Fix your tool/config, then we verify again' },
            { value: 'regenerate', label: 'Regenerate', hint: 'LLM creates new scripts' },
            { value: 'continue', label: 'Continue anyway', hint: 'Proceed with non-working scripts' },
          ],
        );
        if (fix === 'retry') {
          const retry = verifyCriticalScripts(scriptsDir, currentBranch);
          if (!retry.extractTicketId || !retry.getTicketOk) {
            logWarn('Scripts still not working after retry.');
          }
        } else if (fix === 'regenerate') {
          const ok = await promptSetupScripts(
            scriptsDir,
            ['extract-ticket', 'get-ticket', 'start-ticket', 'to-review', 'revert-to-inprogress'],
            effectiveOrg,
            id,
          );
          if (!ok) process.exit(1);
          if (org && org !== 'default') {
            await promptSaveOrg(scriptsDir, org, id);
          }
        }
      }
    }
  }

  // 6. Determine ticket ID
  const localMode = opts.local || false;
  let resolvedTicketId: string | undefined;

  if (localMode) {
    resolvedTicketId = undefined;
  } else if (ticketId) {
    resolvedTicketId = ticketId;
  } else {
    // Extract from current branch via the extract-ticket script
    const extractScript = join(scriptsDir, 'extract-ticket');
    if (existsSync(extractScript)) {
      const proc = Bun.spawnSync({
        cmd: [extractScript],
        stdin: Buffer.from(currentBranch + '\n'),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (proc.exitCode === 0) {
        const result = proc.stdout.toString().trim();
        if (result.length > 0) resolvedTicketId = result;
      }
    }
    if (!resolvedTicketId) {
      throw new Error('Could not extract ticket ID from branch. Provide one: kautopilot init PE-1234');
    }
  }

  logField('Ticket', resolvedTicketId || '(local mode)');

  // 7. Determine branch
  let branch = getCurrentBranch(workDir);
  if (localMode) {
    if (isOnMain(config.repo.baseBranch, workDir)) {
      branch = `feature/local-${generateSessionId().slice(0, 4)}`;
      createBranch(branch, workDir);
    }
  } else if (isOnMain(config.repo.baseBranch, workDir)) {
    branch = `feature/${resolvedTicketId}`;
    createBranch(branch, workDir);
  }

  // 8. Update session with final fields + mark ready
  upsertSession({
    id,
    repo_path: gitRootPath,
    worktree,
    git_root: remoteUrl,
    git_root_host: gitRootHost,
    ticket_id: resolvedTicketId ?? null,
    branch,
    local: localMode ? 1 : 0,
    state: 'ready',
    created_at: now,
    updated_at: now,
  });

  // 9. Log events
  appendEvent(id, { ts: now, event: 'init:started' });
  appendEvent(id, {
    ts: new Date().toISOString(),
    event: 'init:completed',
    metadata: { id, ticketId: resolvedTicketId, local: localMode },
  });

  // 10. Acquire lock
  acquireLock(id);

  // 11. If local mode, run LLM to generate ticket, spec, and plans
  if (localMode) {
    logInfo('Generating ticket, spec, and plans...');

    const specArtifactPath = snapshotPath(id, 1, 'task-spec.md');
    const plansArtifactDir = snapshotPath(id, 1, 'plans');
    ensureArtifactDir(specArtifactPath);
    ensureArtifactDir(plansArtifactDir + '/.keep');

    try {
      const localInitPrompt = getAgentPrompt('init', 'localInit', { sessionId: id });
      await spawnPrintRaw(getDefaultBinary(), localInitPrompt, {
        cwd: workDir,
        timeout: 300,
        spinnerMsg: 'Generating ticket, spec, and plans',
      });
    } catch (err) {
      logWarn('Local mode generation encountered an issue: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // 12. Release lock (init completes, start will re-acquire)
  releaseLock(id);

  // 13. Output
  logOk(`Session initialized: ${id}`);
  logField('Ticket', resolvedTicketId || '(local mode)');
  logField('Branch', branch);
  logDim(`Config:    ~/.kautopilot/${id}/config.yaml`);
  logDim('Next:      kautopilot start');
}
