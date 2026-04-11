import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { sessionDir } from '../core/artifacts';
import { readConfig } from '../core/config';
import { discoverConfigDirs } from '../core/config-dir';
import { getSessionByWorktree } from '../core/db';
import { getGitRoot, getWorktree } from '../core/git';
import { acquireLock, checkLock, releaseLock } from '../core/lock';
import { appendEvent } from '../core/log';
import { supersedEpoch } from '../core/manifests';
import { detectAndRecoverCrash, ensureStatus } from '../core/status';
import type { Phase } from '../core/types';
import { PHASE_ALIASES } from '../core/types';
import { zellijSessionName } from '../core/zellij';
import { type PhaseResult, runPhase } from '../phases/runner';
import { logError, logField, logInfo, logWarn } from '../util/format';

/** Map internal phase names to canonical WAL event names */
const PHASE_EVENT_NAME: Record<Phase, string> = {
  plan: 'phase1',
  implementation: 'phase2',
  polish: 'phase3',
};

export function createStartCommand(): Command {
  return new Command('start')
    .option('--phase <phaseOrStep>', 'Force start at specific phase or step')
    .option('--local', 'Local mode')
    .option('--force', 'Bypass lock and running-state guard (use with caution)')
    .action(async (opts: { phase?: string; local?: boolean; force?: boolean }) => {
      try {
        await runStartZellij(opts);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

export function createInternalStartCommand(): Command {
  return new Command('internal-start')
    .option('--phase <phaseOrStep>', 'Force start at specific phase or step')
    .option('--local', 'Local mode')
    .option('--force', 'Bypass lock and running-state guard (use with caution)')
    .action(async (opts: { phase?: string; local?: boolean; force?: boolean }) => {
      try {
        await runStart(opts);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function runStartZellij(opts: { phase?: string; local?: boolean; force?: boolean }): Promise<void> {
  // Check if zellij is available
  const which = Bun.spawnSync(['which', 'zellij']);
  if (which.exitCode !== 0) {
    logWarn('zellij not found — running directly without session management');
    await runStart(opts);
    return;
  }

  // Look up session (auto-init if needed, before zellij so init prompts work)
  const repoPath = getGitRoot();
  const worktree = getWorktree();
  let session = getSessionByWorktree(repoPath, worktree);

  if (!session) {
    logInfo('No session found. Initializing...');
    const { runInit } = await import('./init');
    await runInit(undefined, { local: opts.local });
    session = getSessionByWorktree(repoPath, worktree);
    if (!session) {
      logError('Init completed but session not found. Something went wrong.');
      process.exit(1);
    }
  }

  if (session.state === 'init') {
    logError(
      `Session ${session.id} has incomplete initialization. ` +
        `Run \`kautopilot init\` to start a fresh init attempt or \`kautopilot init --reset\` to re-initialize.`,
    );
    process.exit(1);
  }

  const zellijName = zellijSessionName(session.id);

  // Check if zellij session already exists
  const listResult = Bun.spawnSync(['zellij', 'list-sessions', '-n', '-s']);
  const zellijSessions = listResult.stdout.toString().trim().split('\n').filter(Boolean);
  const zellijExists = zellijSessions.includes(zellijName);

  if (zellijExists) {
    // Check if the internal process is still alive
    const lockInfo = checkLock(session.id);
    if (lockInfo.locked) {
      // PID alive + zellij alive → attach normally
      logInfo(`Attaching to existing zellij session: ${zellijName}`);
      const result = nodeSpawnSync('zellij', ['attach', zellijName], {
        stdio: 'inherit',
      });
      process.exit(result.status ?? 1);
    }
    // PID dead + zellij alive → checkLock already reaped the orphaned zellij
    // Fall through to create a fresh session
    logWarn('Previous session process died — starting fresh.');
  }

  // Build internal-start args
  const args = ['internal-start'];
  if (opts.phase) args.push('--phase', opts.phase);
  if (opts.local) args.push('--local');
  if (opts.force) args.push('--force');

  // Write a temporary KDL layout that runs kautopilot internal-start
  // Use full binary path — zellij panes may not resolve bare commands from PATH
  const kautopilotBin = Bun.which('kautopilot') ?? 'kautopilot';
  const sDir = sessionDir(session.id);
  const layoutPath = join(sDir, 'zellij-layout.kdl');
  const escapedCwd = session.worktree.replace(/"/g, '\\"');
  // Wrap in bash so the pane always exists (zellij can't apply close_on_exit if the
  // command binary itself is not found). bash -c also gives us a visible error on failure.
  const innerCmd = `${kautopilotBin} internal-start${args.length > 1 ? ` ${args.slice(1).join(' ')}` : ''}`;
  const escapedCmd = innerCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // No session_name in layout — session name is set by `zellij attach <name>`
  const layoutContent = `layout {\n  pane command="bash" cwd="${escapedCwd}" close_on_exit=false {\n    args "-c" "${escapedCmd}"\n  }\n}\n`;
  writeFileSync(layoutPath, layoutContent);

  // Write a temporary config that uses our layout as the default
  // This lets `zellij attach --create-background` pick up the layout
  const configPath = join(sDir, 'zellij-config.kdl');
  writeFileSync(configPath, `default_layout "${layoutPath}"\n`);

  // Delete any dead/serialized zellij session with the same name
  Bun.spawnSync(['zellij', 'delete-session', zellijName], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  // Create session in background (no TTY needed — server-only)
  logInfo(`Creating zellij session: ${zellijName}`);
  const createResult = Bun.spawnSync(['zellij', '-c', configPath, 'attach', zellijName, '--create-background'], {
    cwd: session.worktree,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Clean up temp files
  try {
    unlinkSync(configPath);
  } catch {}
  try {
    unlinkSync(layoutPath);
  } catch {}

  if (createResult.exitCode !== 0) {
    const stderr = createResult.stderr.toString().trim();
    logError(`Failed to create zellij session: ${stderr || `exit ${createResult.exitCode}`}`);
    process.exit(1);
  }

  // Attach to the session — use node:child_process for proper TTY passthrough
  // (Bun.spawnSync does not correctly forward TTY to interactive programs like zellij)
  const attachResult = nodeSpawnSync('zellij', ['attach', zellijName], {
    stdio: 'inherit',
  });
  process.exit(attachResult.status ?? 1);
}

async function runStart(opts: { phase?: string; local?: boolean; force?: boolean }): Promise<void> {
  const repoPath = getGitRoot();
  const worktree = getWorktree();
  let session = getSessionByWorktree(repoPath, worktree);

  if (!session) {
    // Auto-init
    logInfo('No session found. Initializing...');
    const { runInit } = await import('./init');
    await runInit(undefined, { local: opts.local });
    // Reload session after init
    session = getSessionByWorktree(repoPath, worktree);
    if (!session) {
      logError('Init completed but session not found. Something went wrong.');
      process.exit(1);
    }
  }

  // Guard against incomplete init — runtime sessions with state='init' are stale
  // (the new init lifecycle stores init attempts separately under ~/.kautopilot/init/)
  if (session.state === 'init') {
    logError(
      `Session ${session.id} has incomplete initialization. ` +
        `Run \`kautopilot init\` to start a fresh init attempt or \`kautopilot init --reset\` to re-initialize.`,
    );
    process.exit(1);
  }

  // Crash recovery — detect dead process before checking lock
  detectAndRecoverCrash(session.id, session.worktree, session.ticket_id || 'local');

  // Check lock (unless --force)
  if (!opts.force) {
    const lockInfo = checkLock(session.id);
    if (lockInfo.locked) {
      logError(
        `Session is already running (PID ${lockInfo.pid}). Use \`kautopilot stop\` first or \`kautopilot start --force\` to override.`,
      );
      process.exit(1);
    }

    // Re-verify status after crash recovery — ensure status no longer shows running
    const postRecoveryStatus = ensureStatus(session.id);
    if (postRecoveryStatus.running) {
      logError(
        `Session ${session.id} status still shows running after crash recovery. ` +
          `This may indicate a race condition. Use \`kautopilot start --force\` to override.`,
      );
      process.exit(1);
    }
  } else {
    logWarn('--force: bypassing lock and running-state guard');
  }

  // Load config
  const config = readConfig(session.id);
  if (!config) {
    logError(`Session ${session.id} has no config. This can happen if init was interrupted or the config was deleted.`);
    logInfo('Run `kautopilot init --reset` to re-initialize this worktree.');
    process.exit(1);
  }

  // Validate prerequisites: config.yaml must exist
  const sDir = sessionDir(session.id);
  if (!existsSync(`${sDir}/config.yaml`)) {
    logError('Config file missing. Run `kautopilot init` first.');
    process.exit(1);
  }

  // Determine starting phase
  let phase: Phase;
  let forceStartState: string | undefined;

  if (opts.phase) {
    const normalized = opts.phase.toLowerCase();

    // Parse phase:state syntax (e.g., "impl:setup_run", "plan:spec_review")
    const colonMatch = normalized.match(/^(\w+):(\w+)$/);
    if (colonMatch) {
      const [_, phasePart, statePart] = colonMatch;
      if (phasePart in PHASE_ALIASES) {
        phase = PHASE_ALIASES[phasePart];
        forceStartState = statePart;
      } else {
        logError(`Unknown phase: ${phasePart}. Valid phases: plan, impl(ementation), polish`);
        process.exit(1);
      }
    } else if (normalized in PHASE_ALIASES) {
      phase = PHASE_ALIASES[normalized];
    } else {
      logError(
        `Unknown phase: ${opts.phase}. Valid phases: plan, impl(ementation), polish, or phase:state (e.g., impl:setup_run)`,
      );
      process.exit(1);
    }

    // Validate prerequisites for forced phase using session artifacts only
    if (phase === 'implementation' || phase === 'polish') {
      const hasSpec = existsSync(`${sDir}/artifacts`);
      if (!hasSpec) {
        logError(`Cannot start ${phase}: no spec artifacts found. Run phase 'plan' first.`);
        process.exit(1);
      }
    }
    if (phase === 'polish') {
      const hasPlans = existsSync(`${sDir}/artifacts`);
      if (!hasPlans) {
        logError(`Cannot start polish: no plan artifacts found. Run phase 'implementation' first.`);
        process.exit(1);
      }
    }

    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'phase_start:forced',
      metadata: { to: phase, reason: 'user_start_phase', forceStartState },
    });

    logField('Session', session.id);
    logInfo(`Jumping to ${phase}${forceStartState ? `:${forceStartState}` : ''} (user-specified)`);
  } else {
    // Resume from WAL-materialized status
    const status = ensureStatus(session.id);

    if (status.phase === 'none' || status.phase === '') {
      phase = 'plan';
    } else {
      phase = status.phase as Phase;

      // Validate prerequisites for resumed phase using session artifacts only
      if (phase === 'implementation' || phase === 'polish') {
        const artifactsDir = `${sDir}/artifacts`;
        if (!existsSync(artifactsDir)) {
          logWarn(`Cannot resume ${phase}: no session artifacts found. Restarting from plan.`);
          phase = 'plan';
        }
      }
    }

    logInfo(`Starting phase: ${phase}`);
  }

  // Acquire lock
  acquireLock(session.id);

  try {
    // Discover config dirs for all binaries (loads from disk cache on resume, probes on first run)
    await discoverConfigDirs(config);

    // Log start
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'start:started',
      metadata: { phase, pid: process.pid },
    });

    // Execute phases — auto-advance from starting phase through completion
    const PHASE_ORDER: Phase[] = ['plan', 'implementation', 'polish'];
    const startIdx = PHASE_ORDER.indexOf(phase);
    for (let i = startIdx; i < PHASE_ORDER.length; i++) {
      const currentPhase = PHASE_ORDER[i];
      if (i > startIdx) {
        logInfo(`Advancing to phase: ${currentPhase}`);
      }

      const result: PhaseResult = await runPhase(
        currentPhase,
        session,
        config,
        i === startIdx ? { forceStartState } : {},
      );

      // Handle revisit_spec — cross-phase reset to phase1 with feedback
      if (result === 'revisit_spec') {
        const status = ensureStatus(session.id);
        const oldVersion = status.version;
        const nextVersion = oldVersion + 1;

        logInfo(`Revisit spec signal — escalating to plan for epoch v${nextVersion}`);

        // Mark old epoch as superseded
        supersedEpoch(session.id, oldVersion, nextVersion);

        // Create new epoch directory (spec Part 5 step 4)
        const newVersionDir = join(sessionDir(session.id), 'artifacts', `v${nextVersion}`);
        mkdirSync(newVersionDir, { recursive: true });

        // Log version superseded event
        appendEvent(session.id, {
          ts: new Date().toISOString(),
          event: 'version:superseded',
          version: oldVersion,
          metadata: {
            supersededBy: nextVersion,
            reason: 'revisit_spec',
            fromPhase: currentPhase,
          },
        });

        // Log phase completion for the interrupted phase (canonical WAL name)
        appendEvent(session.id, {
          ts: new Date().toISOString(),
          event: `${PHASE_EVENT_NAME[currentPhase]}:completed`,
          version: oldVersion,
          metadata: { reason: 'revisit_spec' },
        });

        // Emit phase1:started with required metadata for new epoch
        // (machine.ts won't emit because hasCompletedWork=true from prior phase1 work)
        appendEvent(session.id, {
          ts: new Date().toISOString(),
          event: 'phase1:started',
          version: nextVersion,
          metadata: {
            previousVersion: oldVersion,
            reason: 'revisit_spec',
          },
        });

        // Re-run plan phase with new version
        const replanned = await runPhase('plan', session, config, {
          versionOverride: nextVersion,
          suppressPhaseStarted: true,
        });

        if (replanned !== true && replanned !== 'revisit_spec' && replanned !== 'amend_spec') {
          logInfo('Phase plan interrupted — run `kautopilot start` to resume');
          break;
        }

        // Handle chained revisit_spec or amend_spec from plan phase
        if (replanned === 'revisit_spec' || replanned === 'amend_spec') {
          logInfo('Plan phase also returned a signal — run `kautopilot start` to resume');
          break;
        }

        // Re-enter implementation phase for the new epoch
        i = PHASE_ORDER.indexOf('implementation') - 1; // -1 so loop increments to 'implementation'
        continue;
      }

      if (!result) {
        logInfo(`Phase ${currentPhase} interrupted — run \`kautopilot start\` to resume`);
        break;
      }
    }

    // Log completion
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'start:completed',
      metadata: { phase: 'all' },
    });
  } finally {
    releaseLock(session.id);
  }
}
