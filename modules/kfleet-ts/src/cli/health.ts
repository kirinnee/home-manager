// `kfleet health` — launch every auto-* agent with a tiny sentinel prompt, in
// parallel, and print which are up/down. Same prober the `kfleet serve` /metrics
// endpoint uses; this is the on-demand human view.
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../core/config';
import { autoAgents, probeFleet } from '../core/health';
import { logDim, logOk, logWarn } from '../util/format';
import { loadOrDie } from './shared';

export function createHealthCommand(): Command {
  return new Command('health')
    .description('launch every auto-* agent with a sentinel prompt; report which work')
    .option('--json', 'machine-readable output')
    .option('--concurrency <n>', 'how many agents to probe at once (default: config health.concurrency)', v =>
      Number.parseInt(v, 10),
    )
    .action(async (opts: { json?: boolean; concurrency?: number }) => {
      const config = loadOrDie(() => loadConfig());
      const agents = autoAgents(config);
      if (agents.length === 0) return logWarn('no auto-* agents in config');

      const concurrency = opts.concurrency ?? config.health.concurrency;
      if (!opts.json) logDim(`probing ${agents.length} auto-* agents (real LLM calls, may take a while)…`);
      const results = await probeFleet(agents, concurrency, config.health.timeout * 1000);

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      const down = results.filter(r => !r.up);
      for (const r of results.sort((a, b) => Number(a.up) - Number(b.up) || a.binary.localeCompare(b.binary))) {
        const mark = r.up ? pc.green('✓') : pc.red('✗');
        const time = pc.dim(`${(r.ms / 1000).toFixed(1)}s`);
        const tail = r.up ? '' : pc.dim(` — ${r.error ?? 'unknown'}`);
        console.log(`  ${mark} ${r.binary.padEnd(26)} ${time}${tail}`);
      }
      console.log(
        down.length
          ? pc.red(`\n${down.length}/${results.length} down: ${down.map(d => d.binary).join(', ')}`)
          : pc.green(`\nall ${results.length} agents healthy`),
      );
      logOk('done');
      process.exit(down.length ? 1 : 0);
    });
}
