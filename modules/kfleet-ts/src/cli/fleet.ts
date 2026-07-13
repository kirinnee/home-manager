// Fleet operations: apply (generate), list, prune.
import { Command } from 'commander';
import { loadConfig } from '../core/config';
import { apply, expandAliases, prune, resolveDefaultHomeTargets, wrapperName } from '../core/generate';
import { KIND_SPECS } from '../core/kinds';
import { resolveAll } from '../core/merge';
import type { Config, ResolvedAgent } from '../core/types';
import { logDim, logInfo, logOk } from '../util/format';
import { loadOrDie } from './shared';

/** Explicit commands + every alias fanned out across the resolved agents. */
const allCommands = (config: Config, agents: ResolvedAgent[]) => [
  ...config.commands,
  ...expandAliases(config.aliases, agents),
];

export function createApplyCommand(): Command {
  return new Command('apply')
    .description('generate wrappers (~/.kfleet/bin) + config dirs from config.yaml')
    .option('--prune', 'also remove managed wrappers no longer in the config')
    .action((opts: { prune?: boolean }) => {
      const config = loadOrDie(() => loadConfig());
      const agents = loadOrDie(() => resolveAll(config));
      const commands = allCommands(config, agents);
      const res = loadOrDie(() => apply(agents, commands, config.defaultHomes, config.sharedHistory));
      const defaults = res.defaultHomes ? ` + ${res.defaultHomes} default homes` : '';
      logOk(`applied ${res.agents} agents + ${res.commands} commands${defaults} → ~/.kfleet/bin`);
      if (config.sharedHistory.claude || config.sharedHistory.codex) {
        const { migrated, conflicts } = res.shared;
        const detail = migrated || conflicts ? `migrated ${migrated} entries, ${conflicts} conflicts` : 'up to date';
        logInfo(`shared history (${detail}) → ~/.kfleet/shared`);
      }
      if (opts.prune) {
        const removed = prune(agents, commands);
        logInfo(removed.length ? `pruned ${removed.length}: ${removed.join(', ')}` : 'nothing to prune');
      }
    });
}

export function createListCommand(): Command {
  return new Command('list')
    .alias('ls')
    .description('list generated wrappers (agents × variants) and commands')
    .action(() => {
      const config = loadOrDie(() => loadConfig());
      const agents = loadOrDie(() => resolveAll(config));
      const commands = allCommands(config, agents);
      if (!agents.length && !commands.length) return logDim('nothing configured');
      for (const a of agents) {
        console.log(`  ${wrapperName(a).padEnd(24)} ${KIND_SPECS[a.kind].configDir(a.name)}`);
      }
      for (const c of commands) {
        console.log(`  ${c.name.padEnd(24)} → ${c.target} ${c.flags.join(' ')}`);
      }
      for (const d of loadOrDie(() => resolveDefaultHomeTargets(config.defaultHomes, agents))) {
        console.log(`  ${`${d.kind} default`.padEnd(24)} ${d.dir} → ${wrapperName(d.agent)}`);
      }
      const variants = Object.keys({ default: 0, ...config.variants }).length;
      logDim(
        `\n${agents.length} wrappers (${config.agents.length} agents × ${variants} variants), ${commands.length} commands`,
      );
    });
}

export function createPruneCommand(): Command {
  return new Command('prune').description('remove managed wrappers no longer in config.yaml').action(() => {
    const config = loadOrDie(() => loadConfig());
    const agents = loadOrDie(() => resolveAll(config));
    const removed = prune(agents, allCommands(config, agents));
    if (!removed.length) return logOk('nothing to prune');
    logOk(`pruned ${removed.length}: ${removed.join(', ')}`);
  });
}
