import { existsSync } from 'node:fs';
import { resolveSpec, resolveActivePlans } from '../shared';
import type { Phase2Context } from './types';
import { appendEvent } from '../../core/log';
import { spawnPrintRaw, stripCodeFences } from '../../llm/spawn';
import { writeStepInit } from '../../core/step-init';
import { getAgentBinary } from '../../core/agents';
import { COMMIT_AGENT_PROMPT } from '../../core/types';
import { updatePlanManifestEntry } from '../../core/manifests';
import { snapshotPath } from '../../core/artifacts';

export async function handleCommit(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex } = ctx;

  const planName = `plan-${planIndex + 1}`;
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'commit:started',
    version,
    plan: planName,
    metadata: { stepType: 'code' },
  });

  // Resolve the active plan path (don't inline content)
  const activePlans = resolveActivePlans(snapshotPath(session.id, version, 'plans'));
  const activePlanPath = activePlans[planIndex];
  const planPath =
    activePlanPath && existsSync(activePlanPath)
      ? activePlanPath
      : snapshotPath(session.id, version, `plans/plan-${planIndex + 1}-1.md`);

  // Build context section for the commit agent
  const contextSection = `### Plan Context\nRead the plan at: ${planPath}`;

  // Use shared COMMIT_AGENT_PROMPT directly
  const prompt = COMMIT_AGENT_PROMPT.replace('{context}', contextSection);

  const binary = getAgentBinary('phase2', 'commit');
  writeStepInit(session.id, version, 'commit', {
    prompt,
    command: `${binary} --print (LLM commit)`,
    type: 'llm_print',
  });

  const result = await spawnPrintRaw(binary, prompt, {
    cwd: session.worktree,
    timeout: 120,
    sessionId: session.id,
    label: 'commit',
  });

  const commitSha = stripCodeFences(result).trim().split('\n')[0];

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'commit:completed',
    version,
    plan: planName,
    metadata: { commitSha },
  });

  if (commitSha && /^[0-9a-f]{7,40}$/.test(commitSha)) {
    updatePlanManifestEntry(session.id, version, planIndex + 1, true, commitSha);
    console.log(`[commit] Committed: ${commitSha.slice(0, 7)}`);
  } else {
    console.warn(`[commit] Unexpected output (expected SHA): ${commitSha.slice(0, 60)}`);
  }

  return 'next_plan';
}
