import type { StateService, TmuxService } from '../deps';
import { LoopRunner } from '../loop/runner';
import { AgentRunner } from '../agents/runner';

export async function handler(deps: { state: StateService; tmux: TmuxService }): Promise<void> {
  try {
    // Check if tmux is available
    const available = await deps.tmux.isAvailable();
    if (!available) {
      console.error('Error: tmux is not installed');
      console.error('Install with: brew install tmux (macOS) or apt install tmux (Linux)');
      process.exit(1);
    }

    // Check if project is initialized
    const hasConfig = await deps.state.hasConfig();
    if (!hasConfig) {
      console.error('Error: dev-loop not initialized');
      console.error('Run: dev-loop init');
      process.exit(1);
    }

    // Load config to get implementer and reviewers
    const config = await deps.state.loadConfig();

    // Create agent runner with configured binaries
    const agentRunner = new AgentRunner(deps.tmux, deps.state, config.implementer, config.reviewers);

    // Create loop runner
    const loopRunner = new LoopRunner(deps.state, deps.tmux, agentRunner);

    // Run the loop
    const result = await loopRunner.run();

    console.log('');
    console.log(`Loop finished: ${result.status}`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
