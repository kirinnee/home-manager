import { Command } from 'commander';
import { getSessionByWorktree } from '../core/db';
import { readLog } from '../core/log';
import { getGitRoot, getWorktree } from '../core/git';
import { logError, logDim } from '../util/format';

export function createLogsCommand(): Command {
  return new Command('logs')
    .argument('[phase]', 'Filter by phase (plan, implementation, polish)')
    .option('--tail <N>', 'Show last N entries', '50')
    .option('--json', 'Raw JSONL output')
    .action(async (phase: string | undefined, opts: { tail: string; json?: boolean }) => {
      try {
        await runLogs(phase, opts);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function runLogs(phase: string | undefined, opts: { tail: string; json?: boolean }): Promise<void> {
  const repoPath = getGitRoot();
  const worktree = getWorktree();
  const session = getSessionByWorktree(repoPath, worktree);
  if (!session) {
    logError('No session found in this worktree.');
    process.exit(1);
  }

  let entries = readLog(session.id);

  // Filter by phase
  if (phase) {
    const phaseMap: Record<string, string[]> = {
      plan: [
        'write_spec',
        'spec_review',
        'spec_feedback',
        'spec_approve',
        'write_plans',
        'plans_review',
        'plans_feedback',
        'plans_approve',
        'approved',
      ],
      implementation: ['clear_loop', 'setup_run', 'running', 'commit', 'next_plan', 'resolve', 'rewrite_spec'],
      polish: [
        'commit_pending',
        'prereview',
        'push',
        'create_pr',
        'poll',
        'eval',
        'act',
        'tty_resolve',
        'write_fix',
        'run_fix',
        'feedback_check',
      ],
    };
    const phaseSteps = phaseMap[phase.toLowerCase()];
    if (phaseSteps) {
      entries = entries.filter(e => phaseSteps.some(step => e.event.startsWith(step)));
    } else {
      // Treat as general filter
      entries = entries.filter(e => e.event.includes(phase));
    }
  }

  // Tail
  const tailN = parseInt(opts.tail, 10) || 50;
  entries = entries.slice(-tailN);

  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  // Human-readable
  for (const entry of entries) {
    const ts = new Date(entry.ts).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const meta = entry.metadata
      ? ' ' +
        Object.entries(entry.metadata)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
      : '';
    const version = entry.version !== undefined ? ` version=${entry.version}` : '';
    const attempt = entry.attempt !== undefined ? ` attempt=${entry.attempt}` : '';
    logDim(`${ts} ${entry.event}${version}${attempt}${meta}`);
  }
}
