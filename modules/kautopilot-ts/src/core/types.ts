import { z } from "zod";

// ============================================================================
// Log Entry
// ============================================================================

export interface LogEntry {
	ts: string;
	event: string;
	version?: number;
	attempt?: number;
	plan?: string;
	/** Repo this event is scoped to (execution/polish steps); absent for shared steps. */
	repo?: string;
	result?: string;
	metadata?: Record<string, unknown>;
}

// ============================================================================
// Session Status — re-exported from status.ts
// ============================================================================

export type { SessionStatus } from "./status";

// ============================================================================
// Reviewer Schema
// ============================================================================

export const reviewerSchema = z.object({
	desc: z.string(),
	prompt: z.string(),
});

export type ReviewerConfig = z.infer<typeof reviewerSchema>;

// ============================================================================
// Main Config Schema
// ============================================================================

const agentSchema = z.object({
	prompt: z.string(),
});

// ============================================================================
// Default Output Templates for Phase 1
// ============================================================================

const DEFAULT_TRIAGE_TEMPLATE = `# Triage: {title}

## Complexity
straightforward | moderate | complex

## Repo Set & Dependency Order
[Which repos this task touches and their order, e.g. "api, infra (infra depends on api)", or "single repo"]

## Assessment
[2-5 sentence summary of what needs to happen]

## Things to Check
[Checklist for the spec/plan phase — files/areas to read and confirm, dependencies/usages
 to trace, tests that may break, shared state touched. List them; do NOT resolve them here.]

## Open Questions
[Ambiguities or decisions the ticket leaves open, for the user / spec phase to answer.
 List them — do NOT answer them here. Or "None — the ticket is unambiguous."]

## Clarifications
[Any points already clarified with the user during triage, or "None needed"]

## Risks
[Likely risk factors to confirm, or "Low risk" with justification]

## Verification

### Assumptions to Verify
[What assumptions does this task make that must be checked against reality?
 This is domain-dependent and open-ended. Any assumption about external
 behavior that the implementation will depend on belongs here.
 Or "None — all assumptions are grounded in code already read."]

### Access Required
[What access/permissions are needed to verify assumptions above?
 Request it here so the user grants it before spec/plan writing.
 Or "None"]

### Testing Level
none | light | moderate | heavy
[Rationale for this level]

### Validation Matrix
- Automated immediate: [what to check before release, automated]
- Manual immediate: [human checks before release, or "none"]
- Automated post-release: [automated checks after release, or "none"]
- Manual post-release: [human checks after release, or "none"]`;

const DEFAULT_SPEC_TEMPLATE = `# Spec: {title}

The spec aligns on the HIGH-LEVEL GOALS and IDEAS — the problem, the intended
outcome, and the agreed direction. It is intentionally implementation-free: no
code, file paths, function names, snippets, or test/command mechanics. Those
concrete decisions belong in the plans.

## Summary
[The goal of this change in 2-3 sentences: the problem it solves and the
 outcome we want. Intent, not implementation.]

## Background & Context
[Why this matters now, and the context a reader needs to understand the goals:
 the current situation, the motivation, relevant prior decisions.]

## Goals
[The high-level objectives this work must achieve. What does success look like
 from the user's / stakeholder's point of view? Each goal is an outcome or an
 intent — never a description of how the code will be written.]

## Approach (high level)
[The agreed direction at a conceptual level — the shape of the solution and the
 key ideas behind it. Describe WHAT we intend to do and WHY. Stay above the
 code: no file/function/API specifics (the plans turn this into changes).]

## Requirements
[What the solution must deliver, as outcomes and behavior from the user's or
 caller's perspective. Write each as a clear, verifiable statement of intent,
 covering the important cases and what should happen when things go wrong —
 at the level of "what should be true", not "which function does it".]

## Non-Goals / Out of Scope
[What this change explicitly does NOT address, to prevent scope creep during
 planning and implementation.]

## Open Questions & Risks
[Decisions still to be made, assumptions to confirm, and the main risks — kept
 at the level of the idea and direction. Note how each open assumption could be
 confirmed; the detailed verification happens in the plan phase.]

## Success Criteria
[How we'll know the goals are met, described as observable outcomes — not test
 commands or code. The concrete verification approach is decided in the plans.]`;

const DEFAULT_PLAN_TEMPLATE = `# Plan {N}: {title}

## Overview
[What this plan implements and why it is a self-contained, committable unit.
 Reference the spec requirements this plan addresses.]

## Changes
[Files to modify or create, with rationale for each change.
 Reference actual file paths and functions.]

## Spec Adherence
[List which spec goals and requirements this plan addresses. Every applicable
 spec requirement must be covered by at least one plan across the full plan set.
 The spec states intent and outcomes; this plan turns them into concrete code.]

## Acceptance Criteria

### Functional Checks
[What observable behavior proves this plan is correctly implemented.
 Each check should be concrete enough for the dev loop to implement as
 an automated test. Reference specific inputs, outputs, and state changes.]

### Non-Functional Checks
[Which non-functional concerns apply to this plan (linting, build, tests,
 security, performance, compatibility, observability, etc.) and how each will
 be verified. Derive them from the spec's goals + the triage testing level.
 Examples: "lint passes on new files", "unit tests cover the new parser",
 "API response time stays under 200ms for N=1000".]

## Validation Approach
[From the triage's validation matrix, what applies to this plan?
 - Immediate automated checks: what the dev loop should verify
 - Post-release checks: what to verify after deployment
 - Manual checks: what a human must review
 Describe the general approach — the dev loop will implement the scripts.]`;

// ============================================================================
// Default prompt constants for Phase 1
// ============================================================================

const DEFAULT_TRIAGE_PROMPT = `You are triaging a ticket for kautopilot. Read the ticket at {ticket} and take a quick look at the codebase — only enough to scope and classify it.

Your job is to CLASSIFY and SCOPE this ticket, and to LIST what must be checked and what questions remain. You do NOT solve it, investigate deeply, verify assumptions, or answer the open questions yourself — the spec and plan phases (and the user) do that. Triage outputs a checklist and a question list, not findings.

## Scope & classify (quick assessment — do NOT investigate deeply)

Name the files/areas you SUSPECT are involved (from the ticket plus a light look) and flag them for the spec phase to confirm. Do not exhaustively read code, trace every usage, or run tools.
- **Complexity** — straightforward | moderate | complex; rough count of moving parts / files likely touched.
- **Repo set + dependency order** — which repos this touches and their order.
- **Parallelizability** — can this split into independent streams of work.
- **Risk factors** — likely blast radius, backward compatibility, data migration (to be confirmed later).
- **Manual work** — infra changes, config deployments, manual verification likely needed.

## Things to Check (LIST them — do NOT perform the checks)

Every item here is work for the spec/plan phase, not for you now:
- Files/areas to read and confirm are in scope.
- Dependencies/usages whose blast radius must be traced.
- Tests that may be affected — do they exist, will they break?
- Shared state possibly touched — DB schemas, API contracts, shared configs, public interfaces.
- Recent-change / stability concerns worth a git-log check.

## Open Questions (LIST them — do NOT answer them)

List every ambiguity, decision, or unknown the ticket leaves open. Surface them — do not resolve them yourself. Raise the blocking ones with the user during this triage; defer the rest to the spec phase.

## Risk Assessment Guidelines

Default to **moderate** risk unless you have concrete evidence otherwise:
- **Low risk**: Only if the change is truly isolated (single file, no callers, has test coverage, no shared state)
- **Moderate risk**: Multiple files, some callers, or any shared state involved
- **High risk**: Database/API changes, many callers, no test coverage, or unclear requirements

Err on the side of caution. It is much better to overestimate risk than to underestimate it.

## Verification

Your job is to IDENTIFY what needs verifying — not to do the verification yourself.
The spec and plan phases will perform the actual checks.

**Assumptions** — What does this task take for granted that could be wrong? Think broadly
across whatever domain this task touches. Any assumption about external behavior (libraries,
APIs, platforms, infrastructure, data formats, integrations) that the implementation will
depend on should be listed. For each, note what source could confirm or deny it.

**Access** — If verifying any assumption requires access the user hasn't granted (cluster
credentials, API keys, staging environments, etc.), request it here so it's available before
spec/plan writing begins.

**Testing level** — Set the bar based on blast radius and behavioral impact.

**Validation matrix** — Always push toward automated-immediate. Human time is far more
expensive than machine time. If something CAN be checked before release and CAN be automated,
it MUST be. Describe what to validate, not how.

## User Approval

After writing your triage assessment to the file, present a clear summary to the user showing:
1. The complexity you chose
2. The repo set + dependency order
3. Key risks identified (or why you believe risk is low)
Ask the user to confirm before approval. Do NOT auto-approve.`;

const DEFAULT_SPEC_WRITER_PROMPT = `You are writing a spec for a kautopilot task. Read the ticket at {ticket} and the triage assessment at {triage}.

The spec aligns on the HIGH-LEVEL GOALS and IDEAS: the problem, the intended outcome, and the agreed direction. It is NOT an implementation document — do NOT specify concrete code, file paths, function names, code snippets, schemas, or test/command mechanics. Those decisions belong in the plans. Keep the whole spec about WHAT and WHY; leave HOW to the plan phase.

Based on the triage assessment:
- **If triage says "straightforward"**: write a focused, concise spec — the goal, the direction, and the success criteria. No heavy debate.
- **If triage says "moderate" or "complex"**: explore the problem space and debate. Surface hidden assumptions, conflicts, and risks at the level of intent and direction. Clarify until the goals and approach are unambiguous.

Explore enough context to ground the goals in reality, but describe outcomes and intent — what we want to be true when this is done — rather than how the code will achieve it.

## Open questions & assumptions

Check the triage at {triage} for its open questions and assumptions. Carry the ones that affect the goals or direction into the spec's "Open Questions & Risks", and resolve the blocking ones with the user now. Note how each open assumption could be confirmed, but leave the detailed verification to the plan phase — don't turn the spec into an evidence log.

Write each requirement as a clear statement of intended behavior or outcome, not a code-level instruction.`;

const DEFAULT_PLAN_WRITER_PROMPT = `You are writing implementation plans for a kautopilot task. Read the spec at {spec} and the triage assessment at {triage}.

Rules:
- Plans must be vertically split (by domain/feature, not by layer)
- Each plan is one isolated, committable unit of work
- For "ticket" delivery: plans describe investigation steps or ticket creation, not code changes
- Reference actual files and functions from the codebase

## Verification & Testing

Check the triage at {triage}. Plans MUST NOT be based on unverified assumptions — the spec
should have resolved them. If any remain unverified in the spec, resolve them now or flag
them to the user.

Based on the triage testing level, suggest the general testing approach using tools
appropriate for this project's stack. Front-load automated testing aggressively.

For the validation matrix: describe the general approach in each plan. The dev loop will
implement concrete scripts. Keep it concise — ideas, not implementations.

## Spec Adherence

Every plan must list which spec requirements it addresses. Across the full set of plans,
every functional requirement and every applicable non-functional requirement from the spec
must be covered by at least one plan. If you discover a requirement cannot be addressed
as specified, flag it — do not silently drop it.`;

const phase1AgentsSchema = z.object({
	triage: agentSchema,
	spec_writer: agentSchema,
	plan_writer: agentSchema,
	spec_reviewers: z.record(z.string(), reviewerSchema),
	plan_reviewers: z.record(z.string(), reviewerSchema),
});

export const configSchema = z.object({
	agents: z.object({
		phase1: phase1AgentsSchema,
		phase2: z.record(z.string(), agentSchema),
		phase3: z.record(z.string(), agentSchema),
		generic: z.record(z.string(), agentSchema),
	}),
	templates: z.object({
		triage: z.string(),
		spec: z.string(),
		plan: z.string(),
	}),
	settings: z.object({
		maxPushCycles: z.number().min(1).max(20),
		pollInterval: z.number().min(1).max(300),
		coderabbit: z.boolean(),
		maxParallelRepos: z.number().min(1).max(10).default(2),
		runMode: z
			.enum(["current-session", "sub-agent"])
			.default("current-session"),
		execMode: z.enum(["kloop", "sub-agent"]).default("kloop"),
	}),
	orgs: z
		.record(
			z.string(),
			z.object({
				ticketSystem: z.enum(["jira", "clickup", "none"]),
				commitSpec: z.boolean(),
				baseBranch: z.string(),
			}),
		)
		.default({}),
});

export type Config = z.infer<typeof configSchema>;

// ============================================================================
// Default prompt strings (extracted from hardcoded values)
// ============================================================================

// ============================================================================
// Shared Commit Agent Prompt
// ============================================================================

/**
 * Generic commit agent prompt used across phases.
 * Variable: {context} — optional context to include (e.g., plan content).
 * If no context needed, pass empty string or omit.
 */
const DEFAULT_COMMIT_PROMPT = `You are committing code changes in a repository. Your task:

1. Discover commit conventions:
   - Search for any .md file whose name contains "commit" (case-insensitive), e.g. COMMIT_CONVENTIONS.md, commit-guide.md
   - Check for .commitlintrc, .commitlintrc.json, .commitlintrc.yml, .commitlintrc.yaml, .commitlintrc.js, commitlint.config.js, commitlint.config.ts
   - Check package.json for a "commitlint" config section
   - Read git log --oneline -10 to see existing commit message style

2. Stage all changes (git add the specific changed files, never git add -A)

3. Commit with a message that follows the discovered conventions. If no conventions found, use conventional commits style (e.g. "feat: ...", "fix: ...", etc.) matching the style of recent commits.

4. If pre-commit hooks fail:
   - Read the error output carefully
   - Fix the underlying issues (formatting, lint, type errors, etc.)
   - Re-stage the fixed files and retry the commit

5. When done, output ONLY the commit SHA (the output of git rev-parse HEAD), nothing else.

{context}`;

export const DEFAULT_CONFIG: Config = {
	agents: {
		phase1: {
			// Available vars: {ticket} — file path, NOT inlined content
			// Mechanics prepended by handler: TRIAGE_MECHANICS (output file, approval gate)
			triage: { prompt: DEFAULT_TRIAGE_PROMPT },
			// Available vars: {ticket}, {triage} — file paths, NOT inlined content
			// Mechanics prepended by handler: SPEC_MECHANICS (ordinal drafts, approval protocol)
			spec_writer: { prompt: DEFAULT_SPEC_WRITER_PROMPT },
			// Available vars: {spec}, {triage} — file paths, NOT inlined content
			// Mechanics prepended by handler: PLAN_MECHANICS (ordinal drafts, approval protocol, spec amendment escalation)
			plan_writer: { prompt: DEFAULT_PLAN_WRITER_PROMPT },
			spec_reviewers: {
				// All reviewers: Available vars {spec}, {ticket} — file paths, NOT inlined content
				completeness: {
					desc: "All requirements from ticket covered",
					prompt: `Read the spec at {spec} and the ticket at {ticket}.
Check: does the spec address every requirement in the ticket?
List any requirements that are missing or insufficiently addressed.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
				grounding: {
					desc: "Claims about the current situation are grounded, not hallucinated",
					prompt: `Read the spec at {spec} and the ticket at {ticket}.
The spec is high-level (goals/intent, no code). Check that its claims about the CURRENT
situation, motivation, and context are accurate and grounded — explore the system enough to
confirm. Flag anything that looks hallucinated, assumed, or contradicted by reality.
Do NOT demand file paths, function names, version numbers, or code citations — that detail
belongs in the plans, not the spec.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
				generalization: {
					desc: "Direction reuses existing approaches rather than reinventing",
					prompt: `Read the spec at {spec}. Explore the system at a high level.
Check: does the proposed DIRECTION reinvent something the org/codebase already provides
(an existing service, pattern, or convention) when reusing it would be simpler? Judge at
the level of approach and intent — not concrete code.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
				complexity: {
					desc: "Is there a simpler or faster approach?",
					prompt: `Read the spec at {spec}.
Check: is the proposed approach unnecessarily complex?
Consider: could fewer files be changed? Could an existing tool/command handle this? Is there a more direct path?
Don't flag reasonable complexity — only flag when there's a clearly simpler alternative.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
				security: {
					desc: "Security and compliance implications",
					prompt: `Read the spec at {spec}.
Check for security concerns: injection risks, auth/authz gaps, secrets handling, data exposure, OWASP top 10.
Only flag genuine issues, not theoretical concerns in internal code paths.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
				success_criteria: {
					desc: "Success criteria are observable outcomes",
					prompt: `Read the spec at {spec}.
Check: does the spec have a "Success Criteria" section, and is each criterion an OBSERVABLE
OUTCOME — something you could later confirm is true (a behavior, a result, a measurable
condition)? Flag vague/unmeasurable criteria ("works well", "is fast"). Do NOT require test
commands, grep assertions, or build steps — the concrete verification approach is decided in
the plans, not the spec.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
				risks_and_scope: {
					desc: "Open questions, risks, and scope boundaries are surfaced",
					prompt: `Read the spec at {spec}.
Check: does the spec surface the main RISKS and OPEN QUESTIONS (decisions still to make,
assumptions to confirm) and state its NON-GOALS / out-of-scope boundaries? A spec that
claims zero risks or open questions for a non-trivial change is suspect.
Flag missing or hand-wavy risk/scope sections. Keep it about direction and intent, not
implementation mechanics.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
				high_level: {
					desc: "Spec stays at goals/intent — no leaked implementation detail",
					prompt: `Read the spec at {spec}.
The spec must align on high-level GOALS and IDEAS. Flag any leaked implementation detail
that belongs in the plans, not here: specific file paths, function/class names, code
snippets, schemas, config keys, or exact test/command mechanics. Also flag goals or
requirements that are too ambiguous to act on.
Carry-over from triage: if the triage raised assumptions, the spec should at least NOTE the
ones that affect the goals (under Open Questions & Risks) — but it need not prove them; the
plan phase verifies.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
			},
			plan_reviewers: {
				// All reviewers: Available vars {plans}, {spec} — file paths, NOT inlined content
				coverage: {
					desc: "Plans fully cover the spec",
					prompt: `Read the plans at {plans} and the spec at {spec}.
Check: do the plans together cover every requirement in the spec?
List any spec items that are not addressed by any plan.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
				ordering: {
					desc: "Plan dependencies ordered correctly",
					prompt: `Read the plans at {plans}.
Check: are plans ordered so that earlier plans don't depend on later ones?
Flag any circular or incorrect dependency ordering.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
				vertical_split: {
					desc: "Plans split by domain/feature, not by layer",
					prompt: `Read the plans at {plans}.
Check: are plans split vertically by domain/feature (each plan = complete slice with types+logic+tests)?
Flag any plan that is a horizontal layer (e.g., "add types" or "write tests" as standalone plans).
Each plan should produce an isolated working commit.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
				cost: {
					desc: "Cost and resource implications",
					prompt: `Read the plans at {plans} and the spec at {spec}.
Check: are there cost implications (compute, storage, API calls, third-party services)?
Flag any plans that could have unexpected cost impact without mentioning it.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
				spec_adherence: {
					desc: "Plans address all spec requirements, no drift",
					prompt: `Read the plans at {plans} and the spec at {spec}.
Check: across all plans, is every functional requirement from the spec addressed by at
least one plan? Is every applicable non-functional requirement addressed?
List any spec requirements that are not covered by any plan.
List any plan content that introduces scope not present in the spec (scope creep).
If you find drift — plans that contradict or ignore spec requirements — flag each instance
with the specific spec requirement and the conflicting plan content.
Output ONLY the problems found — one per line. If none, output "No issues found."`,
				},
			},
		},
		phase2: {
			resolve: {
				// Available vars: {task_spec_path}, {plan_path}, {plans_dir}, {kloop_evidence},
				//   {plan_name}, {reason}, {attempt}
				// Mechanics (strategy list, context doc writing, approval protocol) are hardcoded in resolve.ts
				prompt: `You are helping the user resolve a kloop failure for {plan_name}.

## What Happened

{kloop_evidence}

## Context
- Task spec: {task_spec_path}
- Current plan: {plan_path}
- Plans directory: {plans_dir}

Read these to understand the original intent before proposing a strategy.`,
			},
			amend_plans: {
				// Available vars: {resolution_path}, {task_spec_path}, {plans_dir}, {kloop_evidence}
				// Mechanics (per-strategy prompts, approval protocol) are hardcoded in amend-plans.ts
				prompt: `You are amending plans for the current epoch. Read the resolution document at {resolution_path}
— the previous TTY wrote it to explain what went wrong and what needs to change.

## Context
- Task spec: {task_spec_path}
- Plans directory: {plans_dir}

## Kloop Evidence

{kloop_evidence}`,
			},
		},
		phase3: {
			eval: {
				// Available vars: {spec_path}, {plan_paths} — file paths, NOT inlined content
				prompt: `Analyze PR feedback and decide what action to take.
Be precise: only suggest code_fix for genuine issues.
Mark items as ambiguous when you're unsure rather than guessing.`,
			},
			write_fix: {
				// Available vars: none — context is prepended by handler
				prompt: `Merge all pending code fixes into a single coherent implementation spec.
Deduplicate overlapping fixes on the same file.
Output the complete spec (not just the changes).`,
			},
			prereview_classify: {
				// Available vars: none — content is prepended by handler
				prompt: `Classify CodeRabbit findings as fix/comment/ignore.
Be conservative — only mark as "fix" if it's a genuine issue.`,
			},
			prereview_fix: {
				// Available vars: none — content is prepended by handler
				prompt: `Apply the classified fixes to the codebase.
Be precise and minimal — only change what's needed.`,
			},
			create_pr: {
				// Available vars: {baseBranch}, {ticketId}, {spec_path} — file path, NOT inlined content
				prompt: `You are creating a GitHub Pull Request. Your task:

1. Discover PR conventions:
   - Check for PR templates: .github/PULL_REQUEST_TEMPLATE.md, .github/pull_request_template.md, or any template in .github/PULL_REQUEST_TEMPLATE/
   - Check CONTRIBUTING.md for PR guidelines
   - Look at recent merged PRs for title/body style: gh pr list --state merged --limit 5 --json title,body

2. Create a PR against the "{baseBranch}" branch using gh pr create:
   - Title must start with "[{ticketId}]" followed by a concise summary of what was implemented
   - Body should follow the discovered template/conventions, or include a summary, what changed, and how to test

3. Output ONLY a JSON object with the PR number and URL:
   {"number": <int>, "url": "<string>"}`,
			},
			tty_resolve_ambiguous: {
				// Available vars: none — context is prepended by handler
				prompt: `Help resolve ambiguous items from the PR review.
For each item, decide: reply, code fix, or skip.`,
			},
			tty_resolve_conflict: {
				// Available vars: none — context is prepended by handler
				prompt: `Help resolve merge conflicts from the rebase.
Resolve conflicts while preserving the intent of both changes.`,
			},
			tty_resolve_failure: {
				// Available vars: none — context is prepended by handler
				prompt: `The dev-loop execution failed. Help investigate and determine next steps.
Options: fix the issue and retry, skip and move on, or escalate.`,
			},
			feedback: {
				// Available vars: {task_spec_path}, {plans_dir}, {pr_url}, {checks_status}, {thread_count}, {feedback_path}
				// Mechanics (approval protocol, file writing, restart loop) are hardcoded in feedback-check.ts
				prompt: `## Context Paths
- Task spec: {task_spec_path}
- Plans directory: {plans_dir}

Read these files to understand the original intent.

## PR State
- URL: {pr_url}
- Checks status: {checks_status}
- Open threads: {thread_count}

Discuss the PR with the user. Figure out:
1. What needs improvement?
2. Implementation issue or spec issue?
3. What spec changes would address it?`,
			},
		},
		generic: {
			// Available vars: {context} — optional context (e.g., plan path, reason for commit)
			commit: { prompt: DEFAULT_COMMIT_PROMPT },
		},
	},
	templates: {
		triage: DEFAULT_TRIAGE_TEMPLATE,
		spec: DEFAULT_SPEC_TEMPLATE,
		plan: DEFAULT_PLAN_TEMPLATE,
	},
	settings: {
		maxPushCycles: 10,
		pollInterval: 60,
		coderabbit: true,
		maxParallelRepos: 2,
		runMode: "current-session",
		execMode: "kloop",
	},
	orgs: {
		liftoff: { ticketSystem: "jira", commitSpec: false, baseBranch: "master" },
		atomicloud: {
			ticketSystem: "clickup",
			commitSpec: true,
			baseBranch: "main",
		},
	},
};

// ============================================================================
// Session Row (index.db)
// ============================================================================

export type SessionState = "init" | "ready" | "running" | "done";

export interface SessionRow {
	id: string;
	repo_path: string;
	worktree: string;
	git_root: string;
	git_root_host: string;
	ticket_id: string | null;
	branch: string | null;
	local: number;
	state: SessionState;
	created_at: string;
	updated_at: string;
}

// ============================================================================
// Phase 3 Types
// ============================================================================

export type PollState = "pending" | "blocked" | "mergeable";

export interface PollThread {
	id: string;
	isOutdated: boolean;
	author: string;
	body: string;
	firstCommentId: string;
	firstCommentDatabaseId: number | null;
	replies: PollReply[];
}

export interface PollReply {
	id: string;
	databaseId: number;
	author: string;
	body: string;
	isBot: boolean;
}

export interface CheckStatus {
	name: string;
	status: "pending" | "passing" | "failing";
}

// ============================================================================
// Phase Constants
// ============================================================================

export type Phase = "plan" | "implementation" | "polish";

// ============================================================================
// Lock File
// ============================================================================

export interface LockInfo {
	locked: boolean;
	pid: number;
	alive: boolean;
}
