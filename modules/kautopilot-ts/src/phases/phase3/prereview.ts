import { spawn } from 'bun';
import { getAgentBinary, getAgentPrompt } from '../../core/agents';
import { appendEvent } from '../../core/log';
import { writeStepInit } from '../../core/step-init';
import { spawnPrintRaw, spawnPrintToFile } from '../../llm/spawn';
import type { Phase3Context } from './types';

export async function handlePrereview(ctx: Phase3Context): Promise<string | null> {
  const { session, version, config } = ctx;

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'prereview:started',
    version,
    metadata: { stepType: 'llm' },
  });

  // Prereview requires CodeRabbit — skip entirely if disabled
  if (!config.settings.coderabbit) {
    console.log('[prereview] CodeRabbit disabled in config — skipping');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'prereview:completed',
      version,
      metadata: { skipped: true, reason: 'coderabbit_disabled' },
    });
    return 'push';
  }

  // Check if coderabbit is available
  let coderabbitAvailable = false;
  try {
    const whichProc = spawn({
      cmd: ['which', 'coderabbit'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await whichProc.exited;
    coderabbitAvailable = exitCode === 0;
  } catch {
    coderabbitAvailable = false;
  }

  if (!coderabbitAvailable) {
    console.log('[prereview] CodeRabbit not installed — skipping');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'prereview:completed',
      version,
      metadata: { skipped: true, reason: 'coderabbit_not_installed' },
    });
    return 'push';
  }

  // Run CodeRabbit local review
  console.log('[prereview] Running CodeRabbit local review...');
  let reviewOutput = '';
  try {
    const proc = spawn({
      cmd: ['coderabbit', 'review', '--plain', '--base', ctx.baseBranch],
      cwd: session.worktree,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;

    reviewOutput = stdout.trim();
    if (stderr) console.error(`[prereview] CodeRabbit stderr: ${stderr.slice(0, 500)}`);
  } catch (err) {
    console.warn('[prereview] CodeRabbit failed:', err);
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'prereview:completed',
      version,
      metadata: {
        skipped: true,
        reason: 'coderabbit_error',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return 'push';
  }

  if (!reviewOutput) {
    console.log('[prereview] CodeRabbit returned no findings');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'prereview:completed',
      version,
      metadata: { skipped: true, reason: 'no_findings' },
    });
    return 'push';
  }

  // LLM --print: classify CodeRabbit findings
  interface Finding {
    action: 'fix' | 'comment' | 'ignore';
    file: string;
    description: string;
    fix?: string;
  }

  const classifyInstruction = getAgentPrompt('phase3', 'prereview_classify');
  const classifyPrompt = `
${classifyInstruction}

CodeRabbit findings:
${reviewOutput}

For each finding, decide:
- "fix": True positive issue that should be fixed now
- "comment": Valid concern but doesn't need code change
- "ignore": False positive or not applicable

Output a JSON array of objects with: action, file, description, fix (for "fix" items, provide the fix instructions).
`.trim();

  // Record step init
  const classifyBinary = getAgentBinary('phase3', 'prereview_classify');
  writeStepInit(session.id, version, 'prereview', {
    prompt: classifyPrompt,
    command: `${classifyBinary} --print (LLM print) + coderabbit review`,
    type: 'llm_print',
  });

  let findings: Finding[] = [];
  try {
    findings = await spawnPrintToFile<Finding[]>(classifyBinary, classifyPrompt, {
      cwd: session.worktree,
      timeout: 60,
      sessionId: session.id,
      label: 'prereview-classify',
    });
  } catch (err) {
    console.warn('[prereview] LLM classification failed:', err);
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'prereview:completed',
      version,
      metadata: { skipped: true, reason: 'llm_classification_failed' },
    });
    return 'push';
  }

  const fixes = findings.filter(f => f.action === 'fix');
  if (fixes.length === 0) {
    console.log(`[prereview] No actionable fixes (${findings.length} findings, all comments/ignored)`);
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'prereview:completed',
      version,
      metadata: {
        totalFindings: findings.length,
        fixesApplied: 0,
      },
    });
    return 'push';
  }

  // Apply fixes via LLM
  const fixInstruction = getAgentPrompt('phase3', 'prereview_fix');
  const fixPrompt = `
${fixInstruction}

${fixes.map((f, i) => `## Fix ${i + 1}: ${f.file}\n${f.description}\nFix: ${f.fix || 'determine appropriate fix'}`).join('\n\n')}
`.trim();

  try {
    const _exitCode = await spawnPrintRaw(getAgentBinary('phase3', 'prereview_fix'), fixPrompt, {
      cwd: session.worktree,
      timeout: 120,
      sessionId: session.id,
      label: 'prereview-fix',
    });
    console.log(`[prereview] Applied ${fixes.length} fixes`);
  } catch (err) {
    console.warn('[prereview] Fix application failed:', err);
  }

  // Commit the fixes if there are changes
  const { $ } = await import('bun');
  try {
    const diffResult = await $`git diff --name-only`.cwd(session.worktree).quiet().text();
    const changedFiles = diffResult
      .trim()
      .split('\n')
      .filter(f => f.length > 0);
    if (changedFiles.length > 0) {
      const commitMsg = await spawnPrintRaw(
        getAgentBinary('phase3', 'commit_pending'),
        'Generate a short commit message for CodeRabbit fixes. Output only the message.',
        {
          cwd: session.worktree,
          timeout: 15,
          sessionId: session.id,
          label: 'prereview-commit',
        },
      );
      for (const file of changedFiles) {
        await $`git add ${file}`.cwd(session.worktree).quiet();
      }
      await $`git commit -m ${commitMsg}`.cwd(session.worktree).quiet();
      console.log('[prereview] Committed prereview fixes');
    }
  } catch (err) {
    console.warn('[prereview] Failed to commit fixes:', err);
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'prereview:completed',
    version,
    metadata: {
      totalFindings: findings.length,
      fixesApplied: fixes.length,
    },
  });

  return 'push';
}
