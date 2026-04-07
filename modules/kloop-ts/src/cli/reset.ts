import pc from 'picocolors';
import * as path from 'path';
import * as fs from 'fs/promises';
import { getKloopHome } from '../deps';
import { buildDefaultConfigYaml } from '../agents/default-config';

export async function handler(): Promise<void> {
  try {
    const kloopHome = getKloopHome();
    const defaultsPath = path.join(kloopHome, 'config.yaml');

    await fs.mkdir(kloopHome, { recursive: true });
    await fs.writeFile(defaultsPath, buildDefaultConfigYaml(), 'utf-8');
    console.log(pc.green('Global config reset to defaults:'));
    console.log(pc.dim(`  ${defaultsPath}`));
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
