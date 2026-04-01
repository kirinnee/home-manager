import { mkdirSync, readFileSync } from 'node:fs';
import type { Phase1Context } from './types';
import { appendEvent, readLog } from '../../core/log';
import { buildPromptVars, resolvePromptVars } from '../../core/type-config';
import { getDefaultBinary, ttyExitInstruction } from '../../core/agents';
import { writeStepInit } from '../../core/step-init';
import { spawnTTYWithTurnTracking, findLatestPlanDraftDir, readPlanDraftFiles } from '../shared';
import { logOk, logInfo } from '../../util/format';

/**
 * Non-negotiable mechanics injected by the runner — NOT part of the user-editable prompt.
 * Always prepended so users can freely edit type configs without breaking the pipeline.
 */
const PLAN_MECHANICS = `## CRITICAL: Plan Draft & Approval Mechanics

### Draft Files

Plan drafts are stored as subdirectories of the plans directory:
- First iteration: {plans}/plan-draft-1/plan-1.md, plan-2.md, etc.
- After feedback: {plans}/plan-draft-2/plan-1.md, plan-2.md, etc.
- And so on...

NEVER overwrite a previous draft directory. Always increment the ordinal.
Each draft directory contains the COMPLETE set of plans, NOT a diff or changelog.
Write the full plans every time, with changes applied inline.

### Approval Protocol

When the user approves the plans, you MUST do these things IN ORDER before exiting:
1. Write the approval event by running this command:
   \`kautopilot log-event plans:approved --metadata '{"draft": N}'\`
   (where N is the final draft ordinal number)
2. THEN tell the user to /exit

**CRITICAL**: Do NOT tell the user to /exit before writing the approval event.
If the session crashes or the user Ctrl+C's before the approval event is logged,
the plans will NOT be considered approved and this step will re-run from scratch.

---
`;

/**
 * [tty] Interactive plan writing via TTY handoff.
 *
 * The TTY Claude:
 * 1. Reads the approved spec (draft-spec.md)
 * 2. Writes plan-draft-N/plan-1.md, plan-2.md, etc. derived from the spec
 * 3. Creates a sub-teammate to run `kautopilot plan-review` for feedback
 * 4. Iterates until user approves and exits (/exit)
 */
export async function handleWritePlans(ctx: Phase1Context): Promise<string | null> {
  const { session, version, typeConfig } = ctx;

  if (!typeConfig) {
    throw new Error('typeConfig not set — route_type must run first');
  }

  // Check if plans were already approved (crash recovery — don't re-run)
  const events = readLog(session.id);
  const approved = events.some(e => e.event === 'plans:approved');
  if (approved) {
    logOk('Plans already approved — skipping write_plans');
    return 'finalize_plans';
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'write_plans:started',
    version,
    metadata: { stepType: 'tty' },
  });

  const vars = buildPromptVars(session.worktree, version);

  // Ensure plans dir exists
  mkdirSync(vars.plans, { recursive: true });

  // Build prompt from type config
  let prompt = resolvePromptVars(typeConfig.plan_writer.prompt, vars);

  // Prepend latest draft if resuming — mechanics go first so they're always at the top
  const latestDraft = findLatestPlanDraftDir(vars.plans);
  if (latestDraft) {
    logInfo(`Resuming from plan-draft-${latestDraft.ordinal}`);
    const mechanicsResolved = resolvePromptVars(PLAN_MECHANICS, vars);
    const draftFiles = readPlanDraftFiles(latestDraft.dir);
    const draftContents = draftFiles.map(f => `### ${f.filename}\n${f.content}`).join('\n\n---\n\n');
    prompt = `${mechanicsResolved}\n## Resuming: Current Draft is plan-draft-${latestDraft.ordinal}/\n\nYou are resuming a plan session. The latest draft is below. Continue from where you left off — the next draft should be plan-draft-${latestDraft.ordinal + 1}/.\n\n---\n${draftContents}\n---\n\n${prompt}`;
  } else {
    // Prepend mechanics for fresh starts too
    prompt = resolvePromptVars(PLAN_MECHANICS, vars) + prompt;
  }

  const binary = getDefaultBinary();
  writeStepInit(session.id, version, 'write_plans', {
    prompt,
    command: `${binary} (TTY handoff)`,
    type: 'tty_handoff',
  });

  console.log(`\n=== Writing Plans v${version} ===`);
  await spawnTTYWithTurnTracking(session.id, binary, prompt + ttyExitInstruction(session.id), {
    cwd: session.worktree,
    worktree: session.worktree,
  });

  // Check if approval event was logged during the TTY session
  const postEvents = readLog(session.id);
  const wasApproved = postEvents.some(e => e.event === 'plans:approved');
  if (!wasApproved) {
    logInfo('Plans not approved yet — will resume on next start');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'write_plans:interrupted',
      version,
    });
    return null;
  }

  logOk('Plans approved');

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'write_plans:completed',
    version,
  });

  return 'finalize_plans';
}
