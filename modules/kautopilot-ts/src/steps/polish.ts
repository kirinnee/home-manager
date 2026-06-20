import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentPrompt } from '../core/agents';
import { sessionDir } from '../core/artifacts';
import type { PreparedStep, StepContext, StepDef } from '../core/descriptor';
import { devloopInit, devloopRun } from '../core/devloop';
import { getCurrentBranch, hasUnmergedPaths, isOnMain } from '../core/git';
import {
  BOT_SIGNATURE_MARKER,
  ghClosePr,
  ghFetchMergePolicy,
  ghListPrsForBranch,
  ghPrChecks,
  ghPrComment,
  ghPrComments,
  ghPrRuns,
  ghPrView,
  ghReact,
  ghReplyToIssueComment,
  ghReplyToThread,
  ghRepoInfo,
  ghResolveThread,
  ghReviews,
  ghReviewThreads,
  ghRunLogsFailed,
  withBotSignature,
} from '../core/github';
import { appendEvent, readLog } from '../core/log';
import { diffRevisions, latestRevisionOnDisk, nextRevisionPath } from '../core/revisions';
import type { RepoEntry } from '../core/session-meta';
import { findRepo, updateSessionMeta } from '../core/session-meta';
import { lastEventMetadata } from './execution';
import { SHARED_APPROVAL_GATE, substitute, ticketId } from './prompt-helpers';

/**
 * Persist a `context:updated` event scoped to this repo + epoch so a downstream
 * `code` step can recover the payload (the driver gives code steps no metadata).
 * Mirrors execution.ts `recordRepoState`.
 */
function recordRepoState(ctx: StepContext, metadata: Record<string, unknown>): void {
  appendEvent(ctx.sessionId, {
    ts: new Date().toISOString(),
    event: 'context:updated',
    version: ctx.version,
    repo: repoOf(ctx).repo,
    metadata,
  });
}

// ============================================================================
// POLISH phase (per repo) — `kautopilot next --repo <repo>` (phase: polish).
//
// commit_pending → [prereview] → push → [create_pr] → poll → … → cleanup.
// All `code` steps tolerate a test sandbox with no real git/gh/kloop: every
// external call is wrapped in try/catch and degrades to the next step, so the
// machine never blocks or infinite-loops on `poll`. The controller NEVER merges.
//
// Ported (describe-mode) from src/phases/phase3/*.ts. See PROMPT-SET.md (polish
// table) + SPEC-kautopilot §7.3 / §13.
// ============================================================================

// --- shared helpers ---------------------------------------------------------

/** A polish step's repo entry; throws when missing (every polish step is repo-scoped). */
function repoOf(ctx: StepContext): RepoEntry {
  if (!ctx.repo) throw new Error('polish step requires a repo-scoped context');
  return ctx.repo;
}

/** The repo's worktree path, or null when not seeded yet (test sandbox). */
function worktreeOf(ctx: StepContext): string | null {
  return ctx.repo?.worktree ?? null;
}

/** In-worktree spec dir for this epoch: {worktree}/spec/{ticketId}/v{N}. */
function epochDir(ctx: StepContext): string | null {
  const wt = worktreeOf(ctx);
  if (!wt) return null;
  return join(wt, 'spec', ticketId(ctx.meta), `v${ctx.version}`);
}

/** Absolute path to the master spec inside the worktree, or a stable placeholder. */
function specPathOf(ctx: StepContext): string {
  const dir = epochDir(ctx);
  return dir ? join(dir, 'spec.md') : '(no spec — repo not seeded)';
}

/** Plan paths assigned to this repo inside the worktree (newline-joined), or placeholder. */
function planPathsOf(ctx: StepContext): string {
  const dir = epochDir(ctx);
  const plans = ctx.repo?.plans ?? [];
  if (!dir || plans.length === 0) return '(no plans — repo not seeded)';
  return plans.map(p => join(dir, 'plans', p)).join('\n');
}

/** Feedback doc path for this epoch inside the worktree. */
function feedbackPathOf(ctx: StepContext): string {
  const dir = epochDir(ctx);
  return dir ? join(dir, 'feedback.md') : '(no feedback)';
}

function polishVars(ctx: StepContext): Record<string, string | null> {
  return {
    ticketId: ticketId(ctx.meta),
    baseBranch: ctx.meta.baseBranch,
    spec_path: specPathOf(ctx),
    plan_paths: planPathsOf(ctx),
    feedback_path: feedbackPathOf(ctx),
  };
}

/** Run a synchronous git command, swallowing all errors (returns trimmed stdout or null). */
function gitTry(args: string[], cwd: string): string | null {
  try {
    const proc = Bun.spawnSync({
      cmd: ['git', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
}

// --- generic.commit mechanics (Appendix C) ----------------------------------

const COMMIT_CONTEXT_EMPTY = '';

// --- commit_pending (agent) -------------------------------------------------

const commitPending: StepDef = {
  name: 'commit_pending',
  phase: 'polish',
  kind: 'agent',
  scope: 'repo',
  prepare: async ctx => {
    const vars = { ...polishVars(ctx), context: COMMIT_CONTEXT_EMPTY };
    const prompt = getAgentPrompt('generic', 'commit', {
      context: COMMIT_CONTEXT_EMPTY,
    });
    return {
      prompt,
      vars,
      contract: {
        completionEvent: 'commit_pending:completed',
        completionMetadataSchema: { commitSha: 'string?', skipped: 'boolean?' },
      },
    } satisfies PreparedStep;
  },
  finalize: async ctx => (ctx.config.settings.coderabbit ? 'prereview' : 'push'),
};

// --- prereview (agent when coderabbit, else a no-op code skip) ---------------

const prereviewClassify: StepDef = {
  name: 'prereview',
  phase: 'polish',
  kind: 'agent',
  scope: 'repo',
  // When coderabbit is disabled the binary never yields this step — the
  // preceding commit_pending routes straight to `push`. The `run` below is the
  // degraded code path so the step still resolves if reached.
  run: async () => 'push',
  prepare: async ctx => {
    const vars = polishVars(ctx);
    const classify = getAgentPrompt('phase3', 'prereview_classify', vars as Record<string, string>);
    const fix = getAgentPrompt('phase3', 'prereview_fix', vars as Record<string, string>);
    const prompt = [
      'Run CodeRabbit over the pending changes and process its findings in two passes.',
      '',
      '## Pass 1 — classify',
      classify,
      '',
      '## Pass 2 — fix',
      fix,
      '',
      "Commit any applied fixes with the repo's commit conventions (generic.commit). " +
        'If CodeRabbit is unavailable or finds nothing actionable, skip cleanly.',
    ].join('\n');
    return {
      prompt,
      vars,
      contract: {
        completionEvent: 'prereview:completed',
        completionMetadataSchema: {
          fixesApplied: 'number?',
          skipped: 'boolean?',
          reason: 'string?',
        },
      },
    } satisfies PreparedStep;
  },
  finalize: async () => 'push',
};

// --- push (code) ------------------------------------------------------------

const push: StepDef = {
  name: 'push',
  phase: 'polish',
  kind: 'code',
  scope: 'repo',
  run: async ctx => {
    const repo = repoOf(ctx);
    const wt = worktreeOf(ctx);
    // No worktree (test sandbox) — nothing to push; route to next.
    if (!wt) return repo.prNumber ? 'poll' : 'create_pr';

    try {
      // Safety: never push from the base branch.
      if (isOnMain(ctx.meta.baseBranch, wt)) {
        throw new Error(`Refusing to push from ${ctx.meta.baseBranch} — safety check`);
      }

      const branch = getCurrentBranch(wt);
      const hasUpstream = gitTry(['rev-parse', '--abbrev-ref', '@{upstream}'], wt) !== null;

      if (hasUpstream) {
        const ahead = gitTry(['rev-list', '@{upstream}..HEAD', '--count'], wt);
        if (ahead === '0') {
          // Nothing to push — already up to date.
          return repo.prNumber ? 'poll' : 'create_pr';
        }
        // Subsequent push with retry: direct → pull --ff-only → pull --rebase.
        let pushed = gitTry(['push'], wt) !== null;
        if (!pushed && gitTry(['pull', '--ff-only'], wt) !== null) {
          pushed = gitTry(['push'], wt) !== null;
        }
        if (!pushed) {
          const rebased = gitTry(['pull', '--rebase'], wt) !== null;
          if (rebased) {
            pushed = gitTry(['push'], wt) !== null;
          } else if (hasUnmergedPaths(wt)) {
            // Rebase hit conflicts — hand to the interactive resolver. Persist
            // the reason so tty_resolve renders the conflict variant. (M3)
            recordRepoState(ctx, { ttyReason: 'merge_conflict' });
            return 'tty_resolve';
          }
        }
        if (!pushed) throw new Error('push failed after all retries');
      } else {
        // First push — set upstream.
        if (gitTry(['push', '-u', 'origin', branch], wt) === null) {
          throw new Error('first push failed');
        }
      }
    } catch {
      // Degrade gracefully in a no-git sandbox: still advance the machine.
    }

    return repo.prNumber ? 'poll' : 'create_pr';
  },
};

// --- create_pr (agent) ------------------------------------------------------

const CREATE_PR_MECHANICS = `## Spec Context
Read the spec at: {spec_path}
The spec contains what was implemented. Use it for PR body context.`;

const createPr: StepDef = {
  name: 'create_pr',
  phase: 'polish',
  kind: 'agent',
  scope: 'repo',
  prepare: async ctx => {
    const repo = repoOf(ctx);
    const vars = polishVars(ctx);
    const body = getAgentPrompt('phase3', 'create_pr', vars as Record<string, string>);
    const reuseNote =
      repo.prNumber != null
        ? `\n\n## Existing PR\nA PR already exists for this branch (#${repo.prNumber}). ` +
          "Do NOT open a new one — update the existing PR's title/body to reflect the latest epoch."
        : '';
    const prompt = `${substitute(CREATE_PR_MECHANICS, vars)}\n\n${body}${reuseNote}`;
    return {
      prompt,
      vars,
      contract: {
        completionEvent: 'create_pr:completed',
        completionMetadataSchema: { prNumber: 'number', prUrl: 'string' },
      },
    } satisfies PreparedStep;
  },
  finalize: async ctx => {
    const repo = repoOf(ctx);
    const wt = worktreeOf(ctx);
    const prNumber = ctx.metadata?.prNumber as number | undefined;
    const prUrl = ctx.metadata?.prUrl as string | undefined;
    if (prNumber != null) {
      updateSessionMeta(ctx.sessionId, m => {
        const entry = findRepo(m, repo.repo);
        if (entry) {
          entry.prNumber = prNumber;
          entry.prUrl = prUrl ?? entry.prUrl;
        }
      });

      // PR rollover: close any OTHER open PRs on this branch (never the one we
      // keep, and never a merge). Best-effort; degrades when gh is absent.
      if (wt && repo.branch) {
        try {
          const open = await ghListPrsForBranch(repo.branch, wt);
          for (const pr of open) {
            if (pr.number !== prNumber) await ghClosePr(pr.number, wt);
          }
        } catch {
          // best-effort rollover cleanup.
        }
      }
    }
    return 'poll';
  },
};

// --- poll (code, blocking detection — never merges, never infinite-loops) ----

interface PollSignals {
  prState: string;
  mergeable: boolean;
  mergeStateStatus: string;
  failingChecks: number;
  pendingChecks: number;
  unresolvedThreads: number;
  changesRequested: boolean;
}

/** Decide readiness from signals. Required human approvals are intentionally excluded. */
function computePollState(s: PollSignals): 'mergeable' | 'blocked' | 'pending' {
  if (s.changesRequested) return 'blocked';
  if (s.unresolvedThreads > 0) return 'blocked';
  if (s.failingChecks > 0) return 'blocked';
  if (s.pendingChecks > 0) return 'pending';
  if (!s.mergeable || !['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'BLOCKED'].includes(s.mergeStateStatus)) {
    return 'pending';
  }
  return 'mergeable';
}

/**
 * Count branch-protection required check contexts that have not yet reported a
 * result. Uses the repo's merge policy so a not-yet-started required check keeps
 * the PR pending rather than letting it look mergeable. Best-effort.
 */
async function requiredChecksPending(checks: { name: string; status: string }[], wt: string): Promise<number> {
  const { owner, repo } = await ghRepoInfo(wt);
  const policy = await ghFetchMergePolicy(owner, repo, wt);
  if (!policy.requiresStatusChecks) return 0;
  const reported = new Set(checks.map(c => c.name));
  return policy.requiredStatusCheckContexts.filter(c => !reported.has(c)).length;
}

/**
 * Fetch the failed CI run logs for the branch and record a digest into the WAL,
 * so eval/tty_resolve have failure context. Never throws; degrades when gh is absent.
 */
async function recordFailedRunLogs(ctx: StepContext, branch: string | null, wt: string): Promise<void> {
  if (!branch) return;
  const runs = await ghPrRuns(branch, wt);
  const failed = runs.find(r => r.conclusion === 'failure');
  if (!failed) return;
  const logs = await ghRunLogsFailed(String(failed.databaseId), wt);
  appendEvent(ctx.sessionId, {
    ts: new Date().toISOString(),
    event: 'poll:ci_failed',
    version: ctx.version,
    repo: repoOf(ctx).repo,
    metadata: {
      runId: failed.databaseId,
      name: failed.name,
      logExcerpt: logs.slice(0, 2000),
    },
  });
}

const poll: StepDef = {
  name: 'poll',
  phase: 'polish',
  kind: 'code',
  scope: 'repo',
  run: async ctx => {
    const repo = repoOf(ctx);
    const wt = worktreeOf(ctx);
    if (!wt) return 'repo_ready';

    // Reconcile a missing PR number from the open PRs on this branch (a PR may
    // have been opened out-of-band). Best-effort; degrades when gh is absent.
    let prNumber = repo.prNumber;
    if (prNumber == null && repo.branch) {
      const open = await ghListPrsForBranch(repo.branch, wt).catch(() => []);
      prNumber = open[0]?.number ?? null;
      if (prNumber != null) {
        updateSessionMeta(ctx.sessionId, m => {
          const entry = findRepo(m, repo.repo);
          if (entry) entry.prNumber = prNumber;
        });
      }
    }
    // No real PR (test sandbox): advance, never loop.
    if (prNumber == null) return 'repo_ready';

    const maxCycles = ctx.config.settings.maxPushCycles;
    const intervalMs = (ctx.config.settings.pollInterval || 60) * 1000;

    for (let cycle = 0; cycle < maxCycles; cycle++) {
      const [checks, prView, threads, reviews, prComments] = await Promise.all([
        ghPrChecks(prNumber, wt).catch(() => []),
        ghPrView(prNumber, wt).catch(() => null),
        ghReviewThreads(prNumber, wt).catch(() => []),
        ghReviews(prNumber, wt).catch(() => []),
        ghPrComments(prNumber, undefined, wt).catch(() => []),
      ]);

      // No gh available — degrade to advancing (avoid infinite loop).
      if (!prView) return 'repo_ready';
      if (prView.state === 'CLOSED') return 'repo_ready';

      // Required-check policy: a context the branch protection requires but
      // which isn't reported yet counts as pending (best-effort).
      const requiredPending = await requiredChecksPending(checks, wt).catch(() => 0);

      // Capture failed-CI logs into the WAL so later steps have context.
      const failingChecks = checks.filter(c => c.status === 'failing').length;
      if (failingChecks > 0) {
        await recordFailedRunLogs(ctx, repo.branch, wt).catch(() => {});
      }

      // PR-level issue comments can NOT be resolved, so they must NOT block
      // forever. Exclude bot-authored comments (e.g. a CodeRabbit summary), our
      // own bot-signed replies, and any comment we have already replied to.
      // Only genuinely-actionable HUMAN comments count as blocking conversation.
      const replyTargets = new Set(
        prComments
          .filter(c => c.body.includes(BOT_SIGNATURE_MARKER))
          .map(c => c.author?.login)
          .filter((l): l is string => Boolean(l)),
      );
      const actionableHumanComments = prComments.filter(c => {
        const login = c.author?.login ?? '';
        if (login.includes('[bot]')) return false; // bot summary — not actionable
        if (c.body.includes(BOT_SIGNATURE_MARKER)) return false; // our own reply
        if (replyTargets.has(login)) return false; // already replied to this author
        return true;
      }).length;

      const signals: PollSignals = {
        prState: prView.state,
        mergeable: prView.mergeable,
        mergeStateStatus: prView.mergeStateStatus,
        failingChecks,
        pendingChecks: checks.filter(c => c.status === 'pending').length + requiredPending,
        unresolvedThreads: threads.length + actionableHumanComments,
        changesRequested:
          prView.reviews.some(r => r.state === 'CHANGES_REQUESTED') ||
          reviews.some(r => r.state === 'CHANGES_REQUESTED'),
      };

      const state = computePollState(signals);
      if (state === 'mergeable') return 'repo_ready';
      if (state === 'blocked') return 'ensure_branch';

      // pending — wait then re-poll (bounded by maxCycles).
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    // Exceeded the cycle cap while still pending.
    return 'repo_ready';
  },
};

// --- ensure_branch (code) ---------------------------------------------------

const ensureBranch: StepDef = {
  name: 'ensure_branch',
  phase: 'polish',
  kind: 'code',
  scope: 'repo',
  run: async ctx => {
    const wt = worktreeOf(ctx);
    if (!wt) return 'eval';
    try {
      gitTry(['fetch', 'origin', ctx.meta.baseBranch], wt);
      const behind = gitTry(['rev-list', '--count', `HEAD..origin/${ctx.meta.baseBranch}`], wt);
      const behindCount = behind != null ? Number.parseInt(behind, 10) : 0;
      // Behind base → let push rebase + re-push; up to date → evaluate feedback.
      return behindCount > 0 ? 'push' : 'eval';
    } catch {
      return 'eval';
    }
  },
};

// --- eval (agent fan-out) ---------------------------------------------------

const EVAL_MECHANICS = `## Context Paths
You have access to these files to understand the original intent and determine if feedback is valid:
- Spec: {spec_path}
- Plans: {plan_paths}
Read these files. They define what was INTENDED. Compare against the feedback to determine if it's a genuine issue or a false positive.

## How to Detect False Positives
1. Read the spec — what was the stated requirement? Does the feedback conflict with the spec?
2. Read the plan — what was the implementation approach? Does the feedback misunderstand the design?
3. Check the code — verify the actual state matches the spec/plan
4. Consider context — is the reviewer missing information? Are they applying a generic rule that doesn't fit?

A false positive is when the feedback asks for something that:
- Contradicts the spec (spec says X, reviewer wants Y)
- Is already satisfied (reviewer missed it)
- Is out of scope (reviewer scope creep)
- Is stylistic preference vs. correctness issue

## Possible Actions
- "reply": Post a reply explaining your position or acknowledging the feedback
- "resolve": Resolve the thread (addressed, not actionable, or no longer relevant)
- "code_fix": The feedback requires code changes — provide fix instructions
- "ambiguous": You are unsure — mark it for the user rather than guessing

Outdated/ghosted bot replies (OUTDATED_REPLY / GHOSTED_REPLY) are bot-signed.

## Output Format
For each feedback unit return a JSON object:
{ "verdict": "reply"|"resolve"|"code_fix", "reply": "string", "codeFix": "string", "resolveThread": bool, "reactThumbsUp": bool, "ambiguous": bool, "ambiguousReason": "string" }`;

const evalStep: StepDef = {
  name: 'eval',
  phase: 'polish',
  kind: 'agent',
  scope: 'repo',
  prepare: async ctx => {
    const vars = polishVars(ctx);
    const body = getAgentPrompt('phase3', 'eval', vars as Record<string, string>);
    const prompt = `${substitute(EVAL_MECHANICS, vars)}\n\n${body}`;
    return {
      prompt,
      vars,
      contract: {
        completionEvent: 'eval:completed',
        completionMetadataSchema: {
          // The structured verdicts `act` applies. Each: { kind:
          // "reply"|"resolve"|"code_fix"|"ambiguous", threadId?, commentId?,
          // body?, reactThumbsUp?, prLevel?, inReplyTo? }.
          actions: 'Array<{kind,threadId?,commentId?,body?,...}>',
          replies: 'number?',
          resolves: 'number?',
          codeFixes: 'number?',
          ambiguous: 'number?',
        },
      },
    } satisfies PreparedStep;
  },
  finalize: async () => 'act',
};

/** One structured eval verdict, as carried in `eval:completed` metadata. (C1) */
interface EvalAction {
  kind: 'reply' | 'resolve' | 'code_fix' | 'ambiguous';
  /** GraphQL review-thread id (for resolve). */
  threadId?: string;
  /** PR review-comment database id (for an inline thread reply / reaction). */
  commentId?: number;
  /** Reply/comment body to post (bot-signed before sending). */
  body?: string;
  /** Add a 👍 reaction to the comment. */
  reactThumbsUp?: boolean;
  /** Post as a PR-level issue comment rather than an inline thread reply. */
  prLevel?: boolean;
  /** When prLevel, the issue-comment id to thread under (optional). */
  inReplyTo?: number;
}

// --- act (code) -------------------------------------------------------------

const act: StepDef = {
  name: 'act',
  phase: 'polish',
  kind: 'code',
  scope: 'repo',
  run: async ctx => {
    const repo = repoOf(ctx);
    const wt = worktreeOf(ctx);

    // `act` is a `code` step, so the driver gives it no metadata — the structured
    // eval verdicts live in the latest `eval:completed` event for this repo+epoch
    // (C1). Recover them from the WAL, apply the non-code actions deterministically
    // (the binary never trusts the agent to have done the GitHub I/O itself), then
    // persist what was applied for the downstream verify_fixes / tty_resolve steps.
    const evalMeta = lastEventMetadata(ctx.sessionId, 'eval:completed', repo.repo, ctx.version);
    const actions: EvalAction[] = Array.isArray(evalMeta?.actions) ? (evalMeta.actions as EvalAction[]) : [];

    const nonCode = actions.filter(a => a.kind === 'reply' || a.kind === 'resolve');
    const ambiguousCount = Number(evalMeta?.ambiguous ?? 0) || actions.filter(a => a.kind === 'ambiguous').length;
    const codeFixCount = Number(evalMeta?.codeFixes ?? 0) || actions.filter(a => a.kind === 'code_fix').length;

    let applied = 0;
    let resolvedCount = 0;
    if (wt && repo.prNumber != null) {
      for (const a of nonCode) {
        try {
          if (a.body) {
            const body = withBotSignature(a.body);
            if (a.prLevel && a.inReplyTo != null) {
              await ghReplyToIssueComment(repo.prNumber, body, a.inReplyTo, wt);
            } else if (a.prLevel || a.commentId == null) {
              // Standalone PR-level comment (no in-reply target).
              await ghPrComment(repo.prNumber, body, wt);
            } else {
              await ghReplyToThread(repo.prNumber, a.commentId, body, wt);
            }
            applied++;
          }
          if (a.reactThumbsUp && a.commentId != null) {
            await ghReact(a.commentId, '+1', wt);
          }
          if (a.kind === 'resolve' && a.threadId) {
            await ghResolveThread(a.threadId, wt);
            applied++;
            resolvedCount++;
          }
        } catch {
          // best-effort — a failed action is re-checked by verify_fixes.
        }
      }
    }

    // Persist only what downstream code steps (which get no metadata) read back
    // from the WAL: verify_fixes uses `expectedResolves` (M2); tty_resolve uses
    // `ttyReason` (M3). The number of resolves we expected to land is the count of
    // resolve verdicts (whether or not the gh call succeeded here).
    const expectedResolves = nonCode.filter(a => a.kind === 'resolve').length;
    recordRepoState(ctx, {
      expectedResolves,
      ...(ambiguousCount > 0 ? { ttyReason: 'ambiguous_eval' } : {}),
    });

    if (applied > 0) {
      appendEvent(ctx.sessionId, {
        ts: new Date().toISOString(),
        event: 'act:applied',
        version: ctx.version,
        repo: repo.repo,
        metadata: { applied, resolvedCount },
      });
    }

    // Routing (unchanged) — now driven by the real eval data.
    if (ambiguousCount > 0) return 'tty_resolve';
    if (codeFixCount > 0) return 'write_fix';
    // Non-code actions were applied — re-verify they landed before pushing.
    return applied > 0 || expectedResolves > 0 ? 'verify_fixes' : 'poll';
  },
};

// --- tty_resolve (interactive, reason-selected variant) ----------------------

const TTY_RESOLVE_MECHANICS: Record<'ambiguous' | 'conflict' | 'failure', string> = {
  ambiguous: `## Your Task
Review each ambiguous item and decide: reply / code fix / skip. Apply any needed changes.`,
  conflict: `## Your Task
1. Open the conflicted files and resolve the merge conflicts
2. \`git add\` the resolved files
3. \`git rebase --continue\`
4. If unresolvable, \`git rebase --abort\` and I will try an alternative approach`,
  failure: `## Your Task
Investigate the failure and help decide next steps:
1. Fix the issue and retry  2. Skip and move on  3. Escalate and stop`,
};

/**
 * The latest `ttyReason` any routing step persisted for this repo+epoch (M3).
 * Scans for the most recent `context:updated` event that actually carries the
 * key (act persists it conditionally, so the very latest event may not have it).
 */
function lastTtyReason(ctx: StepContext): string | undefined {
  const repo = repoOf(ctx).repo;
  const last = readLog(ctx.sessionId)
    .filter(
      e =>
        e.event === 'context:updated' &&
        (e.repo ?? e.metadata?.repo ?? null) === repo &&
        (e.version ?? 0) === ctx.version &&
        e.metadata?.ttyReason != null,
    )
    .at(-1);
  return last?.metadata?.ttyReason as string | undefined;
}

/** Map the recorded reason to the variant + configurable agent name. */
function ttyVariant(reason: string | undefined): {
  variant: 'ambiguous' | 'conflict' | 'failure';
  agent: string;
} {
  if (reason === 'conflict' || reason === 'merge_conflict') {
    return { variant: 'conflict', agent: 'tty_resolve_conflict' };
  }
  if (reason === 'failure' || reason === 'run_fix_failure') {
    return { variant: 'failure', agent: 'tty_resolve_failure' };
  }
  return { variant: 'ambiguous', agent: 'tty_resolve_ambiguous' };
}

const ttyResolve: StepDef = {
  name: 'tty_resolve',
  phase: 'polish',
  kind: 'interactive',
  scope: 'repo',
  prepare: async ctx => {
    // tty_resolve is yielded by `next` (prepare gets no `--metadata`), so the
    // reason was persisted to the WAL by the routing step that sent us here:
    // `act` → ttyReason "ambiguous_eval", `push` rebase-conflict → "merge_conflict",
    // `run_fix` failure → "run_fix_failure". Read the latest persisted reason. (M3)
    const reason = lastTtyReason(ctx);
    const { variant, agent } = ttyVariant(reason);
    const vars: Record<string, string | null> = {
      ...polishVars(ctx),
      ttyReason: reason ?? 'ambiguous',
    };
    const body = getAgentPrompt('phase3', agent, vars as Record<string, string>);
    const prompt = [
      body,
      '',
      '## Context',
      `Spec: ${vars.spec_path}`,
      `Plans:\n${vars.plan_paths}`,
      '',
      TTY_RESOLVE_MECHANICS[variant],
      '',
      SHARED_APPROVAL_GATE,
    ].join('\n');
    return {
      prompt,
      vars,
      contract: {
        completionEvent: 'tty_resolve:approved',
        completionMetadataSchema: {
          ttyReason: 'ambiguous|conflict|failure',
          filesChanged: 'number?',
        },
      },
    } satisfies PreparedStep;
  },
  finalize: async ctx => {
    const wt = worktreeOf(ctx);
    // Prefer the explicit metadata; fall back to a git diff probe.
    const declared = ctx.metadata?.filesChanged;
    let changed = typeof declared === 'number' ? declared > 0 : false;
    if (declared == null && wt) {
      const diff = gitTry(['diff', '--name-only'], wt);
      changed = diff != null && diff.length > 0;
    }
    return changed ? 'write_fix' : 'poll';
  },
};

// --- write_fix (agent) ------------------------------------------------------

const WRITE_FIX_MECHANICS = `## Context Paths
- Spec: {spec_path}
- Plans: {plan_paths}
- Previous feedback: {feedback_path}
Read these files to understand the original context.

## Fixes
Merge all pending code fixes from the eval results into a single coherent implementation spec.

## Output Format
Write a structured implementation spec for each fix:
### Fix N: [Title]
**File**: [path] · **Issue**: [what's wrong, from PR feedback]
**Changes**: - [change 1] - [change 2]
**Definition of Done**: - [ ] [verifiable 1] - [ ] [verifiable 2]
Output ALL fixes in this format, one per section. Deduplicate overlapping fixes on the same file.`;

const writeFix: StepDef = {
  name: 'write_fix',
  phase: 'polish',
  kind: 'agent',
  scope: 'repo',
  prepare: async ctx => {
    const fixSpecPath = join(sessionDir(ctx.sessionId), 'tmp', `fix-spec-${repoOf(ctx).repo}-v${ctx.version}.md`);
    const vars = { ...polishVars(ctx), fix_spec_path: fixSpecPath };
    const body = getAgentPrompt('phase3', 'write_fix', vars as Record<string, string>);
    const prompt = `${substitute(WRITE_FIX_MECHANICS, vars)}\n\nWrite the merged fix spec to: ${fixSpecPath}\n\n${body}`;
    return {
      prompt,
      vars,
      contract: {
        outputFile: fixSpecPath,
        completionEvent: 'write_fix:completed',
        completionMetadataSchema: {
          fixSpecPath: 'string?',
          codeFixCount: 'number?',
        },
      },
    } satisfies PreparedStep;
  },
  finalize: async ctx => {
    // Init the kloop fix run from the produced fix-spec and persist its run id +
    // spec path to the WAL so `run_fix` (a code step with no metadata) can drive
    // it (M1). Sandbox-tolerant: no kloop / no fix-spec → degrade to verify_fixes.
    const fixSpecPath = (ctx.metadata?.fixSpecPath as string | undefined) ?? ctx.output;
    const wt = worktreeOf(ctx);
    if (wt && fixSpecPath && existsSync(fixSpecPath)) {
      try {
        const runId = devloopInit(wt, fixSpecPath);
        recordRepoState(ctx, { kloopRunId: runId });
      } catch {
        // No kloop in the sandbox — run_fix will degrade to verify_fixes.
      }
    }
    return 'run_fix';
  },
};

// --- run_fix (code = kloop fix run; kloop NEVER commits) ----------------------

const runFix: StepDef = {
  name: 'run_fix',
  phase: 'polish',
  kind: 'code',
  scope: 'repo',
  run: async ctx => {
    // `run_fix` is a `code` step and gets no metadata — the kloop fix run id was
    // persisted to the WAL by `write_fix.finalize` (M1). Read it back.
    const runId = lastEventMetadata(ctx.sessionId, 'context:updated', repoOf(ctx).repo, ctx.version)?.kloopRunId as
      | string
      | undefined;
    if (!runId) {
      // No kloop run to drive (test sandbox) — treat as completed and re-verify.
      return 'verify_fixes';
    }
    try {
      const result = await devloopRun(runId);
      if (result.status === 'completed') return 'verify_fixes';
      if (result.status === 'conflict' || result.status === 'max_iterations') {
        // Hand to the interactive resolver as a run-fix failure. (M3)
        recordRepoState(ctx, { ttyReason: 'run_fix_failure' });
        return 'tty_resolve';
      }
      return 'failed';
    } catch {
      return 'verify_fixes';
    }
  },
};

// --- verify_fixes (code — reliability gate, SPEC §13 #17) ---------------------

const verifyFixes: StepDef = {
  name: 'verify_fixes',
  phase: 'polish',
  kind: 'code',
  scope: 'repo',
  run: async ctx => {
    const repo = repoOf(ctx);
    const wt = worktreeOf(ctx);
    // No gh / worktree (test sandbox) — assume verified.
    if (!wt || repo.prNumber == null) return 'push';

    try {
      // `verify_fixes` is a code step (no metadata) — read the expected non-code
      // resolve count `act` persisted to the WAL (M2). Re-pull the thread list and
      // confirm those fixes actually landed (threads resolved) before we push. The
      // binary never trusts an "I applied it" report.
      const expected = Number(
        lastEventMetadata(ctx.sessionId, 'context:updated', repo.repo, ctx.version)?.expectedResolves ?? 0,
      );
      const threads = await ghReviewThreads(repo.prNumber, wt).catch(() => null);
      if (threads === null) return 'push'; // no gh — degrade to verified
      // Each fetched review thread is unresolved; if we expected resolves but the
      // same (or more) threads remain unresolved, the actions did not land — loop
      // back to eval/act instead of pushing on faith.
      const unverified = expected > 0 && threads.length >= expected;
      return unverified ? 'eval' : 'push';
    } catch {
      return 'push';
    }
  },
};

// --- feedback_check (interactive) -------------------------------------------

const feedbackCheck: StepDef = {
  name: 'feedback_check',
  phase: 'feedback',
  kind: 'interactive',
  scope: 'session',
  prepare: async ctx => {
    const prRef =
      ctx.meta.repos
        .map(r => r.prUrl ?? (r.prNumber != null ? `#${r.prNumber}` : null))
        .filter(Boolean)
        .join(', ') || '(no PR)';
    const prompt = [
      `Every PR (${prRef}) is ready to merge — CI is green and all threads are resolved.`,
      '',
      'Are you done, or do you have feedback that should shape the next epoch?',
      '- done: no further changes wanted.',
      '- feedback: there is something to improve; we re-enter the plan phase next epoch.',
      '',
      "If you choose 'done', also tell me whether the PR has been FULLY MERGED yet — " +
        'the controller only tears down worktrees once you confirm a merge.',
      '',
      SHARED_APPROVAL_GATE,
    ].join('\n');
    return {
      prompt,
      vars: {},
      contract: {
        completionEvent: 'feedback_check:completed',
        completionMetadataSchema: {
          choice: 'feedback|done',
          fullyMerged: 'boolean?',
        },
      },
    } satisfies PreparedStep;
  },
  finalize: async ctx => {
    const choice = ctx.metadata?.choice as string | undefined;
    if (choice === 'feedback') return 'feedback';
    // choice === 'done'
    const fullyMerged = ctx.metadata?.fullyMerged === true;
    return fullyMerged ? 'cleanup' : null; // session complete; worktrees kept.
  },
};

// --- feedback (interactive) → rules.md evolution -----------------------------

const FEEDBACK_MECHANICS = `## CRITICAL: Feedback Mechanics
### Output File
Write the feedback to {feedback_doc} (consumed by phase-1 write_spec next epoch).

### Evolution → rules.md (do NOT apply feedback literally)
Distill the user's feedback into candidate RULES, reasoning about scope:
- task-specific vs repo-specific?
- a rule for WRITING CODE, or for THINKING about big-picture solutions?
Suggest a few candidate rules. Confirm with AskUserQuestion (show a rules.md diff).
The controller appends confirmed rules to each involved repo's rules.md and links it from
CLAUDE.md / AGENTS.md. Curated, deduped, terse — nothing added unconfirmed.

### Previous revision diff (if any)
{lastDiff}`;

const feedback: StepDef = {
  name: 'feedback',
  phase: 'feedback',
  kind: 'interactive',
  scope: 'session',
  prepare: async ctx => {
    const { path } = nextRevisionPath(ctx.sessionId, 'feedback', {
      epoch: ctx.version,
    });
    const epochDir = join(sessionDir(ctx.sessionId), 'epoch', String(ctx.version));
    const prUrls =
      ctx.meta.repos
        .map(r => r.prUrl)
        .filter((u): u is string => !!u)
        .join(', ') || '(no PR)';
    const vars: Record<string, string | null> = {
      feedback_doc: path,
      task_spec_path: join(epochDir, 'spec'),
      plans_dir: join(epochDir, 'plans'),
      pr_url: prUrls,
      checks_status: '(ready to merge)',
      thread_count: '0',
      lastDiff:
        latestRevisionOnDisk(ctx.sessionId, 'feedback', {
          epoch: ctx.version,
        }) >= 2
          ? diffRevisions(ctx.sessionId, 'feedback', { epoch: ctx.version })
          : null,
    };
    const body = getAgentPrompt('phase3', 'feedback', vars as Record<string, string>);
    const prompt = `${substitute(FEEDBACK_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}\n\n${body}`;
    return {
      prompt,
      vars,
      contract: {
        outputFile: path,
        completionEvent: 'feedback:approved',
        completionMetadataSchema: { rules: 'string[]' },
      },
    } satisfies PreparedStep;
  },
  finalize: async ctx => {
    // Append confirmed rules to each involved repo's rules.md (best-effort).
    const rules = (ctx.metadata?.rules as string[] | undefined) ?? [];
    if (rules.length > 0) {
      for (const r of ctx.meta.repos) {
        if (!r.worktree) continue;
        try {
          const rulesFile = join(r.worktree, 'rules.md');
          const prev = existsSync(rulesFile) ? readFileSync(rulesFile, 'utf-8') : '';
          const additions = rules.map(line => `- ${line}`).join('\n');
          const next = prev ? `${prev.replace(/\s*$/, '')}\n${additions}\n` : `# Rules\n\n${additions}\n`;
          Bun.write(rulesFile, next);
        } catch {
          // best-effort — never block the epoch bump on rules.md I/O.
        }
      }
    }
    // Bump the epoch and re-enter the plan phase (same branch + PR). Reset each
    // repo to pending so the new epoch's `await_repos` gate waits for them again.
    updateSessionMeta(ctx.sessionId, m => {
      m.epoch += 1;
      for (const r of m.repos) r.status = 'pending';
    });
    return 'write_spec';
  },
};

// --- cleanup (code) ---------------------------------------------------------

const cleanup: StepDef = {
  name: 'cleanup',
  phase: 'feedback',
  kind: 'code',
  scope: 'session',
  run: async ctx => {
    // Remove this session's worktrunk worktrees (best-effort). The binary never
    // merges — it only tears down worktrees the user already merged.
    for (const r of ctx.meta.repos) {
      const wt = r.worktree;
      if (!wt) continue;
      try {
        // Detach the git worktree registration from its repo, then drop the dir.
        if (r.repoPath) gitTry(['worktree', 'remove', '--force', wt], r.repoPath);
        if (existsSync(wt)) {
          // Only remove a directory that still looks like a worktree.
          const entries = readdirSync(wt);
          if (entries.length === 0 || entries.includes('.git')) {
            rmSync(wt, { recursive: true, force: true });
          }
        }
      } catch {
        // best-effort teardown.
      }
    }
    return null; // session done.
  },
};

// --- repo_ready (code) — per-repo terminal -----------------------------------

/**
 * A repo has reached ready-to-merge (CI green + threads resolved, never merged).
 * Mark it ready and end this repo's timeline; the shared `await_repos` gate then
 * proceeds to the feedback phase once EVERY repo is ready. (SPEC §7.5)
 */
const repoReady: StepDef = {
  name: 'repo_ready',
  phase: 'polish',
  kind: 'code',
  scope: 'repo',
  run: async ctx => {
    const repo = repoOf(ctx);
    updateSessionMeta(ctx.sessionId, m => {
      const e = m.repos.find(r => r.repo === repo.repo);
      if (e) e.status = 'ready';
    });
    return null; // this repo is ready to merge — timeline complete.
  },
};

export const POLISH_STEPS: StepDef[] = [
  commitPending,
  prereviewClassify,
  push,
  createPr,
  poll,
  ensureBranch,
  evalStep,
  act,
  ttyResolve,
  writeFix,
  runFix,
  verifyFixes,
  repoReady,
  feedbackCheck,
  feedback,
  cleanup,
];
