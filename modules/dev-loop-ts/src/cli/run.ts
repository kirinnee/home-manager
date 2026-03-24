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

    // Load config
    const config = await deps.state.loadConfig();

    // Create agent runner with configured binaries
    const agentRunner = new AgentRunner(deps.tmux, deps.state, config);

    // Create loop runner
    const loopRunner = new LoopRunner(deps.state, deps.tmux, agentRunner);

    // Run the loop
    const result = await loopRunner.run();

    console.log('');
    console.log(`Loop finished: ${result.status}`);

    // Exit with code 2 if conflict was detected
    if (result.status === 'conflict') {
      process.exit(2);
    }
  } catch (err) {
    const error = err as Error & { name: string };
    if (error.name === 'AgentFailureError') {
      console.log('');
      console.log('========================================');
      console.log('AGENT FAILURE');
      console.log('========================================');
      console.log(error.message);
      console.log('');
      console.log('A failure.md file has been generated.');
      console.log('Please resolve and restart the loop.');
      console.log('========================================');
      process.exit(3);
    }
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
