import { existsSync, mkdirSync } from 'node:fs';
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
    .action(async (opts: { phase?: string; local?: boolean }) => {
      try {
        await runStart(opts);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function runStart(opts: { phase?: string; local?: boolean }): Promise<void> {
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

  // Check lock
  const lockInfo = checkLock(session.id);
  if (lockInfo.locked) {
    logError(`Session is already running (PID ${lockInfo.pid}). Use \`kautopilot stop\` first.`);
    process.exit(1);
  }

  // Load config
  const config = readConfig(session.id);
  if (!config) {
    logError('No config found. Run `kautopilot init` first.');
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
