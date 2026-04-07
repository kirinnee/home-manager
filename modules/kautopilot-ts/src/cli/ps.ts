import { Command } from 'commander';
import { listSessions } from '../core/db';
import { checkLock } from '../core/lock';
import { ensureStatus } from '../core/status';
import { formatDuration, formatPhase, formatStatus } from '../util/format';

export function createPsCommand(): Command {
  return new Command('ps')
    .option('--repo <origin>', 'Filter by git root (substring match)')
    .option('--all', 'Include stopped/completed sessions')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { repo?: string; all?: boolean; json?: boolean }) => {
      try {
        await runPs(opts);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function runPs(opts: { repo?: string; all?: boolean; json?: boolean }): Promise<void> {
  const sessions = listSessions({ includeAll: true });

  // Filter by repo
  let filtered = sessions;
  if (opts.repo) {
    const repoFilter = opts.repo.toLowerCase();
    filtered = sessions.filter(s => s.git_root_host.includes(repoFilter));
  }

  const runningRows = filtered.filter(session => opts.all || checkLock(session.id).locked);

  if (runningRows.length === 0) {
    console.log('No sessions found.');
    return;
  }

  const rows = runningRows.map(session => {
    const lockInfo = checkLock(session.id);
    const status = ensureStatus(session.id);

    const elapsed = lockInfo.locked && status.startedAt ? Date.now() - new Date(status.startedAt).getTime() : 0;

    return {
      id: session.id,
      ticketId: session.ticket_id || '—',
      repo: session.git_root_host,
      branch: session.branch || '—',
      state: session.state,
      phase: status.phase,
      step: status.state,
      stateStatus: status.stateStatus,
      stepType: status.stepType,
      userTurn: status.userTurn,
      running: lockInfo.locked,
      checkpoint: status.lastCheckpoint,
      elapsed,
      tasks: Object.fromEntries(Object.entries(status.tasks).map(([k, v]) => [k, v.status])),
    };
  });

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // Table output
  const cols = {
    session: 10,
    ticket: 12,
    repo: 32,
    branch: 30,
    phase: 16,
    status: 16,
  };

  const header = [
    'SESSION'.padEnd(cols.session),
    'TICKET'.padEnd(cols.ticket),
    'REPO'.padEnd(cols.repo),
    'BRANCH'.padEnd(cols.branch),
    'PHASE'.padEnd(cols.phase),
    'STATUS'.padEnd(cols.status),
  ].join(' ');

  console.log(header);

  for (const row of rows) {
    const _statusText =
      row.state === 'init' ? 'init-incomplete' : row.running ? `running (${formatDuration(row.elapsed)})` : 'stopped';

    const line = [
      row.id.padEnd(cols.session),
      row.ticketId.padEnd(cols.ticket),
      row.repo.slice(0, cols.repo).padEnd(cols.repo),
      row.branch.slice(0, cols.branch).padEnd(cols.branch),
      formatPhase(row.phase),
      formatStatus(row.state, row.running),
    ].join(' ');

    console.log(line);
  }
}
