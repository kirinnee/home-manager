import { getAgentBinary, getAgentPrompt } from '../../core/agents';
import { findLatestPlansPath, findLatestSpecPath } from '../../core/artifact-versioning';
import { snapshotPath } from '../../core/artifacts';
import { devloopInit, writeKloopConfig, writeKloopSpec } from '../../core/devloop';
import { appendEvent } from '../../core/log';
import { writeStepInit } from '../../core/step-init';
import { spawnPrintRaw } from '../../llm/spawn';
import { resolveActivePlans } from '../shared';
import type { Phase3Context } from './types';

// Mechanical context prepended by handler — NOT part of user-editable prompt
const WRITE_FIX_MECHANICS = `## Context Paths

- Spec: {spec_path}
- Plans: {plan_paths}
- Previous feedback: {feedback_path}

Read these files to understand the original context.

## Fixes
{fixes_section}

## Output Format

Write a structured implementation spec for each fix. Use this format:

### Fix N: [Title]

**File**: [path to file or files]

**Issue**: [what's wrong, referenced from PR feedback]

**Changes**:
- [specific change 1]
- [specific change 2]
- ...

**Definition of Done**:
- [ ] [verifiable condition 1]
- [ ] [verifiable condition 2]
- ...

Output ALL fixes in this format, one per section. Deduplicate overlapping fixes on the same file.`;

export async function handleWriteFix(ctx: Phase3Context): Promise<string | null> {
  const { session, version } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'write_fix:started',
    version,
    metadata: { stepType: 'llm' },
  });

  // Resolve file paths (don't inline content) — use versioned snapshots
  const specPath = findLatestSpecPath(session.id, version) || snapshotPath(session.id, version, 'task-spec.md');
  const latestPlansDir = findLatestPlansPath(session.id, version) || snapshotPath(session.id, version, 'plans');
  const planPaths = resolveActivePlans(latestPlansDir);
  const plansPathList = planPaths.join('\n');
  const feedbackPath = snapshotPath(session.id, version, 'feedback.md');

  // Build fixes section from eval results on context
  const evalResults = ctx.evalResults || [];
  const codeFixes = evalResults.filter(r => r.verdict === 'code_fix' && r.codeFix);

  const fixesSection =
    codeFixes.length > 0
      ? codeFixes.map((fix, i) => `### Fix ${i + 1}: ${fix.unitId}\n${fix.codeFix}`).join('\n\n')
      : 'Based on the current PR review feedback — check the eval results in the log for details.';

  // Get user-configurable prompt, then prepend mechanics
  const userPrompt = getAgentPrompt('phase3', 'write_fix');
  const mechanics = WRITE_FIX_MECHANICS.replace('{spec_path}', specPath)
    .replace('{plan_paths}', plansPathList)
    .replace('{feedback_path}', feedbackPath)
    .replace('{fixes_section}', fixesSection);
  const prompt = `${mechanics}\n\n${userPrompt}`;

  // Record step init
  const binary = getAgentBinary('phase3', 'write_fix');
  writeStepInit(session.id, version, 'write_fix', {
    prompt,
    command: `${binary} --print (LLM print)`,
    type: 'llm_print',
  });

  console.log(`[write_fix] Generating merged fix spec from ${codeFixes.length} code fixes...`);

  const fixSpec = await spawnPrintRaw(binary, prompt, {
    cwd: session.worktree,
    timeout: 60,
    sessionId: session.id,
    label: 'write-fix',
  });

  // Write fix spec to temp file and init kloop run
  const specPathKloop = writeKloopSpec(session.id, fixSpec, `fix-cycle-${ctx.pushCycle}-spec.md`);
  const configPath = writeKloopConfig(session.id, ctx.config.kloop);

  const kloopRunId = devloopInit(session.worktree, specPathKloop, configPath);
  ctx.kloopRunId = kloopRunId;
  console.log(`[write_fix] kloop run initialized: ${kloopRunId}`);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'write_fix:completed',
    version,
    metadata: {
      kloopRunId,
      codeFixCount: codeFixes.length,
    },
  });

  return 'run_fix';
}
