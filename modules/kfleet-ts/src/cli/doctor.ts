// Diagnostics: doctor (env/PATH/binaries).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig } from '../core/config';
import { KIND_SPECS } from '../core/kinds';
import { binDir, kfleetHome } from '../deps';
import { logOk, logWarn } from '../util/format';

export function createDoctorCommand(): Command {
  return new Command('doctor').description('check PATH, config, and agent binaries').action(() => {
    let ok = true;

    if (existsSync(kfleetHome)) logOk(`~/.kfleet exists (${kfleetHome})`);
    else {
      logWarn('~/.kfleet missing — run "kfleet init"');
      ok = false;
    }

    const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(binDir);
    if (onPath) logOk('~/.kfleet/bin is on PATH');
    else {
      logWarn(`~/.kfleet/bin not on PATH — add: export PATH="$HOME/.kfleet/bin:$PATH"`);
      ok = false;
    }

    try {
      const config = loadConfig();
      logOk(`config valid — ${config.agents.length} agents`);
      const bins = new Set(config.agents.map(a => KIND_SPECS[a.kind].bin));
      for (const bin of bins) {
        if (Bun.which(bin)) logOk(`binary "${bin}" found`);
        else {
          logWarn(`binary "${bin}" not on PATH`);
          ok = false;
        }
      }
    } catch (e) {
      logWarn((e as Error).message);
      ok = false;
    }

    process.exit(ok ? 0 : 1);
  });
}
