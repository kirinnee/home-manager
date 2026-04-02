import { Command } from 'commander';
import { getSessionByWorktree, getSessionById } from '../core/db';
import { getActiveInitForWorktree, getInitAttemptById, getInitAttemptByPromotedSessionId } from '../core/init-db';
import { ensureStatus } from '../core/status';
import { ensureInitStatus } from '../core/init-status';
import { getGitRoot, getWorktree } from '../core/git';
import { formatDuration, logField, logError } from '../util/format';
import { readPlanManifest, readDeliveryManifest } from '../core/manifests';

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

async function runStatus(id: string | undefined, opts: { json?: boolean }): Promise<void> {
  if (id) {
    const session = getSessionById(id);
    if (session) {
      const status = ensureStatus(session.id);
      const phaseElapsed = status.startedAt ? Date.now() - new Date(status.startedAt).getTime() : 0;
      const data = {
        kind: 'session',
        session: session.id,
        ticketId: session.ticket_id,
        branch: session.branch,
        repo: session.git_root_host,
        org: session.git_root_host.split('/')[1],
        local: session.local === 1,
        phase: status.phase,
        state: status.state,
        stateStatus: status.stateStatus,
        running: status.running,
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

      logField('Session', session.id);
      logField('Ticket', session.ticket_id || '—');
      logField('Branch', session.branch || '—');
      logField('Repo', session.git_root_host);
      logField('Local', session.local === 1 ? 'yes' : 'no');
      console.log();
      logField('Phase', status.phase);
      const stepSuffix = status.stepType
        ? ` (${status.stepType}${status.userTurn === true ? ", user's turn" : status.userTurn === false ? ", LLM's turn" : ''})`
        : '';
      logField('Step', (status.state || '—') + stepSuffix);
      logField('Status', status.running ? `running (${status.stateStatus})` : 'stopped');
      logField('Checkpoint', status.lastCheckpoint || '—');
      console.log();
      logField('Duration', formatDuration(phaseElapsed));
      logField('Version', String(status.version));
      logField('Init attempt', data.initAttempt || '—');

      const taskEntries = Object.entries(status.tasks);
      if (taskEntries.length > 0) {
        console.log();
        logField('Tasks', '');
        for (const [name, task] of taskEntries) {
          logField(`  ${name}`, task.status);
        }
      }
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
