import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import type { Phase1Context } from './types';
import { appendEvent, readLog } from '../../core/log';
import { buildPromptVars, resolvePromptVars } from '../../core/type-config';
import { getDefaultBinary, ttyExitInstruction } from '../../core/agents';
import { writeStepInit } from '../../core/step-init';
import { spawnTTYWithTurnTracking } from '../shared';
import { logOk, logInfo } from '../../util/format';

/**
 * Non-negotiable mechanics injected by the runner — NOT part of the user-editable prompt.
 * Always prepended so users can freely edit type configs without breaking the pipeline.
 */
const SPEC_MECHANICS = `## CRITICAL: Spec Draft & Approval Mechanics

### Draft Files

Every draft of the spec MUST be written as a new ordinal file:
- First draft: {specDir}/spec-draft-1.md
- After feedback: {specDir}/spec-draft-2.md
- After more feedback: {specDir}/spec-draft-3.md
- And so on...

NEVER overwrite a previous draft. Always increment the ordinal. This lets us diff between
versions to see exactly what changed.

Each draft MUST be a complete, standalone spec — NOT a changelog or diff. Write the full spec
every time, with changes applied inline. Do NOT add "Changed:" or "Updated:" annotations.
The draft should read as if it were written from scratch.

### Approval Protocol

When the user approves the spec, you MUST do these things IN ORDER before exiting:
1. Write the approval event by running this command:
   \`kautopilot log-event spec:approved --metadata '{"draft": N}'\`
   (where N is the final draft ordinal number)
2. THEN tell the user to /exit

**CRITICAL**: Do NOT tell the user to /exit before writing the approval event.
If the session crashes or the user Ctrl+C's before the approval event is logged,
the spec will NOT be considered approved and this step will re-run from scratch.

---
`;

/**
 * Find the latest spec-draft-N.md in the spec dir and return its content + ordinal.
 */
function findLatestDraft(specDir: string): { ordinal: number; content: string } | null {
  let files: string[];
  try {
    files = readdirSync(specDir);
  } catch {
    return null;
  }

  const drafts = files
    .filter(f => /^spec-draft-\d+\.md$/.test(f))
    .map(f => ({ file: f, ordinal: parseInt(f.match(/spec-draft-(\d+)\.md/)![1]) }))
    .sort((a, b) => b.ordinal - a.ordinal);

  if (drafts.length === 0) return null;

  const latest = drafts[0];
  const content = readFileSync(`${specDir}/${latest.file}`, 'utf-8');
  return { ordinal: latest.ordinal, content };
}

/**
 * [tty] Interactive spec writing via TTY handoff.
 *
 * The TTY Claude creates a team to gather context, debates with user,
 * writes ordinal spec drafts (spec-draft-1.md, spec-draft-2.md, ...),
 * and logs spec:approved before exiting.
 */
export async function handleWriteSpec(ctx: Phase1Context): Promise<string | null> {
  const { session, version, typeConfig } = ctx;

  if (!typeConfig) {
    throw new Error('typeConfig not set — route_type must run first');
  }

  // Check if spec was already approved (crash recovery — don't re-run)
  const events = readLog(session.id);
  const approved = events.some(e => e.event === 'spec:approved');
  if (approved) {
    logOk('Spec already approved — skipping write_spec');
    return 'finalize_spec';
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'write_spec:started',
    version,
    metadata: { stepType: 'tty' },
  });

  const vars = buildPromptVars(session.worktree, version);

  // Ensure spec dir exists
  mkdirSync(vars.specDir, { recursive: true });

  // Build prompt from type config
  let prompt = resolvePromptVars(typeConfig.spec_writer.prompt, vars);

  // Prepend latest draft if resuming — mechanics go first so they're always at the top
  const latest = findLatestDraft(vars.specDir);
  if (latest) {
    logInfo(`Resuming from spec-draft-${latest.ordinal}.md`);
    const resumeCtx = resolvePromptVars(SPEC_MECHANICS, vars);
    prompt = `${resumeCtx}\n## Resuming: Current Draft is spec-draft-${latest.ordinal}.md\n\nYou are resuming a spec session. The latest draft is below. Continue from where you left off — the next draft should be spec-draft-${latest.ordinal + 1}.md.\n\n---\n${latest.content}\n---\n\n${prompt}`;
  }

  const binary = getDefaultBinary();
  writeStepInit(session.id, version, 'write_spec', {
    prompt,
    command: `${binary} (TTY handoff)`,
    type: 'tty_handoff',
  });

  console.log(`\n=== Writing Spec v${version} ===`);
  await spawnTTYWithTurnTracking(session.id, binary, prompt + ttyExitInstruction(session.id), {
    cwd: session.worktree,
    worktree: session.worktree,
  });

  // Check if approval event was logged during the TTY session
  const postEvents = readLog(session.id);
  const wasApproved = postEvents.some(e => e.event === 'spec:approved');
  if (!wasApproved) {
    // TTY exited without approval — re-run on next start
    logInfo('Spec not approved yet — will resume on next start');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'write_spec:interrupted',
      version,
    });
    // Return null to stop the state machine (user needs to restart)
    return null;
  }

  logOk('Spec approved');

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'write_spec:completed',
    version,
  });

  return 'finalize_spec';
}
