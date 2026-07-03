# kautopilot Prompt Set — The Whole Prompt, Per Yielded Step

What `kautopilot next` hands the harness for plan/feedback steps, fully assembled, for
the inverted (host-driven) model. Execution and PR polish are driven by the skill through
`schedule`/`record`, not yielded as binary prompts. Pairs with `CLI-CONTRACT.md` (the
command/JSON surface) and `SPEC-kautopilot.md` (the architecture).

Every prompt = **mechanics** (binary-owned, hard-coded contract) + **configurable
body** (`DEFAULT_CONFIG.agents.*`, per-org overridable) + **resolved vars** (absolute
paths substituted by the binary). `code` steps yield no prompt. The bodies below are
**verbatim** from `src/core/types.ts` / handler constants; the mechanics are shown in
their **describe-mode** form (see the gate adaptation immediately below).

---

## 0. Describe-mode adaptations (what changed from the spawned model)

The legacy mechanics told the TTY agent to self-report approval via
`kautopilot log-event <event>` and then `/exit`. In the inverted model the session
never exits and the **controller** calls `kautopilot complete` after the gate is
satisfied. So three things change uniformly:

1. **No `/exit`, no `log-event`.** The interactive agent debates to approval and stops;
   the controller calls `complete <step> --output <file> [--metadata …]`, which appends
   the canonical `completionEvent`.
2. **Session-store paths** for yielded plan/feedback steps (`~/.kautopilot/<sessionId>/…`,
   versioned under `revisions/`). Execution/PR polish paths are skill-owned and are not
   yielded as binary prompts.
3. **`{rules}` var injected** (each repo's `rules.md`) into triage/spec/plan/implementer
   prompts when present.
4. **Org resolved first** (`--org` → detect-from-ticket → ask: `liftoff`|`atomicloud`);
   the org's `commitSpec` policy gates whether the spec is committed (atomicloud yes,
   liftoff no).

Two scope changes from the redesign, reflected below:

- **No `deliveryKind`.** Every task is build → PR(s); the triage "Delivery Kind"
  field and the entire ticket-delivery path are dropped. Triage now also outputs the
  **repo set + dependency order**.
- **Spec is the master spec** (one, top-level, repo-agnostic); **plans are tagged by
  repo**. "Ready to merge" (CI green + threads resolved) is the finish line — never merge.

### Shared Approval Gate (describe-mode) — referenced by every `interactive` step

```
### Interaction Protocol — STRICT

1. You suggest first. Propose a concrete result — do not open with "what do you want to
   do?" The user hired you to be proactive.
2. Debate with the user. They push back; iterate until you both agree.
3. Confirm the final decision explicitly so there is no ambiguity.
4. Wait for EXPLICIT approval. The user must say "approve" (or a clear equivalent like
   "yes approve this"). "ok", "sounds good", "sure" are NOT approval — ask again.
5. After approval, ensure the output file is written. Then STOP and hand control back —
   the controller finalizes the step (it calls `kautopilot complete`, which records the
   approval event). Do NOT run any kautopilot command yourself.
```

Each interactive step below shows its **step-specific mechanics** (output file, template,
escalation rules) and then `+ Shared Approval Gate`.

---

# PLAN-phase steps — `kautopilot next`

## `resolve_org` — kind: `interactive` (bootstrap)

Pick the org before anything else. Not yielded when `--org` is passed or when the ticket
id determines it; otherwise a one-line ask.

- **contract**: `{ completionEvent: "org:resolved", completionMetadataSchema: { org: "liftoff|atomicloud" } }`
- **prompt**: "Which org is this task for — `liftoff` or `atomicloud`? (Determines the
  ticket system and whether the spec is committed to repos.)"

## `brainstorm` — kind: `interactive` (ad-hoc / no-ticket only)

Shapes a vague request into a concrete problem + direction before a ticket exists. Skipped
when a ticket id is given.

- **contract**: `{ outputFile: <sessionId>/revisions/brainstorm/v{N}.md, completionEvent: "brainstorm:approved", snapshot: { type:"brainstorm", diffAgainstPrevious:true } }`
- **vars**: `{brainstorm}` = `<sessionId>/revisions/brainstorm/v{N}.md`
- **prompt** (mechanics — stolen from `superpowers:brainstorming`):

```
You are brainstorming a raw idea with the user before any ticket or spec exists. Your job
is to turn a vague request into a concrete, agreed problem statement + direction — NOT to
design or implement.

## Explore first
Read the relevant context (repos, docs, recent commits) so your questions are grounded.
Offer a visual aid only if it genuinely helps.

## Ask, don't assume — one question at a time
- Ask ONE clarifying question at a time. Prefer multiple-choice (AskUserQuestion) over
  open-ended — it is faster and easier to answer.
- Focus questions on UNDERSTANDING: the real problem, who it is for, constraints, success
  criteria, what "done" looks like. Do NOT jump to solutions.
- Keep going until the problem is unambiguous.

## Then propose approaches
- Offer 2–3 distinct approaches with explicit trade-offs.
- Lead with a recommendation and the reasoning for why it fits best.

## Converge
- Write the agreed problem statement + chosen direction to {brainstorm} (the working
  copy). This feeds the ticket draft and the later triage/spec.
- HARD GATE: do not proceed until the user explicitly approves the problem + direction.
```

`+ Shared Approval Gate`. Controller: `complete brainstorm --output {brainstorm}`.

## `create_ticket` — kind: `agent` (bootstrap, ad-hoc only)

Yielded only when the task has no ticket id. Runs harness-side via the org's ticket
system (`jira`→acli, `clickup`→MCP, `none`→mint local id). Idempotent via stored-id check.

- **contract**: `{ outputFile: <sessionId>/ticket-draft.md, completionEvent: "create_ticket:done", completionMetadataSchema: { ticketId: "string" } }`
- **prompt** (binary-owned mechanics; no configurable body today):

```
Create a ticket for this task in {ticketSystem}.

1. From the brainstorm output `{brainstorm}` (or, if none, the user's one-liner), draft a
   clear title and a description (problem, desired outcome, any constraints). Keep it tight.
2. Show the draft and get explicit confirmation before creating anything.
3. Create the ticket: jira → `acli`; clickup → the ClickUp MCP; none → propose a local
   id of the form `local-<slug>`.
4. Output the created ticket id as metadata { "ticketId": "..." }. This id becomes the
   session key. If a ticket was already created for this task (stored id present), reuse it
   — never create a duplicate.
```

`+ Shared Approval Gate` (confirm before creating).

## `fetch_ticket` — kind: `agent`

- **contract**: `{ outputFile: <sessionId>/ticket.md, completionEvent: "fetch_ticket:done" }`
- **prompt** (binary-owned mechanics):

```
Fetch ticket {ticketId} from {ticketSystem} and write it to {ticket}.

- jira → use `acli` to read the issue; clickup → the ClickUp MCP; none → the ticket.md
  is the drafted title/description from create_ticket.
- Walk parent/epic links when they exist and include the hierarchy for context.
- Write the full ticket (title, description, parents) to {ticket}. Do not summarize away
  detail the spec writer will need.
```

- **vars**: `{ticketId}`, `{ticket}` = `<sessionId>/ticket.md`, `{ticketSystem}`

## `triage` — kind: `interactive`

Mechanics (describe-mode; derived from `TRIAGE_MECHANICS` + `TRIAGE_APPROVAL_GATE`,
with delivery-kind removed and repo-set added):

```
## CRITICAL: Triage Output & Approval Mechanics

### Output File
Write your triage assessment to: {triage}
(This is the session-level working copy under revisions/. Do not write it under an epoch directory.)

The triage document MUST follow this template structure:
{triageTemplate}

### Repo Set & Dependency Order
Triage also decides WHICH repos this task touches and their order:
- Explore candidate repos (spawn Explore subagents for breadth).
- Propose the repo set and dependencies, e.g. "touches `api` and `infra`; `infra`
  depends on `api`'s contract." Confirm with the user.
- All repos must share one org / ticket system — reject cross-org tasks.
The confirmed repo set + dependsOn seed `session.json.repos[]`.
```

`+ Shared Approval Gate`. On approval the controller calls
`complete triage --output {triage} --metadata '{"complexity":"…","repos":[…],"dependsOn":{…}}'`.

- **contract**: `{ outputFile: <sessionId>/revisions/triage/v{N}.md, completionEvent: "triage:approved", completionMetadataSchema: { complexity: "straightforward|moderate|complex", repos: "string[]", dependsOn: "object" }, snapshot: { type: "triage", diffAgainstPrevious: true } }`
- **vars**: `{ticket}`, `{triage}`, `{specDir}`, `{triageTemplate}`, `{rules}`
- **configurable body** (`agents.phase1.triage`, verbatim):

```
You are triaging a ticket for kautopilot. Read the ticket at {ticket} and do **thorough** codebase exploration to assess scope and risk.

Your job is to classify this ticket, NOT to solve it or write implementation details.

## Research Before Assessing

Do NOT guess at risk or complexity. Before writing your assessment:
- **Read the relevant code** — find the files that will be touched, understand the current implementation
- **Trace dependencies** — grep for usages of functions/types/configs being changed; understand blast radius
- **Check for tests** — are there existing tests covering the affected code? Will they break?
- **Look at recent changes** — git log the affected files to understand velocity and stability
- **Identify shared state** — does this touch database schemas, API contracts, shared configs, or public interfaces?

## Evaluate (with evidence)

For each evaluation point, cite specific files, functions, or patterns you found:
- **Complexity** — how many moving parts, how many files likely touched. Name the files.
- **Parallelizability** — can this be split into independent streams of work
- **Risk factors** — blast radius, backward compatibility, data migration. Be specific: "changing X in file Y affects Z callers"
- **Manual work** — infra changes, config deployments, manual verification needed
- **Known/unknown ratio** — is the approach clear or does it need research first
- **Disambiguate with user** — if the ticket is vague or under-specified, firm it up through conversation. If you are unsure about the risk level, ASK the user for input rather than defaulting to low risk.

## Risk Assessment Guidelines

Default to **moderate** risk unless you have concrete evidence otherwise:
- **Low risk**: Only if the change is truly isolated (single file, no callers, has test coverage, no shared state)
- **Moderate risk**: Multiple files, some callers, or any shared state involved
- **High risk**: Database/API changes, many callers, no test coverage, or unclear requirements

Err on the side of caution. It is much better to overestimate risk than to underestimate it.

## Verification

Your job is to IDENTIFY what needs verifying — not to do the verification yourself.
The spec and plan phases will perform the actual checks.

**Assumptions** — What does this task take for granted that could be wrong? ... (full
section retained — list each assumption + a source that could confirm/deny it.)

**Access** — If verifying any assumption requires access the user hasn't granted, request it here.

**Testing level** — Set the bar based on blast radius and behavioral impact.

**Validation matrix** — Always push toward automated-immediate. ...

## User Approval

After writing your triage assessment to the file, present a clear summary to the user showing:
1. The complexity you chose
2. The repo set + dependency order
3. Key risks identified (or why you believe risk is low)
Ask the user to confirm before approval. Do NOT auto-approve.
```

> Body retained verbatim except: the original opened the assessment with a "Delivery
> Kind (pr|ticket)" classification — **removed** (every task is a PR). The
> approval-summary now lists complexity + repo set instead of delivery kind.

## `write_spec` — kind: `interactive`

Mechanics (describe-mode; from `SPEC_MECHANICS` + `SPEC_APPROVAL_PROTOCOL`, snapshot via
`complete` not manual):

```
## CRITICAL: Spec Writing & Approval Mechanics

### Working Copy
Write the master spec to: {spec}
This is the ONLY spec file you edit. On each feedback round edit it in-place — the
controller snapshots it (and shows the user a diff) when it finalizes the round. Each
version MUST be a complete, standalone spec (NOT a changelog/diff). Follow this template:
{specTemplate}

This is the ONE master spec for the whole task — repo-agnostic. Cross-repo intent is
useful context; the per-repo split happens in plans, not here.

### Previous Epoch Feedback
{feedback_reference}
```

`+ Shared Approval Gate`. Controller: `complete write_spec --output {spec}`.

- **contract**: `{ outputFile: <sessionId>/revisions/spec/v{N}.md, completionEvent: "spec:approved", snapshot: { type:"spec", diffAgainstPrevious:true } }`
- **vars**: `{ticket}`, `{triage}`, `{spec}`, `{specDir}`, `{specTemplate}`, `{feedback_reference}`, `{rules}`
- **configurable body** (`agents.phase1.spec_writer`, verbatim):

```
You are writing a spec for a kautopilot task. Read the ticket at {ticket} and the triage assessment at {triage}.

Based on the triage assessment:
- **If triage says "straightforward"**: write a focused, concise spec. No heavy debate. Cover what to change, acceptance criteria, and proof of completion.
- **If triage says "moderate" or "complex"**: do thorough exploration and debate. Walk through requirements, identify hidden assumptions, conflicts, and risks. Clarify until nothing is ambiguous.

Explore the codebase to ground your spec in reality. Reference actual files, functions, and patterns.

## Verification

Check the triage at {triage} for its verification section. If it lists assumptions to verify,
you MUST verify each one before writing the spec. Read docs, query live systems, inspect
package versions — whatever it takes. Cite evidence for each confirmed assumption. Flag
unverifiable ones as "UNVERIFIED: [assumption] — [reason]".

If the triage requested access, use it now to check actual state.

Ground every claim in evidence. No hypotheticals.

## Non-Functional Checklist

You MUST evaluate every item in the non-functional checklist from the spec template. For each:
decide if it applies, state why or why not, and describe the concrete requirement if it does.
Then add any domain-specific items the checklist missed. Do not skip any item.
```

> The original "If delivery kind is 'ticket': spec the research…" branch is **removed**.

## Spec review — kind: `agent` (fan-out gate, all must approve)

Descriptor carries `review: { reviewers: [...8...], synthesize: {...}, gate: "all_approve" }`.
Controller spawns reviewers in parallel, runs synthesize, feeds the numbered list back
into `write_spec`. Withhold `complete` on the writer until every reviewer approves
(or `--metadata '{"reviewOverride":true}'`).

The 8 spec reviewer bodies (`agents.phase1.spec_reviewers.*`) and the synthesizer are in
**Appendix A** (verbatim). Each reviewer outputs one problem per line or "No issues found."

## `write_plans` — kind: `interactive`

Mechanics (describe-mode; from `PLAN_MECHANICS` + `PLAN_APPROVAL_PROTOCOL`, **plans
tagged by repo**, amendment escalation retained):

```
## CRITICAL: Plan Writing & Approval Mechanics

### Working Copies
Write plan files in the plans directory, one per slice, TAGGED BY REPO:
- {plans}/plan-1.md   (repo: <repoA>)
- {plans}/plan-2.md   (repo: <repoB>)
Each plan declares which repo it belongs to (front-matter `repo:` or a header line).
Plans are still vertical, committable slices — the repo tag is an additional axis.
Each version MUST be a complete, standalone set. Follow this template:
{planTemplate}

### Previous Epoch Feedback
{feedback_reference}

### Previous Epoch Plans (for reference only)
{previous_epoch_plans_reference}

### Spec Amendment Escalation
If during plan writing you discover the master spec is wrong or incomplete:
1. Explain what's wrong and why plans can't proceed.
2. Debate until the user agrees the spec needs amendment.
3. After explicit approval, STOP — tell the controller this is a `spec_amendment`
   (it records `spec_amendment:requested` with your reason and re-runs write_spec at a
   bumped version). Do NOT approve plans when escalating.
```

`+ Shared Approval Gate`. Controller: `complete write_plans --output {plans}` (or, on
escalation, `complete write_plans --metadata '{"escalate":"amend_spec","reason":"…"}'`).

- **contract**: `{ outputFile: <sessionId>/revisions/plans/<repo>/v{N}/, completionEvent: "plans:approved", snapshot: { type:"plans", diffAgainstPrevious:true } }`
- **vars**: `{spec}`, `{triage}`, `{plans}`, `{planTemplate}`, `{feedback_reference}`, `{previous_epoch_plans_reference}`, `{rules}`
- **configurable body** (`agents.phase1.plan_writer`, verbatim):

```
You are writing implementation plans for a kautopilot task. Read the spec at {spec} and the triage assessment at {triage}.

Rules:
- Plans must be vertically split (by domain/feature, not by layer)
- Each plan is one isolated, committable unit of work
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
as specified, flag it — do not silently drop it.
```

> The original `ticket`-delivery plan branch is **removed**.

## Plan review — kind: `agent` (fan-out gate)

Same shape as spec review. 5 plan reviewer bodies (`agents.phase1.plan_reviewers.*`) +
synthesizer in **Appendix A**.

## `finalize_plans` — kind: `code` (never yielded)

Snapshots the approved master spec + per-repo plans into the session store and records
the plan→repo partition in `session.json.repos[].plans`. No git commit here; the per-repo
first commit is skill-owned when a ready plan creates/locates its repo worktree. Emits
`finalize_plans:done`.

---

# Execution + PR polish prompts — owned by the skill

The old repo-scoped binary step machine (repo worktree setup, execution, commit, PR polish,
CodeRabbit/eval/write_fix loops) has been removed. After the plan phase, the binary
only exposes the DAG frontier through `kautopilot schedule` and records lifecycle
transitions through `kautopilot record`.

The skill/controller owns worktree setup, kloop or subagent execution, commits, PR
opening, CodeRabbit/CI review-thread polish, and merge/release observation. Fresh
agent contexts are started by the harness as native subagents; the binary no longer
yields repo-scoped prompts for those phases.

# Appendix A — Reviewer & summarizer bodies (verbatim)

**Spec reviewers** (`agents.phase1.spec_reviewers.*`), each ends with: "Output ONLY the
problems found — one per line. If none, output 'No issues found.'"

- `completeness` — "Read the spec at {spec} and the ticket at {ticket}. Check: does the spec address every requirement in the ticket? List any requirements that are missing or insufficiently addressed."
- `docs_accuracy` — "…are all referenced tool versions, API interfaces, and method signatures accurate? Cross-reference with the codebase — grep for referenced functions, check package versions. Flag anything that looks hallucinated or version-incorrect."
- `generalization` — "…does the spec propose new patterns, paths, or abstractions when existing ones could be extended? Flag any 'reinventing the wheel'…"
- `complexity` — "…is the proposed approach unnecessarily complex? Could fewer files be changed? Could an existing tool/command handle this? … only flag when there's a clearly simpler alternative."
- `security` — "Check for security concerns: injection risks, auth/authz gaps, secrets handling, data exposure, OWASP top 10. Only flag genuine issues…"
- `proof_of_completion` — "…does the spec include an 'Acceptance Criteria' section with concrete, testable criteria? Good: test commands, API calls, grep assertions… Bad: 'manually verify', vague assertions…"
- `nonfunctional_checklist` — "…has every item in the non-functional checklist been evaluated? The checklist has 12 standard items (linting, building, unit/integration/E2E testing, documentation, observability, invariant checking, security, performance, backwards compatibility, accessibility). … Flag any items missing/skipped…"
- `verification_evidence` — "Read the spec at {spec} and the triage at {triage}. … does the spec provide verification evidence for each [assumption]? Evidence must include a concrete source… Flag any 'UNVERIFIED' items and assess whether they are blocking."

**Plan reviewers** (`agents.phase1.plan_reviewers.*`), same output convention:

- `coverage` — "…do the plans together cover every requirement in the spec? List any spec items not addressed by any plan."
- `ordering` — "…are plans ordered so that earlier plans don't depend on later ones? Flag any circular or incorrect dependency ordering."
- `vertical_split` — "…are plans split vertically by domain/feature (each plan = complete slice with types+logic+tests)? Flag any horizontal layer ('add types'/'write tests' as standalone plans)."
- `cost` — "…are there cost implications (compute, storage, API calls, third-party services)? Flag any plans with unexpected cost impact…"
- `spec_adherence` — "…is every functional requirement addressed by at least one plan? Every applicable non-functional requirement? List uncovered requirements. List scope creep. Flag drift with the specific spec requirement and conflicting plan content."

**Review summarizer** (`src/core/review-runner.ts`, verbatim):

```
You are a review summarizer. Below are the outputs from multiple independent reviewers analyzing the same document.

Your job:
1. Merge all findings into ONE concise, deduplicated problem list
2. Remove duplicate or overlapping issues
3. Number each unique problem
4. Be concise — one line per problem, no preamble

Reviewer outputs:

${summaryInput}

Output ONLY the numbered problem list. If no real issues, output "No issues found."
```

---

# Appendix B — kloop prompt bundle (`DEFAULT_CONFIG.kloop.prompts`, verbatim)

These seed kloop runs owned by the skill/controller. The full verbatim bodies are large
and unchanged from `src/core/types.ts`:

- `implementer` (`DEFAULT_KLOOP_IMPLEMENTER_PROMPT`, types.ts 28–85)
- `reviewer` (`DEFAULT_KLOOP_REVIEWER_PROMPT`, 87–153)
- `checkpointer` (`DEFAULT_KLOOP_CHECKPOINTER_PROMPT`, 155–254)
- `checkpointerFull` (`DEFAULT_KLOOP_CHECKPOINTER_FULL_PROMPT`, 256–353)
- `synthesizer` (`DEFAULT_KLOOP_SYNTHESIZER_PROMPT`, 355–423)
- `verifier` (`DEFAULT_KLOOP_VERIFIER_PROMPT`, 425–476)
- `reSynthesizer` (`DEFAULT_KLOOP_RE_SYNTHESIS_PROMPT`, 478–539)

Vars: `{specPath}`, `{iteration}`, `{loop}`, `{reviewsDir}`, `{reviewSummaryPath}`,
`{learningsFile}`, `{scratchDir}`, `{evidenceDir}`, `{verdictsDir}`, `{verifyDir}`,
`{reviewerIndex}`, `{verifierIndex}`, `{previousSummaryPath}`, `{archivedReviewsPattern}`,
`{archivedSummariesPattern}`. Each enforces the same evidence protocol (all evidence —
Type-1 captured command output and Type-2 diff pointers — lands in `{evidenceDir}/`, indexed
by `self-review.md`; no sidecar) and Git-Safety block. The skill-owned plan driver runs
`kloop init` and lets kloop use its own native prompts (`kloop-ts/src/agents/default-prompts.ts`);
the kautopilot binary does not inject these, so they are not reproduced here.

---

# Appendix C — `generic.commit` (verbatim)

Shared by skill-owned commit subagents. `{context}` varies per caller.

```
You are committing code changes in a repository. Your task:

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

{context}
```

---

# Appendix D — Templates (verbatim)

`DEFAULT_TRIAGE_TEMPLATE` (note: the "Delivery Kind" section is dropped in the redesign;
a "Repo Set & Dependency Order" section is added), `DEFAULT_SPEC_TEMPLATE`,
`DEFAULT_PLAN_TEMPLATE` — all in `src/core/types.ts` (647–822) and injected via the
`{triageTemplate}` / `{specTemplate}` / `{planTemplate}` vars. Reproduced verbatim in
`PROMPT-CATALOG.md` / types.ts; they move with the binary unchanged except the triage
template's delivery-kind field.
