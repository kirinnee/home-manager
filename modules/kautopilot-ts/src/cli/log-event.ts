import { Command } from 'commander';
import { getSessionByWorktree } from '../core/db';
import { appendEvent } from '../core/log';
import { getGitRoot, getWorktree } from '../core/git';
import { logOk, logError } from '../util/format';

export function createLogEventCommand(): Command {
  return new Command('log-event')
    .argument('<event>', 'Event name (e.g. spec:approved)')
    .option('--metadata <json>', 'JSON metadata to attach')
    .action(async (event: string, opts: { metadata?: string }) => {
      try {
        const repoPath = getGitRoot();
        const worktree = getWorktree();
        const session = getSessionByWorktree(repoPath, worktree);
        if (!session) {
          logError('No session found for this worktree.');
          process.exit(1);
        }

        let metadata: Record<string, unknown> | undefined;
        if (opts.metadata) {
          try {
            metadata = JSON.parse(opts.metadata);
          } catch {
            logError('Invalid JSON for --metadata');
            process.exit(1);
          }
        }

        appendEvent(session.id, {
          ts: new Date().toISOString(),
          event,
          metadata,
        });

        logOk(`Event logged: ${event}`);
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
