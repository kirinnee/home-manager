import pc from 'picocolors';
import type { StateService } from '../deps';
import { format } from 'date-fns';

export async function handler(state: StateService): Promise<void> {
  try {
    const hasConfig = await state.hasConfig();
    if (!hasConfig) {
      console.log(pc.yellow('Dev-loop not initialized.'));
      console.log(pc.dim('Run: dev-loop init'));
      return;
    }

    const config = await state.loadConfig();
    const run = await state.loadRun();

    console.log(pc.bold('Dev Loop Status'));
    console.log('');

    console.log(pc.cyan('Config:'));
    console.log(`  Implementer: ${config.implementer}`);
    console.log(`  Reviewers: ${config.reviewers.join(', ')}`);
    console.log(`  Max iterations: ${config.maxIterations}`);
    console.log(`  Timeouts: impl ${config.implementerTimeout}m, rev ${config.reviewerTimeout}m`);
    console.log('');

    if (!run) {
      console.log(pc.yellow('No active run.'));
      console.log(pc.dim('Run: dev-loop run'));
      return;
    }

    const statusColor = run.status === 'running' ? pc.green : run.status === 'completed' ? pc.blue : pc.yellow;
    console.log(`${pc.cyan('Run:')} ${run.id} ${statusColor(`[${run.status.toUpperCase()}]`)}`);
    console.log(`  Iteration: ${run.iteration} / ${config.maxIterations}`);
    console.log(`  Phase: ${run.phase}`);
    console.log(`  Started: ${format(new Date(run.startedAt), 'yyyy-MM-dd HH:mm:ss')}`);
    console.log('');

    if (run.learnings.length > 0) {
      console.log(pc.cyan(`Learnings (${run.learnings.length}):`));
      run.learnings.slice(-3).forEach((l, i) => {
        console.log(`  ${pc.dim(`${i + 1}.`)} ${l.slice(0, 60)}...`);
      });
      console.log('');
    }

    const sessions = await state.loadSessions();
    if (sessions.length > 0) {
      const currentIterSessions = sessions.filter(s => s.iteration === run.iteration);
      if (currentIterSessions.length > 0) {
        console.log(pc.cyan('Current Sessions:'));
        for (const s of currentIterSessions) {
          const status =
            s.status === 'running' ? pc.yellow('●') : s.status === 'completed' ? pc.green('✓') : pc.red('✗');
          const role = s.role === 'implementer' ? '🔨 impl' : `🔍 rev${s.reviewerIndex ?? ''}`;
          const binary = s.binary ? pc.dim(` (${s.binary})`) : '';
          const verdict = s.verdict ? (s.verdict === 'approved' ? pc.green(' ✓') : pc.red(' ✗')) : '';
          console.log(`  ${status} ${role}${binary}${verdict} ${pc.dim(s.tmuxSession)}`);
        }
        console.log('');
      }
    }

    console.log(pc.dim('Commands: dev-loop attach | dev-loop cancel | dev-loop logs'));
  } catch (err) {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}
