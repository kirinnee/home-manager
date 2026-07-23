# Spec: kautopilot — Host-Driven Controller, One Flat Session

The unified design for the next kautopilot: the **binary owns codified state /
replay / dispatch / detection / all prompts (0 tokens)**, and **Claude — or any
harness that can shell out and talk to a user — drives a thin controller loop and runs
the actual step work**, in-session, with no `claude -p`.

kautopilot is **one flat top-level entity** — a **session**, keyed by a ticket. A
session can span **one or more repositories**, but repos are a _detail_, not a separate
concept: there is no "group" and no "member session." Per-repo work (implement a plan,
open a PR) runs under the same one loop as mechanical `sub-agent` or `kloop` jobs that
can be **parallel-ordered**; anything that needs the user is **queued and resolved
serially in the main chat**.

Companion docs: `CLI-CONTRACT.md` (command + JSON surface) and `PROMPT-SET.md` (the
fully-assembled prompt each step yields). Where prose here and §13 differ, **§13 governs**.

## 1. Problem

Today kautopilot _pushes_ LLM work: `runStateMachine` → handler → `spawnPrint` /
`spawnTTY` spawns a headless `claude --print` or interactive `claude` TTY for every
step. Consequences:

- Every step is a fresh `claude -p` subprocess — no shared context, full per-step
  startup, high token cost. Only the binary can drive the loop.
- A parallel Claude-Code **skill** had to _re-implement_ the state machine, resume
  logic, and dispatch in markdown — duplicating tested binary logic, spending tokens.
- The flow is implicitly single-repo; multi-repo has no story.
- A heavy dynamic `init` machine researches/generates ticket-system adapter scripts per
  repo — brittle, when the real world is just two orgs with Jira/ClickUp.
- Token-heavy non-interactive work runs in the orchestration context, degrading it.

## 2. Goals

1. **Invert control.** The binary yields step descriptors; the harness runs them
   in-session and reports back. No `claude -p` / TTY spawns from the binary.
2. **Codify deterministic state.** State machine, replay, WAL, versioning/epochs,
   snapshot validation, artifact paths, and prompt config + org overrides stay in the
   binary at zero token cost. Execution and PR polish actions are skill-owned through
   `schedule`/`record`.
3. **One flat session; repos are details.** No group/member two-level model. A session
   is a ticket; it may touch N repos; each repo's implement/PR loop is a mechanical
   `sub-agent`/`kloop` job under the same loop. Parallel ordering allowed.
4. **Judgment + interaction in the controller.** Triage debate, spec/plan approval,
   resolve, feedback — live in the skill/harness. Interactive work is **queued and
   serialized to the one user**, even while repos progress in parallel on mechanical work.
5. **Isolate token-heavy work.** Every non-interactive `agent` step (reviewers, commit,
   eval, drafting, per-repo implement-as-subagent) runs as a fresh isolated subagent so
   it never pollutes the controller's context.
6. **No dynamic ticket-system discovery; always ask the org.** The org is **always
   asked**, never auto-detected — `liftoff` or `atomicloud`. The org's config fixes the
   ticket system (`jira` | `clickup` | `none`). The dynamic `init` phase is removed.

## 3. Architecture

```
CONTROLLER  (Claude — thin loop; judgment + interaction; no codified state)
│   loop: d = `kautopilot next --json`
│         if d.done: report; break
│         if d.kind == interactive: run inline, converse to approval  ← queued, serial
│         else (agent):             run as an isolated sub-agent
│         `kautopilot complete <step> --output … [--metadata …]`
│
│   ONE flat session (= ticket). Phases run in order; the skill drives plans/PR polish:
│     plan:       triage → spec → plans(per repo)         (interactive, versioned artifacts)
│     execution:  schedule/record frontier: run plans, PR polish, merge/release gates
│     feedback:   optional evolution phase → per-repo rules.md → next epoch (same PR)
▼
BINARY  (codified, zero tokens — one session, one WAL)
   next (BLOCKS on detection/watch) · complete · diff · runStateMachine resume · WAL ·
   snapshots/versioning/epochs · artifact paths · prompt config + org overrides ·
   orchestration/schedule/record state
```

## 4. Core concepts (keep distinct)

| Concept     | What it is                                                               | Lifetime / store                                             |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Session** | the whole task — one ticket, top-level. Holds WAL, status, repos[], all. | `~/.kautopilot/<sessionId>/` (global; never committed)       |
| **Epoch**   | one delivery cycle: ticket → all PRs ready to merge. Bumped on revisit.  | committed `v{N}` dir per repo: `spec/<ticketId>/v{N}/`       |
| **Version** | one revision of a working artifact (triage/spec/plan/feedback).          | `revisions/` in the session store; diffable; **uncommitted** |
| **Repo**    | a detail of the session: one `(worktree, branch, plans[], PR, status)`.  | tracked in `session.json` `repos[]`; not a separate session  |

- **Epoch ≠ Version.** Epoch = the whole ticket→ready-PRs cycle (`v1`, `v2`, …).
  Version = one iteration of one artifact while the user is still approving it. Only the
  **final approved** version is committed (triage/spec/plans into repos; feedback distilled
  into per-repo `rules.md`).
- **Epochs share the branch + PR.** Epoch 1 opens each repo's branch + PR; **epochs 2+
  continue on the same branch + PR** (fresh commit per epoch, updated PR) — never a new
  PR. Worktree cleanup is skill-owned after the binary session is done.
- **Repo is not a concept of its own** — no per-repo session/WAL. The one session tracks
  every repo's worktree/branch/plans/PR/status in `session.json`.

## 5. The contract: `next` / `complete`

One protocol, one session. (Full JSON in `CLI-CONTRACT.md`.)

### `kautopilot next [--json]`

Resolves the session, runs resume/dispatch (`ensureStatus` replay over the WAL),
**auto-executes every `code` step inline — including blocking detection/watch loops**,
and stops at the first `interactive` or `agent` step, printing a **StepDescriptor**.

```jsonc
{ "done": false, "sessionId": "…", "ticketId": "PE-1234",
  "phase": "plan", "step": "write_spec", "kind": "interactive",
  "repo": null,                    // repo-scoped yielded steps were removed
  "version": 2,
  "prompt": "…fully-resolved mechanics + configurable body…",
  "vars": { "ticket":"…", "triage":"…", "spec":"…", "plans":"…", "rules":"…", "worktree":"…" },
  "contract": { "outputFile":"…", "completionEvent":"resolve:approved",
                "completionMetadataSchema": {…}, "snapshot": { "type":"…", "diffAgainstPrevious":true } },
  "review": null }                 // present only on review fan-out steps
```

**`next` BLOCKS; there is no `pending`.** When the binary is watching the world (CI
running, threads unresolved), `next` runs its internal poll loop and blocks; it returns
only a **StepDescriptor** or **`{ "done": true, … }`**. Killing a blocked `next` and
re-calling it resumes the same wait (the WAL is unchanged). `next` is idempotent — it
yields the same descriptor until the step's `completionEvent` is logged. **This is the
resume story.**

**Driving the execution DAG.** Bare `kautopilot next` advances shared phases and hands
approved master-plan execution to `schedule`/`record`. The controller runs bounded ready
plans from `schedule.ready[]`, opens or continues PRs from `schedule.toPolish[]`, and
merges only scheduled ready PRs from `schedule.toMerge[]`. Repo-scoped `next` has been
removed; execution is only `schedule`/`record`.

`kind` ∈:

- **`code`** — deterministic plumbing + all detection. **Never yielded**; the binary
  runs it (and blocks on watch loops) and moves on.
- **`interactive`** — needs the user (brainstorm, create_ticket, triage, spec, master
  plan, plans, feedback_check, feedback). Run **inline**; serialized to the user (§7.2).
- **`agent`** — needs an LLM, not the user (create_ticket, fetch_ticket, reviewers).
  Execution, commit, PR creation, and review polish are run by the skill through native
  subagents and recorded with `schedule`/`record`.

### `kautopilot complete <step> [--output <path>] [--metadata <json>]`

Validates the step is the pending one, validates the contract (output file exists; the
written file is the source of truth; `--metadata` must match the parsed file and any
`completionMetadataSchema`), runs the step's `finalize` (parse → set context → persist →
snapshot/diff), appends the canonical `completionEvent`, prints `{ "ok": true }`. The
next `next` advances. Approval gates stay the harness's responsibility — the binary
enforces _artifact presence_, not consent.

## 6. Run mode & execution mode

- **Run mode** — where the controller loop runs: `current-session` (default) |
  `sub-agent` (a sub-agent **inside this same Claude** drives the loop; not a detached
  Claude — there is no separate-Claude / `claude -p` path).
- **Execution mode** — how the skill-owned plan driver implements a ready plan:
  `kloop` (default — multi-reviewer consensus loop) | direct isolated subagent
  (lighter, for straightforward plans). The binary does not yield a `running` step; it
  records `started`/`implemented`/`failed`.
- **Parallelism** — `maxParallelRepos` (default small, e.g. 2): at most N ready-plan
  drivers from `schedule.ready[]` run concurrently; the rest queue. Plans in different PRs
  can run at the same time when their gates are satisfied. Per-invocation override.
- **Writer mode** — how interactive writer steps execute: `inline` (default —
  the main harness session thinks/drafts itself) | `deferred` (the step is
  relayed to a separate, resumable **writer session** on a fleet account via
  `kautopilot relay`; the main session only presents summary + questions +
  links per turn). Pinned per session at `start --writer …`; staged per step via
  `config.writer.steps`. Full design: `specs/deferred-writer-relay.md`;
  command surface: CLI-CONTRACT §5d. (The "no `claude -p` from the binary" rule
  still holds — the writer session is a persistent **kteamd** session, `kteam
  start`/`send`-driven, kloop-style, never `--print`. kteamd owns the TUI,
  resume/crash-recovery, and account failover.)

## 7. Phases (one flat machine)

### 7.1 plan (interactive; versioned artifacts) — runs once, repo-agnostic for spec

`resolve_org → [brainstorm? → create_ticket?] → fetch_ticket → triage → spec → master_plan → plans`

- **resolve_org** (bootstrap): pick the org (`liftoff` | `atomicloud`) by precedence —
  `--org` arg → else **detect from the ticket** when a ticket id is passed (its
  tracker/project maps to an org) → else **ask** the user. Never auto-detect from the
  repo/environment. The org's config fixes the ticket system, **commit-spec policy**, and
  prompt overrides.
- **brainstorm** (interactive, **ad-hoc/no-ticket only**): shape the raw idea into a
  concrete problem + direction _before_ a ticket exists. Methodology (from
  `superpowers:brainstorming`): explore context first; ask clarifying questions **one at
  a time, multiple-choice preferred**, focused on understanding — purpose, constraints,
  success criteria — and **do not jump to solutions**; then propose **2–3 approaches with
  trade-offs**, leading with a recommendation; converge on an agreed problem statement +
  direction. Output `brainstorm.md`, which seeds `create_ticket` and is available to
  triage/spec. Versioned artifact. **Skipped when a ticket is given.**
- **create_ticket** (agent, ad-hoc only): if no ticket id, draft title/description from
  the **brainstorm output** (or, if none, the user's one-liner), confirm, create it in the
  org's tracker (`jira`→acli, `clickup`→MCP, `none`→mint a local id). The id becomes the
  session key. Idempotent.
- **fetch_ticket** (agent): read the ticket (+ parents) → `ticket.md` (epoch-agnostic).
- **triage** (interactive): assess scope/risk **and decide the repo set + ordering**
  (explore candidates via `Explore` subagents; confirm with the user; all repos must be
  the asked org). Repo set + `dependsOn` seed `session.json.repos[]`. Versioned artifact.
- **spec** (interactive): one **master spec** — top-level, repo-agnostic. Versioned.
  Followed by **spec review** (agent fan-out; every reviewer must approve, §7.4).
- **master_plan** (interactive): the **orchestration layer**, approved **before** the
  per-repo plans so the order of execution is locked first. It lays out (a) the **PR/branch
  layout** — each PR with its repo, branch, title, and the plans it ships (a repo may open
  **several PRs on several branches**); (b) the **dependency DAG with gate levels** — each
  edge gates a downstream plan on an upstream reaching `completed` | `merged` | `released`
  (edges may span repos); and (c) a **mermaid graph** for the dashboard. Versioned artifact.
  On approval the binary freezes it into `orchestration.yaml` (§5b / §11) — the resumable
  record that also tracks each plan's exec status + kloop run. See §7.5 for how gates are
  enforced and §13 #22 for the merge policy.
- **plans** (interactive): the per-repo plan bodies, written for the master plan's agreed
  `plan-<N>` nodes, **tagged by repo**, still vertical slices. Versioned. Followed by
  **plan review**.

Each of triage/spec/plans is an interactive debate producing **multiple versions**
(§8). Escalation `amend_spec` (plans found the spec wrong) bumps the epoch and re-runs
spec.

### 7.1a phase-set model — independently selectable phases

The four plan-shaping phases — **brainstorm, triage, spec, plan** — are
**independently selectable**. A session pins a **`phases`** set (`session.json.phases`,
canonical order, validated: unique + ordered + **always includes `plan`**). Any subset
of the earlier phases may be included; they always run in canonical order, and an
**omitted phase is skipped ENTIRELY** — its step never runs, so no empty placeholder
artifact is created. **`plan` is mandatory**: every run ends in a plan artifact then
implementation.

- **`[plan]` alone is the "fast" shape.** `resolve_org → plan_only → finalize_plans →
  await_repos`. **plan_only** (interactive) collapses brainstorm ⨝ triage ⨝ ticket ⨝
  spec ⨝ master_plan ⨝ plans into **ONE artifact**: it captures & **confirms** the
  user's intent (the clarifying-question guardrail is never skipped), decides the
  **single repo + path**, then writes **one document — the plan** (titled as the plan,
  folding problem/scope/goals/implementation) as `plan-1`. On approval it registers
  exactly one repo and freezes a **single-PR, single-plan** `orchestration.yaml` by
  construction — the fast shape produces **exactly one PR**. It maps to the `plans`
  artifact kind, so `revise` and the deferred-writer relay work unchanged (**composes
  with deferred-writer mode**: the single plan is the deferred artifact).
- **Any larger set** routes through the normal timeline, skipping the omitted phases:
  the first included phase does the intent capture, and the `plan` phase keeps the full
  `write_master_plan → write_plans` orchestration (multi-PR capable). When an earlier
  doc is absent (its phase was skipped), the downstream step's `{triage}`/`{spec}`
  placeholder resolves to a note pointing at the ticket/request.

**Phase resolution at `start`** (pinned, never re-read mid-session): an explicit
`--phases <list>` (validated, normalized, `plan` forced in) → else a **keyword-heuristic
proposal** from the request (config-driven `settings.phases.keywords`; word-boundary,
case-insensitive): `small|simple|quick|fast → [plan]`, `big|long|dangerous|risky → all
four`, `unsure|discuss|brainstorm|explore|"bounce ideas" → include brainstorm` → else
`settings.phases.default`. The proposal carries a **confidence** scored against
`settings.phases.confidenceThreshold`: high → **propose** the set and continue; low →
**ask** a few clarifying questions first. Either way the chosen set is echoed and always
overridable, and intent capture + user confirmation stay mandatory in every shape.

### 7.2 execution (DAG plans, PR waves; interaction queued serially)

When plans are approved, bare `next` hands execution to the controller as a DAG frontier.
The controller calls `schedule`, runs pending plans from `ready[]`, records each lifecycle
transition, opens/continues PRs from `toPolish[]`, and merges only scheduled PRs from
`toMerge[]` under `mergeMode`.

For each ready plan, the controller creates or locates a **worktrunk worktree** for that repo
(via `wt`, the same mechanism `/rc-session` uses), then spawns a subagent to run kloop for
that one plan. Ready plans are dispatched in parallel up to `maxParallelRepos`; plans in
different PRs can run concurrently when their gates are satisfied.

- The controller records `started`, `implemented`, or `failed` with `kautopilot record`.
- Any genuine human decision is queued back to the main chat; no two interactive prompts
  compete.
- **Who commits — only the dedicated commit subagent.** The **main controller agent never
  commits**, and **kloop never commits** (it implements/reviews only). After kloop succeeds,
  the isolated commit subagent commits, then the controller records `implemented`.

### 7.3 polish (PR-scoped → ready-to-merge)

In the DAG model, polish is **per PR**, not per repo or per plan. A PR enters polish once
every plan assigned to that PrPlan is implemented. `schedule` reports that frontier as
`toPolish[]`: `pending` means open the PR and record `pr-opened`; `open` means continue the
CodeRabbit/CI/review-thread loop. When CI is green and all actionable review threads are
resolved, record `pr-ready`. The PR is never listed in `toMerge` before that point.

The binary no longer owns a repo-scoped polish step machine. The skill/controller opens
or continues each PR from `toPolish[]`, handles CI and CodeRabbit/human review threads,
and records `pr-ready` only after CI is green and all actionable conversations are
resolved. **Ready-to-merge** excludes human-review approval. Merge/release happens only
after `pr-ready`, and only when `schedule.toMerge[]` asks for that PR/gate.

### 7.4 Review fan-out (spec & plans)

A review step's descriptor carries the **set** of reviewer prompts (8 spec / 5 plan) +
a **synthesize** prompt. The controller spawns reviewers as parallel isolated
sub-agents, runs synthesize into one numbered problem list, feeds it back into the
interactive writer. **Gate: every reviewer must approve** (harness-enforced — withhold
`complete` on the writer) unless the user explicitly overrides.

### 7.5 Epoch end + cross-repo gate enforcement

- The epoch **can advance to feedback only when no ready/running/polish work and no
  scheduled merge/release remains.** Ready-to-merge (CI green + threads resolved, human
  approval excluded) is the floor before any PR can enter `toMerge`.
- **Cross-repo merge/release gating (master plan).** When the master plan's DAG has
  `merged`/`released` edges, a downstream plan is **not driven** until its upstream PRs
  reach the required gate. The skill/controller observes merge/release state, records each
  transition, and only then the scheduler exposes downstream work. Plan progress
  (`pr_open → pr_ready → merged → released`) and PR lifecycle progress
  (`open → ready → merged → released`) are tracked in `orchestration.yaml`.
- **Merge policy `mergeMode` (per session, §13 #22).** `manual` | `auto`, set at `start`
  (`--merge`) and confirmable in the master plan. Either way the PR reaches ready-to-merge
  first; then `auto` lets the controller merge scheduled ready PRs while `manual` leaves the
  merge to the user (the skill asks/waits). A `released` gate waits for the upstream repo's
  semantic releaser to publish its newest release with all release CI/CD green when a releaser
  is configured; without a releaser, the merged PR is the release boundary.
- **feedback_check** (interactive gate): ask the user — feedback, or done?
  - **No feedback** → ask whether the PRs are **fully merged**. If the user confirms
  **"done,"** the binary session ends. Ticket close and worktree cleanup are skill-owned
    follow-up actions, not `next`-yielded steps.
  - **Has feedback** → enter the **feedback / evolution phase** (§7.6).

### 7.6 feedback / evolution (a full phase — only when there is feedback)

A first-class phase that runs the evolution loop, then rolls into the next epoch:

1. **feedback** (interactive): a **versioned artifact** iterated with the user like
   triage/spec/plan (diffable, uncommitted). Capture what was wrong/missing and what the
   next epoch must change.
2. **Evolution → rules.md (do not apply feedback literally).** Distill the approved
   feedback into **per-repo rules**, reasoning about scope (task- vs repo-specific;
   code-writing vs solution-thinking), then **generalize**. Each involved repo gets the
   relevant rules **appended to its own `rules.md`** (curated/deduped/terse, user-confirmed
   via a `rules.md` diff), `CLAUDE.md`/`AGENTS.md` linked. Injected into that repo's future
   runs (`vars.rules`).
3. **Next epoch.** Bump to `v{N+1}` and reset to **plan**, seeded by the prior spec +
   feedback. **From epoch 2 onward, each repo continues on the SAME branch + PR** — never a
   new PR/branch. The new epoch's seed-commit is a fresh commit on the existing branch, and
   the existing PR is updated. Worktree cleanup is skill-owned after the binary session is
   done.

## 8. Versioned artifacts & diffs (reviewability, decoupled from git)

triage / spec / plans / feedback are each iterated through many **versions**. So the
user reviews **what changed** (not the whole doc each round), every proposed version is
snapshotted into the session store and diffed against the previous:

```
~/.kautopilot/<sessionId>/revisions/
├── triage/   v1.md v2.md …
├── spec/     v1.md v2.md …
├── plans/<repo>/ v1/ v2/ …
└── feedback/ v1.md v2.md …
```

`kautopilot diff <artifact[:repo]> [--from n] [--to n]` shows the unified diff (default
n-1→n). Versions are **machine-local and never committed**. Only the **final approved**
version is committed (§9). This reuses the existing `snapshot` / `artifact-versioning`
machinery, extended to the session store.

## 9. What gets committed, where

- Working/versioned artifacts + WAL + status live **only** in `~/.kautopilot/<sessionId>/`.
- When the skill creates a repo branch/worktree, each involved repo should get:
  - `spec/<ticketId>/ticket.md` — the ticket (epoch-agnostic).
  - `spec/<ticketId>/<epoch>/triage.md` — **one copy per repo**.
  - `spec/<ticketId>/<epoch>/task-spec.md` — the **whole** master spec — **only when the
    org's `commitSpec` is true.** `atomicloud`: yes. `liftoff`: **no** — the spec stays
    in the session store (and may go in the PR body), never committed to a liftoff repo.
  - `spec/<ticketId>/<epoch>/plans/…` — **only this repo's** plans.
- After feedback, each repo's `rules.md` is updated (+ `CLAUDE.md`/`AGENTS.md` link).
- Whether the spec is also committed to the repo is the org's **`commitSpec`** policy
  (replaces the blanket `removeSpecOnPush`). A fresh commit per epoch (not amend).
  Intermediate versions are never committed.

## 10. Org & ticket systems (replaces `init`)

No dynamic discovery, no generated adapter scripts. **Resolve the org** by precedence:
`--org` arg → detect from the ticket (if passed) → ask the user (`liftoff` |
`atomicloud`). Per-org config at `~/.kautopilot/orgs/<org>/config.yaml` (ticket system +
access, **`commitSpec` policy** — atomicloud `true`, liftoff `false` — baseBranch hints,
kloop defaults, prompt overrides). Fixed mapping, executed **harness-side** (the binary
never shells to ticket systems):

- `jira` → `acli` for read / transition / create.
- `clickup` → ClickUp MCP for read / transition / create.
- `none` → no external ticket; a local id is minted; transitions are no-ops.

A session uses exactly one org/tracker; all its repos must belong to that org (reject
otherwise). Ticket transitions are yielded as harness-side `agent` steps at phase
boundaries.

## 11. State, WAL & resume (reused)

One session, one WAL (`~/.kautopilot/<sessionId>/log.jsonl`), one materialized
`status.yaml` via `ensureStatus` lazy replay. Per-repo progress lives in `session.json`
`repos[] = { repo, worktree, branch, plans[], dependsOn[], prUrl, status }` and in WAL
events tagged with `repo`. The describe-mode driver uses **split handlers**: `prepare(ctx)
→ StepDescriptor | null` builds the prompt + emits `:started`; `finalize(ctx) → nextStep`
runs inside `complete`, deterministically. Crash recovery rolls a half-done step back to
its checkpoint before `next` re-yields it. A short per-call lock guards `next`/`complete`;
the lock is **released during internal blocking waits** so `status`/`diff` stay responsive.

## 12. On-disk layout

```
~/.kautopilot/
├── config.yaml                 # global default config
├── orgs/{liftoff,atomicloud}/config.yaml
└── <sessionId>/                # the one flat session
    ├── log.jsonl               # the WAL
    ├── status.yaml             # materialized status
    ├── config.yaml             # resolved (org) config
    ├── session.json            # ticketId, org, epoch, runMode, execMode, mergeMode, repos[]
    ├── orchestration.yaml      # master plan (PRs/branches + gate DAG) + per-plan exec status + kloop run (§5b)
    ├── ticket.md               # fetched ticket (epoch-agnostic working copy)
    ├── revisions/{triage,spec,master_plan,plans/<repo>,feedback}/   # versioned working artifacts (uncommitted)
    ├── artifacts/v<epoch>/     # frozen snapshots (existing scheme)
    └── tmp/kloop.pid
```

No `groups/` dir, no per-member session dirs. Committed artifacts live in each repo's
worktree (§9).

## 13. Binary changes (resolved decisions — these govern)

1. **One flat session machine.** Remove the group/member two-level design entirely.
   Repos are entries in `session.json.repos[]`, but execution/polish are no longer
   binary-yielded repo steps. No `group` CLI namespace, no per-member session/WAL.
2. **Invert via split handlers** (`prepare`/`finalize`); `complete` runs `finalize`.
   Delete `spawnTTY*` / `spawnPrint*` / `src/llm/spawn.ts` and the zellij wrapper. "Zero
   `claude -p`" is literal. `start` becomes a thin convenience that invokes the default
   harness (Claude) to drive `next`/`complete`.
3. **`next` blocks; no `pending`.** All detection/watch (poll, thread-pull, CI/ready,
   rebase-detect) runs inside `next` as `code` and blocks until actionable or `done`.
   Release the session lock during blocking waits.
4. **Run mode** = `current-session` | `sub-agent`-in-same-Claude. **Exec mode** =
   `kloop` | `sub-agent`. Both in `session.json`.
5. **Resolve the org** by `--org` → detect-from-ticket → ask (never auto-detect from the
   repo/env). Org config → ticket system (`jira` | `clickup` | `none`), **`commitSpec`
   policy** (atomicloud true, liftoff false), prompt overrides. Remove the dynamic `init`
   machine (`src/phases/init/*`, `init-{db,status,types,lock}.ts`, script generation in
   `scripts.ts`, `agents.init`, `src/cli/init.ts`).
6. **All ticket ops harness-side** (`create_ticket` / `fetch_ticket` / transitions) — the
   binary yields the op; Claude runs acli / the ClickUp MCP. `create_ticket` is idempotent.
7. **triage/spec/plans/feedback are versioned artifacts** with `revisions/` snapshots +
   `kautopilot diff`. Only the final approved version is committed. Feedback is iterated
   like the others.
8. **Reviewers are blocking — every reviewer must approve** (spec & plans), or the user
   explicitly overrides. Fan-out lives in the controller; the binary emits the set +
   synthesize prompt.
9. **Commit to each repo's PR**: triage + that repo's **own** plans as the first branch
   commit; the **whole** master spec too **only when the org's `commitSpec` is true**
   (atomicloud commits it, liftoff does not). Replaces the blanket `removeSpecOnPush`.
   Commits are skill-owned through isolated commit subagents.
10. **Epoch feedback waits for a clear execution frontier** — no ready/running plan work,
    no PR polish, and no scheduled merges. `merged` and `released` gates are explicit DAG
    edges; merges happen only for PRs returned by `schedule.toMerge`, under the session's
    `mergeMode`.
11. **Parallel ready plans, serialized interaction.** Ready-plan drivers run in parallel as
    sub-agent/kloop jobs, **bounded by `maxParallelRepos`** (default small) to cap token
    use; any interactive resolution returns upward to the main chat, which **queues and
    drains prompts one at a time** with the user.
12. **feedback → per-repo `rules.md`**: distilled, generalized, scope-reasoned,
    user-confirmed; linked from `CLAUDE.md`/`AGENTS.md`; injected into that repo's future
    prompts (`vars.rules`).
13. **Drop the ticket-delivery path** (`deliveryKind`, `ticket_draft/review/publish`).
    Every task is build → PR(s). Drop per-step run-artifact/transcript logging — git +
    the PR are the record.
14. **What stays as-is**: WAL reducer, versioning/epochs, snapshot validation, artifact
    paths, `buildPromptVars` + per-org prompt overrides. Kloop init/run is skill-owned.
15. **Brainstorm before ticket (ad-hoc only).** The no-ticket flow inserts an interactive
    `brainstorm` step (superpowers methodology: one question at a time, multiple-choice,
    explore the problem before solutions, 2–3 approaches with trade-offs) → `brainstorm.md`
    seeds `create_ticket`. Versioned. Skipped when a ticket is given.
16. **Only the commit subagent commits.** The main controller agent never commits, and
    **kloop never commits** (it implements/reviews only). Commits come from isolated
    skill-owned commit subagents.
17. **PR polish is skill-owned.** The skill handles CI, CodeRabbit, human review threads,
    and fix loops inside the PR construct, then records `pr-ready` only after the PR is
    genuinely ready to merge.
18. **Merge policy is per-session (`mergeMode`, see #22).** Ready-to-merge (CI green +
    threads resolved) is always reached first, and kloop never merges. In `manual`
    (default) the user merges. In `auto`, the controller may merge only ready PRs returned by
    `schedule.toMerge`, to clear downstream gates.
19. **Worktrunk worktrees + cleanup.** Each repo gets its own `wt` (worktrunk) worktree
    (the `/rc-session` mechanism). Cleanup is skill-owned after the binary session is done.
20. **Feedback / evolution is a full phase** — entered only when the user has feedback:
    feedback artifact → generalized per-repo `rules.md` → bump epoch → next epoch. With no
    feedback, the binary session completes.
21. **Epochs 2+ reuse the same branch + PR** per repo (no new PR/branch); fresh seed-commit
    per epoch on the existing branch; worktrees persist until skill-owned cleanup.
22. **Master plan + multi-repo/multi-PR orchestration.** A `master_plan` interactive step
    sits between `write_spec` and `write_plans`: it is approved FIRST and lays out the
    **PR/branch layout** (a repo may open several PRs on several branches), the **dependency
    DAG with gate levels** (`completed | merged | released`, edges may span repos), and a
    mermaid graph. It is frozen into `orchestration.yaml` (a resumable companion record that
    also tracks each plan's exec status + kloop run; the WAL stays the cursor's source of
    truth). The scheduler enforces gates from recorded state (a downstream repo is blocked
    until its upstream PRs reach the required gate, so its worktree is cut off an updated
    base), and `mergeMode ∈ manual | auto` (set via `start --merge`) decides whether the
    controller may merge scheduled ready PRs itself. `released` gates wait for the upstream
    repo's semantic releaser to publish + all release CI/CD to finish when a releaser exists;
    otherwise the merged PR is the release boundary.
23. **Execution is agent-driven via a DAG scheduler (`schedule`/`record`); the binary is a
    record-keeper, not a kloop driver.** After the master plan is approved, the agent runs
    kloop, resolves conflicts, provisions worktrees, and opens + merges PRs, **recording**
    each transition (`started`/`implemented`/`pr-opened`/`pr-ready`/`merged`/`released`/`failed`) via
    `kautopilot record`. `kautopilot schedule` reads `orchestration.yaml` and returns the
    runnable frontier — which plans can run now (deps satisfied), which PRs must merge to
    unblock a downstream, what's blocked/in-flight, and `allReady`/`done`. This is fully
    resumable (the frontier is recomputed from the ledger) and is how **multi-PR-per-repo is
    actually executed** (the agent opens exactly the master plan's PrPlans, recorded by
    `pr-<n>` id). This replaces the binary-driven seed→running→commit→poll execution loop.

## 14. Skill (thin controller)

`SKILL.md` is the loop, the per-`kind` execution rule (interactive inline & queued;
agent as isolated sub-agent), the parallel-repo fan-out with serialized interaction,
"show diffs not whole docs," and "feedback → rules." No dispatch tables, no prompts —
the binary emits everything per step. (Already written; aligned to this spec.)

## 15. Definition of done

- `kautopilot next --json` drives a full ticket→ready-PRs run with the skill as the only
  controller and **zero `claude -p` / TTY spawns**; `next` blocks on detection and never
  surfaces `pending`.
- Killing the harness mid-step (or mid-blocking-wait) and re-running `next` resumes
  exactly, no duplicate work, no lost approval.
- One repo and many repos run the **identical** flat flow — no count branch, no group
  abstraction. A two-repo ticket produces 2 worktrees + 2 linked PRs from one triage +
  master spec, plans partitioned per repo; both reach ready-to-merge before the epoch ends.
- Org is always asked; ticket integration is `jira | clickup | none` from org config.
- Every `agent` step is an isolated sub-agent; interactive steps queue and serialize.
- triage/spec/plans/feedback show **diffs** between versions; only finals are committed.
- Post-epoch feedback distills into user-confirmed, generalized per-repo `rules.md`.

## 16. Implementation plan (how to build this)

This refactors the **existing** `modules/kautopilot-ts` (Bun/TypeScript) — it is not a
rewrite from scratch. Reuse everything in §13 #14; change only the spawn call sites and
the group/member + init machinery; flatten to one session.

**Verify gate (every phase lands green before the next):** from `modules/kautopilot-ts`,
`bun run check` (biome + knip + `tsc --noEmit`) **and** `bun test` must pass. Clean up
test session dirs afterward per `CLAUDE.md`.

**Phase 1 — flat `next`/`complete` describe-mode core, one repo end-to-end.**
Split each handler into `prepare(ctx) → StepDescriptor | null` (build prompt, emit
`:started`) and `finalize(ctx) → nextStep` (run inside `complete`). Add
`createNextCommand`/`createCompleteCommand` on the existing `log-event`/`snapshot`/
`status` machinery. `next` **blocks** on detection, never returns `pending`. Delete the
spawn path (`src/llm/spawn.ts`, `spawnTTY*`/`spawnPrint*`, zellij wrapper, self-driving
`start`) and the **init** machine (`src/phases/init/*`, `init-{db,status,types,lock}.ts`,
script-gen in `scripts.ts`, `agents.init`, `src/cli/init.ts`). Drive one repo through
`resolve_org → fetch_ticket → triage → spec → master_plan → plans`, then hand execution to
`schedule`/`record` until feedback.

**Phase 2 — artifacts, diffs, org/ticket.** `revisions/` snapshots for
triage/spec/plans/feedback + `kautopilot diff`; org config `liftoff|atomicloud` with
`commitSpec` + resolution precedence (`--org` → ticket → ask); ticket ops harness-side
(`jira|clickup|none`); drop `deliveryKind`/ticket-delivery and `removeSpecOnPush`.

**Phase 3 — quality + evolution.** Reviewer fan-out (all-approve) + synthesize;
`brainstorm` step (no-ticket, superpowers methodology); feedback/evolution full phase →
generalized per-repo `rules.md`; commits only via commit subagents; merge only via
`mergeMode` and `schedule.toMerge`.

**Phase 4 — multi-repo.** `schedule`/`record` DAG execution, `session.json.repos[]`,
`maxParallelRepos`, worktrunk worktrees, queued/serialized interaction, epochs 2+ reuse
the same branch + PR, skill-owned cleanup after completion.

**Tests.** Remove init/spawn-path tests; add coverage for `next`/`complete` describe-mode,
resume-after-kill idempotency, `create_ticket` dedupe, blocking-`next` detection,
versioned-artifact diff, and multi-repo DAG scheduling + parallelism. Net suite green.

**Completion bar = §13 (all 21 resolved decisions) + §15 (every DoD bullet).** Done only
when all are implemented and the verify gate is green.
