import pc from 'picocolors';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { CliDeps } from './index';
import { paths } from '../deps';

export async function handler(runId: string | undefined, deps: CliDeps): Promise<void> {
  try {
    const { indexDb } = deps;

    // Resolve run ID: explicit or latest in CWD
    if (!runId) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(pc.yellow('No run found for this workspace.'));
        return;
      }
      runId = row.id;
    }

    const row = await indexDb.getRun(runId);
    if (!row) {
      console.log(pc.red(`Run not found: ${runId}`));
      return;
    }

    const localKloop = path.join(process.cwd(), '.kloop');
    const specTarget = paths.runSpec(runId);
    const configTarget = paths.runConfig(runId);

    // Check targets exist
    if (!(await fileExists(specTarget))) {
      console.log(pc.red(`Spec file not found: ${specTarget}`));
      process.exit(1);
    }

    // Check if local .kloop already exists
    if (await fileExists(localKloop)) {
      console.log(pc.yellow(`.kloop/ already exists in this directory. Remove it first.`));
      return;
    }

    // Create local .kloop dir
    await fs.mkdir(localKloop, { recursive: true });

    // Symlink spec
    const specLink = path.join(localKloop, 'spec.md');
    await fs.symlink(specTarget, specLink);

    // Symlink config if exists
    if (await fileExists(configTarget)) {
      const configLink = path.join(localKloop, 'config.yaml');
      await fs.symlink(configTarget, configLink);
    }

    console.log(pc.green(`Linked run ${runId} into .kloop/`));
    console.log(pc.dim(`  .kloop/spec.md → ${specTarget}`));
    if (await fileExists(configTarget)) {
      console.log(pc.dim(`  .kloop/config.yaml → ${configTarget}`));
    }
    console.log('');
    console.log(pc.dim('Edit the files, then run:'));
    console.log(pc.dim(`  kloop run ${runId}`));
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
