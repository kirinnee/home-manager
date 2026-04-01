import { existsSync, readFileSync } from 'node:fs';
import type { Phase3Context } from './types';
import { appendEvent } from '../../core/log';
import { spawnPrintRaw } from '../../llm/spawn';
import { devloopInit, writeKloopSpec, writeKloopConfig } from '../../core/devloop';
import { sessionDir } from '../../core/artifacts';
import { resolveSpec, resolvePlans } from '../shared';
import { writeStepInit } from '../../core/step-init';
import { getAgentPrompt, getAgentBinary } from '../../core/agents';

export async function handleWriteFix(ctx: Phase3Context): Promise<string | null> {
  const { session, version, ticketId } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'write_fix:started',
    version,
    metadata: { stepType: 'llm' },
  });

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

  // Build fixes section from eval results on context
  const evalResults = ctx.evalResults || [];
  const codeFixes = evalResults.filter(r => r.verdict === 'code_fix' && r.codeFix);

  const fixesSection =
    codeFixes.length > 0
      ? codeFixes.map((fix, i) => `### Fix ${i + 1}: ${fix.unitId}\n${fix.codeFix}`).join('\n\n')
      : 'Based on the current PR review feedback — check the eval results in the log for details.';

  // Build fix spec from context
  const writeFixInstruction = getAgentPrompt('phase3', 'write_fix');
  const fixPrompt = `
${writeFixInstruction}

## Original Spec
${specContent}

## Original Plans
${plansContent}

## Fixes Needed
${fixesSection}

${feedbackContent ? `## Previous Feedback\n${feedbackContent}` : ''}

## Instructions
1. Review all pending fixes
2. Deduplicate any overlapping fixes on the same file
3. Merge into one coherent implementation spec
4. Output the complete spec (not just the changes)

Output the complete implementation spec.
`.trim();

  // Record step init
  const binary = getAgentBinary('phase3', 'write_fix');
  writeStepInit(session.id, version, 'write_fix', {
    prompt: fixPrompt,
    command: `${binary} --print (LLM print)`,
    type: 'llm_print',
  });

  console.log(`[write_fix] Generating merged fix spec from ${codeFixes.length} code fixes...`);

  const fixSpec = await spawnPrintRaw(binary, fixPrompt, {
    cwd: session.worktree,
    timeout: 60,
    sessionId: session.id,
    label: 'write-fix',
  });

  // Write fix spec to temp file and init kloop run
  const specPath = writeKloopSpec(session.id, fixSpec, `fix-cycle-${ctx.pushCycle}-spec.md`);
  const configPath = writeKloopConfig(session.id, {
    maxIterations: ctx.config.kloop.maxIterations,
    implementerTimeout: ctx.config.kloop.implementerTimeout,
    reviewerTimeout: ctx.config.kloop.reviewerTimeout,
  });

  const kloopRunId = devloopInit(session.worktree, specPath, configPath);
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
