import { existsSync, mkdirSync } from 'node:fs';
import { getAgentPrompt, getDefaultBinary } from '../../core/agents';
import { findLatestPlansPath } from '../../core/artifact-versioning';
import { snapshotPath } from '../../core/artifacts';
import { appendEvent, readLog } from '../../core/log';
import { writeStepInit } from '../../core/step-init';
import { buildPromptVars, resolvePromptVars } from '../../core/type-config';
import { logBanner, logInfo, logOk } from '../../util/format';
import { discoverPlans, spawnTTYWithTurnTracking } from '../shared';
import type { Phase1Context } from './types';

/**
 * Non-negotiable mechanics injected by the runner — NOT part of the user-editable prompt.
 * Always prepended so users can freely edit type configs without breaking the pipeline.
 */
const PLAN_APPROVAL_PROTOCOL = `### Interaction Protocol — STRICT

Follow this loop for the plans approval:

1. **You suggest first.** Based on your analysis, propose concrete plans — do not open with "what do you want to do?" The user hired you to be proactive.
2. **Debate with the user.** They will push back, ask questions, suggest alternatives. Iterate until you both agree on the final plans.
3. **Confirm the final decision.** State clearly what you both agreed on so there is no ambiguity.
4. **Wait for explicit approval.** The user must say "approve" (or a clear equivalent like "yes approve this"). Ambiguous acknowledgements like "ok", "sounds good", or "sure" are NOT approval — ask for explicit confirmation.
5. **Only after approval**, run:
   \`kautopilot log-event plans:approved\`
6. **Only after the event is logged**, tell the user: "All set — type /exit (or Ctrl+C) to continue kautopilot."

**DO NOT mention /exit before step 6.** Mentioning it earlier makes the user think the session is over before the event is committed. If they exit early, this step re-runs from scratch.

**DO NOT log the event before step 4.** Explicit approval is the only gate.`;

const PLAN_MECHANICS = `## CRITICAL: Plan Writing & Approval Mechanics

### Working Copies

Write plan files directly in the plans directory:
- {plans}/plan-1.md
- {plans}/plan-2.md
- etc.

These are the ONLY plan files you edit. On each feedback round, edit these same files in-place
and re-snapshot. Do NOT create draft subdirectories — the snapshot command handles versioning
automatically.

Each version MUST be a complete, standalone set of plans — NOT a diff or changelog.
Write the full plans every time, with changes applied inline.

Each plan file MUST follow this template:
{planTemplate}

### Snapshot Workflow (COMPULSORY)

After each edit cycle (writing or editing the plans), you MUST create a snapshot:
\`\`\`bash
kautopilot snapshot plans
\`\`\`

This copies the working copies to a versioned snapshot in the global artifacts directory.
The epoch version is auto-detected from the session — you do not need to specify it.
The snapshot command outputs:
- SNAPSHOT_VERSION=N (the new version number)
- SNAPSHOT_PATH=... (the path to the snapshot)

This step is COMPULSORY — do not skip it. It creates an audit trail of all plan versions.

### Previous Epoch Feedback

{feedback_reference}

### Previous Epoch Plans (for reference only)

{previous_epoch_plans_reference}

### Spec Amendment Escalation

If during plan writing you discover the spec is wrong or incomplete:
1. **Suggest the escalation** — explain what's wrong with the spec and why plans can't proceed.
2. **Debate with the user** until they agree the spec needs amendment.
3. **Wait for explicit approval** — the user must say "approve" before you escalate.
4. **Only after approval**, log: \`kautopilot log-event spec_amendment:requested --metadata '{"reason": "..."}'\`
5. **Then** tell the user: "All set — type /exit (or Ctrl+C) to continue kautopilot."
Do NOT write plans:approved when escalating.

${PLAN_APPROVAL_PROTOCOL}
`;

/**
 * [tty] Interactive plan writing via TTY handoff.
 *
 * The TTY Claude:
 * 1. Reads the approved spec
 * 2. Writes plan-1.md, plan-2.md, etc. directly in plans/
 * 3. Snapshots each version
 * 4. Iterates until user approves and exits (/exit)
 */
export async function handleWritePlans(ctx: Phase1Context): Promise<string | null> {
  const { session, version, config } = ctx;

  // Check if plans were already approved for THIS version (crash recovery — don't re-run)
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

  // Build feedback reference for new epochs
  let feedbackReference = 'No previous epoch feedback — this is the first epoch.';
  if (version > 1) {
    const prevFeedbackPath = snapshotPath(session.id, version - 1, 'feedback.md');
    if (existsSync(prevFeedbackPath)) {
      feedbackReference = `This is epoch v${version}. The previous epoch v${version - 1} failed. Read the feedback at:\n${prevFeedbackPath}\n\nAddress this feedback in your plans.`;
    }
  }

  // Build previous epoch plans reference
  let previousEpochPlansReference = 'No previous epoch plans — this is the first epoch.';
  if (version > 1) {
    const prevPlansDir = findLatestPlansPath(session.id, version - 1);
    if (prevPlansDir) {
      previousEpochPlansReference = `Previous epoch v${version - 1} plans are at: ${prevPlansDir}\nRead them to understand what was attempted, but DO NOT trust their metadata. Ground yourself in actual codebase state (git diff, code state) to determine what's already done.`;
    }
  }

  // Ensure plans dir exists
  mkdirSync(vars.plans, { recursive: true });

  // Build prompt from config
  let prompt = getAgentPrompt('phase1', 'plan_writer', vars as unknown as Record<string, string>);

  // Build mechanics with template, feedback
  const mechanicsResolved = PLAN_MECHANICS.replace('{planTemplate}', config.templates.plan)
    .replace('{feedback_reference}', feedbackReference)
    .replace('{previous_epoch_plans_reference}', previousEpochPlansReference);
  const mechanicsPrompt = resolvePromptVars(mechanicsResolved, vars);

  // Prepend existing working copies if resuming (use paths, not inlined content)
  let resumeNote = '';
  const existingPlans = discoverPlans(vars.plans);
  if (existingPlans.length > 0) {
    const planPaths = existingPlans.map(p => `- ${p}`).join('\n');
    resumeNote = `\n## Resuming: Plans exist\n\nYou are resuming a plan session. The working copies are at:\n${planPaths}\n\nRead them and continue editing in-place.\n\n`;
    logInfo(`Resuming from ${existingPlans.length} existing plan(s)`);
  }

  prompt = mechanicsPrompt + resumeNote + prompt;

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
