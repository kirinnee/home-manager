import { mkdirSync, readFileSync } from 'node:fs';
import type { Phase1Context } from './types';
import { appendEvent, readLog } from '../../core/log';
import { buildPromptVars, resolvePromptVars } from '../../core/type-config';
import { getDefaultBinary, getAgentPrompt } from '../../core/agents';
import { writeStepInit } from '../../core/step-init';
import { spawnTTYWithTurnTracking, findLatestPlanDraftDir, readPlanDraftFiles } from '../shared';
import { logOk, logInfo, logBanner } from '../../util/format';

/**
 * Non-negotiable mechanics injected by the runner — NOT part of the user-editable prompt.
 * Always prepended so users can freely edit type configs without breaking the pipeline.
 */
const PLAN_APPROVAL_PROTOCOL = `### Approval Protocol

When the user approves the plans, you MUST do these things IN ORDER before exiting:
1. Write the approval event by running this command:
   \`kautopilot log-event plans:approved --metadata '{"draft": N}'\`
   (where N is the final draft ordinal number)
2. THEN tell the user to /exit

**CRITICAL**: Do NOT tell the user to /exit before writing the approval event.
If the session crashes or the user Ctrl+C's before the approval event is logged,
the plans will NOT be considered approved and this step will re-run from scratch.`;

const PLAN_MECHANICS = `## CRITICAL: Plan Draft & Approval Mechanics

### Draft Files

Plan drafts are stored as subdirectories of the plans directory:
- First iteration: {plans}/plan-draft-1/plan-1.md, plan-2.md, etc.
- After feedback: {plans}/plan-draft-2/plan-1.md, plan-2.md, etc.
- And so on...

NEVER overwrite a previous draft directory. Always increment the ordinal.
Each draft directory contains the COMPLETE set of plans, NOT a diff or changelog.
Write the full plans every time, with changes applied inline.

Each plan file MUST follow this template:
{planTemplate}

${PLAN_APPROVAL_PROTOCOL}

### Spec Amendment Escalation

If during plan writing you discover the spec is wrong or incomplete:
1. Log the issue: \`kautopilot log-event spec_amendment:requested --metadata '{"reason": "..."}'\`
2. Tell the user to /exit — do NOT write plans:approved
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
  const { session, version, config } = ctx;

  // Check if plans were already approved for THIS version (crash recovery — don't re-run)
  // Use write_plans:completed (which has version) as the marker, since plans:approved
  // from log-event CLI doesn't carry version. This prevents old-version approvals
  // from skipping re-entered plan writing after spec amendment escalation.
  const events = readLog(session.id);
  const completedForThisVersion = events.some(e => e.event === 'write_plans:completed' && e.version === version);
  if (completedForThisVersion) {
    logOk('Plans already approved — skipping write_plans');
    return 'finalize_plans';
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'write_plans:started',
    version,
    metadata: { stepType: 'tty' },
  });

  const vars = buildPromptVars(session.worktree, version, session.ticket_id || 'local');

  // Ensure plans dir exists
  mkdirSync(vars.plans, { recursive: true });

  // Build prompt from config
  let prompt = getAgentPrompt('phase1', 'plan_writer', vars as unknown as Record<string, string>);

  // Prepend latest draft if resuming — mechanics go first so they're always at the top
  const latestDraft = findLatestPlanDraftDir(vars.plans);
  if (latestDraft) {
    logInfo(`Resuming from plan-draft-${latestDraft.ordinal}`);
    const mechanicsWithTemplate = PLAN_MECHANICS.replace('{planTemplate}', config.templates.plan);
    const mechanicsResolved = resolvePromptVars(mechanicsWithTemplate, vars);
    const draftFiles = readPlanDraftFiles(latestDraft.dir);
    const draftContents = draftFiles.map(f => `### ${f.filename}\n${f.content}`).join('\n\n---\n\n');
    prompt = `${mechanicsResolved}\n## Resuming: Current Draft is plan-draft-${latestDraft.ordinal}/\n\nYou are resuming a plan session. The latest draft is below. Continue from where you left off — the next draft should be plan-draft-${latestDraft.ordinal + 1}/.\n\n---\n${draftContents}\n---\n\n${prompt}`;
  } else {
    // Prepend mechanics for fresh starts too — inject template first
    const mechanicsWithTemplate = PLAN_MECHANICS.replace('{planTemplate}', config.templates.plan);
    prompt = resolvePromptVars(mechanicsWithTemplate, vars) + prompt;
  }

  const binary = getDefaultBinary();
  writeStepInit(session.id, version, 'write_plans', {
    prompt,
    command: `${binary} (TTY handoff)`,
    type: 'tty_handoff',
  });

  logBanner('Writing Plans', { Version: `v${version}` });
  await spawnTTYWithTurnTracking(session.id, binary, prompt, {
    cwd: session.worktree,
    worktree: session.worktree,
  });

  // Check if approval/amendment events were logged during THIS version's TTY session.
  // Scope to events after write_plans:started for the current version, so that
  // old events from previous versions don't poison the check.
  const postEvents = readLog(session.id);
  const startedIdx = postEvents.findLastIndex(e => e.event === 'write_plans:started' && e.version === version);
  const eventsSinceStart = startedIdx >= 0 ? postEvents.slice(startedIdx + 1) : postEvents;
  const wasApproved = eventsSinceStart.some(e => e.event === 'plans:approved');
  const amendmentRequested = eventsSinceStart.some(e => e.event === 'spec_amendment:requested');

  // Approval takes precedence over amendment (per spec: escalation only when no plans:approved)
  if (wasApproved) {
    logOk('Plans approved');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'write_plans:completed',
      version,
    });
    return 'finalize_plans';
  }

  if (amendmentRequested) {
    // Spec amendment escalation — return 'amend_spec' to trigger version increment
    logOk('Spec amendment requested — escalating to new spec version');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'write_plans:escalated',
      version,
    });
    return 'amend_spec';
  }

  logInfo('Plans not approved yet — will resume on next start');
  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'write_plans:interrupted',
    version,
  });
  return null;
}
