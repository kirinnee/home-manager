import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentPrompt } from '../core/agents';
import { sessionDir } from '../core/artifacts';
import type { PreparedStep, ReviewDescriptor, ReviewerDescriptor, StepContext, StepDef } from '../core/descriptor';
import type { ArtifactKind, ArtifactRef } from '../core/revisions';
import {
  approvedRevisionCount,
  diffRevisions,
  latestRevisionOnDisk,
  listPlanSetVersions,
  nextRevisionPath,
  plansRepoDir,
  revisionPath,
} from '../core/revisions';
import { updateSessionMeta } from '../core/session-meta';
import type { ReviewerConfig } from '../core/types';
import { authoringRepoName, latestPlanFiles } from '../phases/shared';
import { rulesPath, SHARED_APPROVAL_GATE, substitute, ticketId, ticketPath } from './prompt-helpers';

// ============================================================================
// PLAN phase — `kautopilot next` (session-scoped, repo-agnostic for spec).
// resolve_org → [brainstorm → create_ticket] → fetch_ticket → triage →
// write_spec → spec_review → write_plans → plan_review → finalize_plans
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
function lastDiff(sessionId: string, kind: ArtifactKind, ref: ArtifactRef = {}): string | null {
  const count =
    kind === 'plans' && ref.repo
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
  const list: ReviewerDescriptor[] = Object.entries(reviewers).map(([id, r]) => ({
    id,
    prompt: substitute(r.prompt, vars),
    verdictSchema: { approved: 'boolean', issues: 'string[]' },
  }));
  return {
    reviewers: list,
    synthesize: { prompt: REVIEW_SYNTHESIZE_PROMPT, outputFile: summaryFile },
    gate: 'all_approve',
  };
}

// --- resolve_org (code) ------------------------------------------------------

const resolveOrg: StepDef = {
  name: 'resolve_org',
  phase: 'plan',
  kind: 'code',
  scope: 'session',
  run: async ctx => {
    // Org is resolved at `start` (--org → ticket → ask) and recorded in session.json.
    if (!ctx.meta.org) throw new Error('resolve_org: org not set on session');
    // Ad-hoc (no ticket) flow shapes the idea first.
    return ctx.meta.ticketId ? 'fetch_ticket' : 'brainstorm';
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
  name: 'brainstorm',
  phase: 'plan',
  kind: 'interactive',
  scope: 'session',
  prepare: async ctx => {
    const { path } = nextRevisionPath(ctx.sessionId, 'brainstorm');
    const vars = {
      ...planVars(ctx),
      brainstorm: path,
      request: ctx.meta.request ?? '(no request text recorded — ask the user)',
      lastDiff: lastDiff(ctx.sessionId, 'brainstorm'),
    };
    return {
      prompt: `${substitute(BRAINSTORM_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}`,
      vars,
      contract: {
        outputFile: path,
        completionEvent: 'brainstorm:approved',
      },
    } satisfies PreparedStep;
  },
  finalize: async () => 'create_ticket',
};

// --- create_ticket (agent, ad-hoc only) -------------------------------------

const CREATE_TICKET_MECHANICS = `Create a ticket for this task in {ticketSystem}.

1. From the brainstorm output \`{brainstorm}\` (or, if none, the user's one-liner: "{request}"), draft a clear title and description (problem, desired outcome, any constraints). Keep it tight.
2. Show the draft and get explicit confirmation before creating anything.
3. Create the ticket: jira → \`acli\`; clickup → the ClickUp MCP; none → propose a local id of the form \`local-<slug>\`.
4. Output the created ticket id as metadata { "ticketId": "..." }. This id becomes the session key. If a ticket was already created for this task (stored id present), reuse it — never create a duplicate.`;

const createTicket: StepDef = {
  name: 'create_ticket',
  phase: 'plan',
  kind: 'agent',
  scope: 'session',
  prepare: async ctx => {
    const draft = join(sessionDir(ctx.sessionId), 'ticket-draft.md');
    const brainstorm = revisionPath(ctx.sessionId, 'brainstorm', 1);
    const vars = {
      ...planVars(ctx),
      brainstorm,
      draft,
      request: ctx.meta.request ?? '',
    };
    return {
      prompt: substitute(CREATE_TICKET_MECHANICS, vars),
      vars,
      contract: {
        outputFile: draft,
        completionEvent: 'create_ticket:done',
        completionMetadataSchema: { ticketId: 'string' },
      },
    } satisfies PreparedStep;
  },
  finalize: async ctx => {
    const newId = ctx.metadata?.ticketId as string | undefined;
    if (newId)
      updateSessionMeta(ctx.sessionId, m => {
        m.ticketId = newId;
      });
    return 'fetch_ticket';
  },
};

// --- fetch_ticket (agent) ----------------------------------------------------

const FETCH_TICKET_MECHANICS = `Fetch ticket {ticketId} from {ticketSystem} and write it to {ticket}.

- jira → use \`acli\` to read the issue; clickup → the ClickUp MCP; none → the ticket.md is the drafted title/description from create_ticket.
- Walk parent/epic links when they exist and include the hierarchy for context.
- Write the full ticket (title, description, parents) to {ticket}. Do not summarize away detail the spec writer will need.`;

const fetchTicket: StepDef = {
  name: 'fetch_ticket',
  phase: 'plan',
  kind: 'agent',
  scope: 'session',
  prepare: async ctx => {
    const vars = planVars(ctx);
    return {
      prompt: substitute(FETCH_TICKET_MECHANICS, vars),
      vars,
      contract: {
        outputFile: ticketPath(ctx.sessionId),
        completionEvent: 'fetch_ticket:done',
      },
    } satisfies PreparedStep;
  },
  finalize: async () => 'triage',
};

// --- triage (interactive) ----------------------------------------------------

const TRIAGE_MECHANICS = `## CRITICAL: Triage Output & Approval Mechanics

### Output File
Write your triage assessment to: {triage}
(This is the working copy for the current epoch under epoch/<E>/triage/.)

The triage document MUST follow this template structure:
{triageTemplate}

### Repo Set & Dependency Order
Triage also decides WHICH repos this task touches and their order:
- Explore candidate repos (spawn Explore subagents for breadth).
- Propose the repo set and dependencies, e.g. "touches \`api\` and \`infra\`; \`infra\` depends on \`api\`'s contract." Confirm with the user.
- All repos must share one org / ticket system — reject cross-org tasks.
The confirmed repo set + dependsOn seed session.json repos[].

### Previous revision diff (if any)
{lastDiff}`;

const triage: StepDef = {
  name: 'triage',
  phase: 'plan',
  kind: 'interactive',
  scope: 'session',
  prepare: async ctx => {
    const { path } = nextRevisionPath(ctx.sessionId, 'triage', {
      epoch: ctx.version,
    });
    const vars = {
      ...planVars(ctx),
      triage: path,
      triageTemplate: ctx.config.templates.triage,
      lastDiff: lastDiff(ctx.sessionId, 'triage', { epoch: ctx.version }),
    };
    const body = getAgentPrompt('phase1', 'triage', vars as Record<string, string>);
    return {
      prompt: `${substitute(TRIAGE_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}\n\n${body}`,
      vars,
      contract: {
        outputFile: path,
        completionEvent: 'triage:approved',
        completionMetadataSchema: {
          complexity: 'straightforward|moderate|complex',
          repos: 'string[]',
          dependsOn: 'object',
          repoPaths: 'object',
        },
      },
    } satisfies PreparedStep;
  },
  finalize: async ctx => {
    const repos = (ctx.metadata?.repos as string[] | undefined) ?? [];
    const dependsOn = (ctx.metadata?.dependsOn as Record<string, string[]> | undefined) ?? {};
    // The harness explored the candidate repos during triage, so it can supply
    // each repo's git root (defaults to the session's primary repo otherwise).
    const repoPaths = (ctx.metadata?.repoPaths as Record<string, string> | undefined) ?? {};
    if (repos.length > 0) {
      updateSessionMeta(ctx.sessionId, m => {
        for (const repo of repos) {
          if (!m.repos.some(r => r.repo === repo)) {
            m.repos.push({
              repo,
              repoPath: repoPaths[repo] ?? m.repoPath,
              worktree: null,
              branch: null,
              plans: [],
              dependsOn: dependsOn[repo] ?? [],
              prNumber: null,
              prUrl: null,
              status: 'pending',
            });
          }
        }
      });
    }
    return 'write_spec';
  },
};

// --- write_spec (interactive) ------------------------------------------------

const SPEC_MECHANICS = `## CRITICAL: Spec Writing & Approval Mechanics

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
  name: 'write_spec',
  phase: 'plan',
  kind: 'interactive',
  scope: 'session',
  prepare: async ctx => {
    const { path } = nextRevisionPath(ctx.sessionId, 'spec', {
      epoch: ctx.version,
    });
    const summaryFile = join(sessionDir(ctx.sessionId), 'tmp', 'spec-review-summary.md');
    const triagePath = latestTriagePath(ctx);
    const vars = {
      ...planVars(ctx),
      spec: path,
      triage: triagePath,
      specTemplate: ctx.config.templates.spec,
      review_summary: existsSync(summaryFile) ? summaryFile : '(none — first draft)',
      lastDiff: lastDiff(ctx.sessionId, 'spec', { epoch: ctx.version }),
    };
    const body = getAgentPrompt('phase1', 'spec_writer', vars as Record<string, string>);
    return {
      prompt: `${substitute(SPEC_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}\n\n${body}`,
      vars,
      contract: {
        outputFile: path,
        completionEvent: 'spec:approved',
      },
    } satisfies PreparedStep;
  },
  finalize: async () => 'spec_review',
};

// --- spec_review (agent fan-out) --------------------------------------------

const specReview: StepDef = {
  name: 'spec_review',
  phase: 'plan',
  kind: 'agent',
  scope: 'session',
  prepare: async ctx => {
    const specPath = latestSpecPath(ctx);
    const triagePath = latestTriagePath(ctx);
    const summaryFile = join(sessionDir(ctx.sessionId), 'tmp', 'spec-review-summary.md');
    mkdirSync(join(sessionDir(ctx.sessionId), 'tmp'), { recursive: true });
    const vars = { ...planVars(ctx), spec: specPath, triage: triagePath };
    const review = buildReview(ctx.config.agents.phase1.spec_reviewers, vars, summaryFile);
    return {
      prompt:
        'Run the spec review fan-out. Spawn each reviewer below as an isolated sub-agent in parallel, ' +
        'synthesize their findings into one numbered problem list, and decide approval. ' +
        'Gate: EVERY reviewer must approve (or the user overrides). Report metadata ' +
        '{ "approved": <bool>, "reviewOverride"?: <bool> }.',
      vars,
      contract: {
        outputFile: summaryFile,
        completionEvent: 'spec_review:done',
        completionMetadataSchema: {
          approved: 'boolean',
          reviewOverride: 'boolean',
        },
      },
      review,
    } satisfies PreparedStep;
  },
  finalize: async ctx => {
    const approved = ctx.metadata?.approved === true || ctx.metadata?.reviewOverride === true;
    return approved ? 'write_plans' : 'write_spec';
  },
};

function latestSpecVersion(ctx: StepContext): number {
  return latestRevisionOnDisk(ctx.sessionId, 'spec', { epoch: ctx.version }) || 1;
}

function latestTriageVersion(ctx: StepContext): number {
  return latestRevisionOnDisk(ctx.sessionId, 'triage', { epoch: ctx.version }) || 1;
}

/** Path of the latest triage revision for the current epoch. */
function latestTriagePath(ctx: StepContext): string {
  return revisionPath(ctx.sessionId, 'triage', latestTriageVersion(ctx), {
    epoch: ctx.version,
  });
}

/** Path of the latest spec revision for the current epoch. */
function latestSpecPath(ctx: StepContext): string {
  return revisionPath(ctx.sessionId, 'spec', latestSpecVersion(ctx), {
    epoch: ctx.version,
  });
}

// --- write_plans (interactive) ----------------------------------------------

const PLAN_MECHANICS = `## CRITICAL: Plan Writing & Approval Mechanics

### Working Copies
Each plan is a FOLDER of versions under the plans directory. Write each plan file to
\`{plans}/<plan-name>/v{version}.md\`, one folder per slice, TAGGED BY REPO:
- {plans}/plan-1/v{version}.md   (repo: <repoA>)
- {plans}/plan-2/v{version}.md   (repo: <repoB>)
Every plan written in THIS round shares the same v{version} (the plan-set version).
Each plan declares which repo it belongs to (front-matter \`repo:\` or a header line).
Plans are vertical, committable slices — the repo tag is an additional axis.
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
  name: 'write_plans',
  phase: 'plan',
  kind: 'interactive',
  scope: 'session',
  prepare: async ctx => {
    const repo = authoringRepo(ctx);
    // Plan-set version M for this epoch+repo (all plan folders share v{M}).
    const version =
      approvedRevisionCount(ctx.sessionId, 'plans', {
        epoch: ctx.version,
        repo,
      }) + 1;
    const plansDir = plansRepoDir(ctx.sessionId, ctx.version, repo);
    mkdirSync(plansDir, { recursive: true });
    const vars = {
      ...planVars(ctx),
      plans: plansDir,
      version: String(version),
      spec: latestSpecPath(ctx),
      triage: latestTriagePath(ctx),
      planTemplate: ctx.config.templates.plan,
      lastDiff: lastDiff(ctx.sessionId, 'plans', { epoch: ctx.version, repo }),
    };
    const body = getAgentPrompt('phase1', 'plan_writer', vars as Record<string, string>);
    return {
      prompt: `${substitute(PLAN_MECHANICS, vars)}\n\n${SHARED_APPROVAL_GATE}\n\n${body}`,
      vars,
      contract: {
        outputFile: plansDir,
        completionEvent: 'plans:approved',
        completionMetadataSchema: {
          escalate: 'amend_spec?',
          reason: 'string?',
        },
      },
    } satisfies PreparedStep;
  },
  finalize: async ctx => {
    if (ctx.metadata?.escalate === 'amend_spec') {
      // amend_spec (plans found the spec wrong) bumps the epoch and re-runs the
      // shared plan phase (SPEC §7.1/§13 #5). write_plans is already session-scoped,
      // so returning "write_spec" re-enters the shared timeline at the new epoch.
      updateSessionMeta(ctx.sessionId, m => {
        m.epoch += 1;
        for (const r of m.repos) r.status = 'pending';
      });
      return 'write_spec';
    }
    return 'plan_review';
  },
};

// --- plan_review (agent fan-out) --------------------------------------------

const planReview: StepDef = {
  name: 'plan_review',
  phase: 'plan',
  kind: 'agent',
  scope: 'session',
  prepare: async ctx => {
    const plansDir = plansRepoDir(ctx.sessionId, ctx.version, authoringRepo(ctx));
    const specPath = latestSpecPath(ctx);
    const summaryFile = join(sessionDir(ctx.sessionId), 'tmp', 'plan-review-summary.md');
    mkdirSync(join(sessionDir(ctx.sessionId), 'tmp'), { recursive: true });
    const vars = { ...planVars(ctx), plans: plansDir, spec: specPath };
    const review = buildReview(ctx.config.agents.phase1.plan_reviewers, vars, summaryFile);
    return {
      prompt:
        'Run the plan review fan-out. Spawn each reviewer below as an isolated sub-agent in parallel, ' +
        'synthesize their findings, and decide approval. Gate: EVERY reviewer must approve ' +
        '(or the user overrides). Report metadata { "approved": <bool>, "reviewOverride"?: <bool> }.',
      vars,
      contract: {
        outputFile: summaryFile,
        completionEvent: 'plan_review:done',
        completionMetadataSchema: {
          approved: 'boolean',
          reviewOverride: 'boolean',
        },
      },
      review,
    } satisfies PreparedStep;
  },
  finalize: async ctx => {
    const approved = ctx.metadata?.approved === true || ctx.metadata?.reviewOverride === true;
    return approved ? 'finalize_plans' : 'write_plans';
  },
};

/** The repo bucket the plan WRITER authors into (delegates to shared). */
function authoringRepo(ctx: StepContext): string {
  return authoringRepoName(ctx.meta);
}

// --- finalize_plans (code) ---------------------------------------------------

const finalizePlans: StepDef = {
  name: 'finalize_plans',
  phase: 'plan',
  kind: 'code',
  scope: 'session',
  run: async ctx => {
    // Partition plans per repo into session.json repos[].plans. The per-epoch
    // `epoch/<E>/plans/<repo>/<plan>/vN.md` tree is the single source of truth —
    // there is no separate frozen snapshot. (Commit happens at repo seed.)
    const plans = latestPlanFiles(ctx.sessionId, ctx.version, authoringRepo(ctx));
    const byRepo: Record<string, string[]> = {};
    for (const { plan, file } of plans) {
      const content = readFileSync(file, 'utf-8');
      const m = content.match(/^repo:\s*(\S+)/m) ?? content.match(/repo:\s*(\S+)/);
      const repo = m?.[1] ?? ctx.meta.repos[0]?.repo ?? 'default';
      byRepo[repo] ??= [];
      byRepo[repo].push(plan);
    }
    const allPlans = plans.map(p => p.plan);
    updateSessionMeta(ctx.sessionId, m => {
      for (const r of m.repos) r.plans = byRepo[r.repo] ?? [];
      // Ensure at least one repo exists for the one-repo flow.
      if (m.repos.length === 0) {
        m.repos.push({
          repo: 'default',
          repoPath: null,
          worktree: null,
          branch: null,
          plans: allPlans,
          dependsOn: [],
          prNumber: null,
          prUrl: null,
          status: 'pending',
        });
      }
    });

    // Plans approved → hand off to the per-repo execution/polish loops, each
    // driven by `kautopilot next --repo <repo>`. The shared timeline waits at
    // `await_repos` until every repo is ready, then runs the feedback phase.
    return 'await_repos';
  },
};

export const PLAN_STEPS: StepDef[] = [
  resolveOrg,
  brainstorm,
  createTicket,
  fetchTicket,
  triage,
  writeSpec,
  specReview,
  writePlans,
  planReview,
  finalizePlans,
];
