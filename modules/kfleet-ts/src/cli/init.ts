// Scaffold ~/.kfleet from the in-repo templates (base assets + starter config).
// Never clobbers existing files, so re-running init only fills in what's missing.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { binDir, configPath, kfleetHome } from '../deps';
import { logDim, logOk, logWarn } from '../util/format';

const templatesDir = path.join(import.meta.dir, '../../templates');

export function createInitCommand(): Command {
  return new Command('init')
    .description("scaffold ~/.kfleet (config.yaml + base assets) — won't overwrite existing files")
    .action(() => {
      mkdirSync(kfleetHome, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      if (existsSync(templatesDir)) {
        // force:false → skip files that already exist (preserve user edits).
        cpSync(templatesDir, kfleetHome, { recursive: true, force: false, errorOnExist: false });
      } else {
        logWarn(`no templates bundled at ${templatesDir} — created empty ~/.kfleet only`);
      }
      logOk(`scaffolded ${kfleetHome}`);
      logDim(existsSync(configPath) ? `  config: ${configPath}` : '  (no config.yaml template found — add one)');
      logDim('  next: edit config.yaml, then run "kfleet apply"');
    });
}
