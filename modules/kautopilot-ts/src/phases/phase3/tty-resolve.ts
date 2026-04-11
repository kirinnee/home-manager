import { getAgentBinary, getAgentPrompt } from '../../core/agents';
import { findLatestPlansPath, findLatestSpecPath } from '../../core/artifact-versioning';
import { snapshotPath } from '../../core/artifacts';
import { appendEvent, readLog } from '../../core/log';
import { writeStepInit } from '../../core/step-init';
import { resolveActivePlans, spawnTTYWithTurnTracking } from '../shared';
import type { Phase3Context } from './types';

const MAX_RESTARTS = 5;

// Mechanical instructions prepended by handler — NOT part of user-editable prompt
const TTY_RESOLVE_MECHANICS = {
  ambiguous: `## Your Task
Review each ambiguous item and decide:
1. Should I reply to the reviewer? If so, what should I say?
2. Should I make a code fix? If so, describe the fix.
3. Should I skip the item?

After resolving, apply any needed changes to the codebase.

### Interaction Protocol — STRICT

1. **You suggest first.** Propose how to handle each ambiguous item — do not open with "what do you want to do?"
2. **Debate with the user.** Iterate until you both agree on the resolution.
3. **Confirm the final decision.** State clearly what you both agreed on so there is no ambiguity.
4. **Wait for explicit approval.** The user must say "approve" (or a clear equivalent like "yes approve this"). Ambiguous acknowledgements like "ok", "sounds good", or "sure" are NOT approval — ask for explicit confirmation.
5. **Only after approval**, apply the changes and run:
   \`kautopilot log-event tty_resolve:approved --metadata '{"reason": "ambiguous_eval"}'\`
6. **Only after the event is logged**, tell the user: "All set — type /exit (or Ctrl+C) to continue kautopilot."

**DO NOT mention /exit before step 6.** If the user exits early, this step re-runs from scratch.
**DO NOT log the event before step 4.** Explicit approval is the only gate.`,

  conflict: `## Your Task
1. Open the conflicted files and resolve the merge conflicts
2. Stage the resolved files with \`git add\`
3. Continue the rebase with \`git rebase --continue\`
4. If the conflict cannot be resolved, run \`git rebase --abort\` and I will try an alternative approach

### Interaction Protocol — STRICT

1. **You suggest first.** Propose how to resolve each conflict — do not open with "what do you want to do?"
2. **Debate with the user.** Iterate until you both agree on the resolution.
3. **Confirm the final decision.** State clearly what you both agreed on so there is no ambiguity.
4. **Wait for explicit approval.** The user must say "approve" (or a clear equivalent like "yes approve this"). Ambiguous acknowledgements like "ok", "sounds good", or "sure" are NOT approval — ask for explicit confirmation.
5. **Only after approval**, apply the changes and run:
   \`kautopilot log-event tty_resolve:approved --metadata '{"reason": "merge_conflict"}'\`
6. **Only after the event is logged**, tell the user: "All set — type /exit (or Ctrl+C) to continue kautopilot."

**DO NOT mention /exit before step 6.** If the user exits early, this step re-runs from scratch.
**DO NOT log the event before step 4.** Explicit approval is the only gate.`,

  failure: `## Your Task
Investigate the failure and help determine the next steps. Options:
1. Fix the specific issue and retry
2. Skip this fix and move on
3. Escalate and stop

### Interaction Protocol — STRICT

1. **You suggest first.** Propose how to fix the failure — do not open with "what do you want to do?"
2. **Debate with the user.** Iterate until you both agree on the resolution.
3. **Confirm the final decision.** State clearly what you both agreed on so there is no ambiguity.
4. **Wait for explicit approval.** The user must say "approve" (or a clear equivalent like "yes approve this"). Ambiguous acknowledgements like "ok", "sounds good", or "sure" are NOT approval — ask for explicit confirmation.
5. **Only after approval**, apply the changes and run:
   \`kautopilot log-event tty_resolve:approved --metadata '{"reason": "run_fix_failure"}'\`
6. **Only after the event is logged**, tell the user: "All set — type /exit (or Ctrl+C) to continue kautopilot."

**DO NOT mention /exit before step 6.** If the user exits early, this step re-runs from scratch.
**DO NOT log the event before step 4.** Explicit approval is the only gate.`,
};

export async function handleTtyResolve(ctx: Phase3Context): Promise<string | null> {
  const { session, version, ttyReason } = ctx;

  const { $ } = await import('bun');

  // Resolve file paths (don't inline content) — use versioned snapshots
  const specPath = findLatestSpecPath(session.id, version) || snapshotPath(session.id, version, 'task-spec.md');
  const latestPlansDir = findLatestPlansPath(session.id, version) || snapshotPath(session.id, version, 'plans');
  const planPaths = resolveActivePlans(latestPlansDir);
  const plansPathList = planPaths.join('\n');
  const feedbackPath = snapshotPath(session.id, version, 'feedback.md');

  // Determine agent name based on reason
  const agentName =
    ttyReason === 'ambiguous_eval'
      ? 'tty_resolve_ambiguous'
      : ttyReason === 'merge_conflict'
        ? 'tty_resolve_conflict'
        : 'tty_resolve_failure';

  let restartCount = 0;

  while (true) {
    const fenceEvent = restartCount === 0 ? 'tty_resolve:started' : 'tty_resolve:restarted';

    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: fenceEvent,
      version,
      metadata: { stepType: 'tty', ttyReason: ttyReason || 'unknown' },
    });

    // Get user-configurable prompt
    const userPrompt = getAgentPrompt('phase3', agentName);

    // Build TTY prompt based on reason — prepend mechanics to user prompt
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

      ttyPrompt = `
${userPrompt}

## Context
Spec path: ${specPath}
Plan paths:
${plansPathList}

## Ambiguous Items
${itemsSection}

## Previous Feedback
Read at: ${feedbackPath}

${TTY_RESOLVE_MECHANICS.ambiguous}
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

      ttyPrompt = `
${userPrompt}

## Context
Spec path: ${specPath}
Plan paths:
${plansPathList}

## Conflicted Files
${conflictFiles.length > 0 ? conflictFiles.join('\n') : 'No conflict markers found in source files.'}

${TTY_RESOLVE_MECHANICS.conflict}

## Previous Feedback
Read at: ${feedbackPath}
`.trim();
    } else {
      // run_fix_failure
      ttyPrompt = `
${userPrompt}

## Context
Spec path: ${specPath}
Plan paths:
${plansPathList}

${TTY_RESOLVE_MECHANICS.failure}

## Previous Feedback
Read at: ${feedbackPath}
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
    await spawnTTYWithTurnTracking(session.id, ttyBinary, ttyPrompt, {
      cwd: session.worktree,
      worktree: session.worktree,
    });

    // Read events since fence event
    const allEvents = readLog(session.id);
    const fenceIdx = allEvents.findLastIndex(e => e.event === fenceEvent);
    const eventsSince = fenceIdx >= 0 ? allEvents.slice(fenceIdx + 1) : allEvents;

    // Check approval event
    const approved = eventsSince.some(e => e.event === 'tty_resolve:approved');
    if (!approved) {
      if (restartCount >= MAX_RESTARTS) {
        throw new Error('TTY resolve restarted too many times without approval');
      }
      restartCount++;
      console.log(
        `[tty_resolve] No tty_resolve:approved found — restarting TTY (attempt ${restartCount}/${MAX_RESTARTS})`,
      );
      continue;
    }

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
}
