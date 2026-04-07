import { getAgentBinary } from '../../core/agents';
import { appendEvent } from '../../core/log';
import { writeStepInit } from '../../core/step-init';
import { COMMIT_AGENT_PROMPT } from '../../core/types';
import { spawnPrintRaw } from '../../llm/spawn';
import type { Phase3Context } from './types';

export async function handleCommitPending(ctx: Phase3Context): Promise<string | null> {
  const { session, version, config } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'commit_pending:started',
    version,
    metadata: { stepType: 'code' },
  });

  const { $ } = await import('bun');

  // Check for uncommitted changes
  const diffResult = await $`git diff --name-only`.cwd(session.worktree).quiet().text();
  const untrackedResult = await $`git ls-files --others --exclude-standard`.cwd(session.worktree).quiet().text();
  const allFiles = [
    ...diffResult
      .trim()
      .split('\n')
      .filter(f => f.length > 0),
    ...untrackedResult
      .trim()
      .split('\n')
      .filter(f => f.length > 0),
  ];

  if (allFiles.length === 0) {
    console.log('[commit_pending] No uncommitted changes — skipping');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'commit_pending:completed',
      version,
      metadata: { skipped: true },
    });
    return config.settings.coderabbit ? 'prereview' : 'push';
  }

  // Use shared COMMIT_AGENT_PROMPT directly with empty context
  const prompt = COMMIT_AGENT_PROMPT.replace('{context}', '');

  const binary = getAgentBinary('phase3', 'commit_pending');
  writeStepInit(session.id, version, 'commit_pending', {
    prompt,
    command: `${binary} --print (LLM commit)`,
    type: 'llm_print',
  });

  await spawnPrintRaw(binary, prompt, {
    cwd: session.worktree,
    timeout: 120,
    sessionId: session.id,
    label: 'commit-pending',
  });

  // Read commit SHA as verification
  let commitSha = '';
  try {
    const shaResult = await $`git rev-parse HEAD`.cwd(session.worktree).quiet().text();
    commitSha = shaResult.trim();
    const msgResult = await $`git log --oneline -1`.cwd(session.worktree).quiet().text();
    console.log(`[commit_pending] Committed: ${msgResult.trim()}`);
  } catch (err) {
    console.warn('[commit_pending] Could not read commit SHA:', err);
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'commit_pending:completed',
    version,
    metadata: {
      commitSha,
      filesStaged: allFiles.length,
    },
  });

  return config.settings.coderabbit ? 'prereview' : 'push';
}
