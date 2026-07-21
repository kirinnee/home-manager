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
  d = json(`kautopilot next --json`)
  if d.done && d.phase == "execution":
      drive the DAG with `kautopilot schedule` + `kautopilot record`
      run bounded ready plans, PR polish from `toPolish[]`, then scheduled merge/release
      continue
  if d.done: report(d); break
  if d.kind == "interactive":
      run d.prompt inline, converse with the user, satisfy d.contract   # approval gate
  else: # agent
      spawn an isolated Task subagent with d.prompt; it writes d.contract.outputFile
  kautopilot complete --output d.contract.outputFile [--metadata {…}]   # no step name — binary owns the cursor
```

`code` steps are **never yielded** — the binary runs plan/feedback plumbing inline
(org resolution, artifact finalization, WAL writes, version/epoch bookkeeping) and
advances. Worktrees, kloop, commits, PR creation/polish, merge, and release waiting are
skill/controller work driven from `schedule` and recorded through `record`.

**Driving the phases.** Bare `kautopilot next` advances the **shared phases** (plan,
execution handoff, feedback). In master-plan/DAG sessions, execution is driven by
`kautopilot schedule` and `kautopilot record`: run bounded `ready[]` plans, open/continue
PRs from `toPolish[]`, record `pr-ready` only after CI/review polish is complete, and
merge only PRs returned by `toMerge[]` under `mergeMode`. Repo-scoped `next` has been
removed; it is not the DAG execution contract.

---

## 2. `kautopilot next`

```
kautopilot next [--json] [--session <id>]
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
  "phase": "plan", // plan | feedback; execution handoff is returned as done:true
  "step": "resolve",
  "kind": "interactive", // interactive | agent   (code is never surfaced)
  "repo": null, // repo-scoped yielded steps were removed; execution uses schedule/record
  "version": 2, // epoch version
  "prompt": "## CRITICAL: Resolve …\n…fully-resolved mechanics + configurable body…",
  "vars": {
    // absolute paths already substituted into `prompt`
    "ticket": "~/.kautopilot/k7f3a9/ticket.md",
    "triage": "~/.kautopilot/k7f3a9/revisions/triage/v2.md",
    "spec": "~/.kautopilot/k7f3a9/revisions/spec/v3.md",
    "plans": "~/.kautopilot/k7f3a9/epoch/1/plans/api",
    "rules": null,
    "worktree": null,
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
  "execution": "inline", // inline | deferred — deferred writer steps are driven
                         // via `kautopilot relay` (§5d), never run inline
}
```

**Deferred descriptors are lightweight**: when `execution: "deferred"` the
`prompt` is a short stub (the full prompt travels to the writer session via the
relay), `review` is null (the writer owns the fan-out), and `vars` is trimmed to
cheap path entries. `contract` is intact — the harness still needs it for
`complete`.

For yielded steps `repo`/`worktree` are null and paths point at the session store. Execution
and PR polish are no longer yielded by `next`; the skill drives them through
`schedule`/`record`.

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
| `code`        | the binary, inline (**never yielded**) | plan/feedback plumbing such as org resolution and artifact finalization |
| `interactive` | harness, **inline**, serialized        | brainstorm (ad-hoc), triage, write_spec, **write_master_plan**, write_plans, feedback_check, feedback |
| `agent`       | harness, **isolated sub-agent**        | create_ticket, fetch_ticket. Reviewer fan-out rides on write_spec/write_plans. |

---

## 3. `kautopilot complete`

```
kautopilot complete [step] [--output <path>] [--metadata <json>] [--session <id>]
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
  - `released` — if the upstream repo has a semantic releaser, its newest release is fully
    published and release CI/CD is green; otherwise the merged PR is treated as the release boundary.
  - Edges may span repos.
- A **mermaid `graph TD`** for the dashboard (the binary derives one if the agent omits it).

On `master_plan:approved` the harness passes the structured plan as `--metadata` (`{ mergeMode?,
prs[], nodes[], deps[] }`); the binary freezes it into **`~/.kautopilot/<sessionId>/orchestration.yaml`**
— a human-readable, resumable record that ALSO tracks each plan's **exec status** (`pending →
running → implemented → pr_open → pr_ready → merged → released`), each PR's lifecycle
(`pending → open → ready → merged → released`), and the **kloop run id** that built it.
It's a companion view over the WAL + `session.json`, never the cursor's source of truth.

**Gate enforcement.** Before running a pending plan from `schedule.ready[]`, the controller
observes and records upstream PR merge/release state. The scheduler leaves downstream plans
blocked while any dependency still waits on an unsatisfied `merged`/`released` gate, so the
downstream worktree is cut off a base that already contains the upstream work.

### Merge policy (per session)

`session.json.mergeMode ∈ manual | auto` (set at `start` via `--merge`, confirmable in the
master plan). Either way every PR must reach **ready-to-merge** first. Then:

- `manual` — ask/wait for the user merge, then record it.
- `auto` — the controller may merge only PRs returned by `schedule.toMerge`, then record it.
  If an entry has `gate: "released"`, wait for the release boundary and record `released`.

`released` gates additionally require the upstream repo's semantic releaser (detected from
`.releaserc*`/release-please/GoReleaser/`semantic-release` in package.json) to have published
its newest release with all release CI/CD finished before the gate opens. If no releaser is
configured, the merged PR is the release boundary and the controller may record `released`
after observing the merge.

---

## 5c. DAG execution — `schedule` + `record` (kautopilot is a record-keeper, not a kloop driver)

Once the master plan is approved, **the agent drives the work** (kloop, conflict resolution,
worktrees, opening + merging PRs) and **records** each transition; **kautopilot does not run or
watch kloop**. The binary's job in execution is to track progress and answer scheduling
questions over the DAG. Bare `next` after plan approval returns a `phase:"execution"` done-result
telling the agent to drive via `schedule`/`record`; once no work, polish, or scheduled merge
remains, it advances to feedback.

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
  "toPolish": [ { "pr": "pr-1", "repo": "api", "branch": "…", "status": "open",
                  "prNumber": 42, "plans": [{ "repo": "api", "plan": "plan-1" }] } ],
  "toMerge": [ { "pr": "pr-1", "repo": "api", "branch": "…", "prNumber": 42,
                 "gate": "merged", "unblocks": ["web/plan-2"] } ], // clear merge/release gate
  "allReady": false,   // no ready/running/polish/merge work remains → time for feedback
  "done": false        // every plan merged/released → DAG delivered
}
```

```
kautopilot record <event> [--repo <r> --plan <p> | --pr <prId>] [--kloop <id>] [--number <n>] [--url <u>]
   event ∈ started | implemented | pr-opened | pr-ready | merged | released | failed
```

Updates the plan(s)' status in `orchestration.yaml`. `--pr <prId>` marks **every plan in that
PrPlan** (how multi-PR-per-repo is recorded — one PR at a time). `schedule` recomputes purely
from what's recorded, so the model is **fully resumable**: a killed/auto-resumed session just
calls `schedule` again and continues from the frontier. The plan status ladder is `pending →
running → implemented → pr_open → pr_ready → merged → released` (plus terminal `failed`).
The PR lifecycle is separate: `toPolish` lists PRs whose plans are implemented but whose PR
polish is not complete; `pr-opened` records the PR exists, and `pr-ready` records CI green
plus actionable review threads resolved. `toMerge` entries carry the next gate to clear:
`gate: "merged"` means merge the ready PR; `gate: "released"` means the PR is already merged
but still blocks downstream release-gated work. Every PR in `toMerge` should be
merged/released before `allReady` advances the session to feedback. A `merged`/`released`
record clears the matching downstream gate so newly-runnable plans appear in the next
`schedule`.

(If a session has no master plan/orchestration, fix or re-approve the master plan. The
DAG model above is the only execution path.)

## 5d. Deferred writer — `relay` + `discussion`

When `session.json.writerMode == "deferred"` (set at `start --writer deferred`,
default from `config.writer.mode`; **pinned per session** against config flips),
the six writer steps (brainstorm, triage, write_spec, write_master_plan,
write_plans, feedback) that are enabled in `config.writer.steps` yield
`execution: "deferred"`. The harness then drives the step through a **writer
session** — a Claude conversation on a fleet account (`config.writer.pool`,
pinned per phase in `scratch/<phaseKey>/writer.json`) that the binary runs
turn-by-turn as a persistent **kteamd** session (`kteam start` on turn 1,
`kteam send` after; never `--print`). kteamd owns the TUI, resume/crash-recovery,
and account failover.

```
kautopilot relay [--message <text> | --message-file <path>] [--approval]
                 [--fallback-inline] [--session <id>]
```

One call = one writer turn. The binary composes `scratch/<phaseKey>/turn-N/
message.md` (turn 1 carries the full step prompt + reviewer payload + visual
brief + envelope contract; each turn re-states the contract), mints/reuses the
working artifact version itself (the writer NEVER runs kautopilot commands),
then drives the writer's **persistent kteam session** — turn 1 `kteam start -a
<acct> --mode auto --name writer-<kind> --label kauto-<sessionId> --prompt-file
<msg>`, later turns / retries `kteam send <id> --message-file <msg>` — and parks
on `kteam wait <id> --until-marker <reply.json>`. It validates `reply.json`
(schema + on-disk side effects: revised turns must have the vN.md + vN.html),
retries correctively in the same kteam session (max `writer.maxTurnRetries`),
then enriches with viewer URLs and prints the envelope on stdout. **Exit is the
wake signal** — callers run it in the background (it can block ~30 min/attempt)
and read stdout; `reply.json` is rewritten mid-flight and must not be watched.

- Idempotent: re-running with no message (or the same message) returns the last
  accepted envelope; a half-done turn is re-attached (`kteam send` nudge —
  auto-revives a finished session); a finished-on-disk turn (controller died) is
  adopted without re-sending.
- `--approval` = the final consistency turn (no version prep; the writer must
  not revise). `--fallback-inline` flips `session.json.writerMode` to inline for
  the rest of the session (the escape hatch; irreversible per session).
- Failures print `{ok:false, error, remediation[], snapshotPath, kteamSession}`.
  kteam statuses map to outcomes: `failed`/`stalled`/`stopped` → failed,
  `awaiting_*`/`waiting` without a marker → needs-attention, deadline → timeout;
  all nudge-and-`send`-retry within the budget. kteam owns crash recovery
  (auto-revive) and account failover — there is no rebootstrap. **Daemon down**
  fails loudly (`kteam daemon start` hint) WITHOUT corrupting turn state.
- WAL events (`relay:sent|reply|invalid|failed|fallback_inline`) are
  observability-only — never cursor events.
- `kautopilot revise` is rejected on deferred steps (the relay owns version
  bookkeeping).

```
kautopilot discussion [--phase <phaseKey|kind>] [--session <id>] [--json]
```

The capture surface: the phase's writer state + turn list (state, attempts,
elapsed, last progress.log line, accepted envelopes). Also served at
`GET /api/sessions/:id/discussion[/:phaseKey]` and rendered as a Discussion
timeline in the dashboard. `stop` stops the writer's kteam sessions (by
`--label kauto-<sessionId>`) and marks running writers `interrupted`
(re-attachable); `delete` also removes them.

---

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
kautopilot next [--json]                                              # the plan/feedback driver (§2)
kautopilot complete [step] …                                          # advance; step optional (§3)
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
- **Repo setup is skill-owned** when the controller runs a plan from `schedule.ready[]`:
  create or locate a **worktrunk worktree** for the repo (via `wt` — the `/rc-session`
  mechanism; **ask before cloning** a missing remote), then run kloop/commit subagents and
  record lifecycle transitions.
- **Cleanup is skill-owned** after the binary session is done. The binary no longer yields
  `cleanup`.

### Commit policy (org-gated)

When the skill creates the repo branch/worktree, each involved repo should get:
`spec/<ticketId>/ticket.md` (epoch-agnostic), `spec/<ticketId>/<epoch>/triage.md`,
`…/plans/…` (**this repo's own** plans), and `…/task-spec.md` (the **whole** master
spec) **only when the org's `commitSpec` is true** — **atomicloud: yes; liftoff: no**
(spec stays in the session store / PR body). Replaces the blanket `removeSpecOnPush`.

**Who commits:** only isolated commit subagents. The **main controller agent never commits**,
and **kloop never commits** (it implements/reviews only). Merge ownership is
`mergeMode`-gated: manual waits for the user; auto allows the controller to merge only PRs
returned by `schedule.toMerge`.

**Epochs 2+ reuse the branch + PR.** Epoch 1 opens each repo's branch + PR; later epochs
seed a fresh commit on the **same branch** and updates the existing PR — never a new PR.
Worktrees persist across epochs until skill-owned cleanup. The **feedback / evolution phase**
(entered only when the user has feedback)
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
- **Exec mode** — skill-owned plan drivers use `kloop` by default or a direct isolated
  subagent for straightforward plans; the binary only records the chosen lifecycle events.
- **Parallelism** — `maxParallelRepos` (default small, e.g. 2): at most N ready
  plan drivers run at once from `schedule.ready[]`. Plans in different PRs can run
  concurrently when their gates are satisfied. PR polish is driven from `toPolish[]`
  after every plan in that PR is implemented.

All three live in `session.json` and are per-invocation overridable.

## 12. Error model

- Stale `complete` (step ≠ pending for that scope) → exit 1, `{ "ok": false, "error":
"stale step" }`.
- Missing `contract.outputFile` / `--metadata` mismatch → exit 1.
- Per-call lock around `next`/`complete`, **released during blocking waits** so
  `status`/`diff` stay responsive.
- A crashed controller resumes by calling `next` for shared phases or `schedule` for the
  execution DAG frontier.
