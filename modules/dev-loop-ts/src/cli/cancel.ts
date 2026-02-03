import type { StateService, TmuxService } from '../deps';

export async function handler(state: StateService, tmux: TmuxService): Promise<void> {
  try {
    const run = await state.loadRun();
    let targetRunId: string | null = run?.id ?? null;

    if (!targetRunId) {
      const history = await state.listHistory();
      if (history.length === 0) {
        console.log('No active run to cancel.');
        return;
      }
      const latest = history[0];
      targetRunId = latest.id;
      console.log(`No active run found. Cleaning up latest run ${targetRunId}...`);
    } else {
      console.log(`Cancelling run ${targetRunId}...`);
      await state.cancelRun();
    }

    const sessions = await tmux.listSessions();
    let killed = 0;
    for (const session of sessions) {
      const parsed = tmux.parseSessionName(session);
      if (!parsed || parsed.runId !== targetRunId) continue;
      if (await tmux.killSession(session)) {
        killed++;
      }
    }
    if (killed > 0) {
      console.log(`Killed ${killed} tmux session(s)`);
    }

    if (run) {
      const stillActive = await state.loadRun();
      if (stillActive) {
        await state.completeRun('cancelled');
      }
      console.log('Run cancelled and archived.');
    } else {
      console.log('Cleanup complete.');
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
