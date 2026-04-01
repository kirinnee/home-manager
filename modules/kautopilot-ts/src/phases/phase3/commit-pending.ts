import { existsSync, readFileSync } from 'node:fs';
import type { Phase3Context } from './types';
import { appendEvent } from '../../core/log';
import { spawnPrintRaw } from '../../llm/spawn';
import { writeStepInit } from '../../core/step-init';
import { getAgentPrompt, getAgentBinary } from '../../core/agents';

export async function handleCommitPending(ctx: Phase3Context): Promise<string | null> {
  const { session, version } = ctx;

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
    return 'prereview';
  }

  // LLM --print: detect conventions and generate commit message
  let commitLog = '';
  try {
    commitLog = await $`git log --oneline -10`.cwd(session.worktree).quiet().text();
  } catch {
    commitLog = '';
  }

  const conventionFiles = [
    'CommitConventions.md',
    'CONTRIBUTING.md',
    '.commitlintrc',
    '.commitlintrc.js',
    '.commitlintrc.json',
  ];
  let conventions = '';
  for (const f of conventionFiles) {
    const path = `${session.worktree}/${f}`;
    if (existsSync(path)) {
      conventions += `\n### ${f}\n${readFileSync(path, 'utf-8')}\n`;
    }
  }

  // Build diff summary for context
  const diffContent = await $`git diff --stat`.cwd(session.worktree).quiet().text();

  const commitPendingInstruction = getAgentPrompt('phase3', 'commit_pending');
  const prompt = `
${commitPendingInstruction}

Recent commits:
${commitLog}

Conventions:
${conventions || '(no convention files found)'}

Changed files summary:
${diffContent}

Output ONLY the commit message (first line = title, blank line, body if needed).
`.trim();

  // Record step init
  const binary = getAgentBinary('phase3', 'commit_pending');
  writeStepInit(session.id, version, 'commit_pending', {
    prompt,
    command: `${binary} --print (LLM print)`,
    type: 'llm_print',
  });

  const commitMessage = await spawnPrintRaw(binary, prompt, {
    cwd: session.worktree,
    timeout: 30,
    sessionId: session.id,
    label: 'commit-pending',
  });

  // Stage and commit
  let commitSha = '';
  try {
    for (const file of allFiles) {
      await $`git add ${file}`.cwd(session.worktree).quiet();
    }
    await $`git commit -m ${commitMessage}`.cwd(session.worktree).quiet();
    const shaResult = await $`git rev-parse HEAD`.cwd(session.worktree).quiet().text();
    commitSha = shaResult.trim();
    console.log(`[commit_pending] Committed: ${commitMessage.split('\n')[0]} (${commitSha.slice(0, 7)})`);
  } catch (err) {
    console.warn('[commit_pending] Git commit failed:', err);
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'commit_pending:completed',
    version,
    metadata: {
      commitSha,
      commitMessage: commitMessage.split('\n')[0],
      filesStaged: allFiles.length,
    },
  });

  return 'prereview';
}
