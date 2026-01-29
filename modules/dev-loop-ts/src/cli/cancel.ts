import type { StateService, TmuxService } from '../deps';

export async function handler(state: StateService, tmux: TmuxService): Promise<void> {
  try {
    const run = await state.loadRun();

    if (!run) {
      console.log('No active run to cancel.');
      return;
    }

    console.log(`Cancelling run ${run.id}...`);

    // Kill all tmux sessions
    const killed = await tmux.killAllSessions();
    if (killed > 0) {
      console.log(`Killed ${killed} tmux session(s)`);
    }

    // Archive the run
    await state.cancelRun();

    console.log('Run cancelled and archived.');
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
