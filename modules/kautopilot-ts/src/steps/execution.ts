import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentPrompt } from "../core/agents";
import type { PreparedStep, StepContext, StepDef } from "../core/descriptor";
import {
	devloopCancel,
	devloopDescribe,
	devloopStatus,
	devloopVerify,
	type KloopOutcome,
} from "../core/devloop";
import {
	createBranch,
	detectDefaultBranch,
	getCurrentBranch,
	getGitRoot,
} from "../core/git";
import { appendEvent, readLog } from "../core/log";
import { latestRevisionOnDisk, revisionPath } from "../core/revisions";
import { type RepoEntry, updateSessionMeta } from "../core/session-meta";
import {
	authoringRepoName,
	latestPlanFiles,
	resolveActivePlans,
} from "../phases/shared";
import {
	SHARED_APPROVAL_GATE,
	substitute,
	ticketId,
	ticketPath,
} from "./prompt-helpers";

// ============================================================================
// EXECUTION phase (per repo) — `kautopilot next --repo <repo>`.
//
// seed → clear_loop → setup_run → (running | running_subagent)
//   running   [agent]    : the main agent spawns a babysitter that runs kloop
//                          (init + run -d + poll) and reports the runId. The BINARY
//                          then verifies the outcome via `kloop status` (decision A)
//                          and routes: completed→commit · conflict|max_iter→resolve ·
//                          crash→clear_loop (≤2 retries) then failed.
//   running_subagent      : implements the plan directly (no kloop) → commit
//   resolve    [interactive] : strategy picker → amend_plans | clear_loop |
//                              write_spec (new epoch) | failed
//   amend_plans[interactive] : rewrite plans → clear_loop
//   commit     [agent]       : commit the plan's work → next_plan
//   next_plan  [code]        : more plans → clear_loop · else → commit_pending (polish)
//
// `code` steps here run inline and must tolerate a test sandbox with no real git
// repo and no kloop binary — every external call is wrapped and degrades to the
// next deterministic transition. Per-repo mutable state (plan index, kloop run
// id, crash retries, rewrite decision) lives in the WAL as `context:updated`
// events scoped by `repo`, read back via `readLog`.
// ============================================================================

const MAX_CRASH_RETRIES = 2;

/** The repo this step operates on — execution steps are always repo-scoped. */
function requireRepo(ctx: StepContext): RepoEntry {
	if (!ctx.repo)
		throw new Error("execution step requires a repo (ctx.repo is null)");
	return ctx.repo;
}

/** Worktree, asserted present. Execution work always happens in a worktree. */
function requireWorktree(ctx: StepContext): string {
	const repo = requireRepo(ctx);
	if (!repo.worktree)
		throw new Error(
			`execution step requires repo "${repo.repo}" to have a worktree`,
		);
	return repo.worktree;
}

/** `{worktree}/spec/{ticketId}/v{version}` — where this repo's epoch artifacts live. */
function worktreeSpecDir(ctx: StepContext): string {
	return join(
		requireWorktree(ctx),
		"spec",
		ticketId(ctx.meta),
		`v${ctx.version}`,
	);
}

function worktreePlansDir(ctx: StepContext): string {
	return join(worktreeSpecDir(ctx), "plans");
}

/** Whether this repo implements its plan via a sub-agent instead of kloop. */
function isSubAgentExec(ctx: StepContext): boolean {
	const repo = requireRepo(ctx);
	return (repo.execMode ?? ctx.meta.execMode) === "sub-agent";
}

// --- per-repo WAL-backed state ----------------------------------------------

/** Read the latest `context:updated` numeric/string field for this repo. */
function readRepoState<T>(ctx: StepContext, key: string): T | undefined {
	const repo = requireRepo(ctx).repo;
	const events = readLog(ctx.sessionId)
		.filter(
			(e) =>
				e.event === "context:updated" &&
				e.repo === repo &&
				e.version === ctx.version,
		)
		.filter((e) => e.metadata && key in e.metadata);
	const last = events.at(-1);
	return last?.metadata?.[key] as T | undefined;
}

function currentPlanIndex(ctx: StepContext): number {
	return readRepoState<number>(ctx, "planIndex") ?? 0;
}

function currentKloopRunId(ctx: StepContext): string | undefined {
	return readRepoState<string>(ctx, "kloopRunId");
}

function currentCrashRetries(ctx: StepContext): number {
	return readRepoState<number>(ctx, "crashRetryCount") ?? 0;
}

function recordRepoState(
	ctx: StepContext,
	metadata: Record<string, unknown>,
): void {
	appendEvent(ctx.sessionId, {
		ts: new Date().toISOString(),
		event: "context:updated",
		version: ctx.version,
		repo: requireRepo(ctx).repo,
		metadata,
	});
}

/**
 * The metadata of the latest WAL event named `event` matching repo + version.
 * Shared cross-step data channel (the driver builds StepContext for `code` steps
 * with no `output`/`metadata`, so a code step that needs an agent/interactive
 * step's completion data must read it back from the WAL). Used by `act`,
 * `run_fix`, `verify_fixes`, `tty_resolve` to recover the structured payload
 * persisted in the completion event (or a `context:updated` event).
 */
export function lastEventMetadata(
	sessionId: string,
	event: string,
	repo: string | null,
	epoch: number,
): Record<string, unknown> | undefined {
	const last = readLog(sessionId)
		.filter(
			(e) =>
				e.event === event &&
				(e.repo ?? e.metadata?.repo ?? null) === repo &&
				(e.version ?? 0) === epoch,
		)
		.at(-1);
	return last?.metadata;
}

/** Resolve the active plan paths for this repo, from the worktree epoch dir. */
function repoPlanPaths(ctx: StepContext): string[] {
	return resolveActivePlans(worktreePlansDir(ctx));
}

function planNameFor(index: number): string {
	return `plan-${index + 1}`;
}

/**
 * Per-subprocess timeout for seed provisioning. `wt switch --create` runs worktree
 * creation, `bun install`, and secrets sync inside one opaque command — any of which
 * can wedge (network, a secrets prompt). Without a timeout `Bun.spawnSync` blocks
 * forever, `next`'s `finally { releaseLock }` never runs, and the run-lock is held
 * indefinitely (observed as an ~8h stall). A bounded timeout turns a wedge into a
 * clean step failure that releases the lock. Override with `KAUTOPILOT_SEED_STEP_TIMEOUT_MS`.
 *
 * Bounds EVERY seed subprocess: worktree provisioning (provisionWorktree) AND the
 * branch checkout + seed commit (ensureFeatureBranch/seedCommit). Coupled with the
 * run-lock heartbeat TTL (see `lockTtlMs` in core/lock.ts): seed runs several of these
 * back-to-back with no heartbeat between them, so keep `KAUTOPILOT_LOCK_TTL_MS`
 * comfortably above their worst-case sum. If you raise this, raise the lock TTL too.
 */
function seedStepTimeoutMs(): number {
	const raw = Number(process.env.KAUTOPILOT_SEED_STEP_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 8 * 60 * 1000;
}

/** Bun kills a timed-out child (SIGTERM) → exitCode is null. Detect that case. */
function spawnTimedOut(r: { exitCode: number | null }): boolean {
	return r.exitCode === null;
}

/**
 * Provision a worktrunk worktree for a repo via `wt switch --create <name>` (the
 * /rc-session mechanism). Resolves the created worktree path from `git worktree
 * list --porcelain`. Degrades to `git worktree add`, then to a bare path so unit
 * tests (no git/wt) and sandboxes still proceed deterministically. Every subprocess
 * is bounded by `seedStepTimeoutMs()`; on a timeout we don't retry the SAME tool
 * (the retry would just wedge again) — we fall through to the next strategy, and
 * report `timedOut` so the caller can surface it instead of stalling forever.
 */
function provisionWorktree(
	repoPath: string,
	name: string,
	fallback: string,
): {
	worktree: string;
	branch: string;
	provisioned: boolean;
	timedOut: boolean;
} {
	const timeout = seedStepTimeoutMs();
	let timedOut = false;
	const resolveByName = (): string | null => {
		try {
			const list = Bun.spawnSync({
				cmd: ["git", "worktree", "list", "--porcelain"],
				cwd: repoPath,
				stdout: "pipe",
				stderr: "pipe",
				timeout,
			});
			if (list.exitCode !== 0) return null;
			for (const block of list.stdout.toString().split("\n\n")) {
				const w = /^worktree (.+)$/m.exec(block);
				if (!w) continue;
				// Match by branch ref first (so slashed names like `user/ticket-x`
				// resolve — their worktree dir basename won't equal the branch), then
				// fall back to dir-basename for plain names.
				const b = /^branch refs\/heads\/(.+)$/m.exec(block);
				if ((b && b[1].trim() === name) || basename(w[1].trim()) === name)
					return w[1].trim();
			}
		} catch {
			// no git
		}
		return null;
	};
	// 1. worktrunk `wt` (create, or switch if the branch already exists for epochs 2+).
	try {
		const created = Bun.spawnSync({
			cmd: ["wt", "switch", "--create", name, "--no-cd"],
			cwd: repoPath,
			stdout: "pipe",
			stderr: "pipe",
			timeout,
		});
		// On timeout, don't retry `wt` — it would just wedge again. Fall through to git.
		if (spawnTimedOut(created)) {
			timedOut = true;
		} else {
			if (created.exitCode !== 0) {
				const sw = Bun.spawnSync({
					cmd: ["wt", "switch", name, "--no-cd"],
					cwd: repoPath,
					stdout: "pipe",
					stderr: "pipe",
					timeout,
				});
				if (spawnTimedOut(sw)) timedOut = true;
			}
			const wt = resolveByName();
			if (wt)
				return { worktree: wt, branch: name, provisioned: true, timedOut };
		}
	} catch {
		// wt not installed — fall through
	}
	// 2. plain `git worktree add` (new branch, or existing branch on epochs 2+).
	try {
		const add = Bun.spawnSync({
			cmd: ["git", "worktree", "add", "-b", name, fallback],
			cwd: repoPath,
			stdout: "pipe",
			stderr: "pipe",
			timeout,
		});
		if (spawnTimedOut(add)) {
			timedOut = true;
		} else if (add.exitCode !== 0) {
			const addExisting = Bun.spawnSync({
				cmd: ["git", "worktree", "add", fallback, name],
				cwd: repoPath,
				stdout: "pipe",
				stderr: "pipe",
				timeout,
			});
			if (spawnTimedOut(addExisting)) timedOut = true;
		}
		if (existsSync(fallback))
			return { worktree: fallback, branch: name, provisioned: true, timedOut };
	} catch {
		// no git
	}
	// 3. sandbox / no-VCS — a bare deterministic path. NOT a real worktree: the
	// caller must surface this (repoPath wasn't a usable git repo, or every
	// provisioning subprocess timed out).
	return { worktree: fallback, branch: name, provisioned: false, timedOut };
}

// --- seed (code, repo) ------------------------------------------------------

/**
 * Repo's first-time setup: ensure the worktree dirs exist, copy the approved
 * triage + this repo's plans (and the master spec only when `commitSpec`) into
 * `{worktree}/spec/{ticketId}/v{version}/…`, then a deterministic seed-commit
 * if a git repo is present. Git is best-effort so unit tests without a repo pass.
 */
const seed: StepDef = {
	name: "seed",
	phase: "execution",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		const repo = requireRepo(ctx);

		// Mark this repo active up-front (counts against maxParallelRepos) — epoch-2+
		// worktrees persist, so this must NOT live inside the worktree-provisioning
		// branch below, or a re-seeded repo would never re-activate. (M4)
		updateSessionMeta(ctx.sessionId, (m) => {
			const entry = m.repos.find((r) => r.repo === repo.repo);
			if (entry) entry.status = "active";
		});
		repo.status = "active";

		// Provision this repo's worktrunk worktree via `wt` (the /rc-session
		// mechanism), one per repo/sub. Best-effort: falls back to `git worktree
		// add`, then to a bare path in a sandbox without git/wt. (SPEC §13 #19)
		if (!repo.worktree) {
			const id = ticketId(ctx.meta);
			const name = repo.branch ?? `${repo.repo}-${id}`;
			// A repo's path comes from triage; the session folder is only a fallback
			// (and the deterministic base for the sandbox worktree path).
			const repoPath = repo.repoPath ?? ctx.meta.folder;
			// Worktree dir can't contain the branch's slashes (e.g. user/ticket-x).
			const fallback = join(dirname(ctx.meta.folder), name.replace(/\//g, "-"));
			// Progress marker so `kautopilot logs`/`status` show where seed is during
			// the long, opaque `wt switch` (worktree + bun install + secrets). Without
			// this the WAL was silent for the whole provisioning window.
			appendEvent(ctx.sessionId, {
				ts: new Date().toISOString(),
				event: "seed:provision_worktree:started",
				version: ctx.version,
				repo: repo.repo,
				metadata: { repoPath, name, timeoutMs: seedStepTimeoutMs() },
			});
			const prov = provisionWorktree(repoPath, name, fallback);
			appendEvent(ctx.sessionId, {
				ts: new Date().toISOString(),
				event: "seed:provision_worktree:completed",
				version: ctx.version,
				repo: repo.repo,
				metadata: {
					worktree: prov.worktree,
					provisioned: prov.provisioned,
					timedOut: prov.timedOut,
				},
			});
			// kautopilot can launch outside any repo, so a repo's path comes from
			// triage. If no REAL worktree could be created, the path was missing or
			// not a git repo — surface it loudly (don't let the repo silently no-op
			// its way to a PR with no work). Diagnosable via the WAL/status; the bare
			// path is still set so the sandbox/tests proceed deterministically.
			if (!prov.provisioned) {
				const reason = prov.timedOut
					? `worktree provisioning timed out (> ${seedStepTimeoutMs()}ms) — \`wt\`/\`git worktree\` wedged (network, secrets, or bun install). Lock released; re-run \`kautopilot next --repo ${repo.repo}\` to retry.`
					: "could not create a worktree — repo path missing or not a git repo (triage must provide each repo's path)";
				appendEvent(ctx.sessionId, {
					ts: new Date().toISOString(),
					event: "seed:no_worktree",
					version: ctx.version,
					repo: repo.repo,
					metadata: { repoPath, reason, timedOut: prov.timedOut },
				});
				console.warn(`[seed] repo "${repo.repo}": ${reason}`);
			}
			updateSessionMeta(ctx.sessionId, (m) => {
				const entry = m.repos.find((r) => r.repo === repo.repo);
				if (entry) {
					entry.worktree = prov.worktree;
					entry.branch ??= prov.branch;
					entry.status = "active"; // counts against maxParallelRepos
				}
			});
			repo.worktree = prov.worktree;
			repo.branch ??= prov.branch;
		}
		const worktree = repo.worktree;

		appendEvent(ctx.sessionId, {
			ts: new Date().toISOString(),
			event: "seed:started",
			version: ctx.version,
			repo: repo.repo,
			metadata: { stepType: "code" },
		});

		// Only seed artifacts when a worktree exists on disk. (In the sandbox the
		// worktree may be null/missing — degrade to a no-op and move on.)
		if (worktree && existsSync(worktree)) {
			const id = ticketId(ctx.meta);
			const specDir = join(worktree, "spec", id, `v${ctx.version}`);
			const plansDir = join(specDir, "plans");
			try {
				mkdirSync(plansDir, { recursive: true });

				// Copy the latest approved artifacts straight from this epoch's store
				// (epoch/<E>/… — the single source of truth; no frozen snapshot).
				const triageV = latestRevisionOnDisk(ctx.sessionId, "triage", {
					epoch: ctx.version,
				});
				if (triageV > 0) {
					copyIfPresent(
						revisionPath(ctx.sessionId, "triage", triageV, {
							epoch: ctx.version,
						}),
						join(specDir, "triage.md"),
					);
				}

				// Copy the ticket (unversioned) so the dev loop has the original ask.
				copyIfPresent(ticketPath(ctx.sessionId), join(specDir, "ticket.md"));

				// Copy each of this repo's plans from epoch/<E>/plans/<repo>/<plan>/vN.md
				// into the worktree as plans/<plan>.md (latest version of each folder).
				const planFolders = latestPlanFiles(
					ctx.sessionId,
					ctx.version,
					authoringRepoName(ctx.meta),
				);
				const wanted = new Set(repo.plans);
				// A repo with no matched plans means "give it everything" ONLY in the
				// single-repo case (the legacy one-repo fallback). With multiple repos a
				// zero-plan repo must copy NOTHING — otherwise it pulls in every other
				// repo's plans and next_plan drives them into the wrong worktree/PR.
				const copyAll = repo.plans.length === 0 && ctx.meta.repos.length <= 1;
				for (const { plan, file } of planFolders) {
					if (!copyAll && !wanted.has(plan)) continue;
					copyIfPresent(file, join(plansDir, `${plan}.md`));
				}

				// The whole master spec is committed into the repo only for orgs that opt in.
				if (ctx.meta.commitSpec) {
					const specV = latestRevisionOnDisk(ctx.sessionId, "spec", {
						epoch: ctx.version,
					});
					if (specV > 0) {
						copyIfPresent(
							revisionPath(ctx.sessionId, "spec", specV, {
								epoch: ctx.version,
							}),
							join(specDir, "task-spec.md"),
						);
					}
				}
			} catch (err) {
				console.warn(`[seed] artifact copy skipped: ${(err as Error).message}`);
			}

			// Ensure the feature branch exists (best-effort; degrades in sandbox).
			ensureFeatureBranch(worktree, repo.branch, ctx.meta.baseBranch);

			// Deterministic seed-commit — tolerate absence of git (sandbox).
			seedCommit(worktree, `${id}: seed spec artifacts (v${ctx.version})`);
		}

		appendEvent(ctx.sessionId, {
			ts: new Date().toISOString(),
			event: "seed:completed",
			version: ctx.version,
			repo: repo.repo,
			metadata: { worktree: worktree ?? null },
		});

		return "clear_loop";
	},
};

function copyIfPresent(from: string, to: string): void {
	if (existsSync(from)) copyFileSync(from, to);
}

/**
 * Ensure the repo's feature branch exists and is checked out. Best-effort: if the
 * worktree isn't a git repo (sandbox) or the branch already exists/checked out,
 * this degrades to a no-op. Never throws.
 */
function ensureFeatureBranch(
	worktree: string,
	branch: string | null,
	baseBranch: string,
): void {
	if (!branch) return;
	const timeout = seedStepTimeoutMs();
	try {
		getGitRoot(worktree);
		// Already on the target branch → nothing to do.
		if (getCurrentBranch(worktree) === branch) return;
		// Branch already exists locally → check it out; else create from the
		// detected default branch (kept for parity with the host's branch setup).
		const exists =
			Bun.spawnSync({
				cmd: ["git", "rev-parse", "--verify", branch],
				cwd: worktree,
				stdout: "pipe",
				stderr: "pipe",
				timeout,
			}).exitCode === 0;
		if (exists) {
			// Bounded: a `git checkout` wedged on a stale index.lock must not hold the
			// run-lock past its TTL (see lockTtlMs) — the heartbeat can't refresh mid-step.
			Bun.spawnSync({
				cmd: ["git", "checkout", branch],
				cwd: worktree,
				stdout: "pipe",
				stderr: "pipe",
				timeout,
			});
			return;
		}
		// Anchor to the real default branch when one is detectable.
		const base = detectDefaultBranch(worktree) || baseBranch;
		Bun.spawnSync({
			cmd: ["git", "checkout", base],
			cwd: worktree,
			stdout: "pipe",
			stderr: "pipe",
			timeout,
		});
		createBranch(branch, worktree);
	} catch {
		// No git repo / branch op failed (sandbox) — degrade to a no-op.
	}
}

function seedCommit(worktree: string, message: string): void {
	const timeout = seedStepTimeoutMs();
	try {
		// Only attempt git operations when the worktree is actually a git repo.
		getGitRoot(worktree);
		// Bounded like the rest of seed: a wedged `git add`/`commit` (index.lock,
		// fsmonitor, credential helper) must not hold the run-lock past its TTL.
		Bun.spawnSync({
			cmd: ["git", "add", "spec"],
			cwd: worktree,
			stdout: "pipe",
			stderr: "pipe",
			timeout,
		});
		Bun.spawnSync({
			cmd: ["git", "commit", "--no-verify", "-m", message],
			cwd: worktree,
			stdout: "pipe",
			stderr: "pipe",
			timeout,
		});
	} catch {
		// No git repo (test sandbox) — seed-commit is a no-op.
	}
}

// --- clear_loop (code, repo) ------------------------------------------------

const clearLoop: StepDef = {
	name: "clear_loop",
	phase: "execution",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		const repo = requireRepo(ctx);
		const planIndex = currentPlanIndex(ctx);
		const planName = planNameFor(planIndex);

		appendEvent(ctx.sessionId, {
			ts: new Date().toISOString(),
			event: "clear_loop:started",
			version: ctx.version,
			repo: repo.repo,
			plan: planName,
			metadata: { stepType: "code", planIndex },
		});

		let runWasActive = false;
		const kloopRunId = currentKloopRunId(ctx);
		if (kloopRunId) {
			try {
				const status = devloopStatus(kloopRunId);
				if (status.running) {
					devloopCancel(kloopRunId);
					runWasActive = true;
				}
			} catch {
				// kloop unavailable in the sandbox — nothing to cancel.
			}
			recordRepoState(ctx, { kloopRunId: null });
		}

		appendEvent(ctx.sessionId, {
			ts: new Date().toISOString(),
			event: "clear_loop:completed",
			version: ctx.version,
			repo: repo.repo,
			plan: planName,
			metadata: { runWasActive },
		});

		return "setup_run";
	},
};

// --- setup_run (code, repo) — exec-mode router ------------------------------

const setupRun: StepDef = {
	name: "setup_run",
	phase: "execution",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		const repo = requireRepo(ctx);
		const planName = planNameFor(currentPlanIndex(ctx));
		const subAgent = isSubAgentExec(ctx);
		appendEvent(ctx.sessionId, {
			ts: new Date().toISOString(),
			event: "setup_run:completed",
			version: ctx.version,
			repo: repo.repo,
			plan: planName,
			metadata: { execMode: subAgent ? "sub-agent" : "kloop" },
		});
		// kloop init/run is no longer driven in-binary — the `running` agent step
		// spawns a babysitter that runs kloop; this just routes by exec mode.
		return subAgent ? "running_subagent" : "running";
	},
};

// --- running (agent, repo) — the main agent babysits kloop ------------------

const RUNNING_MECHANICS = `## Run the dev loop (kloop) for this plan — babysit it

Drive kloop for ONE plan in this repo's worktree, keeping its verbose output OUT of
the main conversation (run it in this isolated sub-agent; kloop's own logs hold the detail).

- Worktree:        {worktree}
- Plan (= kloop spec): {plan_path}

Steps:
1. \`kloop init --workspace {worktree} --spec {plan_path}\` — note the printed Run ID.
2. \`kloop run -d <runId>\` — daemon mode, so output goes to kloop's logs, not your context.
3. Babysit: poll \`kloop status <runId> --json\` until status is no longer "running";
   surface brief progress (loop/phase). You may \`kloop logs -f <runId>\` to watch.
4. When it stops, read \`kloop describe <runId>\` once for a short summary.

Then complete with metadata \`{ "kloopRunId": "<runId>" }\`. **You do NOT decide the
outcome** — the binary re-checks kloop's own status and routes (commit / resolve /
retry). Do NOT resolve conflicts and do NOT commit here: if kloop conflicts or stalls,
just report — the controller drives an interactive resolve in the main session.`;

const running: StepDef = {
	name: "running",
	phase: "execution",
	kind: "agent",
	scope: "repo",
	prepare: async (ctx) => {
		const planIndex = currentPlanIndex(ctx);
		const planName = planNameFor(planIndex);
		const plans = repoPlanPaths(ctx);
		const planPath =
			plans[planIndex] ?? join(worktreePlansDir(ctx), `${planName}.md`);
		const vars: Record<string, string | null> = {
			worktree: requireRepo(ctx).worktree ?? "(worktree not provisioned)",
			plan_name: planName,
			plan_path: planPath,
		};
		return {
			prompt: substitute(RUNNING_MECHANICS, vars),
			vars,
			contract: {
				completionEvent: "running:completed",
				completionMetadataSchema: { kloopRunId: "string?" },
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		const repo = requireRepo(ctx);
		const planName = planNameFor(currentPlanIndex(ctx));
		const runId = ctx.metadata?.kloopRunId as string | undefined;
		if (runId) recordRepoState(ctx, { kloopRunId: runId });

		// Decision A — the BINARY verifies the outcome from kloop itself; it never
		// trusts that the agent's report of "done" means kloop actually completed.
		const verdict: KloopOutcome = runId ? devloopVerify(runId) : "unavailable";
		// kloop still running → the agent reported early; babysit again (idempotent).
		if (verdict === "running") return "running";
		// `unavailable` = no run / no kloop (sandbox) → advance deterministically.
		const status: "completed" | "max_iterations" | "conflict" | "crash" =
			verdict === "unavailable" ? "completed" : verdict;

		// Record the VERIFIED status (non-cursor) for `resolve` to read.
		appendEvent(ctx.sessionId, {
			ts: new Date().toISOString(),
			event: "running:completed",
			version: ctx.version,
			repo: repo.repo,
			plan: planName,
			metadata: {
				status,
				runId: runId ?? null,
				verified: verdict !== "unavailable",
			},
		});

		switch (status) {
			case "completed":
				return "commit";
			case "conflict":
			case "max_iterations":
				return "resolve";
			case "crash": {
				const retries = currentCrashRetries(ctx) + 1;
				recordRepoState(ctx, { crashRetryCount: retries });
				if (retries <= MAX_CRASH_RETRIES) {
					appendEvent(ctx.sessionId, {
						ts: new Date().toISOString(),
						event: "crash:retry",
						version: ctx.version,
						repo: repo.repo,
						plan: planName,
						metadata: {
							crashRetryCount: retries,
							maxRetries: MAX_CRASH_RETRIES,
						},
					});
					return "clear_loop";
				}
				return "failed";
			}
		}
	},
};

// --- running_subagent (agent, repo) — sub-agent exec mode -------------------

const RUNNING_SUBAGENT_MECHANICS = `## Implement This Plan Directly

You are implementing a single plan for the repository — no kloop, no review loop.

- Read the plan at {plan_path} — it is the **source of truth** for this change. If a task
  spec is present at {task_spec_path}, read it too for extra context (it may be absent —
  some orgs don't seed the master spec; don't block on it).
- Implement the plan end-to-end in the worktree: write the code, add/adjust tests,
  and make the change actually work. Follow the repo's existing conventions.
- Do NOT commit — a separate commit step owns committing. Just leave a clean, working
  tree that satisfies the plan.
- When the implementation is complete and self-verified, stop and hand control back to
  the controller (it calls \`kautopilot complete\`). Do NOT run any kautopilot command.`;

const runningSubagent: StepDef = {
	name: "running_subagent",
	phase: "execution",
	kind: "agent",
	scope: "repo",
	prepare: async (ctx) => {
		const planIndex = currentPlanIndex(ctx);
		const plans = repoPlanPaths(ctx);
		const planPath =
			plans[planIndex] ??
			join(worktreePlansDir(ctx), `${planNameFor(planIndex)}.md`);
		const vars: Record<string, string | null> = {
			plan_name: planNameFor(planIndex),
			plan_path: planPath,
			plans_dir: worktreePlansDir(ctx),
			task_spec_path: join(worktreeSpecDir(ctx), "task-spec.md"),
		};
		return {
			prompt: substitute(RUNNING_SUBAGENT_MECHANICS, vars),
			vars,
			contract: {
				completionEvent: "running:completed",
				completionMetadataSchema: { status: "completed" },
			},
		} satisfies PreparedStep;
	},
	finalize: async () => "commit",
};

// --- resolve (interactive, repo) --------------------------------------------

const RESOLVE_MECHANICS = `## CRITICAL: Resolve Mechanics

### Step 1: Propose a Strategy
Suggest one, based on the kloop evidence:
1. refine_local — current plan needs targeted fixes (kloop was close).
2. patch_downstream — completed plans fine, downstream plans need updates.
3. regenerate_remaining — fundamental shift; rewrite remaining plans from scratch.
4. revisit_spec — the SPEC is the problem; escalate to a full replan.
5. retry — transient/environmental failure; just re-run.

### Step 2: Write the Context Document
This step does NOT edit plans; it writes a context doc the next step uses.
- retry: no document.
- revisit_spec: write {feedback_path} (what's wrong with the spec; what the next epoch
  must address) — consumed by phase-1 write_spec.
- refine_local / patch_downstream / regenerate_remaining: write {resolution_path}
  (what went wrong w/ kloop evidence; what must change; which plans; constraints) —
  consumed by amend_plans.`;

const resolve: StepDef = {
	name: "resolve",
	phase: "execution",
	kind: "interactive",
	scope: "repo",
	prepare: async (ctx) => {
		const planIndex = currentPlanIndex(ctx);
		const planName = planNameFor(planIndex);
		const specDir = worktreeSpecDir(ctx);
		const plansDir = worktreePlansDir(ctx);
		const planPaths = repoPlanPaths(ctx);

		let evidence = "(no evidence available)";
		const kloopRunId = currentKloopRunId(ctx);
		if (kloopRunId) {
			try {
				evidence = devloopDescribe(kloopRunId);
			} catch {
				// kloop unavailable — keep the placeholder.
			}
		}

		const reason = lastRunningStatus(ctx, planName);
		const vars: Record<string, string | null> = {
			plan_name: planName,
			plan_path: planPaths[planIndex] ?? "",
			plans_dir: plansDir,
			task_spec_path: join(specDir, "task-spec.md"),
			kloop_evidence: evidence,
			reason,
			feedback_path: join(specDir, "feedback.md"),
			resolution_path: join(plansDir, "resolution.md"),
		};
		const body = getAgentPrompt(
			"phase2",
			"resolve",
			vars as Record<string, string>,
		);
		return {
			prompt: `${substitute(RESOLVE_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}\n\n${body}`,
			vars,
			contract: {
				completionEvent: "resolve:approved",
				completionMetadataSchema: {
					rewriteDecision:
						"refine_local|patch_downstream|regenerate_remaining|revisit_spec|retry",
				},
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		const decision = ctx.metadata?.rewriteDecision as string | undefined;
		if (ctx.metadata?.abandon === true) return "failed";

		// Persist the decision for amend_plans (WAL-scoped to this repo).
		if (decision) recordRepoState(ctx, { rewriteDecision: decision });

		switch (decision) {
			case "retry":
				return "clear_loop";
			case "revisit_spec": {
				// revisit_spec escalates the SHARED plan phase (SPEC §7.1/§13 #5): bump
				// the epoch, reset every repo to pending, and append a SESSION-scoped
				// cursor so the bare `next` re-enters write_spec at the new epoch. This
				// repo's epoch-N timeline ends here (return null).
				const newEpoch = ctx.version + 1;
				updateSessionMeta(ctx.sessionId, (m) => {
					m.epoch = newEpoch;
					for (const r of m.repos) r.status = "pending";
				});
				appendEvent(ctx.sessionId, {
					ts: new Date().toISOString(),
					event: "revisit_spec:escalated",
					version: newEpoch,
					metadata: {
						step: "revisit_spec",
						to: "write_spec",
						repo: null,
					},
				});
				return null;
			}
			case "refine_local":
			case "patch_downstream":
			case "regenerate_remaining":
				return "amend_plans";
			default:
				return "failed";
		}
	},
};

/** The status recorded by the most recent `running:completed` for this plan. */
function lastRunningStatus(ctx: StepContext, planName: string): string {
	const repo = requireRepo(ctx).repo;
	const last = readLog(ctx.sessionId)
		.filter(
			(e) =>
				e.event === "running:completed" &&
				e.repo === repo &&
				e.version === ctx.version &&
				e.plan === planName &&
				// The driver appends its own `running:completed` cursor (no `status`)
				// after the step's internal one; only the internal one carries status.
				e.metadata?.status != null,
		)
		.at(-1);
	const status = last?.metadata?.status;
	return status === "max_iterations" || status === "conflict"
		? status
		: "conflict";
}

// --- amend_plans (interactive, repo) ----------------------------------------

const AMEND_PLANS_COMMON = `## CRITICAL: Amend Plans Mechanics

### Context Document
Read {resolution_path} first — it contains the decision context from the previous step.
Do not re-debate the strategy; debate the IMPLEMENTATION of it.`;

const REFINE_LOCAL_PROMPT = `## Strategy: refine_local

Rewrite ONLY {plan_name} at {plan_path}. Do not touch other plans.

Each plan file MUST follow the template:
{planTemplate}

${AMEND_PLANS_COMMON}`;

const PATCH_DOWNSTREAM_PROMPT = `## Strategy: patch_downstream

Edit ONLY the incomplete plan files. Do not touch completed ones.

Completed (do NOT edit):
{completed_plans_list}

Incomplete (to patch):
{incomplete_plans_list}

Each plan file MUST follow the template:
{planTemplate}

${AMEND_PLANS_COMMON}`;

const REGENERATE_REMAINING_PROMPT = `## Strategy: regenerate_remaining

Rewrite ALL incomplete plan files FROM SCRATCH based on the current spec plus learnings in the resolution doc.

Completed (do NOT edit):
{completed_plans_list}

Incomplete (to regenerate):
{incomplete_plans_list}

Each plan file MUST follow the template:
{planTemplate}

${AMEND_PLANS_COMMON}`;

type AmendStrategy =
	| "refine_local"
	| "patch_downstream"
	| "regenerate_remaining";

function strategyHeader(decision: AmendStrategy): string {
	switch (decision) {
		case "refine_local":
			return REFINE_LOCAL_PROMPT;
		case "patch_downstream":
			return PATCH_DOWNSTREAM_PROMPT;
		case "regenerate_remaining":
			return REGENERATE_REMAINING_PROMPT;
	}
}

const amendPlans: StepDef = {
	name: "amend_plans",
	phase: "execution",
	kind: "interactive",
	scope: "repo",
	prepare: async (ctx) => {
		const planIndex = currentPlanIndex(ctx);
		const planName = planNameFor(planIndex);
		const specDir = worktreeSpecDir(ctx);
		const plansDir = worktreePlansDir(ctx);
		const planPaths = repoPlanPaths(ctx);

		let evidence = "(no evidence available)";
		const kloopRunId = currentKloopRunId(ctx);
		if (kloopRunId) {
			try {
				evidence = devloopDescribe(kloopRunId);
			} catch {
				// kloop unavailable — keep the placeholder.
			}
		}

		const decision = (readRepoState<string>(ctx, "rewriteDecision") ??
			"refine_local") as AmendStrategy;

		// Completed/incomplete plan lists, derived from this repo's plan files.
		const completed = planPaths
			.slice(0, planIndex)
			.map((_, i) => `- ${planNameFor(i)} (completed)`);
		const incomplete = planPaths
			.slice(planIndex)
			.map((_, i) => `- ${planNameFor(planIndex + i)}`);

		const vars: Record<string, string | null> = {
			plan_name: planName,
			plan_path: planPaths[planIndex] ?? "",
			plans_dir: plansDir,
			task_spec_path: join(specDir, "task-spec.md"),
			resolution_path: join(plansDir, "resolution.md"),
			kloop_evidence: evidence,
			planTemplate: ctx.config.templates.plan,
			completed_plans_list:
				completed.length > 0 ? completed.join("\n") : "(none)",
			incomplete_plans_list:
				incomplete.length > 0 ? incomplete.join("\n") : "(none)",
		};

		const header = substitute(strategyHeader(decision), vars);
		const body = getAgentPrompt(
			"phase2",
			"amend_plans",
			vars as Record<string, string>,
		);
		return {
			prompt: `${header}\n\n${SHARED_APPROVAL_GATE}\n\n${body}`,
			vars,
			contract: {
				completionEvent: "rewrite_plans:approved",
			},
		} satisfies PreparedStep;
	},
	finalize: async () => "clear_loop",
};

// --- commit (agent, repo) ---------------------------------------------------

const commit: StepDef = {
	name: "commit",
	phase: "execution",
	kind: "agent",
	scope: "repo",
	prepare: async (ctx) => {
		const planIndex = currentPlanIndex(ctx);
		const planPaths = repoPlanPaths(ctx);
		const planPath =
			planPaths[planIndex] ??
			join(worktreePlansDir(ctx), `${planNameFor(planIndex)}.md`);
		const context = `### Plan Context\nRead the plan at: ${planPath}`;
		const vars: Record<string, string | null> = {
			plan_name: planNameFor(planIndex),
			plan_path: planPath,
			context,
		};
		const prompt = getAgentPrompt("generic", "commit", { context });
		return {
			prompt,
			vars,
			contract: {
				completionEvent: "commit:completed",
				completionMetadataSchema: { commitSha: "string" },
			},
		} satisfies PreparedStep;
	},
	finalize: async () => "next_plan",
};

// --- next_plan (code, repo) -------------------------------------------------

const nextPlan: StepDef = {
	name: "next_plan",
	phase: "execution",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		const repo = requireRepo(ctx);
		const planIndex = currentPlanIndex(ctx);
		const maxPlans = Math.max(repoPlanPaths(ctx).length, repo.plans.length);

		appendEvent(ctx.sessionId, {
			ts: new Date().toISOString(),
			event: "next_plan:started",
			version: ctx.version,
			repo: repo.repo,
			plan: planNameFor(planIndex),
			metadata: { stepType: "code" },
		});

		const nextIndex = planIndex + 1;
		recordRepoState(ctx, { planIndex: nextIndex, crashRetryCount: 0 });

		const more = nextIndex < maxPlans;
		appendEvent(ctx.sessionId, {
			ts: new Date().toISOString(),
			event: "next_plan:completed",
			version: ctx.version,
			repo: repo.repo,
			metadata: {
				from: planNameFor(planIndex),
				to: more ? planNameFor(nextIndex) : "done",
			},
		});

		// More plans for this repo → loop; otherwise execution is done for this repo
		// and we hand off to the polish phase (sibling file).
		return more ? "clear_loop" : "commit_pending";
	},
};

// --- failed (code, repo) — terminal -----------------------------------------

/**
 * Terminal step for a repo whose execution/polish loop cannot proceed (crash
 * over the retry cap, an abandoned resolve, or an unrecoverable run_fix). Marks
 * the repo entry status="failed" and ends this repo's timeline (returns null) so
 * `next --repo` reports done rather than throwing "Unknown step". Reachable from
 * `running` (crash>2), `resolve` (abandon), and polish `run_fix`. (C3)
 */
const failed: StepDef = {
	name: "failed",
	phase: "execution",
	kind: "code",
	scope: "repo",
	run: async (ctx) => {
		const repo = requireRepo(ctx);
		updateSessionMeta(ctx.sessionId, (m) => {
			const e = m.repos.find((r) => r.repo === repo.repo);
			if (e) e.status = "failed";
		});
		appendEvent(ctx.sessionId, {
			ts: new Date().toISOString(),
			event: "failed:marked",
			version: ctx.version,
			repo: repo.repo,
			metadata: { stepType: "code" },
		});
		return null; // this repo's timeline ends.
	},
};

export const EXECUTION_STEPS: StepDef[] = [
	seed,
	clearLoop,
	setupRun,
	running,
	runningSubagent,
	resolve,
	amendPlans,
	commit,
	nextPlan,
	failed,
];
