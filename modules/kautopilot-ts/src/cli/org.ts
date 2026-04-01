import { Command } from 'commander';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGlobalConfig } from '../core/config';
import { ALL_SCRIPTS, loadOrgScripts, promptSetupScripts, promptSaveOrg, showScripts } from '../core/scripts';
import { logField, logOk, logInfo, logError, logDim } from '../util/format';

const ORGS_DIR = `${process.env.HOME}/.kautopilot/orgs`;

export function createOrgCommand(): Command {
  return new Command('org')
    .description('Org ticket script management')
    .addCommand(createOrgInitCommand())
    .addCommand(createOrgLsCommand());
}

function createOrgInitCommand(): Command {
  return new Command('init')
    .argument('<name>', 'Org name')
    .description('Create or re-init org ticket scripts')
    .action(async (name: string) => {
      try {
        await runOrgInit(name);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function runOrgInit(name: string): Promise<void> {
  const orgDir = join(ORGS_DIR, name);

  if (existsSync(orgDir)) {
    const { confirmAction } = await import('../llm/inquirer');
    const confirmed = await confirmAction(`Org '${name}' already exists. Overwrite?`, false);
    if (!confirmed) return;
  }

  mkdirSync(orgDir, { recursive: true });

  // 1. Ensure global config exists, then copy to org
  ensureGlobalConfig();
  const globalConfigPath = `${process.env.HOME}/.kautopilot/config.yaml`;
  const orgConfigPath = join(orgDir, 'config.yaml');
  const { copyFileSync } = await import('node:fs');
  if (existsSync(globalConfigPath)) {
    copyFileSync(globalConfigPath, orgConfigPath);
    logField('Config', `${orgConfigPath} (copied from global)`);
  }

  logField('Org', name);

  // 2. Setup scripts — try loading from org (self), then LLM for missing
  const scriptsDir = orgDir;
  const { missing } = loadOrgScripts(scriptsDir, name);

  // 3. If any scripts are missing, run the interactive setup flow
  if (missing.length > 0) {
    const ok = await promptSetupScripts(scriptsDir, missing, name);
    if (!ok) {
      logInfo('Script setup cancelled.');
      return;
    }
  }

  // 4. Show all scripts
  showScripts(scriptsDir, ALL_SCRIPTS);

  // 5. Offer to save scripts as org config (same flow as init)
  if (missing.length > 0) {
    await promptSaveOrg(scriptsDir, name);
  }
}

function createOrgLsCommand(): Command {
  return new Command('ls').description('List configured orgs').action(async () => {
    try {
      await runOrgLs();
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
}

async function runOrgLs(): Promise<void> {
  mkdirSync(ORGS_DIR, { recursive: true });

  const { readdirSync, statSync } = await import('node:fs');
  const orgs = readdirSync(ORGS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());

  if (orgs.length === 0) {
    logInfo('No orgs configured. Run `kautopilot org init <name>` to create one.');
    return;
  }

  const cols = { org: 12, scripts: 60 };
  console.log('ORG'.padEnd(cols.org) + 'SCRIPTS');

  for (const org of orgs) {
    const orgDir = join(ORGS_DIR, org.name);
    const scripts = readdirSync(orgDir)
      .filter(f => !f.startsWith('.'))
      .filter(f => {
        try {
          return statSync(join(orgDir, f)).isFile();
        } catch {
          return false;
        }
      });
    console.log(org.name.padEnd(cols.org) + scripts.join(', '));
  }
}
