import { existsSync, mkdirSync } from 'node:fs';
import { getAgentPrompt, getDefaultBinary } from '../../core/agents';
import { snapshotPath } from '../../core/artifacts';
import { appendEvent, readLog } from '../../core/log';
import { writeStepInit } from '../../core/step-init';
import { buildPromptVars, resolvePromptVars } from '../../core/type-config';
import { logBanner, logInfo, logOk } from '../../util/format';
import { spawnTTYWithTurnTracking } from '../shared';
import type { Phase1Context } from './types';

/**
 * Non-negotiable mechanics injected by the runner — NOT part of the user-editable prompt.
 * Always prepended so users can freely edit type configs without breaking the pipeline.
 */
const SPEC_APPROVAL_PROTOCOL = `### Approval Protocol

When the user approves the spec, you MUST do these things IN ORDER before exiting:
1. Write the approval event by running this command:
   \`kautopilot log-event spec:approved\`
2. THEN tell the user to /exit

**CRITICAL**: Do NOT tell the user to /exit before writing the approval event.
If the session crashes or the user Ctrl+C's before the approval event is logged,
the spec will NOT be considered approved and this step will re-run from scratch.`;

const SPEC_MECHANICS = `## CRITICAL: Spec Writing & Approval Mechanics

### Working Copy

Write the spec to the working copy file:
- {spec}

This is the ONLY spec file you edit. On each feedback round, edit this same file in-place
and re-snapshot. Do NOT create numbered drafts or separate files — the snapshot command
handles versioning automatically.

Each version MUST be a complete, standalone spec — NOT a changelog or diff. Write the full spec
every time, with changes applied inline. Do NOT add "Changed:" or "Updated:" annotations.

Each version MUST follow this template:
{specTemplate}

### Snapshot Workflow (COMPULSORY)

After each edit cycle (writing or editing the spec), you MUST create a snapshot:
\`\`\`bash
kautopilot snapshot spec
\`\`\`

This copies the working copy to a versioned snapshot in the global artifacts directory.
The epoch version is auto-detected from the session — you do not need to specify it.
The snapshot command outputs:
- SNAPSHOT_VERSION=N (the new version number)
- SNAPSHOT_PATH=... (the path to the snapshot)

This step is COMPULSORY — do not skip it. It creates an audit trail of all spec versions.

### Previous Epoch Feedback

{feedback_reference}

${SPEC_APPROVAL_PROTOCOL}
`;

/**
 * [tty] Interactive spec writing via TTY handoff.
 *
 * The TTY Claude creates a team to gather context, debates with user,
 * writes/edits the working copy (task-spec.md), snapshots each version,
 * and logs spec:approved before exiting.
 */
export async function handleWriteSpec(ctx: Phase1Context): Promise<string | null> {
  const { session, version, config } = ctx;

  // Check if spec was already approved for THIS version (crash recovery — don't re-run)
  const events = readLog(session.id);
  const completedForThisVersion = events.some(e => e.event === 'write_spec:completed' && e.version === version);
  if (completedForThisVersion) {
    logOk('Spec already approved — skipping write_spec');
    return 'finalize_spec';
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'write_spec:started',
    version,
    metadata: { stepType: 'tty' },
  });

  const vars = buildPromptVars(session.worktree, version, session.ticket_id || 'local');

  // Build feedback reference for new epochs (v{N} reads v{N-1}/feedback.md)
  let feedbackReference = 'No previous epoch feedback — this is the first epoch.';
  if (version > 1) {
    const prevFeedbackPath = snapshotPath(session.id, version - 1, 'feedback.md');
    if (existsSync(prevFeedbackPath)) {
      feedbackReference = `This is epoch v${version}. The previous epoch v${version - 1} failed. Read the feedback at:\n${prevFeedbackPath}\n\nAddress this feedback in your new spec.`;
    }
  }

  // Ensure spec dir exists
  mkdirSync(vars.specDir, { recursive: true });

  // Build prompt from config
  let prompt = getAgentPrompt('phase1', 'spec_writer', vars as unknown as Record<string, string>);

  // Build spec amendment context note if present (from amend_spec escalation)
  // Use path reference, not inlined content (per spec: paths, not inlined content)
  const amendmentNote = ctx.specAmendmentContext
    ? `\n## Previous Spec Amendment\n\nThe spec needs amendment because: ${ctx.specAmendmentContext.reason}\nThe previous spec v${ctx.specAmendmentContext.previousVersion} is at:\n${ctx.specAmendmentContext.previousSpecPath}\n\nRead the previous spec to understand what needs to be amended.\n`
    : '';

  // Build mechanics with template, feedback reference
  const mechanicsResolved = SPEC_MECHANICS.replace('{specTemplate}', config.templates.spec).replace(
    '{feedback_reference}',
    feedbackReference,
  );
  const mechanicsPrompt = resolvePromptVars(mechanicsResolved, vars);

  // Prepend existing working copy if resuming (use path, not inlined content)
  let resumeNote = '';
  if (existsSync(vars.spec)) {
    resumeNote = `\n## Resuming: task-spec.md exists\n\nYou are resuming a spec session. The working copy is at:\n${vars.spec}\n\nRead it and continue editing in-place.\n\n`;
    logInfo('Resuming from existing task-spec.md');
  }

  prompt = mechanicsPrompt + amendmentNote + resumeNote + prompt;

  const binary = getDefaultBinary();
  writeStepInit(session.id, version, 'write_spec', {
    prompt,
    command: `${binary} (TTY handoff)`,
    type: 'tty_handoff',
  });

  logBanner('Writing Spec', { Version: `v${version}` });
  await spawnTTYWithTurnTracking(session.id, binary, prompt, {
    cwd: session.worktree,
    worktree: session.worktree,
  });

  // Check if approval event was logged during THIS version's TTY session
  const postEvents = readLog(session.id);
  const startedIdx = postEvents.findLastIndex(e => e.event === 'write_spec:started' && e.version === version);
  const eventsSinceStart = startedIdx >= 0 ? postEvents.slice(startedIdx + 1) : postEvents;
  const wasApproved = eventsSinceStart.some(e => e.event === 'spec:approved');
  if (!wasApproved) {
    logInfo('Spec not approved yet — will resume on next start');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'write_spec:interrupted',
      version,
    });
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
