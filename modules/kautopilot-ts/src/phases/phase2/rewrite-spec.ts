import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Phase2Context } from './types';
import { appendEvent } from '../../core/log';
import { writePlanManifest } from '../../core/manifests';
import { devloopInit, writeKloopSpec, writeKloopConfig } from '../../core/devloop';
import { sessionDir, snapshotPath, ensureArtifactDir } from '../../core/artifacts';
import { spawnPrintRaw } from '../../llm/spawn';
import { resolveSpec } from '../shared';
import { writeStepInit } from '../../core/step-init';
import { getAgentPrompt, getAgentBinary } from '../../core/agents';

export function getRewriteTargets(
  plansDir: string,
  currentPlanIndex: number,
  decision: Phase2Context['lastRewriteDecision'],
): number[] {
  const filenames = readdirSync(plansDir).filter(
    name => /^plan-\d+-\d+\.md$/.test(name) || /^plan-\d+\.md$/.test(name),
  );
  const ordinals = Array.from(
    new Set(
      filenames
        .map(name => name.match(/^plan-(\d+)(?:-\d+)?\.md$/)?.[1])
        .filter((value): value is string => !!value)
        .map(value => parseInt(value, 10)),
    ),
  ).sort((a, b) => a - b);

  if (decision === 'patch_downstream' || decision === 'regenerate_remaining') {
    return ordinals.filter(ordinal => ordinal - 1 >= currentPlanIndex);
  }

  return [currentPlanIndex + 1];
}

export function nextRewriteNumber(plansDir: string, ordinal: number): number {
  const filenames = readdirSync(plansDir);
  let maxRewrite = 0;
  for (const filename of filenames) {
    const match = filename.match(new RegExp(`^plan-${ordinal}(?:-(\\d+))?\\.md$`));
    if (!match) continue;
    const rewrite = match[1] ? parseInt(match[1], 10) : 1;
    maxRewrite = Math.max(maxRewrite, rewrite);
  }
  return maxRewrite + 1;
}

export async function handleRewriteSpec(ctx: Phase2Context): Promise<string | null> {
  const { session, version, planIndex, attempt } = ctx;

  const planName = `plan-${planIndex + 1}`;
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'rewrite_spec:started',
    version,
    plan: planName,
    attempt,
    metadata: { stepType: 'llm' },
  });

  // Read resolution and original plan content
  const resolutionPath = `${sessionDir(session.id)}/tmp/resolution.md`;
  const resolution = existsSync(resolutionPath) ? readFileSync(resolutionPath, 'utf-8') : '';
  const plansDir = snapshotPath(session.id, version, 'plans');
  const currentPlanCandidates = readdirSync(plansDir)
    .filter(name => new RegExp(`^plan-${planIndex + 1}(?:-\\d+)?\\.md$`).test(name))
    .sort();
  const activePlanPath =
    currentPlanCandidates.length > 0
      ? join(plansDir, currentPlanCandidates[currentPlanCandidates.length - 1])
      : snapshotPath(session.id, version, `plans/plan-${planIndex + 1}-1.md`);
  const planContent = existsSync(activePlanPath)
    ? readFileSync(activePlanPath, 'utf-8')
    : resolveSpec(session.id, version, `plans/plan-${planIndex + 1}-1.md`);
  const taskSpecContent = resolveSpec(session.id, version);

  const rewriteInstruction = getAgentPrompt('phase2', 'rewrite_spec');
  const rewritePrompt = `
${rewriteInstruction}

RESOLUTION:
${resolution}

CURRENT SPEC:
${planContent}

TASK SPEC:
${taskSpecContent}
`.trim();

  // Record step init
  const binary = getAgentBinary('phase2', 'rewrite_spec');
  writeStepInit(session.id, version, 'rewrite_spec', {
    prompt: rewritePrompt,
    command: `${binary} --print (LLM print)`,
    type: 'llm_print',
  });

  const rewriteDecision = ctx.lastRewriteDecision ?? 'refine_local';
  const rewriteTargets = getRewriteTargets(plansDir, planIndex, rewriteDecision);
  const rewrittenPlans: string[] = [];

  for (const ordinal of rewriteTargets) {
    const targetPlanPath = snapshotPath(
      session.id,
      version,
      `plans/plan-${ordinal}-${ordinal === planIndex + 1 ? attempt : 1}.md`,
    );
    const targetPlanContent = existsSync(targetPlanPath)
      ? readFileSync(targetPlanPath, 'utf-8')
      : resolveSpec(session.id, version, `plans/plan-${ordinal}-1.md`);

    const targetPrompt = `
${rewriteInstruction}

REWRITE DECISION:
${rewriteDecision}

TARGET PLAN: plan-${ordinal}

RESOLUTION:
${resolution}

CURRENT SPEC:
${targetPlanContent}

TASK SPEC:
${taskSpecContent}
`.trim();

    const rewrittenPlan = await spawnPrintRaw(binary, targetPrompt, {
      cwd: session.worktree,
      timeout: 60,
      sessionId: session.id,
      label: `rewrite-spec-plan-${ordinal}`,
    });

    const rewriteFilename = `plan-${ordinal}-${nextRewriteNumber(plansDir, ordinal)}.md`;
    const rewritePath = join(plansDir, rewriteFilename);
    ensureArtifactDir(rewritePath);
    writeFileSync(rewritePath, rewrittenPlan);
    rewrittenPlans.push(rewriteFilename);
  }

  writePlanManifest(session.id, version);

  // Init a new kloop run with the rewritten active plan
  const activeRewriteFilename = rewrittenPlans[0] ?? `plan-${planIndex + 1}-${attempt + 1}.md`;
  const activeRewritePath = join(plansDir, activeRewriteFilename);
  const rewrittenActivePlan = readFileSync(activeRewritePath, 'utf-8');
  const specPath = writeKloopSpec(session.id, rewrittenActivePlan, `plan-${planIndex + 1}-rewrite-${attempt}.md`);
  const configPath = writeKloopConfig(session.id, {
    maxIterations: ctx.config.kloop.maxIterations,
    implementerTimeout: ctx.config.kloop.implementerTimeout,
    reviewerTimeout: ctx.config.kloop.reviewerTimeout,
  });

  const kloopRunId = devloopInit(session.worktree, specPath, configPath);
  ctx.kloopRunId = kloopRunId;
  console.log(`[rewrite_spec] New kloop run initialized: ${kloopRunId}`);

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'rewrite_spec:completed',
    version,
    plan: planName,
    attempt,
    metadata: { kloopRunId, rewriteDecision, rewrittenPlans },
  });

  // Increment attempt and go back to running
  ctx.attempt += 1;

  return 'running';
}
