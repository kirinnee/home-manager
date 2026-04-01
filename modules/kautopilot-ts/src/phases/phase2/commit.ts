import { existsSync, readFileSync } from 'node:fs';
import { resolveSpec } from '../shared';
import type { Phase2Context } from './types';
import { appendEvent } from '../../core/log';
import { spawnPrintRaw } from '../../llm/spawn';
import { writeStepInit } from '../../core/step-init';
import { getAgentPrompt, getAgentBinary } from '../../core/agents';
import { updatePlanManifestEntry } from '../../core/manifests';

export async function handleCommit(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex } = ctx;

  const planName = `plan-${planIndex + 1}`;
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'commit:started',
    version,
    plan: planName,
    metadata: { stepType: 'llm' },
  });

  // LLM --print: detect conventions and generate commit message
  const { $ } = await import('bun');

  // Read recent commits for context
  let commitLog = '';
  try {
    const result = await $`git log --oneline -10`.cwd(session.worktree).quiet().text();
    commitLog = result;
  } catch {
    commitLog = '';
  }

  // Read convention files if they exist
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

  // Resolve the active plan (highest rewrite suffix for this ordinal)
  const { resolveActivePlans } = await import('../shared');
  const { snapshotPath: snapPath } = await import('../../core/artifacts');
  const activePlans = resolveActivePlans(snapPath(session.id, version, 'plans'));
  const activePlanPath = activePlans[planIndex];
  const planContent =
    activePlanPath && existsSync(activePlanPath)
      ? readFileSync(activePlanPath, 'utf-8')
      : resolveSpec(session.id, version, `plans/plan-${planIndex + 1}-1.md`);

  const commitInstruction = getAgentPrompt('phase2', 'commit');
  const commitPrompt = `
${commitInstruction}

Recent commits:
${commitLog}

Conventions:
${conventions || '(no convention files found)'}

Plan:
${planContent}

Output ONLY the commit message (first line = title, blank line, body if needed).
`.trim();

  // Record step init
  const binary = getAgentBinary('phase2', 'commit');
  writeStepInit(session.id, version, 'commit', {
    prompt: commitPrompt,
    command: `${binary} --print (LLM print)`,
    type: 'llm_print',
  });

  const commitMessage = await spawnPrintRaw(binary, commitPrompt, {
    cwd: session.worktree,
    timeout: 30,
    sessionId: session.id,
    label: 'commit',
  });

  // Stage and commit
  let commitSha = '';
  try {
    // Get the list of changed files (tracked + untracked)
    const diffResult = await $`git diff --name-only`.cwd(session.worktree).quiet().text();
    const changedFiles = diffResult
      .trim()
      .split('\n')
      .filter(f => f.length > 0);

    const untrackedResult = await $`git ls-files --others --exclude-standard`.cwd(session.worktree).quiet().text();
    const untrackedFiles = untrackedResult
      .trim()
      .split('\n')
      .filter(f => f.length > 0);

    const allFiles = [...changedFiles, ...untrackedFiles];

    if (allFiles.length > 0) {
      // Stage specific files (never git add -A)
      for (const file of allFiles) {
        await $`git add ${file}`.cwd(session.worktree).quiet();
      }
      await $`git commit -m ${commitMessage}`.cwd(session.worktree).quiet();

      // Capture commit SHA
      const shaResult = await $`git rev-parse HEAD`.cwd(session.worktree).quiet().text();
      commitSha = shaResult.trim();

      console.log(`[commit] Committed: ${commitMessage.split('\n')[0]} (${commitSha.slice(0, 7)})`);

      // Update plan manifest with completion state and commit SHA (spec sections 5.2 / 8)
      updatePlanManifestEntry(session.id, version, planIndex + 1, true, commitSha);
    } else {
      console.log('[commit] No changes to commit');
    }
  } catch (err) {
    console.warn('[commit] Git commit failed:', err);
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'commit:completed',
    version,
    plan: planName,
    metadata: { commitSha, commitMessage: commitMessage.split('\n')[0] },
  });

  return 'next_plan';
}
