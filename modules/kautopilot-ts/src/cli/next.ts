import { Command } from 'commander';
import { runNext } from '../core/driver';
import { acquireLock, checkLock, releaseLock, scopeLockKey } from '../core/lock';
import { logError } from '../util/format';
import { resolveSession } from './resolve-session';

// ============================================================================
// `kautopilot next` — the driver. Runs every `code` step inline (blocking on
// detection), stops at the first interactive/agent step, and prints a
// StepDescriptor (or `{ "done": true }`). Idempotent. (CLI-CONTRACT §2)
// ============================================================================

export function createNextCommand(): Command {
  return new Command('next')
    .description('Yield the next interactive/agent step (runs all code steps inline)')
    .option('--json', 'Emit the StepDescriptor as JSON')
    .option('--repo <repo>', "Drive a single repo's execution/polish loop")
    .option('--session <id>', 'Target session id')
    .action(async (opts: { json?: boolean; repo?: string; session?: string }) => {
      try {
        const { sessionId, config } = resolveSession(opts.session);
        // Per-scope lock: a bare session timeline (plan/feedback) and each
        // repo driver (`--repo <repo>`) get independent locks, so parallel
        // repos and the session timeline don't block one another. (§12)
        const lockKey = scopeLockKey(sessionId, opts.repo ?? null);
        const lock = checkLock(lockKey);
        if (lock.locked) {
          logError(`Session ${sessionId}${opts.repo ? ` (repo ${opts.repo})` : ''} is busy (PID ${lock.pid}).`);
          process.exit(1);
        }
        acquireLock(lockKey);
        let result: Awaited<ReturnType<typeof runNext>>;
        try {
          result = await runNext(sessionId, config, opts.repo ?? null);
        } finally {
          releaseLock(lockKey);
        }
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
          printHuman(result);
        }
        process.exit(0);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function printHuman(result: Awaited<ReturnType<typeof runNext>>): void {
  if (result.done) {
    console.log(`✓ done (${result.phase}): ${result.reason}`);
    return;
  }
  console.log(`▶ ${result.phase} / ${result.step} [${result.kind}]${result.repo ? ` (repo: ${result.repo})` : ''}`);
  console.log(`\n${result.prompt}\n`);
  if (result.contract.outputFile) console.log(`output → ${result.contract.outputFile}`);
  console.log(`on complete → ${result.contract.completionEvent}`);
}
