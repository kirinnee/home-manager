import pc from 'picocolors';
import * as path from 'path';
import * as fs from 'fs/promises';
import { getKloopHome } from '../deps';

const DEFAULT_CONFIG_YAML = `# kloop default configuration
# This is used when no --config flag is provided to kloop init
implementers:
  claude: 1

reviewPhases:
  - - claude

maxIterations: 10
implementerTimeout: 30     # minutes
reviewerTimeout: 15        # minutes
conflictCheckThreshold: 2
firstLoopFullReview: false
previousReviewPropagation: 0
`;

export async function handler(opts: { config?: string }): Promise<void> {
  try {
    const kloopHome = getKloopHome();
    const defaultsPath = path.join(kloopHome, 'config.yaml');

    if (opts.config) {
      // Import a config file as defaults
      const srcPath = path.resolve(opts.config);
      let content: string;
      try {
        content = await fs.readFile(srcPath, 'utf-8');
      } catch {
        console.error(pc.red(`Error: Config file not found: ${opts.config}`));
        process.exit(1);
      }
      await fs.mkdir(kloopHome, { recursive: true });
      await fs.writeFile(defaultsPath, content, 'utf-8');
      console.log(pc.green(`Default config saved to ${defaultsPath}`));
      return;
    }

    // No --config flag: show or create defaults
    if (await fileExists(defaultsPath)) {
      const content = await fs.readFile(defaultsPath, 'utf-8');
      console.log(pc.bold('Current default config:'));
      console.log(pc.dim(`  ${defaultsPath}`));
      console.log('');
      console.log(content);
    } else {
      await fs.mkdir(kloopHome, { recursive: true });
      await fs.writeFile(defaultsPath, DEFAULT_CONFIG_YAML, 'utf-8');
      console.log(pc.green('Default config created:'));
      console.log(pc.dim(`  ${defaultsPath}`));
      console.log('');
      console.log('Edit this file to change defaults for future kloop init runs.');
    }
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
