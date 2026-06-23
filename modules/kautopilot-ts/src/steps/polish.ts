import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentPrompt } from "../core/agents";
import { sessionDir } from "../core/artifacts";
import type { PreparedStep, StepContext, StepDef } from "../core/descriptor";
import { devloopInit, devloopRun } from "../core/devloop";
import { getCurrentBranch, hasUnmergedPaths, isOnMain } from "../core/git";
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
} from "../core/github";
import { appendEvent, readLog } from "../core/log";
import {
	currentRevisionPath,
	diffRevisions,
	latestRevisionOnDisk,
} from "../core/revisions";
import type { RepoEntry } from "../core/session-meta";
import { findRepo, updateSessionMeta } from "../core/session-meta";
import { lastEventMetadata } from "./execution";
import { SHARED_APPROVAL_GATE, substitute, ticketId } from "./prompt-helpers";

/**
 * Persist a `context:updated` event scoped to this repo + epoch so a downstream
 * `code` step can recover the payload (the driver gives code steps no metadata).
 * Mirrors execution.ts `recordRepoState`.
 */
function recordRepoState(
	ctx: StepContext,
	metadata: Record<string, unknown>,
): void {
	appendEvent(ctx.sessionId, {
		ts: new Date().toISOString(),
		event: "context:updated",
		version: ctx.version,
		repo: repoOf(ctx).repo,
		metadata,
	});
}

/**
 * Read a single `context:updated` value for this repo+epoch, scanning for the
 * latest event that actually CARRIES the key. recordRepoState writes keys
 * conditionally (e.g. `act` may record `{expectedResolves}` and later steps record
 * `{kloopRunId}`), so the very latest event often lacks the key you want — an
 * unfiltered `lastEventMetadata` read would return the wrong event's metadata (and
 * thus a missing/0 value). Mirrors execution.ts `readRepoState`.
 */
function readRepoStateValue<T>(ctx: StepContext, key: string): T | undefined {
	const repo = repoOf(ctx).repo;
	const last = readLog(ctx.sessionId)
		.filter(
			(e) =>
				e.event === "context:updated" &&
				(e.repo ?? e.metadata?.repo ?? null) === repo &&
				(e.version ?? 0) === ctx.version &&
				e.metadata != null &&
				key in e.metadata,
		)
		.at(-1);
	return last?.metadata?.[key] as T | undefined;
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
	if (!ctx.repo) throw new Error("polish step requires a repo-scoped context");
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
	return join(wt, "spec", ticketId(ctx.meta), `v${ctx.version}`);
}

/**
 * Absolute path to the master spec inside the worktree, or a stable placeholder.
 * seed writes the master spec as `task-spec.md` (execution.ts), and only when the
 * org opts in via `commitSpec` — so this file may legitimately be absent; prompts
 * must treat it as read-if-present.
 */
function specPathOf(ctx: StepContext): string {
	const dir = epochDir(ctx);
	return dir ? join(dir, "task-spec.md") : "(no spec — repo not seeded)";
}

/** Plan paths assigned to this repo inside the worktree (newline-joined), or placeholder. */
function planPathsOf(ctx: StepContext): string {
	const dir = epochDir(ctx);
	const plans = ctx.repo?.plans ?? [];
	if (!dir || plans.length === 0) return "(no plans — repo not seeded)";
	// seed writes each plan into the worktree as `plans/<plan>.md` (execution.ts).
	return plans.map((p) => join(dir, "plans", `${p}.md`)).join("\n");
}

/** Feedback doc path for this epoch inside the worktree. */
function feedbackPathOf(ctx: StepContext): string {
	const dir = epochDir(ctx);
	return dir ? join(dir, "feedback.md") : "(no feedback)";
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

/**
 * Run a synchronous git command, swallowing all errors (returns trimmed stdout or null).
 * Pass `timeout` (ms) for network ops (fetch/pull) so a wedged remote can't block a code
 * step holding the run-lock indefinitely.
 */
function gitTry(args: string[], cwd: string, timeout?: number): string | null {
	try {
		const proc = Bun.spawnSync({
			cmd: ["git", ...args],
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout,
		});
		if (proc.exitCode !== 0) return null;
		return proc.stdout.toString().trim();
	} catch {
		return null;
	}
}

/** Bound for network git ops in cleanup (fetch/pull) — keeps the run-lock from wedging. */
const GIT_NET_TIMEOUT_MS = 120_000;

// --- generic.commit mechanics (Appendix C) ----------------------------------

const COMMIT_CONTEXT_EMPTY = "";

// --- commit_pending (agent) -------------------------------------------------

const commitPending: StepDef = {
	name: "commit_pending",
	phase: "polish",
	kind: "agent",
	scope: "repo",
	prepare: async (ctx) => {
		const vars = { ...polishVars(ctx), context: COMMIT_CONTEXT_EMPTY };
		const prompt = getAgentPrompt("generic", "commit", {
			context: COMMIT_CONTEXT_EMPTY,
		});
		return {
			prompt,
			vars,
			contract: {
				completionEvent: "commit_pending:completed",
				completionMetadataSchema: { commitSha: "string?", skipped: "boolean?" },
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) =>
		ctx.config.settings.coderabbit ? "prereview" : "push",
};

// --- prereview (agent when coderabbit, else a no-op code skip) ---------------

const prereviewClassify: StepDef = {
	name: "prereview",
	phase: "polish",
	kind: "agent",
	scope: "repo",
	// When coderabbit is disabled the binary never yields this step — the
	// preceding commit_pending routes straight to `push`. The `run` below is the
	// degraded code path so the step still resolves if reached.
	run: async () => "push",
	prepare: async (ctx) => {
		const vars = polishVars(ctx);
		const classify = getAgentPrompt(
			"phase3",
			"prereview_classify",
			vars as Record<string, string>,
		);
		const fix = getAgentPrompt(
			"phase3",
			"prereview_fix",
			vars as Record<string, string>,
		);
		const prompt = [
			"Run CodeRabbit over the pending changes and process its findings in two passes.",
			"Use the `coderabbit` CLI in agent mode: `coderabbit review --agent` (emits " +
				"structured findings for agents; add `--base <branch>` to scope to this branch's " +
				"changes). `cr` is an alias. Run `coderabbit auth login` / `coderabbit doctor` " +
				"first if it reports it isn't authenticated/ready.",
			"",
			"## Pass 1 — classify",
			classify,
			"",
			"## Pass 2 — fix",
			fix,
			"",
			"Commit any applied fixes with the repo's commit conventions (generic.commit). " +
				"If CodeRabbit is unavailable or finds nothing actionable, skip cleanly.",
		].join("\n");
		return {
			prompt,
			vars,
			contract: {
				completionEvent: "prereview:completed",
				completionMetadataSchema: {
					fixesApplied: "number?",
					skipped: "boolean?",
					reason: "string?",
				},
			},
		} satisfies PreparedStep;
	},
	finalize: async () => "push",
};

// --- push (code) ------------------------------------------------------------

const push: StepDef = {
	name: "push",
	phase: "polish",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		const repo = repoOf(ctx);
		const wt = worktreeOf(ctx);
		// No worktree (test sandbox) — nothing to push; route to next.
		if (!wt) return repo.prNumber ? "poll" : "create_pr";

		try {
			// Safety: never push from the base branch.
			if (isOnMain(ctx.meta.baseBranch, wt)) {
				throw new Error(
					`Refusing to push from ${ctx.meta.baseBranch} — safety check`,
				);
			}

			const branch = getCurrentBranch(wt);
			const hasUpstream =
				gitTry(["rev-parse", "--abbrev-ref", "@{upstream}"], wt) !== null;

			if (hasUpstream) {
				const ahead = gitTry(["rev-list", "@{upstream}..HEAD", "--count"], wt);
				if (ahead === "0") {
					// Nothing to push — already up to date.
					return repo.prNumber ? "poll" : "create_pr";
				}
				// Subsequent push with retry: direct → pull --ff-only → pull --rebase.
				let pushed = gitTry(["push"], wt) !== null;
				if (!pushed && gitTry(["pull", "--ff-only"], wt) !== null) {
					pushed = gitTry(["push"], wt) !== null;
				}
				if (!pushed) {
					const rebased = gitTry(["pull", "--rebase"], wt) !== null;
					if (rebased) {
						pushed = gitTry(["push"], wt) !== null;
					} else if (hasUnmergedPaths(wt)) {
						// Rebase hit conflicts — hand to the interactive resolver. Persist
						// the reason so tty_resolve renders the conflict variant. (M3)
						recordRepoState(ctx, { ttyReason: "merge_conflict" });
						return "tty_resolve";
					}
				}
				if (!pushed) throw new Error("push failed after all retries");
			} else {
				// First push — set upstream.
				if (gitTry(["push", "-u", "origin", branch], wt) === null) {
					throw new Error("first push failed");
				}
			}
		} catch {
			// Degrade gracefully in a no-git sandbox: still advance the machine.
		}

		return repo.prNumber ? "poll" : "create_pr";
	},
};

// --- create_pr (agent) ------------------------------------------------------

const CREATE_PR_MECHANICS = `## Spec Context
Read the spec at: {spec_path}
The spec contains what was implemented. Use it for PR body context.`;

const createPr: StepDef = {
	name: "create_pr",
	phase: "polish",
	kind: "agent",
	scope: "repo",
	prepare: async (ctx) => {
		const repo = repoOf(ctx);
		const vars = polishVars(ctx);
		const body = getAgentPrompt(
			"phase3",
			"create_pr",
			vars as Record<string, string>,
		);
		const reuseNote =
			repo.prNumber != null
				? `\n\n## Existing PR\nA PR already exists for this branch (#${repo.prNumber}). ` +
					"Do NOT open a new one — update the existing PR's title/body to reflect the latest epoch."
				: "";
		const prompt = `${substitute(CREATE_PR_MECHANICS, vars)}\n\n${body}${reuseNote}`;
		return {
			prompt,
			vars,
			contract: {
				completionEvent: "create_pr:completed",
				completionMetadataSchema: { prNumber: "number", prUrl: "string" },
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		const repo = repoOf(ctx);
		const wt = worktreeOf(ctx);
		const prNumber = ctx.metadata?.prNumber as number | undefined;
		const prUrl = ctx.metadata?.prUrl as string | undefined;
		if (prNumber != null) {
			updateSessionMeta(ctx.sessionId, (m) => {
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
		return "poll";
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
function computePollState(s: PollSignals): "mergeable" | "blocked" | "pending" {
	if (s.changesRequested) return "blocked";
	if (s.unresolvedThreads > 0) return "blocked";
	if (s.failingChecks > 0) return "blocked";
	if (s.pendingChecks > 0) return "pending";
	if (
		!s.mergeable ||
		!["CLEAN", "HAS_HOOKS", "UNSTABLE", "BLOCKED"].includes(s.mergeStateStatus)
	) {
		return "pending";
	}
	return "mergeable";
}

/**
 * Count branch-protection required check contexts that have not yet reported a
 * result. Uses the repo's merge policy so a not-yet-started required check keeps
 * the PR pending rather than letting it look mergeable. Best-effort.
 */
async function requiredChecksPending(
	checks: { name: string; status: string }[],
	wt: string,
): Promise<number> {
	const { owner, repo } = await ghRepoInfo(wt);
	const policy = await ghFetchMergePolicy(owner, repo, wt);
	if (!policy.requiresStatusChecks) return 0;
	const reported = new Set(checks.map((c) => c.name));
	return policy.requiredStatusCheckContexts.filter((c) => !reported.has(c))
		.length;
}

/**
 * Fetch the failed CI run logs for the branch and record a digest into the WAL,
 * so eval/tty_resolve have failure context. Never throws; degrades when gh is absent.
 */
async function recordFailedRunLogs(
	ctx: StepContext,
	branch: string | null,
	wt: string,
): Promise<void> {
	if (!branch) return;
	const runs = await ghPrRuns(branch, wt);
	const failed = runs.find((r) => r.conclusion === "failure");
	if (!failed) return;
	const logs = await ghRunLogsFailed(String(failed.databaseId), wt);
	appendEvent(ctx.sessionId, {
		ts: new Date().toISOString(),
		event: "poll:ci_failed",
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
	name: "poll",
	phase: "polish",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		const repo = repoOf(ctx);
		const wt = worktreeOf(ctx);
		if (!wt) return "repo_ready";

		// Reconcile a missing PR number from the open PRs on this branch (a PR may
		// have been opened out-of-band). Best-effort; degrades when gh is absent.
		let prNumber = repo.prNumber;
		if (prNumber == null && repo.branch) {
			const open = await ghListPrsForBranch(repo.branch, wt).catch(() => []);
			prNumber = open[0]?.number ?? null;
			if (prNumber != null) {
				updateSessionMeta(ctx.sessionId, (m) => {
					const entry = findRepo(m, repo.repo);
					if (entry) entry.prNumber = prNumber;
				});
			}
		}
		// No real PR (test sandbox): advance, never loop.
		if (prNumber == null) return "repo_ready";

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
			if (!prView) return "repo_ready";
			if (prView.state === "CLOSED") return "repo_ready";

			// Required-check policy: a context the branch protection requires but
			// which isn't reported yet counts as pending (best-effort).
			const requiredPending = await requiredChecksPending(checks, wt).catch(
				() => 0,
			);

			// Capture failed-CI logs into the WAL so later steps have context.
			const failingChecks = checks.filter((c) => c.status === "failing").length;
			if (failingChecks > 0) {
				await recordFailedRunLogs(ctx, repo.branch, wt).catch(() => {});
			}

			// PR-level issue comments can NOT be resolved, so they must NOT block
			// forever. Exclude bot-authored comments (e.g. a CodeRabbit summary), our
			// own bot-signed replies, and any comment we have already replied to.
			// Only genuinely-actionable HUMAN comments count as blocking conversation.
			const replyTargets = new Set(
				prComments
					.filter((c) => c.body.includes(BOT_SIGNATURE_MARKER))
					.map((c) => c.author?.login)
					.filter((l): l is string => Boolean(l)),
			);
			const actionableHumanComments = prComments.filter((c) => {
				const login = c.author?.login ?? "";
				if (login.includes("[bot]")) return false; // bot summary — not actionable
				if (c.body.includes(BOT_SIGNATURE_MARKER)) return false; // our own reply
				if (replyTargets.has(login)) return false; // already replied to this author
				return true;
			}).length;

			const signals: PollSignals = {
				prState: prView.state,
				mergeable: prView.mergeable,
				mergeStateStatus: prView.mergeStateStatus,
				failingChecks,
				pendingChecks:
					checks.filter((c) => c.status === "pending").length + requiredPending,
				unresolvedThreads: threads.length + actionableHumanComments,
				changesRequested:
					prView.reviews.some((r) => r.state === "CHANGES_REQUESTED") ||
					reviews.some((r) => r.state === "CHANGES_REQUESTED"),
			};

			const state = computePollState(signals);
			if (state === "mergeable") return "repo_ready";
			if (state === "blocked") return "ensure_branch";

			// pending — wait then re-poll (bounded by maxCycles).
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}

		// Exceeded the cycle cap while still pending.
		return "repo_ready";
	},
};

// --- ensure_branch (code) ---------------------------------------------------

const ensureBranch: StepDef = {
	name: "ensure_branch",
	phase: "polish",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		const wt = worktreeOf(ctx);
		if (!wt) return "eval";
		try {
			gitTry(["fetch", "origin", ctx.meta.baseBranch], wt);
			const behind = gitTry(
				["rev-list", "--count", `HEAD..origin/${ctx.meta.baseBranch}`],
				wt,
			);
			const behindCount = behind != null ? Number.parseInt(behind, 10) : 0;
			// Behind base → let push rebase + re-push; up to date → evaluate feedback.
			return behindCount > 0 ? "push" : "eval";
		} catch {
			return "eval";
		}
	},
};

// --- eval (agent fan-out) ---------------------------------------------------

const EVAL_MECHANICS = `## Context Paths
You have access to these files to understand the original intent and determine if feedback is valid:
- Spec: {spec_path}
- Plans: {plan_paths}
Read these files. They define what was INTENDED. Compare against the feedback to determine if it's a genuine issue or a false positive.

## Detecting false positives
Compare each piece of feedback against the spec / plans / code. A false positive asks for something that:
- Contradicts the spec (spec says X, reviewer wants Y)
- Is already satisfied (the reviewer missed it)
- Is out of scope (reviewer scope creep)
- Is stylistic preference, not a correctness issue

## Every thread ends RESOLVED or RAISED — never silently left open
Pick a terminal state for EACH unresolved thread. Work through them in this order:
1. **Outdated** — the code the comment points at has since changed (the thread is marked
   \`isOutdated\`, or the referenced lines no longer exist): "resolve" with a one-line
   "superseded by …" note. The comment no longer applies.
2. **Genuine, fixable issue**: "code_fix" with fix instructions — the change is applied, then
   the thread is replied to and resolved.
3. **False positive**: "reply" explaining WHY you are not changing it. Do NOT resolve on this
   pass — give them one cycle to counter.
4. **Ghosted (bot reviewers only)** — for a BOT reviewer's thread (e.g. CodeRabbit) where the LAST
   comment is your OWN reply and it is still open a cycle later (no counter came): "resolve" with a
   brief closing note. This is how you stop re-fighting a settled bot thread — never loop on it.
   NEVER ghost-resolve a HUMAN's thread this way — see 5.
5. **Needs a human decision** — a product / scope / priority call, a genuinely ambiguous
   requirement, a security or correctness trade-off you are unsure of, or ANY human reviewer's
   change-request you replied to that they have not conceded: set "ambiguous" with a crisp
   \`ambiguousReason\` (state the question AND your recommendation). The binary raises these to the
   user — they are NEVER auto-resolved or guessed. Human threads OUTRANK rule 4: if a human is
   waiting, raise it, don't ghost-resolve it.

Your own prior replies end with the exact line "${BOT_SIGNATURE_MARKER}" — match on that literal to
recognize them when judging "ghosted". A bot summary/overview comment and your own already-posted
replies are not, on their own, actionable.

## Possible Actions
- "reply": post your reasoning or acknowledgement
- "resolve": resolve the thread (fixed, N/A, outdated, or ghosted-after-pushback)
- "code_fix": the feedback needs code changes — provide fix instructions
- "ambiguous": needs the user — mark it (with reason); never guess

## Output Format
Complete with metadata containing an **\`actions\`** array — ONE entry per thread you acted
on — plus rollup counts. The binary (\`act\`) applies these deterministically, so you MUST
echo the thread/comment ids EXACTLY as given in the feedback list above; without them your
replies and resolves cannot be posted to GitHub.

{
  "actions": [
    {
      "kind": "reply" | "resolve" | "code_fix" | "ambiguous",
      "threadId": "<review-thread id — REQUIRED for kind=resolve>",
      "commentId": <inline review-comment id — for a threaded reply / 👍 reaction>,
      "body": "<reply or comment text; omit for pure code_fix/ambiguous>",
      "reactThumbsUp": false,
      "prLevel": false,
      "inReplyTo": <issue-comment id — only when prLevel>,
      "codeFix": "<fix instructions — for kind=code_fix>",
      "ambiguousReason": "<the question + your recommendation — for kind=ambiguous>"
    }
  ],
  "replies": <number of kind=reply>,
  "resolves": <number of kind=resolve>,
  "codeFixes": <number of kind=code_fix>,
  "ambiguous": <number of kind=ambiguous>
}`;

const evalStep: StepDef = {
	name: "eval",
	phase: "polish",
	kind: "agent",
	scope: "repo",
	prepare: async (ctx) => {
		const vars = polishVars(ctx);
		const body = getAgentPrompt(
			"phase3",
			"eval",
			vars as Record<string, string>,
		);
		const prompt = `${substitute(EVAL_MECHANICS, vars)}\n\n${body}`;
		return {
			prompt,
			vars,
			contract: {
				completionEvent: "eval:completed",
				completionMetadataSchema: {
					// The structured verdicts `act` applies. Each: { kind:
					// "reply"|"resolve"|"code_fix"|"ambiguous", threadId?, commentId?,
					// body?, reactThumbsUp?, prLevel?, inReplyTo? }.
					actions: "Array<{kind,threadId?,commentId?,body?,...}>",
					replies: "number?",
					resolves: "number?",
					codeFixes: "number?",
					ambiguous: "number?",
				},
			},
		} satisfies PreparedStep;
	},
	finalize: async () => "act",
};

/** One structured eval verdict, as carried in `eval:completed` metadata. (C1) */
interface EvalAction {
	kind: "reply" | "resolve" | "code_fix" | "ambiguous";
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
	name: "act",
	phase: "polish",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		const repo = repoOf(ctx);
		const wt = worktreeOf(ctx);

		// `act` is a `code` step, so the driver gives it no metadata — the structured
		// eval verdicts live in the latest `eval:completed` event for this repo+epoch
		// (C1). Recover them from the WAL, apply the non-code actions deterministically
		// (the binary never trusts the agent to have done the GitHub I/O itself), then
		// persist what was applied for the downstream verify_fixes / tty_resolve steps.
		const evalMeta = lastEventMetadata(
			ctx.sessionId,
			"eval:completed",
			repo.repo,
			ctx.version,
		);
		const actions: EvalAction[] = Array.isArray(evalMeta?.actions)
			? (evalMeta.actions as EvalAction[])
			: [];

		const nonCode = actions.filter(
			(a) => a.kind === "reply" || a.kind === "resolve",
		);
		const ambiguousCount =
			Number(evalMeta?.ambiguous ?? 0) ||
			actions.filter((a) => a.kind === "ambiguous").length;
		const codeFixCount =
			Number(evalMeta?.codeFixes ?? 0) ||
			actions.filter((a) => a.kind === "code_fix").length;

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
						await ghReact(a.commentId, "+1", wt);
					}
					if (a.kind === "resolve" && a.threadId) {
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
		const expectedResolves = nonCode.filter((a) => a.kind === "resolve").length;
		recordRepoState(ctx, {
			expectedResolves,
			...(ambiguousCount > 0 ? { ttyReason: "ambiguous_eval" } : {}),
		});

		if (applied > 0) {
			appendEvent(ctx.sessionId, {
				ts: new Date().toISOString(),
				event: "act:applied",
				version: ctx.version,
				repo: repo.repo,
				metadata: { applied, resolvedCount },
			});
		}

		// Routing (unchanged) — now driven by the real eval data.
		if (ambiguousCount > 0) return "tty_resolve";
		if (codeFixCount > 0) return "write_fix";
		// Non-code actions were applied — re-verify they landed before pushing.
		return applied > 0 || expectedResolves > 0 ? "verify_fixes" : "poll";
	},
};

// --- tty_resolve (interactive, reason-selected variant) ----------------------

const TTY_RESOLVE_MECHANICS: Record<
	"ambiguous" | "conflict" | "failure",
	string
> = {
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
			(e) =>
				e.event === "context:updated" &&
				(e.repo ?? e.metadata?.repo ?? null) === repo &&
				(e.version ?? 0) === ctx.version &&
				e.metadata?.ttyReason != null,
		)
		.at(-1);
	return last?.metadata?.ttyReason as string | undefined;
}

/** Map the recorded reason to the variant + configurable agent name. */
function ttyVariant(reason: string | undefined): {
	variant: "ambiguous" | "conflict" | "failure";
	agent: string;
} {
	if (reason === "conflict" || reason === "merge_conflict") {
		return { variant: "conflict", agent: "tty_resolve_conflict" };
	}
	if (reason === "failure" || reason === "run_fix_failure") {
		return { variant: "failure", agent: "tty_resolve_failure" };
	}
	return { variant: "ambiguous", agent: "tty_resolve_ambiguous" };
}

const ttyResolve: StepDef = {
	name: "tty_resolve",
	phase: "polish",
	kind: "interactive",
	scope: "repo",
	prepare: async (ctx) => {
		// tty_resolve is yielded by `next` (prepare gets no `--metadata`), so the
		// reason was persisted to the WAL by the routing step that sent us here:
		// `act` → ttyReason "ambiguous_eval", `push` rebase-conflict → "merge_conflict",
		// `run_fix` failure → "run_fix_failure". Read the latest persisted reason. (M3)
		const reason = lastTtyReason(ctx);
		const { variant, agent } = ttyVariant(reason);
		const vars: Record<string, string | null> = {
			...polishVars(ctx),
			ttyReason: reason ?? "ambiguous",
		};
		const body = getAgentPrompt(
			"phase3",
			agent,
			vars as Record<string, string>,
		);
		const prompt = [
			body,
			"",
			"## Context",
			`Spec: ${vars.spec_path}`,
			`Plans:\n${vars.plan_paths}`,
			"",
			TTY_RESOLVE_MECHANICS[variant],
			"",
			SHARED_APPROVAL_GATE,
		].join("\n");
		return {
			prompt,
			vars,
			contract: {
				completionEvent: "tty_resolve:approved",
				completionMetadataSchema: {
					ttyReason: "ambiguous|conflict|failure",
					filesChanged: "number?",
				},
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		const wt = worktreeOf(ctx);
		// Prefer the explicit metadata; fall back to a git diff probe.
		const declared = ctx.metadata?.filesChanged;
		let changed = typeof declared === "number" ? declared > 0 : false;
		if (declared == null && wt) {
			const diff = gitTry(["diff", "--name-only"], wt);
			changed = diff != null && diff.length > 0;
		}
		return changed ? "write_fix" : "poll";
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
	name: "write_fix",
	phase: "polish",
	kind: "agent",
	scope: "repo",
	prepare: async (ctx) => {
		const fixSpecPath = join(
			sessionDir(ctx.sessionId),
			"tmp",
			`fix-spec-${repoOf(ctx).repo}-v${ctx.version}.md`,
		);
		const vars = { ...polishVars(ctx), fix_spec_path: fixSpecPath };
		const body = getAgentPrompt(
			"phase3",
			"write_fix",
			vars as Record<string, string>,
		);
		const prompt = `${substitute(WRITE_FIX_MECHANICS, vars)}\n\nWrite the merged fix spec to: ${fixSpecPath}\n\n${body}`;
		return {
			prompt,
			vars,
			contract: {
				outputFile: fixSpecPath,
				completionEvent: "write_fix:completed",
				completionMetadataSchema: {
					fixSpecPath: "string?",
					codeFixCount: "number?",
				},
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		// Init the kloop fix run from the produced fix-spec and persist its run id +
		// spec path to the WAL so `run_fix` (a code step with no metadata) can drive
		// it (M1). Sandbox-tolerant: no kloop / no fix-spec → degrade to verify_fixes.
		const fixSpecPath =
			(ctx.metadata?.fixSpecPath as string | undefined) ?? ctx.output;
		const wt = worktreeOf(ctx);
		if (wt && fixSpecPath && existsSync(fixSpecPath)) {
			try {
				const runId = devloopInit(wt, fixSpecPath);
				recordRepoState(ctx, { kloopRunId: runId });
			} catch {
				// No kloop in the sandbox — run_fix will degrade to verify_fixes.
			}
		}
		return "run_fix";
	},
};

// --- commit_fix (agent) — commit the applied fixes; kloop NEVER commits -------
// Without this, write_fix → run_fix leaves the fixes as uncommitted working-tree
// changes and `push` publishes nothing (the thread re-appears unaddressed). Mirrors
// the execution phase's `completed → commit → next_plan`.
const commitFix: StepDef = {
	name: "commit_fix",
	phase: "polish",
	kind: "agent",
	scope: "repo",
	prepare: async (ctx) => {
		const vars = { ...polishVars(ctx), context: COMMIT_CONTEXT_EMPTY };
		const prompt = getAgentPrompt("generic", "commit", {
			context: COMMIT_CONTEXT_EMPTY,
		});
		return {
			prompt,
			vars,
			contract: {
				completionEvent: "commit_fix:completed",
				completionMetadataSchema: { commitSha: "string?", skipped: "boolean?" },
			},
		} satisfies PreparedStep;
	},
	finalize: async () => "verify_fixes",
};

// --- run_fix (code = kloop fix run; kloop NEVER commits) ----------------------

const runFix: StepDef = {
	name: "run_fix",
	phase: "polish",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		// `run_fix` is a `code` step and gets no metadata — the kloop fix run id was
		// persisted to the WAL by `write_fix.finalize` (M1). Read it back, key-filtered
		// so a later `context:updated` event that lacks `kloopRunId` can't shadow it.
		const runId = readRepoStateValue<string>(ctx, "kloopRunId");
		if (!runId) {
			// No kloop run to drive (test sandbox) — nothing was applied, so nothing to
			// commit; re-verify directly.
			return "verify_fixes";
		}
		try {
			const result = await devloopRun(runId);
			// kloop applied code but NEVER commits — commit before verify/push.
			if (result.status === "completed") return "commit_fix";
			if (result.status === "conflict" || result.status === "max_iterations") {
				// Hand to the interactive resolver as a run-fix failure. (M3)
				recordRepoState(ctx, { ttyReason: "run_fix_failure" });
				return "tty_resolve";
			}
			return "failed";
		} catch {
			// May have partially applied changes — commit (skips cleanly if none).
			return "commit_fix";
		}
	},
};

// --- verify_fixes (code — reliability gate, SPEC §13 #17) ---------------------

const verifyFixes: StepDef = {
	name: "verify_fixes",
	phase: "polish",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		const repo = repoOf(ctx);
		const wt = worktreeOf(ctx);
		// No gh / worktree (test sandbox) — assume verified.
		if (!wt || repo.prNumber == null) return "push";

		try {
			// `verify_fixes` is a code step (no metadata) — read the expected non-code
			// resolve count `act` persisted to the WAL (M2). Key-filtered: a later
			// `context:updated` (e.g. write_fix's `{kloopRunId}`) must NOT shadow `act`'s
			// `{expectedResolves}`, or the gate silently sees 0 and pushes on faith.
			// Re-pull the thread list and confirm those fixes actually landed before push.
			const expected = Number(
				readRepoStateValue<number>(ctx, "expectedResolves") ?? 0,
			);
			const threads = await ghReviewThreads(repo.prNumber, wt).catch(
				() => null,
			);
			if (threads === null) return "push"; // no gh — degrade to verified
			// Each fetched review thread is unresolved; if we expected resolves but the
			// same (or more) threads remain unresolved, the actions did not land — loop
			// back to eval/act instead of pushing on faith.
			const unverified = expected > 0 && threads.length >= expected;
			return unverified ? "eval" : "push";
		} catch {
			return "push";
		}
	},
};

// --- feedback_check (interactive) -------------------------------------------

const feedbackCheck: StepDef = {
	name: "feedback_check",
	phase: "feedback",
	kind: "interactive",
	scope: "session",
	prepare: async (ctx) => {
		const prRef =
			ctx.meta.repos
				.map((r) => r.prUrl ?? (r.prNumber != null ? `#${r.prNumber}` : null))
				.filter(Boolean)
				.join(", ") || "(no PR)";
		const prompt = [
			`Every PR (${prRef}) is ready to merge — CI is green and all threads are resolved.`,
			"",
			"Are you done, or do you have feedback that should shape the next epoch?",
			"- done: no further changes wanted.",
			"- feedback: there is something to improve; we re-enter the plan phase next epoch.",
			"",
			"If you choose 'done', also tell me whether the PR has been FULLY MERGED yet — " +
				"only on a confirmed merge does wrap-up run: move the ticket to done, tear " +
				"down the worktrees, and pull the merged work into each repo's base branch.",
			"",
			SHARED_APPROVAL_GATE,
		].join("\n");
		return {
			prompt,
			vars: {},
			contract: {
				completionEvent: "feedback_check:completed",
				completionMetadataSchema: {
					choice: "feedback|done",
					fullyMerged: "boolean?",
				},
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		const choice = ctx.metadata?.choice as string | undefined;
		if (choice === "feedback") return "feedback";
		// choice === 'done'
		const fullyMerged = ctx.metadata?.fullyMerged === true;
		if (!fullyMerged) return null; // done now; keep worktrees so the user can still merge
		// Merged: move a REAL ticket to done first, then tear down + pull base. An ad-hoc
		// session (ticketSystem "none", or a synthetic `local-…` id) has nothing to
		// transition → straight to cleanup.
		const id = ctx.meta.ticketId;
		const hasRealTicket =
			ctx.meta.ticketSystem !== "none" && !!id && !id.startsWith("local-");
		return hasRealTicket ? "close_ticket" : "cleanup";
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
Curated, deduped, terse — nothing added unconfirmed.
**You MUST pass the confirmed rules back as completion metadata \`{ "rules": ["…", …] }\`** —
the binary appends them to each involved repo's rules.md (linked from CLAUDE.md / AGENTS.md)
ONLY from that metadata. If you omit it, no rule is recorded and this step is a no-op.

### Previous revision diff (if any)
{lastDiff}`;

const feedback: StepDef = {
	name: "feedback",
	phase: "feedback",
	kind: "interactive",
	scope: "session",
	prepare: async (ctx) => {
		const { path } = currentRevisionPath(ctx.sessionId, "feedback", {
			epoch: ctx.version,
		});
		const epochDir = join(
			sessionDir(ctx.sessionId),
			"epoch",
			String(ctx.version),
		);
		const prUrls =
			ctx.meta.repos
				.map((r) => r.prUrl)
				.filter((u): u is string => !!u)
				.join(", ") || "(no PR)";
		const vars: Record<string, string | null> = {
			feedback_doc: path,
			// The latest spec revision FILE (not the spec/ dir) so the prompt's "read
			// the spec" points at a readable file.
			task_spec_path: currentRevisionPath(ctx.sessionId, "spec", {
				epoch: ctx.version,
			}).path,
			plans_dir: join(epochDir, "plans"),
			pr_url: prUrls,
			checks_status: "(ready to merge)",
			thread_count: "0",
			lastDiff:
				latestRevisionOnDisk(ctx.sessionId, "feedback", {
					epoch: ctx.version,
				}) >= 2
					? diffRevisions(ctx.sessionId, "feedback", { epoch: ctx.version })
					: null,
		};
		const body = getAgentPrompt(
			"phase3",
			"feedback",
			vars as Record<string, string>,
		);
		const prompt = `${substitute(FEEDBACK_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}\n\n${body}`;
		return {
			prompt,
			vars,
			contract: {
				outputFile: path,
				completionEvent: "feedback:approved",
				completionMetadataSchema: { rules: "string[]" },
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		// Append confirmed rules to each involved repo's rules.md (best-effort).
		const rules = (ctx.metadata?.rules as string[] | undefined) ?? [];
		if (rules.length > 0) {
			for (const r of ctx.meta.repos) {
				if (!r.worktree) continue;
				try {
					const rulesFile = join(r.worktree, "rules.md");
					const prev = existsSync(rulesFile)
						? readFileSync(rulesFile, "utf-8")
						: "";
					const additions = rules.map((line) => `- ${line}`).join("\n");
					const next = prev
						? `${prev.replace(/\s*$/, "")}\n${additions}\n`
						: `# Rules\n\n${additions}\n`;
					Bun.write(rulesFile, next);
				} catch {
					// best-effort — never block the epoch bump on rules.md I/O.
				}
			}
		}
		// Bump the epoch and re-enter the plan phase (same branch + PR). Reset each
		// repo to pending so the new epoch's `await_repos` gate waits for them again.
		updateSessionMeta(ctx.sessionId, (m) => {
			m.epoch += 1;
			for (const r of m.repos) r.status = "pending";
		});
		return "write_spec";
	},
};

// --- close_ticket (agent) ---------------------------------------------------

const CLOSE_TICKET_MECHANICS = `All PRs for this task are merged. Move ticket {ticketId} to a DONE/closed status in {ticketSystem}.

- jira → use \`acli\` to transition the issue to its terminal Done status.
- clickup → use the \`cup\` CLI to set the task's status to its done/closed status.

Statuses are project-specific — inspect the available statuses and pick the correct
terminal one (Done / Closed / Complete). Verify the ticket reads as done afterward. If you
CAN'T transition it (missing permission, unknown status, CLI unavailable), report why and
continue — do NOT block; the session is finishing regardless.

Output metadata { "ticketClosed": <true|false> }.`;

const closeTicket: StepDef = {
	name: "close_ticket",
	phase: "feedback",
	// agent: a CLI transition (acli/cup), no user interaction — runs as a sub-agent.
	kind: "agent",
	scope: "session",
	prepare: async (ctx) => {
		const vars = {
			ticketId: ctx.meta.ticketId,
			ticketSystem: ctx.meta.ticketSystem,
		};
		return {
			prompt: substitute(CLOSE_TICKET_MECHANICS, vars),
			vars,
			contract: {
				completionEvent: "close_ticket:completed",
				completionMetadataSchema: { ticketClosed: "boolean?" },
			},
		} satisfies PreparedStep;
	},
	finalize: async () => "cleanup",
};

// --- cleanup (code) ---------------------------------------------------------

const cleanup: StepDef = {
	name: "cleanup",
	phase: "feedback",
	kind: "code",
	scope: "session",
	run: async (ctx) => {
		// Reached only once the user confirms every PR is merged. The binary never
		// merges — it just tears down the worktrees the user already merged, then brings
		// each repo's primary checkout back to base and pulls the now-merged work.
		const base = ctx.meta.baseBranch;
		const syncedMain = new Set<string>();
		for (const r of ctx.meta.repos) {
			const wt = r.worktree;
			if (wt) {
				try {
					// Detach the worktrunk worktree from its repo, then drop the dir.
					if (r.repoPath)
						gitTry(["worktree", "remove", "--force", wt], r.repoPath);
					if (existsSync(wt)) {
						// Only remove a directory that still looks like a worktree.
						const entries = readdirSync(wt);
						if (entries.length === 0 || entries.includes(".git")) {
							rmSync(wt, { recursive: true, force: true });
						}
					}
				} catch {
					// best-effort teardown.
				}
			}
			// Update the repo's main: switch the primary checkout to base and pull the
			// merged work (so local <base> is current). Best-effort, once per repo path,
			// and ff-only so cleanup never creates a merge commit. The pull is
			// network-bounded so it can't wedge the run-lock.
			if (r.repoPath && !syncedMain.has(r.repoPath)) {
				syncedMain.add(r.repoPath);
				gitTry(["checkout", base], r.repoPath);
				gitTry(["pull", "--ff-only"], r.repoPath, GIT_NET_TIMEOUT_MS);
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
	name: "repo_ready",
	phase: "polish",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		const repo = repoOf(ctx);
		updateSessionMeta(ctx.sessionId, (m) => {
			const e = m.repos.find((r) => r.repo === repo.repo);
			if (e) e.status = "ready";
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
	commitFix,
	runFix,
	verifyFixes,
	repoReady,
	feedbackCheck,
	feedback,
	closeTicket,
	cleanup,
];
