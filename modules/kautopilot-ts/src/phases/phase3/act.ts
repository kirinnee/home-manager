import type { Phase3Context, EvalResult, TtyResolveItem } from './types';
import { appendEvent } from '../../core/log';
import {
  ghReplyToThread,
  ghReplyToIssueComment,
  ghResolveThread,
  ghReact,
  ghReviewThreads,
  withBotSignature,
} from '../../core/github';

export async function handleAct(ctx: Phase3Context): Promise<string | null> {
  const { session, version, prNumber, evalResults } = ctx;

  if (!prNumber) {
    throw new Error('act: no PR number available');
  }

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'act:started',
    version,
    metadata: { stepType: 'code' },
  });

  // If no eval results, nothing to do
  if (!evalResults || evalResults.length === 0) {
    console.log('[act] No eval results found — skipping');
    appendEvent(session.id, {
      ts: new Date().toISOString(),
      event: 'act:completed',
      version,
      metadata: {
        replies: 0,
        resolved: 0,
        codeFixes: 0,
      },
    });
    return 'poll';
  }

  const actionable = evalResults;
  const codeFixes: EvalResult[] = [];
  const ambiguousItems: TtyResolveItem[] = [];
  let repliesPosted = 0;
  let threadsResolved = 0;
  let reactionsAdded = 0;

  for (const result of actionable) {
    try {
      // Collect code fixes for write_fix
      if (result.verdict === 'code_fix') {
        codeFixes.push(result);
        continue;
      }

      // Collect ambiguous items for tty_resolve
      if (result.ambiguous) {
        ambiguousItems.push({
          id: result.unitId,
          type: result.unitType,
          title: result.unitId,
          reasoning: result.reply || result.codeFix || 'No reasoning provided',
          ambiguityReason: result.ambiguousReason,
        });
        continue;
      }

      // Post reply for thread-type results
      if (result.reply && result.unitType === 'thread') {
        const threadId = result.unitId.replace('thread-', '');
        const threads = await ghReviewThreads(prNumber, session.worktree);
        const thread = threads.find(t => t.id === threadId);
        if (thread && thread.replies.length > 0) {
          await ghReplyToThread(prNumber, thread.replies[0].id, withBotSignature(result.reply), session.worktree);
          repliesPosted++;
        } else if (thread) {
          // No replies yet — reply to the first comment
          const firstCommentId = thread.firstCommentId;
          if (firstCommentId) {
            await ghReplyToThread(prNumber, firstCommentId, withBotSignature(result.reply), session.worktree);
            repliesPosted++;
          } else {
            console.warn(`[act] No first comment ID for thread ${threadId}`);
          }
        }
      }

      // Post reply for PR comment-type results
      if (result.reply && result.unitType === 'pr_comment') {
        const commentId = result.unitId.replace('comment-', '');
        const numericId = parseInt(commentId, 10);
        if (!isNaN(numericId)) {
          await ghReplyToIssueComment(prNumber, withBotSignature(result.reply), numericId, session.worktree);
          repliesPosted++;
        }
      }

      // Resolve thread
      if (result.resolveThread && result.unitType === 'thread') {
        const threadId = result.unitId.replace('thread-', '');
        await ghResolveThread(threadId, session.worktree);
        threadsResolved++;
      }

      // React thumbs up
      if (result.reactThumbsUp && result.unitType === 'thread') {
        const threadId = result.unitId.replace('thread-', '');
        const threads = await ghReviewThreads(prNumber, session.worktree);
        const thread = threads.find(t => t.id === threadId);
        if (thread && thread.replies.length > 0) {
          const commentId = parseInt(thread.replies[0].id, 10);
          if (!isNaN(commentId)) {
            await ghReact(commentId, '+1', session.worktree);
            reactionsAdded++;
          }
        }
      }
    } catch (err) {
      console.warn(`[act] Action failed for ${result.unitId}:`, err);
    }
  }

  console.log(
    `[act] Posted ${repliesPosted} replies, resolved ${threadsResolved} threads, added ${reactionsAdded} reactions, ${codeFixes.length} code fixes, ${ambiguousItems.length} ambiguous`,
  );

  appendEvent(session.id, {
    ts: new Date().toISOString(),
    event: 'act:completed',
    version,
    metadata: {
      replies: repliesPosted,
      resolved: threadsResolved,
      codeFixes: codeFixes.length,
      ambiguous: ambiguousItems.length,
    },
  });

  // Store items for downstream handlers
  ctx.ttyResolveItems = ambiguousItems;

  // Route: ambiguous → tty_resolve, codeFixes → write_fix, neither → poll
  if (ambiguousItems.length > 0) {
    ctx.ttyReason = 'ambiguous_eval';
    return 'tty_resolve';
  }

  if (codeFixes.length > 0) {
    return 'write_fix';
  }

  return 'poll';
}
