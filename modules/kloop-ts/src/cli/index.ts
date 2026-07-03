import { Command } from 'commander';
import type { StateService, TmuxService, LogsService } from '../deps';
import type { IndexDb, EventLog, PidLock } from '../index-db';
import * as initCmd from './init';
import * as setupCmd from './setup';
import * as runCmd from './run';
import * as psCmd from './ps';
import * as statusCmd from './status';
import * as waitCmd from './wait';
import * as describeCmd from './describe';
import * as metricsCmd from './metrics';
import * as attachCmd from './attach';
import * as cancelCmd from './cancel';
import * as linkCmd from './link';
import * as logsCmd from './logs';
import * as viewCmd from './view';
import * as removeCmd from './remove';
import * as reviewCmd from './review';
import * as summaryCmd from './summary';
import * as resetCmd from './reset';
import * as streamCmd from './stream';
import * as skillCmd from './skill';
import * as showCmd from './show';
import * as serveCmd from './serve';
import { createDashCommand } from './dash';
import { createServiceCommand } from './service';
import { readFileSync } from 'fs';

// Read version from package.json at runtime
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));

export interface CliDeps {
  state: StateService;
  tmux: TmuxService;
  logs: LogsService;
  indexDb: IndexDb;
  eventLog: EventLog;
  pidLock: PidLock;
}

export function createCli(deps: CliDeps): Command {
  const program = new Command()
    .name('kloop')
    .description('Spec-driven development with multi-reviewer consensus')
    .version(pkg.version);

  program
    .command('setup')
    .description('View or set user-level default config')
    .option('--config <path>', 'import a config file as defaults')
    .action(async opts => setupCmd.handler(opts));

  program
    .command('init')
    .description('Create a new run directory with config.yaml + spec.md')
    .option('--workspace <path>', 'specify workspace (defaults to CWD)')
    .option('--spec <path>', 'spec file to use (instead of template)')
    .option('--config <path>', 'config file to use (instead of defaults)')
    .action(async opts => initCmd.handler(opts, deps.state, deps.indexDb, deps.eventLog));

  program
    .command('run [id]')
    .description('Start a run')
    .option('-d, --detach', 'run in background (daemon mode)')
    .action(async (id: string | undefined, opts) => runCmd.handler(id, opts, deps));

  program
    .command('ps')
    .description('List active (running) runs')
    .option('-a, --all', 'list all runs (running + completed)')
    .option('--workspace <path>', 'filter by workspace')
    .option('--json', 'machine-readable output')
    .option('--limit <n>', 'return at most N runs')
    .option('--order <field>', 'sort order: "recent" (default when --limit is set)')
    .action(async opts => psCmd.handler(opts, deps));

  program
    .command('status [id]')
    .description('Current snapshot of a run (derived from events.jsonl)')
    .option('--json', 'machine-readable output')
    .action(async (id, opts) => statusCmd.handler(id, opts, deps));

  program
    .command('wait [id]')
    .description(
      'Block until a run is terminal, streaming one event per status/phase change (poll→stream; for Monitor / cheap-subagent waits)',
    )
    .option('--json', 'emit NDJSON status events')
    .option('--interval <sec>', 'max seconds between status checks (crash-detection safety net)', '10')
    .action(async (id, opts) => waitCmd.handler(id, opts, deps));

  program
    .command('describe [id]')
    .description('Full history: all loops, verdicts, exit code, timings')
    .option('--json', 'machine-readable full report')
    .action(async (id, opts) => describeCmd.handler(id, opts, deps));

  program
    .command('logs [id]')
    .description('Show kloop run log')
    .option('-f', 'follow mode (tail -f)')
    .option('--since <duration|iso>', 'show entries since (e.g. 5m, 1h, 2026-03-25T21:00:00Z)')
    .action(async (id, opts) => logsCmd.handler(id, opts, deps));

  program
    .command('cancel [id]')
    .description('Cancel a run (logged as event)')
    .action(async id => cancelCmd.handler(id, deps));

  program
    .command('link [id]')
    .description('Symlink run spec+config into CWD/.kloop/ for editing')
    .action(async id => linkCmd.handler(id, deps));

  program
    .command('attach [id]')
    .description("Attach to run's tmux session (name: kloop-{runId})")
    .action(async id => attachCmd.handler(id, deps.tmux));

  program
    .command('metrics [query]')
    .description('Query metrics with optional promql-style aggregation')
    .option('--run <id>', 'run ID (default: current workspace)')
    .option('--json', 'machine-readable output')
    .action(async (query, opts) => metricsCmd.handler(query, opts, deps));

  program
    .command('remove [ids...]')
    .alias('rm')
    .description('Delete run(s) — supports multiple ids and prefix matching')
    .option('--force', 'force remove even if run is active')
    .action(async (ids, opts) => removeCmd.handler(ids, opts, deps));

  program
    .command('view [id] [loop] [role] [ordinal]')
    .description('View agent logs (impl, rev-0, etc.)')
    .option('-f', 'follow mode (tail -f)')
    .option('--since <duration|iso>', 'show entries since (e.g. 5m, 1h)')
    .action(async (id, loop, role, ordinal, opts) => viewCmd.handler(id, loop, role, ordinal, opts, deps));

  program
    .command('review [id]')
    .description('Show reviewer verdicts and reasoning for each iteration')
    .option('--run <id>', 'run ID (default: current workspace)')
    .action(async (id, opts) => reviewCmd.handler(id, opts, deps));

  program
    .command('summary [id]')
    .description('Generate/show LLM-evaluated run summary')
    .option('--force', 'regenerate summary even if it already exists')
    .option('--run <id>', 'run ID (default: current workspace)')
    .action(async (id, opts) => summaryCmd.handler(id, opts, deps));

  program
    .command('reset')
    .description('Reset global config (~/.kloop/config.yaml) to defaults')
    .action(async () => resetCmd.handler());

  program
    .command('stream')
    .description('Process streaming JSON from stdin (internal use)')
    .action(async () => streamCmd.handler());

  // show subcommand group
  const showCmd_ = new Command('show').description('View run artifacts (reviews, prompts, verdicts, evidence, etc.)');
  showCmd_
    .command('reviews [id] [loop]')
    .description('Show formatted reviews for a loop')
    .option('--run <id>', 'run ID (default: current workspace)')
    .action(async (id, loop, opts) => showCmd.showReviews(id, loop, opts, deps));
  showCmd_
    .command('prompts [id] [loop]')
    .description('Show agent prompts for a loop')
    .option('--run <id>', 'run ID (default: current workspace)')
    .action(async (id, loop, opts) => showCmd.showPrompts(id, loop, opts, deps));
  showCmd_
    .command('verdicts [id] [loop]')
    .description('Show verdict dashboard for a loop')
    .option('--run <id>', 'run ID (default: current workspace)')
    .action(async (id, loop, opts) => showCmd.showVerdicts(id, loop, opts, deps));
  showCmd_
    .command('evidence [id] [loop]')
    .description('Show evidence (diff stats, verification, changed files)')
    .option('--run <id>', 'run ID (default: current workspace)')
    .action(async (id, loop, opts) => showCmd.showEvidence(id, loop, opts, deps));
  showCmd_
    .command('learnings [id]')
    .description('Show run learnings')
    .option('--run <id>', 'run ID (default: current workspace)')
    .action(async (id, opts) => showCmd.showLearnings(id, opts, deps));
  showCmd_
    .command('spec [id]')
    .description('Show current spec')
    .option('--run <id>', 'run ID (default: current workspace)')
    .option('--diff', 'diff current spec against previous version')
    .option('--versions', 'list all spec versions')
    .action(async (id, opts) => showCmd.showSpec(id, opts, deps));
  showCmd_
    .command('config [id]')
    .description('Show run config')
    .option('--run <id>', 'run ID (default: current workspace)')
    .action(async (id, opts) => showCmd.showConfig(id, opts, deps));
  program.addCommand(showCmd_);

  const skillCmd_ = new Command('skill').description('Claude Code skill management');
  skillCmd_
    .command('show')
    .description('Print the kloop Claude Code skill to stdout')
    .action(() => skillCmd.showHandler());
  skillCmd_
    .command('install')
    .description('Install the kloop skill to ~/.claude/skills/kloop/')
    .action(() => skillCmd.installHandler());
  program.addCommand(skillCmd_);

  program
    .command('serve')
    .description('Start the kloop web viewer (foreground)')
    .option('--port <n>', 'port to listen on (default 47316)')
    .option('--host <h>', 'host to bind (default 127.0.0.1)')
    .action(async opts => serveCmd.handler(opts, deps));

  program.addCommand(createDashCommand());
  program.addCommand(createServiceCommand());

  return program;
}
