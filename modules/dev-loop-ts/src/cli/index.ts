import { Command } from 'commander';
import type { StateService, TmuxService, HistoryService, LogsService } from '../deps';
import * as initCmd from './init';
import * as runCmd from './run';
import * as statusCmd from './status';
import * as metricsCmd from './metrics';
import * as attachCmd from './attach';
import * as cancelCmd from './cancel';
import * as historyCmd from './history';
import * as logsCmd from './logs';
import * as removeCmd from './remove';
import * as streamCmd from './stream';
import * as pollPrCmd from './poll-pr';

// ============================================================================
// CLI Setup
// ============================================================================

export function createCli(deps: {
  state: StateService;
  tmux: TmuxService;
  history: HistoryService;
  logs: LogsService;
}): Command {
  const program = new Command()
    .name('dev-loop')
    .description('Spec-driven development with multi-reviewer consensus')
    .version('2.0.0');

  // Init command
  program
    .command('init')
    .description('Initialize dev-loop configuration (spec + config)')
    .option('--implementer <binary>', 'implementer binary name')
    .option('--implementers <list>', 'implementer binaries with weights (e.g. "a:8,b:2")')
    .option('--reviewers <list>', 'reviewer binaries (comma-separated, single phase)', 'claude-reviewer-zai')
    .option('--review-phases <phases>', 'review phases (pipe-separated, e.g. "a,b|c")')
    .option('--conflict-checker <binary>', 'conflict checker binary name (defaults to implementer)')
    .option('--max-iterations <n>', 'maximum iterations', '10')
    .option('--implementer-timeout <mins>', 'implementer timeout in minutes', '30')
    .option('--reviewer-timeout <mins>', 'reviewer timeout in minutes', '15')
    .option('--conflict-check-threshold <n>', 'consecutive failures before conflict check', '3')
    .option('--first-loop-full-review', 'run all review phases on the first loop (no short-circuit)')
    .option('--previous-review-propagation <0-1>', 'probability (0–1) each reviewer sees previous loop reviews', '0')
    .action(async opts => initCmd.handler(opts, deps.state));

  // Run command
  program
    .command('run')
    .description('Start the dev loop')
    .action(async () => runCmd.handler(deps));

  // Status command
  program
    .command('status')
    .description('Show current run state')
    .action(async () => statusCmd.handler(deps.state));

  // Metrics command
  program
    .command('metrics [query]')
    .description('Query metrics from runs')
    .option('--run <runId>', 'filter to specific run')
    .action(async (query, opts) => metricsCmd.handler(query, opts.run, deps.state));

  // Attach command
  program
    .command('attach')
    .description('Attach to a running tmux session')
    .action(async () => attachCmd.handler(deps.tmux));

  // Cancel command
  program
    .command('cancel')
    .description('Stop current run, kill tmux sessions')
    .action(async () => cancelCmd.handler(deps.state, deps.tmux));

  // History command group
  const historyGroup = program.command('history').description('View run history');

  historyGroup
    .command('list')
    .alias('ls')
    .description('List past runs')
    .action(async () => historyCmd.listHandler(deps.history, deps.logs));

  historyGroup
    .command('show <runId>')
    .description('Show details of a run')
    .action(async runId => historyCmd.showHandler(runId, deps.history, deps.logs));

  historyGroup
    .command('clear')
    .description('Clear all history')
    .action(async () => historyCmd.clearHandler(deps.history));

  historyGroup.action(async () => historyCmd.listHandler(deps.history, deps.logs));

  // Logs command group
  const logsGroup = program.command('logs').description('View agent logs');

  logsGroup
    .command('list')
    .alias('ls')
    .description('List all logs')
    .action(async () => logsCmd.listHandler(deps.logs));

  logsGroup
    .command('view <logName>')
    .description('View a specific log (e.g., impl-1 or rev-1-0)')
    .action(async logName => logsCmd.viewHandler(logName, deps.logs));

  logsGroup
    .command('clear [runId]')
    .description('Clear logs (optionally for a specific run)')
    .action(async runId => logsCmd.clearHandler(deps.logs, runId));

  // Default: interactive selector
  logsGroup.action(async () => logsCmd.interactiveHandler(deps.logs));

  // Remove command
  program
    .command('remove')
    .description('Remove dev-loop state (preserves history)')
    .action(async () => removeCmd.handler(deps.state));

  // Stream command (processes stdin, used internally by agents)
  program
    .command('stream')
    .description('Process streaming JSON from stdin (internal use)')
    .action(async () => streamCmd.handler());

  // Poll PR command
  program
    .command('poll-pr <pr-number>')
    .description('Poll a GitHub PR for CI, reviews, conflicts, and conversation status')
    .option('--repo <owner/repo>', 'GitHub repository (default: detect from current directory)')
    .option('--interval <seconds>', 'poll interval in seconds', '60')
    .action(async (pr, opts) => pollPrCmd.handler(pr, opts));

  return program;
}
