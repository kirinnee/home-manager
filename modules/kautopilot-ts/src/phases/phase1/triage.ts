import { readFileSync } from 'node:fs';
import { getAgentPrompt, getDefaultBinary } from '../../core/agents';
import { appendEvent, readLog } from '../../core/log';
import { writeStepInit } from '../../core/step-init';
import { buildPromptVars, resolvePromptVars } from '../../core/type-config';
import { logBanner, logInfo, logOk } from '../../util/format';
import { spawnTTYWithTurnTracking } from '../shared';
import type { Phase1Context } from './types';

/**
 * Non-negotiable mechanics injected by the runner — NOT part of the user-editable prompt.
 * Always prepended so the pipeline contract is never broken by custom prompts.
 */
const TRIAGE_APPROVAL_GATE = `### User Approval Gate

After writing triage.md, you MUST present a summary to the user and wait for their explicit confirmation:

1. Show the user: delivery kind, complexity, key risks, and files affected
2. Ask: "Does this triage assessment look correct? (yes/no)"
3. ONLY after the user confirms, write the approval event:
   \`kautopilot log-event triage:approved --metadata '{"deliveryKind": "pr|ticket", "complexity": "..."}'\`
4. THEN tell the user to /exit

CRITICAL: Do NOT log the approval event or tell the user to /exit until they explicitly confirm the triage.`;

// ============================================================================
// TriageResult & TestingLevel — exported for use by Phase1Context
// ============================================================================

export type TestingLevel = 'none' | 'light' | 'moderate' | 'heavy';

export interface TriageResult {
  deliveryKind: 'pr' | 'ticket';
  complexity: string;
  verification: {
    hasAssumptions: boolean;
    testing: TestingLevel;
    hasValidators: boolean;
  };
}

/**
 * Parse the triage.md to extract deliveryKind, complexity, and verification flags.
 */
export function parseTriage(triagePath: string): TriageResult | null {
  try {
    const content = readFileSync(triagePath, 'utf-8');
    const deliveryMatch = content.match(/^## Delivery Kind\s*$/m);
    const deliveryLine = deliveryMatch
      ? content
          .slice((deliveryMatch.index as number) + deliveryMatch[0].length)
          .trim()
          .split('\n')[0]
          .trim()
          .toLowerCase()
      : null;
    const complexityMatch = content.match(/^## Complexity\s*$/m);
    const complexityLine = complexityMatch
      ? content
          .slice((complexityMatch.index as number) + complexityMatch[0].length)
          .trim()
          .split('\n')[0]
          .trim()
          .toLowerCase()
      : null;

    const deliveryKind = deliveryLine === 'ticket' ? 'ticket' : 'pr';
    const complexity = ['straightforward', 'moderate', 'complex'].includes(complexityLine ?? '')
      ? (complexityLine as string)
      : 'moderate';

    // Parse verification flags
    // Split on /^### /m to scope sections within ## Verification (h3 sub-headings)
    const assumptionsMatch = content.match(/^### Assumptions to Verify\s*$/m);
    const assumptionsSection = assumptionsMatch
      ? content
          .slice((assumptionsMatch.index as number) + assumptionsMatch[0].length)
          .trim()
          .split(/^### /m)[0]
      : '';
    const hasAssumptions =
      !/(?:None|no assumptions|all assumptions are grounded)/i.test(assumptionsSection) &&
      assumptionsSection.trim().length > 0;

    const testingMatch = content.match(/^### Testing Level\s*$/m);
    const testingSection = testingMatch
      ? content
          .slice((testingMatch.index as number) + testingMatch[0].length)
          .trim()
          .split('\n')[0]
          .trim()
          .toLowerCase()
      : 'none';
    const validTestingLevels: TestingLevel[] = ['none', 'light', 'moderate', 'heavy'];
    const testing: TestingLevel = validTestingLevels.includes(testingSection as TestingLevel)
      ? (testingSection as TestingLevel)
      : 'none';

    const validationMatch = content.match(/^### Validation Matrix\s*$/m);
    const validationSection = validationMatch
      ? content
          .slice((validationMatch.index as number) + validationMatch[0].length)
          .trim()
          .split(/^### /m)[0]
      : '';
    // Check line-by-line: hasValidators is true if ANY validation-matrix cell has real content.
    // A mixed matrix like "run bun test" + three "none" rows should still be true.
    const validationLines = validationSection
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('-'));
    const hasValidators =
      validationLines.length > 0 &&
      validationLines.some(line => {
        const value = line.replace(/^-\s*/, '').trim();
        // Extract content after colon (e.g., "Automated immediate: run bun test" → "run bun test")
        const colonIdx = value.indexOf(':');
        const content = colonIdx >= 0 ? value.slice(colonIdx + 1).trim() : value;
        // Not a validator if content is empty or is a "none"-like value
        return content.length > 0 && !/^(?:none|n\/a|no automated|no manual)/i.test(content);
      });

    return {
      deliveryKind,
      complexity,
      verification: {
        hasAssumptions,
        testing,
        hasValidators,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Non-negotiable mechanics injected by the runner — NOT part of the user-editable prompt.
 * Always prepended so the pipeline contract is never broken by custom prompts.
 * Uses {triageTemplate} placeholder which is replaced with config.templates.triage.
 */
const TRIAGE_MECHANICS = `## CRITICAL: Triage Output & Approval Mechanics

### Output File

Write your triage assessment to: {specDir}/triage.md

The triage document MUST follow this template structure:
{triageTemplate}

${TRIAGE_APPROVAL_GATE}`;

/**

 * [tty] Interactive triage via TTY handoff.
 *
 * Reads the ticket, does lightweight codebase exploration, and produces a triage.md
 * that classifies the ticket's complexity and delivery kind.
 */
export async function handleTriage(ctx: Phase1Context): Promise<string | null> {
  const { session, version, config } = ctx;

  // Check if triage was already approved (crash recovery — don't re-run)
  const events = readLog(session.id);
  const approved = events.some(e => e.event === 'triage:approved');
  if (approved) {
    logOk('Triage already approved — skipping triage');
    // Restore deliveryKind and verification from triage.md if available
    const vars = buildPromptVars(session.worktree, version, session.ticket_id || 'local');
    const parsed = parseTriage(vars.triage);
    if (parsed) {
      ctx.deliveryKind = parsed.deliveryKind;
      ctx.verification = parsed.verification;
    }
    return 'write_spec';
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'triage:started',
    version,
    metadata: { stepType: 'tty' },
  });

  const vars = buildPromptVars(session.worktree, version, session.ticket_id || 'local');

  // Build prompt: inject template into mechanics, then combine with user prompt
  const mechanicsWithTemplate = TRIAGE_MECHANICS.replace('{triageTemplate}', config.templates.triage);
  const mechanics = resolvePromptVars(mechanicsWithTemplate, vars);
  const userPrompt = getAgentPrompt('phase1', 'triage', vars as unknown as Record<string, string>);
  const prompt = mechanics + userPrompt;

  const binary = getDefaultBinary();
  writeStepInit(session.id, version, 'triage', {
    prompt,
    command: `${binary} (TTY handoff)`,
    type: 'tty_handoff',
  });

  logBanner('Triage', { Version: `v${version}` });
  await spawnTTYWithTurnTracking(session.id, binary, prompt, {
    cwd: session.worktree,
    worktree: session.worktree,
  });

  // Check if approval event was logged during the TTY session
  const postEvents = readLog(session.id);
  const wasApproved = postEvents.some(e => e.event === 'triage:approved');
  if (!wasApproved) {
    logInfo('Triage not approved yet — will resume on next start');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'triage:interrupted',
      version,
    });
    return null;
  }

  // Parse triage.md for deliveryKind and verification
  const parsed = parseTriage(vars.triage);
  if (parsed) {
    ctx.deliveryKind = parsed.deliveryKind;
    ctx.verification = parsed.verification;
  }

  logOk('Triage approved');

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'triage:completed',
    version,
    metadata: parsed
      ? {
          deliveryKind: parsed.deliveryKind,
          complexity: parsed.complexity,
          verification: parsed.verification,
        }
      : {},
  });

  return 'write_spec';
}
