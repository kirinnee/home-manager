import pc from 'picocolors';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { StateService } from '../deps';
import { generateKloopRunId, paths, SPEC_TEMPLATE, getKloopHome } from '../deps';
import type { IndexDb } from '../index-db';
import type { EventLog } from '../index-db';
import { buildDefaultConfigYaml } from '../agents/default-config';

export async function handler(
  opts: {
    workspace?: string;
    spec?: string;
    config?: string;
  },
  _state: StateService,
  indexDb: IndexDb,
  eventLog: EventLog,
): Promise<void> {
  try {
    const workspace = path.resolve(opts.workspace ?? process.cwd());
    const kloopHome = getKloopHome();

    // Check for active (non-terminal) run in this workspace
    const existingRun = await indexDb.getRunByWorkspace(workspace);
    if (existingRun) {
      const runState = await eventLog.deriveStatus(existingRun.id);
      if (runState && !eventLog.isTerminal(runState.status)) {
        console.error(pc.red(`Error: Run ${existingRun.id} is still ${runState.status} in this workspace.`));
        console.error(pc.dim('Cancel it first: kloop cancel'));
        process.exit(1);
      }
    }

    const runId = generateKloopRunId();
    const runDir = paths.runPath(runId);
    const defaultsPath = path.join(kloopHome, 'config.yaml');

    // Ensure directories exist
    await fs.mkdir(kloopHome, { recursive: true });
    await fs.mkdir(runDir, { recursive: true });

    // Write config.yaml — resolution: --config > user defaults > generate defaults
    let configContent: string;
    if (opts.config) {
      // Case 1: explicit --config — copy as-is, don't touch global
      try {
        configContent = await fs.readFile(path.resolve(opts.config), 'utf-8');
      } catch {
        console.error(pc.red(`Error: Config file not found: ${opts.config}`));
        process.exit(1);
      }
    } else if (await fileExists(defaultsPath)) {
      // Case 2: user defaults exist — copy to run folder
      configContent = await fs.readFile(defaultsPath, 'utf-8');
    } else {
      // Case 3: first time — write defaults to global + run folder
      configContent = buildDefaultConfigYaml();
      await fs.writeFile(defaultsPath, configContent, 'utf-8');
      console.log(pc.dim(`  Created default config: ${defaultsPath}`));
    }
    await fs.writeFile(paths.runConfig(runId), configContent, 'utf-8');

    // Write spec.md — --spec > template
    let specContent = SPEC_TEMPLATE;
    if (opts.spec) {
      try {
        specContent = await fs.readFile(path.resolve(opts.spec), 'utf-8');
      } catch {
        console.error(pc.red(`Error: Spec file not found: ${opts.spec}`));
        process.exit(1);
      }
    }
    await fs.writeFile(paths.runSpec(runId), specContent, 'utf-8');

    // Create empty events.jsonl and learnings.md
    await fs.writeFile(paths.runEvents(runId), '', 'utf-8');
    await fs.writeFile(paths.runLearnings(runId), '', 'utf-8');

    // Insert into index.db
    await indexDb.insertRun({
      id: runId,
      workspace,
      started_at: new Date().toISOString(),
    });

    console.log(pc.bold('kloop Initialized'));
    console.log('');
    console.log(`  Run ID:     ${pc.green(runId)}`);
    console.log(`  Workspace:  ${workspace}`);
    console.log(`  Run dir:    ${runDir}`);
    console.log('');
    console.log(pc.dim('Next steps:'));
    console.log(pc.dim(`  1. kloop link ${runId}        # symlink spec+config into this project`));
    console.log(pc.dim(`  2. kloop run ${runId}          # start the run`));
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
