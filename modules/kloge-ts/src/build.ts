import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { die, log, need, ok, run } from './exec';
import { PATCHED_IMAGE } from './paths';

export const forkDir = fileURLToPath(new URL('../cliproxy-fork/', import.meta.url));
const buildScript = fileURLToPath(new URL('../cliproxy-fork/build.sh', import.meta.url));

/** Build the maintained CLIProxyAPI fork without changing rendered/live state. */
export async function buildPatchedImage(): Promise<void> {
  await need('docker');
  await need('git');
  await need('jq');
  if (!existsSync(buildScript)) die(`CLIProxyAPI fork build script not found: ${buildScript}`);

  log(`building maintained CLIProxyAPI fork as ${PATCHED_IMAGE}…`);
  const result = await run([buildScript], { interactive: true });
  if (result.code !== 0) die(`patched CLIProxyAPI image build failed (exit ${result.code})`);

  ok(`built ${PATCHED_IMAGE}`);
  log('next: kloge render (the maintained image is the default)');
}
