import { Command, InvalidArgumentError } from 'commander';
import { loadConfig } from '../core/config';
import {
  DEFAULT_CODEX_PREWARM_TIMEOUT_MS,
  type CodexPrewarmResult,
  prewarmCodexSharedSqlite,
} from '../core/codex-prewarm';
import type { Config } from '../core/types';
import { die, logInfo, logOk } from '../util/format';
import { loadOrDie } from './shared';

export function parsePrewarmTimeoutSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new InvalidArgumentError('timeout must be greater than zero');
  return seconds;
}

export async function runCodexPrewarm(
  config: Config,
  timeoutSeconds: number,
  prewarm: (options: { timeoutMs: number }) => Promise<CodexPrewarmResult> = prewarmCodexSharedSqlite,
): Promise<CodexPrewarmResult> {
  if (!config.sharedHistory.codex) {
    throw new Error('sharedHistory.codex is disabled — enable it, run "kfleet apply", then run "kfleet prewarm codex"');
  }
  return prewarm({ timeoutMs: timeoutSeconds * 1000 });
}

export interface PrewarmCommandDeps {
  load?: () => Config;
  prewarm?: (options: { timeoutMs: number }) => Promise<CodexPrewarmResult>;
  info?: (message: string) => void;
  ok?: (message: string) => void;
  fail?: (message: string) => never;
}

export function createPrewarmCommand(deps: PrewarmCommandDeps = {}): Command {
  const command = new Command('prewarm').description('prepare shared runtime state without an LLM call');
  command.addCommand(
    new Command('codex')
      .description('reconcile pooled Codex rollouts into the shared SQLite state database')
      .option(
        '--timeout <seconds>',
        'overall app-server protocol timeout',
        parsePrewarmTimeoutSeconds,
        DEFAULT_CODEX_PREWARM_TIMEOUT_MS / 1000,
      )
      .action(async (options: { timeout: number }) => {
        const config = deps.load ? deps.load() : loadOrDie(() => loadConfig());
        (deps.info ?? logInfo)('prewarming shared Codex SQLite (non-LLM: initialize + thread/list only)');
        try {
          const result = await runCodexPrewarm(config, options.timeout, deps.prewarm);
          (deps.ok ?? logOk)(`reconciled active + archived rollouts in ${result.elapsedMs} ms → ${result.sqliteDir}`);
        } catch (error) {
          (deps.fail ?? die)((error as Error).message);
        }
      }),
  );
  return command;
}
