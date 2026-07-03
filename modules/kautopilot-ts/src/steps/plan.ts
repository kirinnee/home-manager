import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentPrompt } from "../core/agents";
import { sessionDir } from "../core/artifacts";
import type {
	PreparedStep,
	ReviewDescriptor,
	ReviewerDescriptor,
	StepContext,
	StepDef,
} from "../core/descriptor";
import { branchTicketRef, gitUserSlug, slugifyBranch } from "../core/git";
import {
	type GateLevel,
	initOrchestration,
	isGateLevel,
	type MasterPlan,
	type PlanDependency,
	type PlanNode,
	type PrPlan,
} from "../core/orchestration";
import type { ArtifactKind, ArtifactRef } from "../core/revisions";
import {
	currentRevisionPath,
	diffRevisions,
	latestRevisionOnDisk,
	listPlanSetVersions,
	plansRepoDir,
	revisionPath,
} from "../core/revisions";
import { updateSessionMeta } from "../core/session-meta";
import type { ReviewerConfig } from "../core/types";
import { authoringRepoName, latestPlanFiles } from "../phases/shared";
import {
	rulesPath,
	SHARED_APPROVAL_GATE,
	substitute,
	ticketId,
	ticketPath,
} from "./prompt-helpers";

// ============================================================================
// PLAN phase — `kautopilot next` (session-scoped, repo-agnostic for spec).
// resolve_org → [brainstorm → create_ticket] → fetch_ticket → triage →
// write_spec → write_plans → finalize_plans
//
// write_spec and write_plans each CARRY their reviewer fan-out (spec_reviewers /
// plan_reviewers) so reviewers run BEFORE the version is presented to the user —
// every version the user sees is already review-checked. There is no separate
// spec_review / plan_review step. Versions are file-based: the writer edits the
// current version; `kautopilot revise` mints the next one per user presentation.
// ============================================================================

const REVIEW_SYNTHESIZE_PROMPT = `You are a review summarizer. Below are the outputs from multiple independent reviewers analyzing the same document.

Your job:
1. Merge all findings into ONE concise, deduplicated problem list
2. Remove duplicate or overlapping issues
3. Number each unique problem
4. Be concise — one line per problem, no preamble

Output ONLY the numbered problem list. If no real issues, output "No issues found."`;

function planVars(ctx: StepContext): Record<string, string | null> {
	const id = ctx.sessionId;
	return {
		ticketId: ticketId(ctx.meta),
		ticket: ticketPath(id),
		ticketSystem: ctx.meta.ticketSystem,
		rules: rulesPath(ctx.repo),
	};
}

/**
 * The diff between the two most recent revisions of an artifact, or null when
 * fewer than two exist (nothing to diff yet). Carried as `vars.lastDiff` so the
 * harness shows the user WHAT CHANGED rather than the whole doc. (CLI-CONTRACT §5)
 */
function lastDiff(
	sessionId: string,
	kind: ArtifactKind,
	ref: ArtifactRef = {},
): string | null {
	const count =
		kind === "plans" && ref.repo
			? listPlanSetVersions(sessionId, ref.epoch ?? 1, ref.repo).length
			: latestRevisionOnDisk(sessionId, kind, ref);
	if (count < 2) return null;
	return diffRevisions(sessionId, kind, {
		epoch: ref.epoch,
		repo: ref.repo,
	});
}

function buildReview(
	reviewers: Record<string, ReviewerConfig>,
	vars: Record<string, string | null>,
	summaryFile: string,
): ReviewDescriptor {
	const list: ReviewerDescriptor[] = Object.entries(reviewers).map(
		([id, r]) => ({
			id,
			prompt: substitute(r.prompt, vars),
			verdictSchema: { approved: "boolean", issues: "string[]" },
		}),
	);
	return {
		reviewers: list,
		synthesize: { prompt: REVIEW_SYNTHESIZE_PROMPT, outputFile: summaryFile },
		gate: "all_approve",
	};
}

// --- resolve_org (code) ------------------------------------------------------

const resolveOrg: StepDef = {
	name: "resolve_org",
	phase: "plan",
	kind: "code",
	scope: "session",
	run: async (ctx) => {
		// Org is resolved at `start` (--org → ticket → ask) and recorded in session.json.
		if (!ctx.meta.org) throw new Error("resolve_org: org not set on session");
		// Ad-hoc (no ticket) flow shapes the idea first.
		return ctx.meta.ticketId ? "fetch_ticket" : "brainstorm";
	},
};

// --- brainstorm (interactive, ad-hoc only) ----------------------------------

const BRAINSTORM_MECHANICS = `You are brainstorming a raw idea with the user before any ticket or spec exists. Your job
is to turn a vague request into a concrete, agreed problem statement + direction — NOT to
design or implement.

## Explore first
Read the relevant context (repos, docs, recent commits) so your questions are grounded.

## Ask, don't assume — one question at a time
- Ask ONE clarifying question at a time. Prefer multiple-choice (AskUserQuestion) over open-ended.
- Focus on UNDERSTANDING: the real problem, who it is for, constraints, success criteria.
- Do NOT jump to solutions. Keep going until the problem is unambiguous.

## Then propose approaches
- Offer 2–3 distinct approaches with explicit trade-offs.
- Lead with a recommendation and the reasoning for why it fits best.

## The user's request
{request}

## Converge
- Write the agreed problem statement + chosen direction to {brainstorm} (the working copy).`;

const brainstorm: StepDef = {
	name: "brainstorm",
	phase: "plan",
	kind: "interactive",
	scope: "session",
	prepare: async (ctx) => {
		const { path } = currentRevisionPath(ctx.sessionId, "brainstorm");
		const vars = {
			...planVars(ctx),
			brainstorm: path,
			request: ctx.meta.request ?? "(no request text recorded — ask the user)",
			lastDiff: lastDiff(ctx.sessionId, "brainstorm"),
		};
		return {
			prompt: `${substitute(BRAINSTORM_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}`,
			vars,
			contract: {
				outputFile: path,
				completionEvent: "brainstorm:approved",
			},
		} satisfies PreparedStep;
	},
	finalize: async () => "create_ticket",
};

// --- create_ticket (agent, ad-hoc only) -------------------------------------

const CREATE_TICKET_MECHANICS = `Create a ticket for this task in {ticketSystem}.

1. From the brainstorm output \`{brainstorm}\` (or, if none, the user's one-liner: "{request}"), draft a clear title and description (problem, desired outcome, any constraints). Keep it tight.
2. Show the draft and get explicit confirmation before creating anything.
3. Create the ticket: jira → \`acli\`; clickup → the \`cup\` CLI (\`cup create\`); none → propose a local id of the form \`local-<slug>\`.
4. Output the created ticket id as metadata { "ticketId": "..." }. This id becomes the session key. If a ticket was already created for this task (stored id present), reuse it — never create a duplicate.`;

const createTicket: StepDef = {
	name: "create_ticket",
	phase: "plan",
	// interactive, NOT agent: the prompt requires showing the draft and getting
	// explicit user confirmation before creating the ticket — a fresh isolated
	// sub-agent can't talk to the user, so this must run inline in the main chat.
	kind: "interactive",
	scope: "session",
	prepare: async (ctx) => {
		const draft = join(sessionDir(ctx.sessionId), "ticket-draft.md");
		// Use the LATEST approved brainstorm, not a hardcoded v1 — the user may have
		// revised it (e.g. v1→v2 after changing direction); the ticket must reflect that.
		const brainstorm = currentRevisionPath(ctx.sessionId, "brainstorm").path;
		const vars = {
			...planVars(ctx),
			brainstorm,
			draft,
			request: ctx.meta.request ?? "",
		};
		return {
			prompt: substitute(CREATE_TICKET_MECHANICS, vars),
			vars,
			contract: {
				outputFile: draft,
				completionEvent: "create_ticket:done",
				completionMetadataSchema: { ticketId: "string" },
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		const newId = ctx.metadata?.ticketId as string | undefined;
		if (newId)
			updateSessionMeta(ctx.sessionId, (m) => {
				m.ticketId = newId;
			});
		return "fetch_ticket";
	},
};

// --- fetch_ticket (agent) ----------------------------------------------------

const FETCH_TICKET_MECHANICS = `Fetch ticket {ticketId} from {ticketSystem} and write it to {ticket}.

- jira → use \`acli\` to read the issue; clickup → the \`cup\` CLI (\`cup task <id>\`; \`cup subtasks\`/\`cup activity\` for parent/child context); none → the ticket.md is the drafted title/description from create_ticket.
- Walk parent/epic links when they exist and include the hierarchy for context.
- Write the full ticket (title, description, parents) to {ticket}. Do not summarize away detail the spec writer will need.`;

const fetchTicket: StepDef = {
	name: "fetch_ticket",
	phase: "plan",
	kind: "agent",
	scope: "session",
	prepare: async (ctx) => {
		const vars = planVars(ctx);
		return {
			prompt: substitute(FETCH_TICKET_MECHANICS, vars),
			vars,
			contract: {
				outputFile: ticketPath(ctx.sessionId),
				completionEvent: "fetch_ticket:done",
			},
		} satisfies PreparedStep;
	},
	finalize: async () => "triage",
};

// --- triage (interactive) ----------------------------------------------------

const TRIAGE_MECHANICS = `## CRITICAL: Triage Output & Approval Mechanics

### Output File
Write your triage assessment to: {triage}
(This is the working copy for the current epoch under epoch/<E>/triage/.)

The triage document MUST follow this template structure:
{triageTemplate}

### Repo Set, Paths & Dependency Order
Triage decides WHICH repos this task touches, WHERE each lives on disk, and their order:
- Explore candidate repos (spawn Explore subagents for breadth).
- Propose the repo set and dependencies, e.g. "touches \`api\` and \`infra\`; \`infra\` depends on \`api\`'s contract." Confirm with the user.
- **Report each repo's absolute filesystem path** in the \`repoPaths\` metadata
  (\`{ "<repo>": "/abs/path/to/repo", … }\`). kautopilot may have been launched from
  ANYWHERE — possibly NOT inside any repo — so there is no implicit repo to fall back
  to. Locate each repo on disk (and clone it, with the user's OK, if it isn't present);
  confirm the path. \`seed\` creates each repo's worktree on demand (via worktrunk) from
  this path — a wrong/missing path means that repo can't be worked on.
- All repos must share one org / ticket system — reject cross-org tasks.
The confirmed repo set + dependsOn + repoPaths seed session.json repos[].

### Previous revision diff (if any)
{lastDiff}`;

const triage: StepDef = {
	name: "triage",
	phase: "plan",
	kind: "interactive",
	scope: "session",
	prepare: async (ctx) => {
		const { path } = currentRevisionPath(ctx.sessionId, "triage", {
			epoch: ctx.version,
		});
		const vars = {
			...planVars(ctx),
			triage: path,
			triageTemplate: ctx.config.templates.triage,
			lastDiff: lastDiff(ctx.sessionId, "triage", { epoch: ctx.version }),
		};
		const body = getAgentPrompt(
			"phase1",
			"triage",
			vars as Record<string, string>,
		);
		return {
			prompt: `${substitute(TRIAGE_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}\n\n${body}`,
			vars,
			contract: {
				outputFile: path,
				completionEvent: "triage:approved",
				completionMetadataSchema: {
					complexity: "straightforward|moderate|complex",
					repos: "string[]",
					dependsOn: "object",
					repoPaths: "object",
					branchSlug: "string?",
				},
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		const repos = (ctx.metadata?.repos as string[] | undefined) ?? [];
		const dependsOn =
			(ctx.metadata?.dependsOn as Record<string, string[]> | undefined) ?? {};
		// The harness explored the candidate repos during triage, so it can supply
		// each repo's git root (defaults to the session's primary repo otherwise).
		const repoPaths =
			(ctx.metadata?.repoPaths as Record<string, string> | undefined) ?? {};
		// Branch name: `<git-user>/<ticket-id>-<slug>` (e.g. `kirinnee/PE-1234-i18n`)
		// from the controller's apt slug (confirmed with the user post-triage). The
		// ticket id is the variable prefix; when there's no ticket id we fall back to a
		// literal `ticket-`. Same branch across all the task's repos. Null when no slug
		// was supplied → seed falls back to `<repo>-<id>`.
		const branchSlug = ctx.metadata?.branchSlug as string | undefined;
		const slug = branchSlug ? slugifyBranch(branchSlug) : "";
		if (repos.length > 0) {
			updateSessionMeta(ctx.sessionId, (m) => {
				const ticketRef = branchTicketRef(m.ticketId);
				const branch = slug
					? `${gitUserSlug()}/${ticketRef ? `${ticketRef}-` : "ticket-"}${slug}`
					: null;
				for (const repo of repos) {
					if (!m.repos.some((r) => r.repo === repo)) {
						m.repos.push({
							repo,
							repoPath: repoPaths[repo] ?? m.folder,
							worktree: null,
							branch,
							plans: [],
							dependsOn: dependsOn[repo] ?? [],
							prNumber: null,
							prUrl: null,
							status: "pending",
						});
					}
				}
			});
		}
		return "write_spec";
	},
};

// --- write_spec (interactive) ------------------------------------------------

const SPEC_MECHANICS = `## CRITICAL: Spec Writing & Approval Mechanics

### Align the GOALS first
Before writing the spec body, align with the user on the **top-level goals** ("the
main") — there may be ONE or several. Propose the goals, get agreement, and ONLY then
write the spec around them. The goals are the heart of the spec; everything else
derives from them. Give each goal a stable id (G1, G2, …). Every requirement (FR) must
be a derivation of a goal and must cite the goal it completes (→ G1). Keep the spec
implementation-free: minimal/no code, file paths, or function names — that's the plans.

### Working Copy
Write the master spec to: {spec}
This is the ONLY spec file you edit. Each version MUST be a complete, standalone spec
(NOT a changelog/diff). Follow this template:
{specTemplate}

This is the ONE master spec for the whole task — repo-agnostic. Cross-repo intent is
useful context; the per-repo split happens in plans, not here.

### Previous review feedback (if any)
{review_summary}

### Previous revision diff (if any)
{lastDiff}`;

const writeSpec: StepDef = {
	name: "write_spec",
	phase: "plan",
	kind: "interactive",
	scope: "session",
	prepare: async (ctx) => {
		// File-based versioning: the writer edits the CURRENT version (latest on
		// disk, or v1). A NEW version is minted only when the agent calls
		// `kautopilot revise` to present a fresh draft to the user.
		const { path } = currentRevisionPath(ctx.sessionId, "spec", {
			epoch: ctx.version,
		});
		const summaryFile = join(
			sessionDir(ctx.sessionId),
			"tmp",
			"spec-review-summary.md",
		);
		mkdirSync(join(sessionDir(ctx.sessionId), "tmp"), { recursive: true });
		const triagePath = latestTriagePath(ctx);
		const vars = {
			...planVars(ctx),
			spec: path,
			triage: triagePath,
			specTemplate: ctx.config.templates.spec,
			review_summary: existsSync(summaryFile)
				? summaryFile
				: "(none — first draft)",
			lastDiff: lastDiff(ctx.sessionId, "spec", { epoch: ctx.version }),
		};
		const body = getAgentPrompt(
			"phase1",
			"spec_writer",
			vars as Record<string, string>,
		);
		// The reviewer fan-out is carried ON the writer step so reviewers run
		// BEFORE each version is presented to the user — every version the user
		// sees is already review-checked. (Reviewer rounds are not versioned.)
		const review = buildReview(
			ctx.config.agents.phase1.spec_reviewers,
			vars,
			summaryFile,
		);
		return {
			prompt: `${substitute(SPEC_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}\n\n${body}`,
			vars,
			contract: {
				outputFile: path,
				completionEvent: "spec:approved",
			},
			review,
		} satisfies PreparedStep;
	},
	finalize: async () => "write_master_plan",
};

function latestSpecVersion(ctx: StepContext): number {
	return (
		latestRevisionOnDisk(ctx.sessionId, "spec", { epoch: ctx.version }) || 1
	);
}

function latestTriageVersion(ctx: StepContext): number {
	return (
		latestRevisionOnDisk(ctx.sessionId, "triage", { epoch: ctx.version }) || 1
	);
}

/** Path of the latest triage revision for the current epoch. */
function latestTriagePath(ctx: StepContext): string {
	return revisionPath(ctx.sessionId, "triage", latestTriageVersion(ctx), {
		epoch: ctx.version,
	});
}

/** Path of the latest spec revision for the current epoch. */
function latestSpecPath(ctx: StepContext): string {
	return revisionPath(ctx.sessionId, "spec", latestSpecVersion(ctx), {
		epoch: ctx.version,
	});
}

/** Path of the latest master-plan revision for the current epoch (or v1). */
function latestMasterPlanPath(ctx: StepContext): string {
	const n =
		latestRevisionOnDisk(ctx.sessionId, "master_plan", {
			epoch: ctx.version,
		}) || 1;
	return revisionPath(ctx.sessionId, "master_plan", n, { epoch: ctx.version });
}

// --- write_master_plan (interactive) ----------------------------------------

const MASTER_PLAN_MECHANICS = `## CRITICAL: Master Plan & Approval Mechanics

The **master plan** is the ORCHESTRATION layer for a multi-repo, multi-PR task. You
write and get it APPROVED **before** any per-repo sub-plans (write_plans) — it locks the
ORDER OF EXECUTION first, so the detailed plans are written against an agreed shape.

### Working Copy
Write the master plan to: {master_plan}
Each version MUST be a complete, standalone document (NOT a changelog). It must cover:

1. **The repos & the PR/branch layout.** List every repo and, for each, the PRs it will
   open — a repo MAY open SEVERAL PRs on SEVERAL branches. For each PR give a stable id
   (\`pr-1\`, \`pr-2\`, …), its repo, its branch name, a title, and which plans land in it.
2. **The plan breakdown as nodes.** List each plan (\`plan-<N>\`, repo-tagged) and the PR
   it ships in. (The detailed bodies come later in write_plans — here it's just the nodes
   and their order.)
3. **The dependency DAG with GATE LEVELS.** For each cross-plan dependency, state the
   upstream plan, the downstream plan, and the GATE LEVEL the upstream must reach before
   the downstream may START:
   - \`completed\` — upstream code is implemented/committed on its branch.
   - \`merged\` — upstream PR is merged into base (then the downstream worktree is cut off
     the updated base).
   - \`released\` — the upstream repo's semantic RELEASE is fully published AND all release
     CI/CD has finished, THEN base is pulled. Use this when the downstream consumes the
     upstream's PUBLISHED artifact (a released package/image), not just merged source.
   Dependencies MAY span repos.
4. **A mermaid \`graph TD\`** of the DAG (nodes = repo/plan grouped per PR, edges labelled
   with the gate level) so the dashboard can render it.

### Confirm the merge policy
Confirm with the user whether this session should MERGE ready PRs itself (\`auto\`) or ASK
first (\`manual\`). Either way the binary always drives PRs to ready-to-merge; the mode only
decides what happens then, and it is what makes \`merged\`/\`released\` gates progress.

### Previous revision diff (if any)
{lastDiff}

### Completion metadata (REQUIRED)
On approval you MUST pass the structured master plan as completion metadata so the binary
can freeze it into \`orchestration.yaml\` (the resumable record that also tracks each plan's
exec status + kloop run):
{
  "mergeMode": "manual" | "auto",
  "prs":   [ { "id": "pr-1", "repo": "<repo>", "branch": "<branch>", "title": "…", "plans": ["plan-1"] } ],
  "nodes": [ { "plan": "plan-1", "repo": "<repo>", "pr": "pr-1", "title": "…" } ],
  "deps":  [ { "plan": "plan-2", "repo": "<repoB>", "dependsOn": "plan-1", "dependsOnRepo": "<repoA>", "gate": "merged" } ]
}`;

const writeMasterPlan: StepDef = {
	name: "write_master_plan",
	phase: "plan",
	kind: "interactive",
	scope: "session",
	prepare: async (ctx) => {
		const { path } = currentRevisionPath(ctx.sessionId, "master_plan", {
			epoch: ctx.version,
		});
		const vars = {
			...planVars(ctx),
			master_plan: path,
			spec: latestSpecPath(ctx),
			triage: latestTriagePath(ctx),
			mergeMode: ctx.meta.mergeMode,
			lastDiff: lastDiff(ctx.sessionId, "master_plan", { epoch: ctx.version }),
		};
		return {
			prompt: `${substitute(MASTER_PLAN_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}`,
			vars,
			contract: {
				outputFile: path,
				completionEvent: "master_plan:approved",
				completionMetadataSchema: {
					mergeMode: "manual|auto?",
					prs: "Array<{id,repo,branch,title,plans}>",
					nodes: "Array<{plan,repo,pr,title?}>",
					deps: "Array<{plan,repo,dependsOn,dependsOnRepo,gate}>",
				},
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		const master = parseMasterPlanMetadata(ctx.metadata);
		// Confirmed merge policy (optional override) is persisted on the session.
		const mergeMode = ctx.metadata?.mergeMode;
		if (mergeMode === "manual" || mergeMode === "auto") {
			updateSessionMeta(ctx.sessionId, (m) => {
				m.mergeMode = mergeMode;
			});
		}
		const effectiveMerge =
			mergeMode === "manual" || mergeMode === "auto"
				? mergeMode
				: ctx.meta.mergeMode;
		// Freeze the agreed master plan into orchestration.yaml (resumable record).
		if (master.nodes.length > 0 || master.prs.length > 0) {
			initOrchestration(ctx.sessionId, ctx.version, effectiveMerge, master);
		}
		return "write_plans";
	},
};

/**
 * Parse the structured master plan from `master_plan:approved` completion metadata
 * into a {@link MasterPlan}, tolerating missing/extra fields. Unknown gate levels
 * default to `completed` (the weakest gate) so a typo never silently strengthens
 * sequencing into a release-wait.
 */
function parseMasterPlanMetadata(
	metadata: Record<string, unknown> | undefined,
): MasterPlan {
	const prsRaw = Array.isArray(metadata?.prs) ? metadata.prs : [];
	const nodesRaw = Array.isArray(metadata?.nodes) ? metadata.nodes : [];
	const depsRaw = Array.isArray(metadata?.deps) ? metadata.deps : [];
	const prs: PrPlan[] = prsRaw.map((p) => {
		const o = p as Record<string, unknown>;
		return {
			id: String(o.id ?? ""),
			repo: String(o.repo ?? ""),
			branch: String(o.branch ?? ""),
			title: String(o.title ?? ""),
			plans: Array.isArray(o.plans) ? o.plans.map(String) : [],
		};
	});
	const nodes: PlanNode[] = nodesRaw.map((n) => {
		const o = n as Record<string, unknown>;
		return {
			plan: String(o.plan ?? ""),
			repo: String(o.repo ?? ""),
			pr: String(o.pr ?? ""),
			...(o.title ? { title: String(o.title) } : {}),
		};
	});
	const deps: PlanDependency[] = depsRaw
		.map((d) => {
			const o = d as Record<string, unknown>;
			const gate: GateLevel = isGateLevel(o.gate) ? o.gate : "completed";
			return {
				plan: String(o.plan ?? ""),
				repo: String(o.repo ?? ""),
				dependsOn: String(o.dependsOn ?? ""),
				// No fallback to `o.repo`: an omitted upstream repo must NOT silently
				// become a same-repo edge pointing at the wrong plan. A malformed edge
				// (any of the four endpoints empty) is dropped below rather than wired wrong.
				dependsOnRepo: String(o.dependsOnRepo ?? ""),
				gate,
			};
		})
		.filter((d) => d.plan && d.repo && d.dependsOn && d.dependsOnRepo);
	return { prs, nodes, deps };
}

// --- write_plans (interactive) ----------------------------------------------

const PLAN_MECHANICS = `## CRITICAL: Plan Writing & Approval Mechanics

### Follow the approved master plan
The orchestration was already agreed in the master plan: {master_plan}. The plan ids,
repo/PR layout, and the execution-order DAG come from there — write the per-repo plan
bodies for THOSE plans (use the same \`plan-<N>\` ids). If you find the master plan's
breakdown is wrong, raise it rather than silently diverging.

### Propose the breakdown FIRST (before writing any plan bodies)
Do NOT jump straight into writing plan files. FIRST propose the breakdown and get the user to
approve the GRANULARITY:
- For each repo, list the plans as **titles + a ~1-line scope each** (e.g. "repo X: 1) …, 2) …,
  3) …") — the split only, **in chat. Do NOT create any plan files yet** (no bodies, no stubs).
- Apply the vertical-slice rules below; the right granularity is subjective (too fine vs too
  coarse depends on the user) — this proposal is where you ALIGN on it.
- Only AFTER the user approves the breakdown do you write the full plan bodies for the agreed
  set. If they change the split, re-propose before writing.

### Working Copies
Each plan is a FOLDER of versions under the plans directory. Write each plan file to
\`{plans}/<plan-name>/v{version}.md\`, one folder per slice, TAGGED BY REPO:
- {plans}/plan-1/v{version}.md   (repo: <repoA>)
- {plans}/plan-2/v{version}.md   (repo: <repoB>)
**REQUIRED folder-naming convention:** every plan folder MUST be named \`plan-<N>\` or
\`plan-<N>-<short-slug>\` where \`<N>\` is the plan's 1-based ordinal (\`plan-1\`,
\`plan-2\`, … or \`plan-1-auth\`, \`plan-2-api\`). The literal \`plan-\` prefix followed by the
number is mandatory — that stable id is what \`kautopilot schedule\` and
\`kautopilot record --plan <id>\` use to track execution. Put any descriptive title in
the plan body, not in place of the \`plan-<N>\` prefix.
Every plan written in THIS round shares the same v{version} (the plan-set version).
Each plan declares which repo it belongs to (front-matter \`repo:\` or a header line).
Plans are vertical, committable slices — the repo tag is an additional axis.

### Each plan is a self-standing VERTICAL slice
Every plan must stand on its own: its change is PREPPED + IMPLEMENTED + VERIFIED within the
SAME plan, ending in a single commit that stands alone (builds, passes its own verification,
and is independently reviewable/revertable). Split by domain/feature (vertical), never by
layer or phase. ANTI-PATTERNS — reject these:
- ❌ Horizontal phases: plan 1 = prep/scaffold, plan 2 = implement, plan 3 = verify. There is
  NO "foundation"/prep-only plan — each plan does its own prep AND its own verification.
- ❌ Over-granular: "1 small change = 1 plan". Group a change with the surrounding work that
  makes it meaningful and verifiable on its own.
If a plan can't be committed and verified on its own, it is split wrong.

Each version MUST be a complete, standalone set. Follow this template:
{planTemplate}

### Spec Amendment Escalation
If during plan writing you discover the master spec is wrong or incomplete:
1. Explain what's wrong and why plans can't proceed.
2. Debate until the user agrees the spec needs amendment.
3. After explicit approval, STOP — tell the controller this is a \`spec_amendment\`
   (complete with metadata {"escalate":"amend_spec","reason":"…"}). Do NOT approve plans when escalating.

### Previous revision diff (if any)
{lastDiff}`;

const writePlans: StepDef = {
	name: "write_plans",
	phase: "plan",
	kind: "interactive",
	scope: "session",
	prepare: async (ctx) => {
		const repo = authoringRepo(ctx);
		// File-based plan-set version: the writer edits the CURRENT set (latest on
		// disk, or v1). A new set version is minted only via `kautopilot revise`.
		const versions = listPlanSetVersions(ctx.sessionId, ctx.version, repo);
		const version = versions.length ? Math.max(...versions) : 1;
		const plansDir = plansRepoDir(ctx.sessionId, ctx.version, repo);
		mkdirSync(plansDir, { recursive: true });
		const summaryFile = join(
			sessionDir(ctx.sessionId),
			"tmp",
			"plan-review-summary.md",
		);
		mkdirSync(join(sessionDir(ctx.sessionId), "tmp"), { recursive: true });
		const vars = {
			...planVars(ctx),
			plans: plansDir,
			version: String(version),
			spec: latestSpecPath(ctx),
			triage: latestTriagePath(ctx),
			master_plan: latestMasterPlanPath(ctx),
			planTemplate: ctx.config.templates.plan,
			lastDiff: lastDiff(ctx.sessionId, "plans", { epoch: ctx.version, repo }),
		};
		const body = getAgentPrompt(
			"phase1",
			"plan_writer",
			vars as Record<string, string>,
		);
		// Reviewers run BEFORE each version is presented (carried on the writer
		// step), so every plan set the user sees is already review-checked.
		const review = buildReview(
			ctx.config.agents.phase1.plan_reviewers,
			vars,
			summaryFile,
		);
		return {
			prompt: `${substitute(PLAN_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}\n\n${body}`,
			vars,
			contract: {
				outputFile: plansDir,
				completionEvent: "plans:approved",
				completionMetadataSchema: {
					escalate: "amend_spec?",
					reason: "string?",
				},
			},
			review,
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		if (ctx.metadata?.escalate === "amend_spec") {
			// amend_spec (plans found the spec wrong) bumps the epoch and re-runs the
			// shared plan phase (SPEC §7.1/§13 #5). write_plans is already session-scoped,
			// so returning "write_spec" re-enters the shared timeline at the new epoch.
			updateSessionMeta(ctx.sessionId, (m) => {
				m.epoch += 1;
				for (const r of m.repos) r.status = "pending";
			});
			return "write_spec";
		}
		return "finalize_plans";
	},
};

/** The repo bucket the plan WRITER authors into (delegates to shared). */
function authoringRepo(ctx: StepContext): string {
	return authoringRepoName(ctx.meta);
}

// --- finalize_plans (code) ---------------------------------------------------

const finalizePlans: StepDef = {
	name: "finalize_plans",
	phase: "plan",
	kind: "code",
	scope: "session",
	run: async (ctx) => {
		// Partition plans per repo into session.json repos[].plans. The per-epoch
		// `epoch/<E>/plans/<repo>/<plan>/vN.md` tree is the single source of truth —
		// there is no separate frozen snapshot. (Commit happens at repo seed.)
		const plans = latestPlanFiles(
			ctx.sessionId,
			ctx.version,
			authoringRepo(ctx),
		);
		const byRepo: Record<string, string[]> = {};
		for (const { plan, file } of plans) {
			const content = readFileSync(file, "utf-8");
			const m =
				content.match(/^repo:\s*(\S+)/m) ?? content.match(/repo:\s*(\S+)/);
			const repo = m?.[1] ?? ctx.meta.repos[0]?.repo ?? "default";
			byRepo[repo] ??= [];
			byRepo[repo].push(plan);
		}
		const allPlans = plans.map((p) => p.plan);
		updateSessionMeta(ctx.sessionId, (m) => {
			for (const r of m.repos) r.plans = byRepo[r.repo] ?? [];
			// Ensure at least one repo exists for the one-repo flow.
			if (m.repos.length === 0) {
				m.repos.push({
					repo: "default",
					repoPath: null,
					worktree: null,
					branch: null,
					plans: allPlans,
					dependsOn: [],
					prNumber: null,
					prUrl: null,
					status: "pending",
				});
			}
		});

		// Plans approved → hand execution to the skill. The binary waits at
		// `await_repos` while the skill drives `kautopilot schedule`/`record`.
		return "await_repos";
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
				.map((r) => r.prUrl ?? (r.prNumber ? `#${r.prNumber}` : null))
				.filter(Boolean)
				.join(", ") || "(PRs tracked in orchestration.yaml)";
		const prompt = [
			`The execution DAG is clear for this epoch (${prRef}).`,
			"",
			"Confirm the next step:",
			"- done: no further changes for this session.",
			"- feedback: capture changes for a new planning epoch.",
			"",
			"Only choose done after scheduled PR merge/release work is already recorded.",
		].join("\n");
		return {
			prompt,
			vars: {},
			contract: {
				completionEvent: "feedback_check:completed",
				completionMetadataSchema: { choice: "feedback|done" },
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		return ctx.metadata?.choice === "feedback" ? "feedback" : null;
	},
};

// --- feedback (interactive) --------------------------------------------------

const FEEDBACK_MECHANICS = `## CRITICAL: Feedback Mechanics
### Output File
Write the feedback to {feedback_doc}. It is consumed by the next planning epoch.

### Capture the change request
- Identify what was wrong, missing, or newly desired.
- Keep the feedback concrete enough for the next spec/plans pass.
- If the feedback implies durable agent guidance, propose concise candidate rules.

### Completion metadata
Pass confirmed durable rules as { "rules": ["..."] }. Omit rules when there are none.

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
				.join(", ") || "(PRs tracked in orchestration.yaml)";
		const vars: Record<string, string | null> = {
			feedback_doc: path,
			task_spec_path: latestSpecPath(ctx),
			plans_dir: join(epochDir, "plans"),
			pr_url: prUrls,
			checks_status: "(recorded ready/merged/released in orchestration.yaml)",
			thread_count: "0",
			lastDiff: lastDiff(ctx.sessionId, "feedback", { epoch: ctx.version }),
		};
		const body = getAgentPrompt(
			"phase3",
			"feedback",
			vars as Record<string, string>,
		);
		return {
			prompt: `${substitute(FEEDBACK_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}\n\n${body}`,
			vars,
			contract: {
				outputFile: path,
				completionEvent: "feedback:approved",
				completionMetadataSchema: { rules: "string[]" },
			},
		} satisfies PreparedStep;
	},
	finalize: async (ctx) => {
		const rules = (ctx.metadata?.rules as string[] | undefined) ?? [];
		if (rules.length > 0) {
			let written = 0;
			for (const r of ctx.meta.repos) {
				// In the DAG model the binary never seeds worktrees (`worktree` stays
				// null), so fall back to the repo's recorded git root from triage.
				const dir = r.worktree ?? r.repoPath;
				if (!dir || !existsSync(dir)) continue;
				try {
					const rulesFile = join(dir, "rules.md");
					const prev = existsSync(rulesFile)
						? readFileSync(rulesFile, "utf-8")
						: "";
					const additions = rules.map((line) => `- ${line}`).join("\n");
					const next = prev
						? `${prev.replace(/\s*$/, "")}\n${additions}\n`
						: `# Rules\n\n${additions}\n`;
					await Bun.write(rulesFile, next);
					written += 1;
				} catch {
					// Best-effort per repo; surfaced below if NOTHING landed.
				}
			}
			if (written === 0) {
				// Never silently drop user-confirmed rules: fail the complete (no
				// completion event is appended, the step stays pending) so the
				// controller can write rules.md itself and retry.
				throw new Error(
					"confirmed rules could not be written to any repo's rules.md " +
						"(no repo has a usable worktree/repoPath). Write the rules into " +
						"each repo's rules.md yourself, then re-run `kautopilot complete` " +
						"without the rules metadata.",
				);
			}
		}
		updateSessionMeta(ctx.sessionId, (m) => {
			m.epoch += 1;
			for (const r of m.repos) r.status = "pending";
		});
		return "write_spec";
	},
};

export const PLAN_STEPS: StepDef[] = [
	resolveOrg,
	brainstorm,
	createTicket,
	fetchTicket,
	triage,
	writeSpec,
	writeMasterPlan,
	writePlans,
	finalizePlans,
	feedbackCheck,
	feedback,
];
