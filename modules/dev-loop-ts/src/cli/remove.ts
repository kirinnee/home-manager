import pc from 'picocolors';
import type { StateService } from '../deps';

export async function handler(state: StateService): Promise<void> {
  try {
    console.log('Removing dev-loop state (history preserved)...');
    await state.destroy();
    console.log(pc.green('Done.'));
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
