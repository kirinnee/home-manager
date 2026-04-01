import { Command } from 'commander';
import { getSessionByWorktree, getSessionById } from '../core/db';
import { ensureStatus } from '../core/status';
import { getGitRoot, getWorktree } from '../core/git';
import { formatDuration, logField, formatStatus, formatPhase, logError } from '../util/format';
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
  let session;
  if (id) {
    session = getSessionById(id);
    if (!session) {
      logError(`Session ${id} not found in index.`);
      process.exit(1);
    }
  } else {
    const repoPath = getGitRoot();
    const worktree = getWorktree();
    session = getSessionByWorktree(repoPath, worktree);
    if (!session) {
      logError('No session found in this worktree.');
      process.exit(1);
    }
  }

  const status = ensureStatus(session.id);

  const phaseElapsed = status.startedAt ? Date.now() - new Date(status.startedAt).getTime() : 0;

  const data = {
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
    // Durable state surface (spec sections 9.2 / 13.1.E)
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

  // Show parallel tasks if any
  const taskEntries = Object.entries(status.tasks);
  if (taskEntries.length > 0) {
    console.log();
    logField('Tasks', '');
    for (const [name, task] of taskEntries) {
      logField(`  ${name}`, task.status);
    }
  }
}
