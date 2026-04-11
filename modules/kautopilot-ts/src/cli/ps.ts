import { Command } from 'commander';
import { listSessions } from '../core/db';
import { checkLock } from '../core/lock';
import { ensureStatus, getCurrentKloopRunId } from '../core/status';
import { formatPhase, parseRepoHost } from '../util/format';

const isTTY = process.stdout.isTTY;
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
};

export function createPsCommand(): Command {
  return new Command('ps')
    .option('--repo <origin>', 'Filter by git root (substring match)')
    .option('-a, --all', 'Include stopped/completed sessions')
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
    const { org, repo } = parseRepoHost(session.git_root_host);

    const elapsed = lockInfo.locked && status.startedAt ? Date.now() - new Date(status.startedAt).getTime() : 0;

    const isRunning = lockInfo.locked;
    const kloopRunId = getCurrentKloopRunId(status);

    // Compute plan column
    let planCol = '—';
    if (status.phase === 'implementation' && status.activePlan) {
      planCol = `${status.activePlan.planIndex + 1}/${status.activePlan.maxPlans}`;
    } else if (status.phase === 'implementation' && status.context.maxPlans) {
      planCol = `${(status.context.planIndex ?? 0) + 1}/${status.context.maxPlans}`;
    } else if (status.phase === 'polish' && status.polishState) {
      if (status.polishState.prNumber) {
        planCol = `PR#${status.polishState.prNumber}`;
      } else {
        planCol = status.polishState.deliveryKind;
      }
    }

    // Truncate kloop run ID for display
    const kloopCol = kloopRunId ? (kloopRunId.length > 8 ? kloopRunId.slice(0, 8) : kloopRunId) : '—';

    return {
      id: session.id,
      ticketId: session.ticket_id || '—',
      org,
      repo,
      branch: session.branch || '—',
      phase: status.phase,
      step: status.state,
      stepType: status.stepType,
      userTurn: status.userTurn,
      running: isRunning,
      completed: !isRunning && status.phases.polish.status === 'completed',
      elapsed,
      planCol,
      kloopCol,
      // Full data for JSON
      activePlan: status.activePlan,
      polishState: status.polishState,
      kloopRunId,
      allPlans: status.allPlans,
      phases: status.phases,
    };
  });

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // Table output
  const cols = {
    session: 10,
    ticket: 10,
    org: 12,
    repo: 16,
    branch: 25,
    phase: 16,
    step: 18,
    plan: 7,
    kloop: 9,
    turn: 8,
  };

  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
  const ANSI_RE = /\x1b\[[0-9;]*m/gu;
  /** Visible character width of a string (strips ANSI, handles multibyte) */
  const visWidth = (s: string) => {
    const noAnsi = s.replace(ANSI_RE, '');
    // Approximate: count non-surrogate code points
    return [...noAnsi].length;
  };

  /** Truncate to visible width `w` and pad, accounting for ANSI escape sequences */
  const p = (s: string, w: number) => {
    // For plain strings: truncate by visible width and pad
    if (!s.includes('\x1b')) {
      const chars = [...s];
      if (chars.length > w) {
        const truncated = `${chars.slice(0, w - 1).join('')}…`;
        return truncated + ' '.repeat(Math.max(0, w - visWidth(truncated)));
      }
      return s + ' '.repeat(Math.max(0, w - chars.length));
    }
    // ANSI string: pad based on visible width
    return s + ' '.repeat(Math.max(0, w - visWidth(s)));
  };

  const header =
    p('SESSION', cols.session) +
    p('TICKET', cols.ticket) +
    p('ORG', cols.org) +
    p('REPO', cols.repo) +
    p('BRANCH', cols.branch) +
    p('PHASE', cols.phase) +
    p('STEP', cols.step) +
    p('PLAN', cols.plan) +
    p('KLOOP', cols.kloop) +
    'TURN';

  console.log(header);

  for (const row of rows) {
    const done = row.completed;

    const phaseText = done ? `${c.green}done${c.reset}` : formatPhase(row.phase);
    const stepText = done ? `✓ ${row.step}` : row.stepType ? `${row.step} (${row.stepType})` : row.step || '—';
    const turnText =
      !done && row.stepType === 'tty'
        ? row.userTurn === true
          ? "user's"
          : row.userTurn === false
            ? "LLM's"
            : '—'
        : '—';

    const line =
      p(row.id, cols.session) +
      p(row.ticketId, cols.ticket) +
      p(row.org, cols.org) +
      p(row.repo, cols.repo) +
      p(row.branch, cols.branch) +
      p(phaseText, cols.phase) +
      p(stepText, cols.step) +
      p(row.planCol, cols.plan) +
      p(row.kloopCol, cols.kloop) +
      turnText.padEnd(cols.turn);

    console.log(line);
  }
}
