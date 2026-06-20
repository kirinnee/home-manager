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
kloop init, seed-commit, push, poll, WAL writes, version/epoch bookkeeping, **and all
blocking detection**) and advances.

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
| `code`        | the binary, inline (**never yielded**) | finalize_spec, seed-commit, kloop init, push, poll, act, ensure_branch, verify_fixes, next_plan, cleanup                                       |
| `interactive` | harness, **inline**, serialized        | brainstorm (ad-hoc), triage, write_spec, write_plans, resolve, tty_resolve, feedback                                                           |
| `agent`       | harness, **isolated sub-agent**        | create_ticket, fetch_ticket, commit, eval, create_pr, prereview, write_fix, amend_plans, reviewers, per-repo implement (exec mode `sub-agent`) |

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

The controller spawns reviewers as parallel isolated sub-agents, runs **synthesize**
into one numbered problem list, and feeds it back into the interactive writer
(`write_spec`/`write_plans`). The gate is **harness-enforced**: withhold `complete` on
the writer until **every reviewer approves**, unless the user overrides
(`--metadata '{"reviewOverride": true}'`). `kautopilot spec-review` / `plan-review`
remain for manual one-shot use.

---

## 5. Versioned artifacts & diffs

triage / spec / plans / feedback are each iterated through many **versions**; every
proposed version is snapshotted into the session store and diffed against the previous,
so the user reviews **what changed**, not the whole doc.

```
kautopilot diff <artifact> [--from <n>] [--to <n>] [--session <id>]
   artifact ∈ triage | spec | plan[:<repo>] | feedback
   default: latest two versions (n-1 → n)
```

- Revisions live at `~/.kautopilot/<sessionId>/revisions/{triage,spec,plans/<repo>,feedback}/`.
- A `code` snapshot fires automatically inside `complete` when the descriptor carries
  `contract.snapshot`; `next` may include the latest diff inline (`vars.lastDiff`).
- **Machine-local, never committed.** Only the final approved version is committed (§ on
  commit policy below). Reuses the existing `snapshot` / `artifact-versioning` machinery.

---

## 6. State, WAL & resume (reused — one session)

- **One WAL** per session: `~/.kautopilot/<sessionId>/log.jsonl`. `LogEntry =
{ts,event,version?,attempt?,plan?,repo?,result?,metadata?}` — execution/polish events
  carry `repo`.
- **Replay**: `ensureStatus` lazy incremental replay (`walCursor` in `status.yaml`)
  materializes `phase/step/version/context` and per-repo progress.
- **Per-repo state** lives in `session.json.repos[] = { repo, worktree, branch, plans[],
dependsOn[], prUrl, status }`. There is no per-repo WAL.
- **Describe-mode** uses **split handlers**: `prepare(ctx) → StepDescriptor | null`
  builds the prompt + emits `:started`; `finalize(ctx) → nextStep` runs inside
  `complete`, deterministically.
- **Crash recovery** rolls a half-done step back to its checkpoint before `next`
  re-yields it.

---

## 7. Session & repo commands

```
kautopilot start [TICKET_ID | "request"] [--org liftoff|atomicloud]   # convenience: init session + invoke default harness
kautopilot next [--repo <repo>] [--json]                              # the driver (§2)
kautopilot complete [step] [--repo <repo>] …                          # advance; step optional (§3)
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
