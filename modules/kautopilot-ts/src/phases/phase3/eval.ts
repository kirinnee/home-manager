import type { Phase3Context, EvalResult, EvalUnit, PreFilterResult, TtyResolveItem, PollThread } from './types';
import type { CheckStatus } from '../../core/types';
import { appendEvent } from '../../core/log';
import { spawnPrint } from '../../llm/spawn';
import { writeStepInit } from '../../core/step-init';
import { getAgentPrompt, getAgentBinary } from '../../core/agents';
import {
  ghReviewThreads,
  ghPrChecks,
  ghPrView,
  ghPrComments,
  ghReplyToThread,
  ghResolveThread,
  withBotSignature,
} from '../../core/github';

// ============================================================================
// Deterministic pre-filter
// ============================================================================

interface ThreadWithReplies extends PollThread {
  lastReplyByBot: boolean;
}

const OUTDATED_REPLY = withBotSignature(
  'This comment is outdated (the code it refers to has changed). Marking as resolved.',
);
const GHOSTED_REPLY = withBotSignature(
  'The CI checks triggered by my previous change have now completed. Marking as resolved.',
);

export function preFilterThreads(
  threads: ThreadWithReplies[],
  crStatus: 'passing' | 'failing' | 'running' | 'none',
): PreFilterResult[] {
  const results: PreFilterResult[] = [];

  for (const thread of threads) {
    // Outdated: GitHub already flagged this
    if (thread.isOutdated) {
      results.push({
        category: 'outdated',
        threadId: thread.id,
        reason: 'Thread marked as outdated by GitHub',
        templateReply: OUTDATED_REPLY,
      });
      continue;
    }

    // Ghosted: last reply was by us AND CR CI has completed (pass or fail or none)
    if (thread.lastReplyByBot && (crStatus === 'passing' || crStatus === 'failing' || crStatus === 'none')) {
      results.push({
        category: 'ghosted',
        threadId: thread.id,
        reason: 'Last reply by bot and CR CI completed',
        templateReply: GHOSTED_REPLY,
      });
      continue;
    }

    // Pending: last reply was by us AND CR CI is still running
    if (thread.lastReplyByBot && crStatus === 'running') {
      results.push({
        category: 'pending',
        threadId: thread.id,
        reason: 'Last reply by bot and CR CI still running',
      });
      continue;
    }

    // Everything else needs LLM eval
    results.push({
      category: 'needs_eval',
      threadId: thread.id,
      reason: 'Needs LLM evaluation',
    });
  }

  return results;
}

// ============================================================================
// Main eval handler
// ============================================================================

export async function handleEval(ctx: Phase3Context): Promise<string | null> {
  const { session, version, prNumber } = ctx;

  if (!prNumber) {
    throw new Error('eval: no PR number available');
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'eval:started',
    version,
    metadata: { stepType: 'llm' },
  });

  // Fetch current state in parallel
  const [threads, checks, prView, prComments] = await Promise.all([
    ghReviewThreads(prNumber, session.worktree),
    ghPrChecks(prNumber, session.worktree).catch(() => []),
    ghPrView(prNumber, session.worktree),
    ghPrComments(prNumber, undefined, session.worktree).catch(() => []),
  ]);

  // Detect CodeRabbit status from checks
  const crCheck = checks.find(c => c.name.toLowerCase().includes('coderabbit'));
  const crStatus: 'passing' | 'failing' | 'running' | 'none' = crCheck
    ? crCheck.status === 'passing'
      ? 'passing'
      : crCheck.status === 'failing'
        ? 'failing'
        : 'running'
    : 'none';

  // Annotate threads with bot reply status
  const threadsWithReplies: ThreadWithReplies[] = threads.map(t => ({
    ...t,
    lastReplyByBot: t.replies.length > 0 && t.replies[t.replies.length - 1].isBot,
  }));

  // Step 1: Pre-filter
  const preFilterResults = preFilterThreads(threadsWithReplies, crStatus);

  // Step 2: Execute pre-filtered closings (outdated + ghosted)
  const closings = preFilterResults.filter(r => r.category === 'outdated' || r.category === 'ghosted');
  let autoResolved = 0;
  for (const closing of closings) {
    try {
      if (closing.templateReply) {
        const thread = threads.find(t => t.id === closing.threadId);
        if (thread && thread.replies.length > 0) {
          await ghReplyToThread(prNumber, thread.replies[0].id, closing.templateReply, session.worktree);
        }
      }
      await ghResolveThread(closing.threadId, session.worktree);
      autoResolved++;
    } catch (err) {
      console.warn(`[eval] Auto-close failed for ${closing.threadId}:`, err);
    }
  }

  // Step 3: Fan-out LLM eval for needs_eval threads + CI failures + PR comments
  const needsEval = preFilterResults.filter(r => r.category === 'needs_eval');
  const failingChecks = checks.filter(c => c.status === 'failing');

  // Build eval units
  const units: EvalUnit[] = [];

  // CI failures
  for (const check of failingChecks) {
    units.push({
      id: `ci-${check.name}`,
      type: 'ci_failure',
      title: `CI Failure: ${check.name}`,
      content: `The CI check "${check.name}" is failing. This needs to be investigated and fixed.`,
      metadata: { checkName: check.name },
    });
  }

  // Threads needing eval
  for (const pf of needsEval) {
    const thread = threads.find(t => t.id === pf.threadId);
    if (!thread) continue;

    const commentsText = [
      `## Original comment by ${thread.author}:`,
      thread.body,
      ...thread.replies.map(r => `## Reply by ${r.author}:\n${r.body}`),
    ].join('\n\n');

    units.push({
      id: `thread-${pf.threadId}`,
      type: 'thread',
      title: `Review thread by ${thread.author}`,
      content: commentsText,
      metadata: { threadId: pf.threadId, commentId: thread.firstCommentId || thread.replies[0]?.id },
    });
  }

  // PR comments (not from bot)
  for (const comment of prComments) {
    if (comment.author.login === 'claude[bot]') continue;
    units.push({
      id: `comment-${comment.id}`,
      type: 'pr_comment',
      title: `PR comment by ${comment.author.login}`,
      content: comment.body,
      metadata: { commentId: comment.id },
    });
  }

  // Record step init
  const evalBinary = getAgentBinary('phase3', 'eval');
  writeStepInit(session.id, version, 'eval', {
    prompt: `eval: ${units.length} units (${units.map(u => u.type).join(', ')})`,
    command: `${evalBinary} --print (LLM print, fan-out)`,
    type: 'llm_print',
  });

  // Run LLM eval in parallel (fan-out)
  const evalResults = await fanOutEval(units, ctx);

  // Store eval results on context for act handler
  ctx.evalResults = evalResults;

  // Separate results
  const codeFixes = evalResults.filter(r => r.verdict === 'code_fix');
  const ambiguous = evalResults.filter(r => r.ambiguous);

  console.log(
    `[eval] Pre-filtered: ${autoResolved} auto-resolved, ${needsEval.length} + ${failingChecks.length} CI + ${prComments.filter(c => c.author.login !== 'claude[bot]').length} comment units evaluated`,
  );
  console.log(
    `[eval] Results: ${evalResults.filter(r => r.verdict === 'reply').length} replies, ${evalResults.filter(r => r.verdict === 'resolve').length} resolves, ${codeFixes.length} code fixes, ${ambiguous.length} ambiguous`,
  );

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'eval:completed',
    version,
    metadata: {
      autoResolved,
      totalEvalUnits: units.length,
      replies: evalResults.filter(r => r.verdict === 'reply').length,
      resolves: evalResults.filter(r => r.verdict === 'resolve').length,
      codeFixes: codeFixes.length,
      ambiguous: ambiguous.length,
      skipped: evalResults.filter(r => r.verdict === 'skip').length,
    },
  });

  return 'act';
}

// ============================================================================
// Fan-out LLM eval
// ============================================================================

// Non-changeable flow prompt — eval structure is kautopilot plumbing.
// The changeable part (eval instruction) comes from getAgentPrompt('phase3', 'eval').
function buildEvalPrompt(ticketId: string, content: string): string {
  const evalInstruction = getAgentPrompt('phase3', 'eval');
  return `
You are reviewing feedback on a pull request.

${evalInstruction}

## Task Context
Ticket: ${ticketId}

## Feedback Item
${content}

## Possible Actions
- "reply": Post a reply explaining your position or acknowledging the feedback
- "resolve": Resolve the thread (the issue has been addressed or is no longer relevant)
- "code_fix": The feedback requires code changes — provide fix instructions
- "skip": Ignore this feedback (false positive, duplicate, or not actionable)

## Output Format
Return a JSON object:
{
  "verdict": "reply" | "resolve" | "code_fix" | "skip",
  "reply": "string (for reply verdict — the text to post)",
  "codeFix": "string (for code_fix verdict — fix instructions)",
  "resolveThread": true/false (should the thread be resolved?),
  "reactThumbsUp": true/false (should we react +1 to the comment?),
  "ambiguous": true/false (are you unsure about the verdict?),
  "ambiguousReason": "string (if ambiguous, explain why)"
}
`.trim();
}

async function evalSingleUnit(unit: EvalUnit, ctx: Phase3Context): Promise<EvalResult> {
  const prompt = buildEvalPrompt(ctx.ticketId, unit.content);

  const result = await spawnPrint<{
    verdict: string;
    reply?: string;
    codeFix?: string;
    resolveThread?: boolean;
    reactThumbsUp?: boolean;
    ambiguous?: boolean;
    ambiguousReason?: string;
  }>(getAgentBinary('phase3', 'eval'), prompt, {
    cwd: ctx.session.worktree,
    timeout: ctx.config.kloop.reviewerTimeout,
    sessionId: ctx.session.id,
    label: `eval-${unit.content.slice(0, 30).replace(/[^a-z0-9]/gi, '-')}`,
  });

  return {
    unitId: unit.id,
    unitType: unit.type,
    verdict: (result.verdict as EvalResult['verdict']) || 'skip',
    reply: result.reply,
    codeFix: result.codeFix,
    resolveThread: result.resolveThread,
    reactThumbsUp: result.reactThumbsUp,
    ambiguous: result.ambiguous,
    ambiguousReason: result.ambiguousReason,
  };
}

async function fanOutEval(units: EvalUnit[], ctx: Phase3Context): Promise<EvalResult[]> {
  if (units.length === 0) return [];

  // Run all evals in parallel with individual retry
  const results = await Promise.all(
    units.map(async unit => {
      try {
        return await evalSingleUnit(unit, ctx);
      } catch (err) {
        console.warn(`[eval] Unit ${unit.id} failed, retrying...`);
        try {
          return await evalSingleUnit(unit, ctx);
        } catch (retryErr) {
          console.error(`[eval] Unit ${unit.id} failed after retry:`, retryErr);
          return {
            unitId: unit.id,
            unitType: unit.type,
            verdict: 'skip' as const,
          };
        }
      }
    }),
  );

  return results;
}
