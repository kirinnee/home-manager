// Fleet operations: apply (generate), list, prune.
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig } from '../core/config';
import { secretsFileKeysPresent } from '../core/creds';
import {
  type SkippedAgent,
  apply,
  expandAliases,
  partitionByCredential,
  prune,
  removeManagedWrappers,
  resolveDefaultHomeTargets,
  wrapperName,
} from '../core/generate';
import { KIND_SPECS } from '../core/kinds';
import { resolveAll } from '../core/merge';
import type { CommandDef, Config, ResolvedAgent } from '../core/types';
import { logDim, logInfo, logOk, logWarn } from '../util/format';
import { loadOrDie } from './shared';

const SECRETS_FILE = path.join(os.homedir(), '.secrets');

interface ActiveFleet {
  agents: ResolvedAgent[];
  commands: CommandDef[];
  skipped: SkippedAgent[];
  /** Skipped wrappers plus every command (e.g. yolo-loge4) that targets one. */
  gone: string[];
}

/** Resolve the agents that get wrappers right now: agents whose `secrets-file`
 *  token is absent upstream are skipped, along with every command (explicit
 *  or alias-expanded) that targets one of their wrappers. */
function resolveActive(config: Config): ActiveFleet {
  const all = resolveAll(config);
  const keys = [...new Set(all.flatMap(a => (a.credential?.source === 'secrets-file' ? [a.credential.key] : [])))];
  const present = keys.length ? secretsFileKeysPresent(keys, SECRETS_FILE) : new Set<string>();
  if (!present) logWarn(`could not read ${SECRETS_FILE}; keeping every secrets-file agent this run`);
  const { agents, skipped } = partitionByCredential(all, present);
  const wrappers = new Set(skipped.flatMap(s => s.wrappers));
  const targetsGone = (c: CommandDef) => wrappers.has(c.target);
  const commands = [...config.commands.filter(c => !targetsGone(c)), ...expandAliases(config.aliases, agents)];
  const dependents = [...config.commands, ...expandAliases(config.aliases, all)].filter(targetsGone);
  return { agents, commands, skipped, gone: [...wrappers, ...dependents.map(c => c.name)] };
}

export function createApplyCommand(): Command {
  return new Command('apply')
    .description('generate wrappers (~/.kfleet/bin) + config dirs from config.yaml')
    .option('--prune', 'also remove managed wrappers no longer in the config')
    .action((opts: { prune?: boolean }) => {
      const config = loadOrDie(() => loadConfig());
      const { agents, commands, skipped, gone } = loadOrDie(() => resolveActive(config));
      if (skipped.length) {
        // Nothing on PATH may launch a tokenless account; re-adding the token
        // upstream and re-running apply brings the wrappers back.
        removeManagedWrappers(gone);
        for (const s of skipped) logInfo(`${s.agent}: no ${s.key} upstream — skipped`);
      }
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
      const { agents, commands, skipped } = loadOrDie(() => resolveActive(config));
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
      for (const s of skipped) logDim(`  ${s.agent}: no ${s.key} upstream — skipped`);
      const variants = Object.keys({ default: 0, ...config.variants }).length;
      logDim(
        `\n${agents.length} wrappers (${config.agents.length} agents × ${variants} variants), ${commands.length} commands`,
      );
    });
}

export function createPruneCommand(): Command {
  return new Command('prune').description('remove managed wrappers no longer in config.yaml').action(() => {
    const config = loadOrDie(() => loadConfig());
    const { agents, commands } = loadOrDie(() => resolveActive(config));
    const removed = prune(agents, commands);
    if (!removed.length) return logOk('nothing to prune');
    logOk(`pruned ${removed.length}: ${removed.join(', ')}`);
  });
}
