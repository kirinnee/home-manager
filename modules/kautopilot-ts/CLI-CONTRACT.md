# kautopilot CLI Contract — Host-Driven Controller, One Flat Session

The contract between the **binary** (codified state, replay, dispatch, detection,
prompts — zero tokens) and the **harness** (Claude or any agent that can shell out and
talk to a user). The harness runs a thin loop; the binary decides the next step and
hands back a fully-resolved prompt. **No `claude -p` / TTY spawns from the binary.**

kautopilot is **one flat session** (= a ticket). It may touch N repos, but a repo is
just an entry in `session.json.repos[]` — there is **no `group` and no `member
session`**. Companion docs: `SPEC-kautopilot.md` (architecture) and `PROMPT-SET.md` (the
fully-assembled prompt per step). This file is the **command + JSON surface**.

---

## 1. The controller loop (lives in the skill)

```
loop:
  d = json(`kautopilot next --json [--repo <repo>]`)
  if d.done: report(d); break
  if d.kind == "interactive":
      run d.prompt inline, converse with the user, satisfy d.contract   # approval gate
  else: # agent
      spawn an isolated Task subagent with d.prompt; it writes d.contract.outputFile
  kautopilot complete --output d.contract.outputFile [--metadata {…}] [--repo <repo>]   # no step name — binary owns the cursor
```

`code` steps are **never yielded** — the binary runs them inline (snapshot, finalize,
worktree provisioning via `wt`, seed-commit, push, poll, WAL writes, version/epoch
bookkeeping, **and outcome verification** — e.g. re-checking `kloop status` / git / gh)
and advances. kloop itself is **not** run by the binary: the execution `running` step is
an `agent` step whose babysitter sub-agent runs `kloop init`/`run -d`, and the binary
then verifies the result via `kloop status`.

**Driving the phases.** Bare `kautopilot next` advances the **shared phases** (plan,
feedback). `kautopilot next --repo <repo>` drives **one repo's** execution/polish loop —
the controller runs repos in parallel, **bounded by `maxParallelRepos`**, each in its
own sub-agent driver. A repo driver that hits an `interactive` step returns it upward to
the main chat, which serializes such prompts to the one user (other repos keep going).

---

## 2. `kautopilot next`

```
kautopilot next [--json] [--repo <repo>] [--session <id>]
```

Resolves the session, acquires a short per-call lock (**released during blocking
waits**), runs the resume/dispatch (`ensureStatus` replay over the WAL — §6),
**auto-executes every `code` step inline — including blocking detection/watch loops**,
and stops at the first `interactive` or `agent` step, printing a **StepDescriptor**.

### StepDescriptor

```jsonc
{
  "done": false,
  "sessionId": "k7f3a9",
  "ticketId": "PE-1234",
  "phase": "execution", // plan | execution | polish | feedback
  "step": "resolve",
  "kind": "interactive", // interactive | agent   (code is never surfaced)
  "repo": "infra", // set when repo-scoped (execution/polish); null for plan/feedback
  "version": 2, // epoch version
  "prompt": "## CRITICAL: Resolve …\n…fully-resolved mechanics + configurable body…",
  "vars": {
    // absolute paths already substituted into `prompt`
    "ticket": "~/.kautopilot/k7f3a9/ticket.md",
    "triage": "~/.kautopilot/k7f3a9/revisions/triage/v2.md",
    "spec": "~/.kautopilot/k7f3a9/revisions/spec/v3.md",
    "plans": "/abs/wt/infra-PE-1234/spec/PE-1234/v1/plans", // worktree paths for repo steps
    "rules": "/abs/wt/infra-PE-1234/rules.md", // null if none
    "worktree": "/abs/wt/infra-PE-1234", // null for plan/feedback steps
  },
  "contract": {
    "outputFile": "/abs/wt/infra-PE-1234/.kautopilot/resolution.md",
    "completionEvent": "resolve:approved",
    "completionMetadataSchema": {
      "rewriteDecision": "refine_local|patch_downstream|regenerate_remaining|retry|revisit_spec",
    },
    "snapshot": { "type": "plans", "diffAgainstPrevious": true }, // omit if none
  },
  "review": null, // present only on review steps — §4
}
```

For **plan/feedback** steps `repo`/`worktree` are null and paths point at the session
store. For **execution/polish** steps `repo`/`worktree` are set and paths point into the
repo worktree.

### `next` blocks; there is no `pending`

All detection is codified and runs _inside_ the binary: pulling the PR's
conversation/thread list, checking CI / PR-ready, polling, rebase-detection. When the
binary is waiting on the world, `next` **blocks** (internal poll loop at
`settings.pollInterval`) rather than returning a "still waiting" status. It returns
exactly two shapes: a **StepDescriptor** or **`{ "done": true, "phase": "...", "reason":
"..." }`**. A single `next` call may block a long time; killing it and re-calling
resumes the same wait (the WAL is unchanged). `next` is idempotent — same descriptor
until the step's `completionEvent` is logged. **This is the resume story.**

### `kind` semantics

| kind          | Who runs it                            | Examples                                                                                                                                       |
| ------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`        | the binary, inline (**never yielded**) | seed (wt worktree), setup_run, push, poll, act, ensure_branch, verify_fixes, next_plan, cleanup, + outcome verification (kloop status / git / gh) + gate reconciliation (merge/release) |
| `interactive` | harness, **inline**, serialized        | brainstorm (ad-hoc), triage, write_spec, **write_master_plan**, write_plans, resolve, amend_plans, tty_resolve, feedback_check, feedback           |
| `agent`       | harness, **isolated sub-agent**        | create_ticket, fetch_ticket, running (kloop babysitter), commit, eval, create_pr, prereview, write_fix, running_subagent (exec mode `sub-agent`). The reviewer fan-out is not a step — it rides on write_spec/write_plans. |

---

## 3. `kautopilot complete`

```
kautopilot complete [step] [--output <path>] [--metadata <json>] [--repo <repo>] [--session <id>]
```

The binary:

1. **Owns which step.** `step` is **optional** — omit it and the binary completes
   whatever step is pending for that scope (the WAL cursor is the source of truth).
   If `step` IS given it is only an **assertion**: when it doesn't match the pending
   step the call fails as stale (the caller is out of sync — re-run `next`). The
   harness should drive without naming the step so it can never overwrite the cursor.
2. **Validates the contract**: `contract.outputFile` exists; the **written file is the
   source of truth** — `complete` re-parses it; `--metadata` must match the parsed
   values and any `completionMetadataSchema`.
3. **Runs the step's `finalize`** (parse → set context → persist → snapshot/diff).
4. **Appends** the canonical `completionEvent` (+ metadata) to the WAL.
5. Prints `{ "ok": true, "recorded": "resolve:approved" }`.

> **Approval gates stay the harness's responsibility** — only call `complete` after
> explicit user approval (interactive) or after every reviewer approves (review, §4).
> The binary enforces _artifact presence_, not consent.

---

## 4. Review steps (fan-out gate)

A review step's descriptor carries a **set** of reviewer prompts + a **synthesize**
prompt:

```jsonc
"review": {
  "reviewers": [ { "id": "completeness", "prompt": "…", "verdictSchema": {…} }, … ],   // 8 spec / 5 plan
  "synthesize": { "prompt": "…", "outputFile": "…/review-summary.md" },
  "gate": "all_approve"
}
```

The `review` payload is carried **on the writer step** (`write_spec`/`write_plans`),
so reviewers run **before each version is presented to the user** — every version the
user sees is already review-checked. The controller spawns reviewers as parallel
isolated sub-agents on the working draft, runs **synthesize** into one numbered problem
list, and refines the draft until **every reviewer approves** (or the user overrides via
`--metadata '{"reviewOverride": true}'`). Reviewer rounds are **not versioned** — only a
user-facing `revise` (§5) mints a version. There is no separate `spec_review` /
`plan_review` step.

---

## 5. Versioned artifacts, `revise` & diffs

brainstorm / triage / spec / plans / feedback are each iterated through many
**versions**. A version is a **snapshot the user was shown** — numbering is
**file-based** (`vN.md` on disk) and a new version is minted **only** by `revise`,
once per user-facing presentation. Re-running `next` never mints a version; reviewer
rounds (§4) refine the current version in place and are not versioned.

```
kautopilot revise [--repo <repo>] [--session <id>]
```

- Copies the latest version forward (`vN → vN+1`) and prints
  `{ "ok": true, "version": N, "path": "<file to edit>", "url": "/sessions/…/spec/vN", "diffUrl": "/sessions/…/spec/diff?from=…&to=…" }`.
- The harness edits `path`, then presents `url`/`diffUrl` (prefixed with the
  configured viewer base URL) — it never hand-builds a version URL.
- Only valid on an interactive writer step; otherwise `{ ok: false }`.

```
kautopilot diff <artifact> [--from <n>] [--to <n>] [--session <id>]
   artifact ∈ triage | spec | plan[:<repo>] | feedback
   default: latest two versions (n-1 → n)
```

- Revisions live at `~/.kautopilot/<sessionId>/{brainstorm,epoch/<E>/{triage,spec,feedback,plans/<repo>/<plan>}}/vN.md`.
- The web viewer renders the diff as a **markdown redline** (rendered prose with inline
  insertions/deletions), not a code-style line diff; `next` may include the latest diff
  inline (`vars.lastDiff`).
- **Machine-local, never committed.** Only the final approved version is committed (§ on
  commit policy below).

`master_plan` (§5b) is also a versioned writer artifact — same `revise`/`diff` mechanics,
approved **before** `write_plans`.

---

## 5b. Master plan + orchestration (multi-repo, multi-PR)

The plan phase yields a **`master_plan`** interactive step **between `write_spec` and
`write_plans`** — the orchestration layer, approved *first* so the per-repo sub-plans are
written against an agreed shape. It captures:

- **PR/branch layout** — each PR (`pr-<n>`) with its repo, branch, title, and the plans it
  ships. A repo may have **several PRs on several branches**; in the DAG execution model (§5c)
  the agent opens exactly these PRs and records them by `pr-<n>` id, so multi-PR-per-repo is
  executed, not just recorded.
- **The dependency DAG with gate levels** — each edge: `{ plan, repo, dependsOn,
  dependsOnRepo, gate }` where `gate ∈ completed | merged | released`:
  - `completed` — upstream plan's code is committed on its branch.
  - `merged` — upstream PR merged into base (then the downstream worktree is cut off updated base).
  - `released` — upstream repo's semantic release fully published AND all release CI/CD green.
  - Edges may span repos.
- A **mermaid `graph TD`** for the dashboard (the binary derives one if the agent omits it).

On `master_plan:approved` the harness passes the structured plan as `--metadata` (`{ mergeMode?,
prs[], nodes[], deps[] }`); the binary freezes it into **`~/.kautopilot/<sessionId>/orchestration.yaml`**
— a human-readable, resumable record that ALSO tracks each plan's **exec status** (`pending →
running → implemented → pr_open → merged → released`) and the **kloop run id** that built it.
It's a companion view over the WAL + `session.json`, never the cursor's source of truth.

**Gate enforcement.** Before driving a repo (`next --repo R`), the binary reconciles
merge/release state of upstream PRs (a `code` reconciliation) and **blocks** R while any of
its plans still wait on an unsatisfied `merged`/`released` gate, returning a `done` result
with `phase:"execution"` and a "blocked on gate dependencies" reason. The downstream worktree
is therefore always cut off a base that already contains the upstream work.

### Merge policy (per session)

`session.json.mergeMode ∈ manual | auto` (set at `start` via `--merge`, confirmable in the
master plan). Either way the binary drives every PR to **ready-to-merge**. Then:

- `manual` — the binary **never** merges; it observes the merge the user performs (and the
  `feedback_check`/skill asks the user to merge).
- `auto` — the binary **merges a ready PR itself** (`gh pr merge --squash`) to clear
  downstream `merged`/`released` gates.

`released` gates additionally require the upstream repo's semantic releaser (detected from
`.releaserc*`/release-please/GoReleaser/`semantic-release` in package.json) to have published
its newest release with all release CI/CD finished before the gate opens.

---

## 5c. DAG execution — `schedule` + `record` (kautopilot is a record-keeper, not a kloop driver)

Once the master plan is approved, **the agent drives the work** (kloop, conflict resolution,
worktrees, opening + merging PRs) and **records** each transition; **kautopilot does not run or
watch kloop**. The binary's job in execution is to track progress and answer scheduling
questions over the DAG. Bare `next` after plan approval returns a `phase:"execution"` done-result
telling the agent to drive via `schedule`/`record`; when every plan is ready-to-merge it advances
to feedback.

```
kautopilot schedule [--json] [--session <id>]
```

Reads `orchestration.yaml` and returns the runnable frontier:

```jsonc
{
  "ok": true,
  "mergeMode": "manual",
  "ready":   [ { "repo": "api", "plan": "plan-1", "pr": "pr-1" } ],   // deps satisfied → run now
  "running": [ { "repo": "…", "plan": "…", "kloopRunId": "…" } ],     // in flight
  "blocked": [ { "repo": "web", "plan": "plan-2",
                 "waitingOn": [ { "repo": "api", "plan": "plan-1", "gate": "merged" } ] } ],
  "toMerge": [ { "pr": "pr-1", "repo": "api", "branch": "…", "prNumber": 42,
                 "unblocks": ["web/plan-2"] } ],   // open PRs gating a downstream (gate-clearing first)
  "allReady": false,   // every plan pr_open/merged/released → time for feedback
  "done": false        // every plan merged/released → DAG delivered
}
```

```
kautopilot record <event> [--repo <r> --plan <p> | --pr <prId>] [--kloop <id>] [--number <n>] [--url <u>]
   event ∈ started | implemented | pr-opened | merged | released | failed
```

Updates the plan(s)' status in `orchestration.yaml`. `--pr <prId>` marks **every plan in that
PrPlan** (how multi-PR-per-repo is recorded — one PR at a time). `schedule` recomputes purely
from what's recorded, so the model is **fully resumable**: a killed/auto-resumed session just
calls `schedule` again and continues from the frontier. The status ladder is `pending → running
→ implemented → pr_open → merged → released` (plus terminal `failed`); a `merged`/`released`
record clears the matching downstream gate so newly-runnable plans appear in the next `schedule`.

(Legacy: a session with **no** master plan still uses the per-repo `next --repo` execution/polish
step machine + the `await_repos` gate on `repos[].status`. The DAG model above is the path for any
ticket-to-PR run with a master plan.)

---

## 6. State, WAL & resume (reused — one session)

- **One WAL** per session: `~/.kautopilot/<sessionId>/log.jsonl`. `LogEntry =
{ts,event,version?,attempt?,plan?,repo?,result?,metadata?}` — execution/polish events
  carry `repo`.
- **Replay**: `ensureStatus` lazy incremental replay (`walCursor` in `status.yaml`)
  materializes `phase/step/version/context` and per-repo progress.
- **Per-repo state** lives in `session.json.repos[] = { repo, worktree, branch, plans[],
dependsOn[], prNumber, prUrl, status }`. There is no per-repo WAL. The multi-PR/branch
  layout + per-plan gate deps + exec progress live in `orchestration.yaml` (§5b), not here.
- **Describe-mode** uses **split handlers**: `prepare(ctx) → StepDescriptor | null`
  builds the prompt + emits `:started`; `finalize(ctx) → nextStep` runs inside
  `complete`, deterministically.
- **Crash recovery** rolls a half-done step back to its checkpoint before `next`
  re-yields it.

---

## 7. Session & repo commands

```
kautopilot start [TICKET_ID | "request"] [--org liftoff|atomicloud] [--merge manual|auto]   # convenience: init session + invoke default harness
kautopilot next [--repo <repo>] [--json]                              # the driver (§2)
kautopilot complete [step] [--repo <repo>] …                          # advance; step optional (§3)
kautopilot revise [--repo <repo>] …                                   # mint next version + return link (§5)
kautopilot schedule [--json]                                          # DAG frontier: ready plans / PRs to merge (§5c)
kautopilot record <event> …                                           # log a plan/PR lifecycle event (§5c)
kautopilot diff <artifact> …                                          # revision diffs (§5)
kautopilot status [--json]                                            # session + every repo's per-repo state
kautopilot ps [--json]                                                # sessions table (unchanged shape + ticketId/org)
kautopilot logs [phase] [--repo <repo>]                               # tail the WAL
```

- **No `group` namespace, no `members.json`, no `init`.** Repos are registered in
  `session.json.repos[]` as triage selects them; `status --json` reports the session plus
  each repo's `{phase, step, prUrl, status}`.
- **Repo setup + seed** is a `code` step inside `next --repo`: create a **worktrunk
  worktree** for the repo (via `wt` — the `/rc-session` mechanism; **ask before cloning**
  a missing remote, yielded as a one-line interactive confirm), then commit the planning
  artifacts as the first branch commit per the org's commit policy (below).
- **Cleanup** is a `code` step at the end: when the user confirms the PRs are **fully
  merged** (no feedback), remove this session's worktrunk worktrees. The binary never
  merges — it only tears down worktrees the user already merged.

### Commit policy (org-gated)

On seed, each involved repo's branch gets, as its first commit:
`spec/<ticketId>/ticket.md` (epoch-agnostic), `spec/<ticketId>/<epoch>/triage.md`,
`…/plans/…` (**this repo's own** plans), and `…/task-spec.md` (the **whole** master
spec) **only when the org's `commitSpec` is true** — **atomicloud: yes; liftoff: no**
(spec stays in the session store / PR body). Replaces the blanket `removeSpecOnPush`.

**Who commits:** only the isolated `commit`/`commit_pending` **sub-agent** (convention
discovery + hook-repair) or the binary's deterministic **seed-commit** (`code`). The
**main controller agent never commits**, and **kloop never commits** (it
implements/reviews only). **No PR is ever merged** by any agent/kloop/binary.

**Epochs 2+ reuse the branch + PR.** Epoch 1 opens each repo's branch + PR; later epochs
seed a fresh commit on the **same branch** and `create_pr` **updates the existing PR** —
never a new PR. Worktrees persist across epochs; `cleanup` runs only at the final
fully-merged. The **feedback / evolution phase** (entered only when the user has feedback)
distills feedback → per-repo `rules.md`, then bumps the epoch and re-enters `plan`.

---

## 8. Org & ticket ops are harness-side

**Resolve the org** by precedence: `--org` arg → **detect from the ticket** (when a
ticket id is passed) → **ask** the user (`liftoff` | `atomicloud`). Never auto-detect
from repo/env. The org's config (`~/.kautopilot/orgs/<org>/config.yaml`) fixes the ticket
system, `commitSpec`, baseBranch hints, kloop defaults, prompt overrides.

The binary never shells to ticket systems — it yields a ticket-op `agent` step; the
harness runs it (`jira`→`acli`, `clickup`→ClickUp MCP, `none`→local id, transitions
no-op):

- **`create_ticket`** (ad-hoc, before the session is keyed): draft title/description,
  confirm, create; the new id keys the session. Idempotent via stored-id check.
- **`fetch_ticket`**: read the ticket (+ parents) → `ticket.md`.
- **Transitions** (start / review / feedback) at phase boundaries.

A session uses exactly one org/tracker; all its repos must belong to it (reject otherwise).

---

## 9. Feedback → `rules.md`

The post-epoch **feedback** step is a **versioned artifact** (iterated/diffed like
triage/spec/plan). Don't apply it raw: distill it into candidate **rules**, reasoning
about scope (task- vs repo-specific; code-writing vs solution-thinking) and
**generalizing**, confirm with `AskUserQuestion` (showing a `rules.md` diff), and let the
binary append the confirmed rules to **each involved repo's `rules.md`** (+ link from
`CLAUDE.md`/`AGENTS.md`). `rules.md` is injected into that repo's future prompts
(`vars.rules`).

---

## 10. Removed / retired

- **`init`** command + the dynamic init machine (`src/phases/init/*`,
  `init-{db,status,types,lock}.ts`, script generation in `scripts.ts`, `agents.init`,
  `src/cli/init.ts`). `ticketSystem` becomes `jira | clickup | none` from org config.
- **`group` namespace + `members.json` + per-member sessions** — flattened into one
  session with `repos[]`.
- **Self-driving `start` + all spawn code** (`spawnTTY*`, `spawnPrint*`,
  `src/llm/spawn.ts`, zellij wrapper). `start` is a thin convenience that invokes the
  default harness to drive `next`/`complete`. "Zero `claude -p`" is literal.
- **Per-step run-artifact logging** — git + the PR are the record.
- **Ticket-delivery path** (`deliveryKind`, `ticket_draft/review/publish`).
- **`removeSpecOnPush`** → replaced by the per-org `commitSpec` policy.

## 11. Run mode, exec mode, parallelism

- **Run mode** — `current-session` (default) | `sub-agent` (a sub-agent **inside this
  same Claude** drives the loop; no detached Claude / `claude -p`).
- **Exec mode** — per repo's `running` step: `kloop` (default) | `sub-agent` (implement
  the plan directly as one isolated sub-agent). Per-plan opt-in to `sub-agent` for
  straightforward plans.
- **Parallelism** — `maxParallelRepos` (default small, e.g. 2): at most N `next --repo`
  loops run at once; the rest queue. Caps token consumption.

All three live in `session.json` and are per-invocation overridable.

## 12. Error model

- Stale `complete` (step ≠ pending for that scope) → exit 1, `{ "ok": false, "error":
"stale step" }`.
- Missing `contract.outputFile` / `--metadata` mismatch → exit 1.
- Per-call lock around `next`/`complete`, **released during blocking waits** so
  `status`/`diff` stay responsive; a per-session lock guards concurrent `next --repo`
  drivers' shared writes.
- A crashed controller resumes by calling `next` (or `next --repo`) again.
