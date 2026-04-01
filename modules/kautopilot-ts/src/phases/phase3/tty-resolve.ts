import { existsSync, readFileSync } from 'node:fs';
import type { Phase3Context } from './types';
import { appendEvent } from '../../core/log';
import { sessionDir } from '../../core/artifacts';
import { resolveSpec, resolvePlans, spawnTTYWithTurnTracking } from '../shared';
import { writeStepInit } from '../../core/step-init';
import { getAgentPrompt, getAgentBinary, TTY_EXIT_INSTRUCTION } from '../../core/agents';

export async function handleTtyResolve(ctx: Phase3Context): Promise<string | null> {
  const { session, version, ttyReason, baseBranch } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'tty_resolve:started',
    version,
    metadata: { stepType: 'tty', ttyReason: ttyReason || 'unknown' },
  });

  const { $ } = await import('bun');

  // Build context for TTY handoff
  const ticketId = ctx.ticketId;

  // Load spec and plans from session artifacts
  const specContent = resolveSpec(session.id, version);

  const plans = resolvePlans(session.id, version);
  const plansContent = plans.map(p => readFileSync(p, 'utf-8')).join('\n\n---\n\n');

  // Load feedback history
  const feedbackDir = `${sessionDir(session.id)}/artifacts/v${version}`;
  let feedbackContent = '';
  try {
    const feedbackPath = `${feedbackDir}/feedback.md`;
    if (existsSync(feedbackPath)) {
      feedbackContent = readFileSync(feedbackPath, 'utf-8');
    }
  } catch {
    feedbackContent = '';
  }

  // Determine agent name based on reason
  const agentName =
    ttyReason === 'ambiguous_eval'
      ? 'tty_resolve_ambiguous'
      : ttyReason === 'merge_conflict'
        ? 'tty_resolve_conflict'
        : 'tty_resolve_failure';

  // Build TTY prompt based on reason — the instruction part is configurable
  let ttyPrompt: string;
  if (ttyReason === 'ambiguous_eval') {
    const items = ctx.ttyResolveItems || [];
    const itemsSection =
      items.length > 0
        ? items
            .map(
              (item, i) =>
                `### Item ${i + 1}: ${item.id}\n${item.reasoning}\n\nAmbiguity: ${item.ambiguityReason || 'Unknown'}`,
            )
            .join('\n\n')
        : 'No specific items available — check the eval results in the log.';

    const ambiguousInstruction = getAgentPrompt('phase3', agentName);
    ttyPrompt = `
${ambiguousInstruction}

## Context
Spec: ${specContent.slice(0, 1500)}
Plans: ${plansContent.slice(0, 1500)}

## Ambiguous Items
${itemsSection}

${feedbackContent ? `## Previous Feedback\n${feedbackContent.slice(0, 500)}` : ''}

## Your Task
Review each ambiguous item and tell me:
1. Should I reply to the reviewer? If so, what should I say?
2. Should I make a code fix? If so, describe the fix.
3. Should I skip the item?

After resolving, apply any needed changes to the codebase.
`.trim();
  } else if (ttyReason === 'merge_conflict') {
    // Get conflict markers from current tree
    const grepResult =
      await $`grep -rn '<<<<<<<' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' || true`
        .cwd(session.worktree)
        .quiet()
        .text();
    const conflictFiles = grepResult
      .trim()
      .split('\n')
      .filter(f => f.length > 0);

    const conflictInstruction = getAgentPrompt('phase3', agentName);
    ttyPrompt = `
${conflictInstruction}

## Context
Spec: ${specContent.slice(0, 1500)}
Plans: ${plansContent.slice(0, 1500)}

## Conflicted Files
${conflictFiles.length > 0 ? conflictFiles.join('\n') : 'No conflict markers found in source files.'}

## Your Task
1. Open the conflicted files and resolve the merge conflicts
2. Stage the resolved files with \`git add\`
3. Continue the rebase with \`git rebase --continue\`
4. If the conflict cannot be resolved, run \`git rebase --abort\` and I will try an alternative approach

${feedbackContent ? `## Previous Feedback\n${feedbackContent.slice(0, 500)}` : ''}

Please resolve the merge conflicts and continue the rebase.
`.trim();
  } else {
    // run_fix_failure
    const failureInstruction = getAgentPrompt('phase3', agentName);
    ttyPrompt = `
${failureInstruction}

## Context
Spec: ${specContent.slice(0, 1500)}
Plans: ${plansContent.slice(0, 1500)}

## Your Task
Investigate the failure and help me determine the next steps. Options:
1. Fix the specific issue and retry
2. Skip this fix and move on
3. Escalate and stop

${feedbackContent ? `## Previous Feedback\n${feedbackContent.slice(0, 500)}` : ''}

Please review the situation and help me resolve the issue. Apply any needed changes.
`.trim();
  }

  // Record step init
  const ttyBinary = getAgentBinary('phase3', agentName);
  writeStepInit(session.id, version, `tty_resolve_${ttyReason || 'unknown'}`, {
    prompt: ttyPrompt,
    command: `${ttyBinary} (TTY handoff)`,
    type: 'tty_handoff',
  });

  // Hand off to TTY
  console.log(`[tty_resolve] Handing off to user for ${ttyReason}`);
  const exitCode = await spawnTTYWithTurnTracking(session.id, ttyBinary, ttyPrompt + TTY_EXIT_INSTRUCTION, {
    cwd: session.worktree,
    worktree: session.worktree,
  });

  // Check for changes after TTY handoff
  const diffResult = await $`git diff --name-only`.cwd(session.worktree).quiet().text();
  const changedFiles = diffResult
    .trim()
    .split('\n')
    .filter(f => f.length > 0);

  if (changedFiles.length > 0) {
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'tty_resolve:completed',
      version,
      metadata: {
        ttyReason,
        result: 'fixes_applied',
        filesChanged: changedFiles.length,
      },
    });
    return 'write_fix';
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'tty_resolve:completed',
    version,
    metadata: {
      ttyReason,
      result: 'no_fixes',
    },
  });

  return 'poll';
}
