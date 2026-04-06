import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import type { Phase1Context } from './types';
import { appendEvent, readLog } from '../../core/log';
import { buildPromptVars, resolvePromptVars } from '../../core/type-config';
import { getDefaultBinary, getAgentPrompt } from '../../core/agents';
import { writeStepInit } from '../../core/step-init';
import { spawnTTYWithTurnTracking } from '../shared';
import { logOk, logInfo, logBanner } from '../../util/format';

/**
 * Non-negotiable mechanics injected by the runner — NOT part of the user-editable prompt.
 * Always prepended so users can freely edit type configs without breaking the pipeline.
 */
const SPEC_APPROVAL_PROTOCOL = `### Approval Protocol

When the user approves the spec, you MUST do these things IN ORDER before exiting:
1. Write the approval event by running this command:
   \`kautopilot log-event spec:approved --metadata '{"draft": N}'\`
   (where N is the final draft ordinal number)
2. THEN tell the user to /exit

**CRITICAL**: Do NOT tell the user to /exit before writing the approval event.
If the session crashes or the user Ctrl+C's before the approval event is logged,
the spec will NOT be considered approved and this step will re-run from scratch.`;

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

Each draft MUST follow this template:
{specTemplate}

${SPEC_APPROVAL_PROTOCOL}
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
  const { session, version, config } = ctx;

  // Check if spec was already approved for THIS version (crash recovery — don't re-run)
  // Use write_spec:completed (which has version) as the marker, since spec:approved
  // from log-event CLI doesn't carry version. This prevents old-version approvals
  // from skipping re-entered spec writing after spec amendment escalation.
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

  // Ensure spec dir exists
  mkdirSync(vars.specDir, { recursive: true });

  // Build prompt from config
  let prompt = getAgentPrompt('phase1', 'spec_writer', vars as unknown as Record<string, string>);

  // Build spec amendment context note if present (from amend_spec escalation)
  const amendmentNote = ctx.specAmendmentContext
    ? `\n## Previous Spec Amendment\n\nPrevious spec v${ctx.specAmendmentContext.previousVersion} is below for reference. It needs amendment because: ${ctx.specAmendmentContext.reason}\n\n---\n${ctx.specAmendmentContext.previousSpec}\n---\n`
    : '';

  // Prepend latest draft if resuming — mechanics go first so they're always at the top
  const latest = findLatestDraft(vars.specDir);
  if (latest) {
    logInfo(`Resuming from spec-draft-${latest.ordinal}.md`);
    const mechanicsWithTemplate = SPEC_MECHANICS.replace('{specTemplate}', config.templates.spec);
    const resumeCtx = resolvePromptVars(mechanicsWithTemplate, vars);
    prompt = `${resumeCtx}${amendmentNote}\n## Resuming: Current Draft is spec-draft-${latest.ordinal}.md\n\nYou are resuming a spec session. The latest draft is below. Continue from where you left off — the next draft should be spec-draft-${latest.ordinal + 1}.md.\n\n---\n${latest.content}\n---\n\n${prompt}`;
  } else {
    // Prepend mechanics for fresh starts too — inject template first
    const mechanicsWithTemplate = SPEC_MECHANICS.replace('{specTemplate}', config.templates.spec);
    prompt = resolvePromptVars(mechanicsWithTemplate, vars) + amendmentNote + prompt;
  }

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
  // Scope to events after write_spec:started for the current version, so that
  // old approval events from previous versions don't count.
  const postEvents = readLog(session.id);
  const startedIdx = postEvents.findLastIndex(e => e.event === 'write_spec:started' && e.version === version);
  const eventsSinceStart = startedIdx >= 0 ? postEvents.slice(startedIdx + 1) : postEvents;
  const wasApproved = eventsSinceStart.some(e => e.event === 'spec:approved');
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
