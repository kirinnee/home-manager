import { Command } from 'commander';
import { getSessionById, getSessionByWorktree } from '../core/db';
import { getGitRoot, getWorktree } from '../core/git';
import { getActiveInitForWorktree, getInitAttemptById, getInitAttemptByPromotedSessionId } from '../core/init-db';
import { ensureInitStatus } from '../core/init-status';
import { checkLock } from '../core/lock';
import { readDeliveryManifest, readPlanManifest } from '../core/manifests';
import type { ActivePlan, PolishState } from '../core/status';
import { ensureStatus, getCurrentKloopRunId, PHASE_STEPS } from '../core/status';
import { formatDuration, formatStepLine, logError, logField, logHeading, logOk, parseRepoHost } from '../util/format';

export function createStatusCommand(): Command {
  return new Command('status')
    .argument('[id]', 'Session ID (optional — defaults to local worktree)')
    .option('--json', 'Machine-readable JSON output')
    .action(async (id: string | undefined, opts: { json?: boolean }) => {
      try {
        await runStatus(id, opts);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function turnLabel(userTurn: boolean | null, stepType: string | null): string {
  if (!stepType || stepType === 'code') return '—';
  if (userTurn === true) return "user's turn";
  if (userTurn === false) return "LLM's turn";
  return '—';
}

function stepDetail(stepType: string | null, userTurn: boolean | null): string {
  if (!stepType) return '';
  const turn = turnLabel(userTurn, stepType);
  return turn !== '—' ? `(${stepType}, ${turn})` : `(${stepType})`;
}

function printPhaseProgress(
  phase: string,
  currentState: string,
  stepType: string | null,
  userTurn: boolean | null,
  completedSteps: string[],
): void {
  const steps = PHASE_STEPS[phase];
  if (!steps) return;

  const phaseLabel = phase === 'plan' ? 'Plan' : phase === 'implementation' ? 'Implementation' : 'Polish';
  logHeading(`${phaseLabel} Phase`);
  console.log();

  const completedSet = new Set(completedSteps);
  let foundActive = false;

  for (const step of steps) {
    if (completedSet.has(step)) {
      console.log(formatStepLine(step, 'done'));
    } else if (step === currentState && !foundActive) {
      console.log(formatStepLine(step, 'active', stepDetail(stepType, userTurn)));
      foundActive = true;
    } else {
      console.log(formatStepLine(step, 'pending'));
    }
  }
}

function printPlanChecklist(
  activePlan: ActivePlan | null,
  allPlans: Array<{
    ordinal: number;
    completed: boolean;
    commitSha: string | null;
  }>,
): void {
  if (allPlans.length === 0) return;

  logHeading('Plans');
  console.log();

  for (const plan of allPlans) {
    if (plan.completed) {
      const sha = plan.commitSha ? ` (${plan.commitSha.slice(0, 7)})` : '';
      console.log(formatStepLine(`plan-${plan.ordinal}${sha}`, 'done'));
    } else if (activePlan && activePlan.planIndex === plan.ordinal - 1) {
      const kloop = activePlan.kloopRunId ? `, kloop #${activePlan.kloopRunId}` : '';
      const attempt = activePlan.attempt > 1 ? `, attempt ${activePlan.attempt}` : '';
      console.log(formatStepLine(`plan-${plan.ordinal}`, 'active', `running${kloop}${attempt}`));
    } else {
      console.log(formatStepLine(`plan-${plan.ordinal}`, 'pending'));
    }
  }
}

function printPolishDetails(polishState: PolishState): void {
  if (!polishState) return;

  console.log();
  logHeading('Delivery');
  console.log();
  logField('Kind', polishState.deliveryKind);

  if (polishState.prNumber) {
    logField('PR', `#${polishState.prNumber}`);
  }
  if (polishState.prUrl) {
    logField('URL', polishState.prUrl);
  }

  logField('Push cycles', String(polishState.pushCycle));

  if (polishState.lastPollState) {
    const pollLabels: Record<string, string> = {
      mergeable: 'Mergeable',
      pending: 'Waiting for CI/reviews',
      blocked: 'Blocked',
    };
    logField('Poll state', pollLabels[polishState.lastPollState] ?? polishState.lastPollState);
  }

  if (polishState.kloopRunId) {
    logField('Kloop fix', polishState.kloopRunId);
  }

  if (polishState.lastEvalSummary) {
    const s = polishState.lastEvalSummary;
    logField(
      'Eval',
      `${s.totalEvalUnits} units: ${s.replies} reply, ${s.resolves} resolve, ${s.codeFixes} fix, ${s.ambiguous} ambiguous`,
    );
  }

  if (polishState.ttyReason) {
    logField('TTY reason', polishState.ttyReason);
  }
}

async function runStatus(id: string | undefined, opts: { json?: boolean }): Promise<void> {
  if (id) {
    const session = getSessionById(id);
    if (session) {
      const status = ensureStatus(session.id);
      const lockInfo = checkLock(session.id);
      const running = lockInfo.locked;
      const phaseElapsed = status.startedAt ? Date.now() - new Date(status.startedAt).getTime() : 0;
      const { org, repo } = parseRepoHost(session.git_root_host);
      const kloopRunId = getCurrentKloopRunId(status);
      const data = {
        kind: 'session',
        session: session.id,
        ticketId: session.ticket_id,
        branch: session.branch,
        repo: session.git_root_host,
        org,
        local: session.local === 1,
        phase: status.phase,
        state: status.state,
        stateStatus: status.stateStatus,
        running,
        completed: !running && status.stateStatus === 'completed',
        stepType: status.stepType,
        userTurn: status.userTurn,
        checkpoint: status.lastCheckpoint,
        version: status.version,
        tasks: status.tasks,
        context: status.context,
        stats: status.stats,
        elapsed: phaseElapsed,
        walCursor: status.walCursor,
        initAttempt: getInitAttemptByPromotedSessionId(session.id)?.id ?? null,
        activeEpoch: status.version,
        // New rich fields
        activePlan: status.activePlan,
        allPlans: status.allPlans,
        polishState: status.polishState,
        kloopRunId,
        phases: status.phases,
        currentPlans: (() => {
          const pm = readPlanManifest(session.id, status.version);
          return (
            pm?.plans.map(p => ({
              ordinal: p.ordinal,
              file: p.file,
              activeRewrite: p.activeRewrite,
              completed: p.completed,
              commitSha: p.commitSha ?? null,
            })) ?? []
          );
        })(),
        delivery: (() => {
          const d = readDeliveryManifest(session.id, status.version);
          return d
            ? {
                kind: d.kind,
                prNumber: d.prNumber ?? null,
                prUrl: d.prUrl ?? null,
                rolloverHistory: d.prRolloverHistory ?? [],
                ticketArtifacts: d.ticketArtifacts ?? [],
                publishedAt: d.publishedAt ?? null,
              }
            : null;
        })(),
        rolloverRecommendation: status.context.rolloverRecommendation ?? null,
      };

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      // Header
      logField('Session', session.id);
      logField('Ticket', session.ticket_id || '—');
      logField('Org/Repo', `${org}/${repo}`);
      logField('Branch', session.branch || '—');
      if (data.initAttempt) logField('Init', data.initAttempt);
      console.log();

      // Completed session — show summary instead of in-progress phase
      if (data.completed) {
        logOk('Completed');

        // Show delivery result if available
        const delivery = data.delivery;
        if (delivery) {
          console.log();
          logHeading('Delivery');
          console.log();
          logField('Kind', delivery.kind);
          if (delivery.prNumber) logField('PR', `#${delivery.prNumber}`);
          if (delivery.prUrl) logField('URL', delivery.prUrl);
          if (delivery.publishedAt) logField('Published', delivery.publishedAt);
        } else if (status.context.prNumber) {
          console.log();
          logField('PR', `#${status.context.prNumber}`);
          if (status.context.prUrl) logField('URL', status.context.prUrl as string);
        }

        // Show kloop runs
        const allRunIds = Object.values(status.planRuns).flat();
        if (allRunIds.length > 0) {
          console.log();
          logField('Kloop', allRunIds.join(', '));
        }

        // Show plan completion
        if (status.allPlans.length > 0) {
          console.log();
          const completed = status.allPlans.filter(p => p.completed).length;
          logField('Plans', `${completed}/${status.allPlans.length} completed`);
        }

        console.log();
        logHeading('Progress');
        console.log();
        logField('Duration', formatDuration(phaseElapsed));
        logField('Version', String(status.version));
        logField('Phase', status.phase);
        logField('Step', status.state);
        return;
      }

      // Phase progress (running)
      printPhaseProgress(status.phase, status.state, status.stepType, status.userTurn, status.completedSteps);

      // Implementation plan details
      if (status.phase === 'implementation') {
        printPlanChecklist(status.activePlan, status.allPlans);

        // Show rewrite decision if in resolve/amend_plans
        if (status.activePlan?.rewriteDecision && ['resolve', 'amend_plans'].includes(status.state)) {
          console.log();
          logField('Rewrite', status.activePlan.rewriteDecision);
        }
      }

      // Polish phase details
      if (status.phase === 'polish' && status.polishState) {
        printPolishDetails(status.polishState);

        // Show delivery manifest if available
        const delivery = data.delivery;
        if (delivery && !status.polishState?.prNumber) {
          if (delivery.prNumber) logField('PR', `#${delivery.prNumber}`);
          if (delivery.prUrl) logField('URL', delivery.prUrl);
        }
      }

      // Progress & Stats
      console.log();
      logHeading('Progress');
      console.log();
      logField('Checkpoint', status.lastCheckpoint || '—');
      logField('Duration', formatDuration(phaseElapsed));
      logField('Version', String(status.version));

      if (kloopRunId) {
        logField('Kloop', kloopRunId);
      }

      const taskEntries = Object.entries(status.tasks);
      if (taskEntries.length > 0) {
        console.log();
        logHeading('Tasks');
        console.log();
        for (const [name, task] of taskEntries) {
          logField(`  ${name}`, task.status);
        }
      }

      // Stats
      console.log();
      logHeading('Stats');
      console.log();
      logField('Replies', String(status.stats.totalReplies));
      logField('Resolved', String(status.stats.totalResolved));
      logField('Push cycles', String(status.stats.pushCycles));

      return;
    }

    const initAttempt = getInitAttemptById(id);
    if (!initAttempt) {
      logError(`Session or init attempt ${id} not found in index.`);
      process.exit(1);
    }

    const initStatus = ensureInitStatus(initAttempt.id);
    const elapsed = initStatus.startedAt ? Date.now() - new Date(initStatus.startedAt).getTime() : 0;
    const data = {
      kind: 'init',
      initAttempt: initAttempt.id,
      outcome: initAttempt.outcome,
      promotedSessionId: initAttempt.promoted_session_id,
      repoPath: initAttempt.repo_path,
      worktree: initAttempt.worktree,
      repo: initAttempt.git_root_host,
      org: initAttempt.org,
      state: initStatus.state,
      stateStatus: initStatus.stateStatus,
      running: initStatus.running,
      context: initStatus.context,
      completedStates: initStatus.completedStates,
      elapsed,
      walCursor: initStatus.walCursor,
    };

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    logField('Init attempt', initAttempt.id);
    logField('Outcome', initAttempt.outcome || 'active');
    logField('Promoted', initAttempt.promoted_session_id || '—');
    logField('Repo', initAttempt.git_root_host);
    console.log();
    logField('State', initStatus.state);
    logField('Status', initStatus.running ? `running (${initStatus.stateStatus})` : initStatus.stateStatus);
    logField('Duration', formatDuration(elapsed));
    return;
  }

  const repoPath = getGitRoot();
  const worktree = getWorktree();
  const session = getSessionByWorktree(repoPath, worktree);
  if (session) {
    await runStatus(session.id, opts);
    return;
  }

  const activeInit = getActiveInitForWorktree(repoPath, worktree);
  if (!activeInit) {
    logError('No session or init attempt found in this worktree.');
    process.exit(1);
  }

  await runStatus(activeInit.id, opts);
}
