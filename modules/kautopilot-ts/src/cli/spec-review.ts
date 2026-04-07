import { Command } from 'commander';
import { readConfig } from '../core/config';
import { getSessionByWorktree } from '../core/db';
import { getGitRoot, getWorktree } from '../core/git';
import { runReviewers } from '../core/review-runner';
import { ensureStatus } from '../core/status';
import { buildPromptVars } from '../core/type-config';
import { logError } from '../util/format';

export function createSpecReviewCommand(): Command {
  return new Command('spec-review')
    .description('Run spec reviewers for the current session (stateless, stdout only)')
    .action(async () => {
      try {
        await runSpecReview();
      } catch (err) {
        logError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function runSpecReview(): Promise<void> {
  // Discover session from worktree
  const repoPath = getGitRoot();
  const worktree = getWorktree();
  const session = getSessionByWorktree(repoPath, worktree);
  if (!session) {
    logError('No session found in this worktree.');
    process.exit(1);
  }

  // Load config
  const config = readConfig(session.id);
  if (!config) {
    logError('No config found for this session.');
    process.exit(1);
  }

  // Determine version from status
  const status = ensureStatus(session.id);
  const version = status.version || 1;

  const reviewers = config.agents.phase1.spec_reviewers;
  if (!reviewers || Object.keys(reviewers).length === 0) {
    console.log('No spec reviewers configured.');
    return;
  }

  // Build prompt vars
  const vars = buildPromptVars(worktree, version, session.ticket_id || 'local');

  // Run reviewers and print summary to stdout
  const summary = await runReviewers(reviewers, vars, config, session.id);
  console.log(summary);
}
