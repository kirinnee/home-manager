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
2. **Codify everything deterministic — including detection.** State machine, replay,
   WAL, versioning/epochs, snapshot validation, artifact paths, prompt config + org
   overrides, kloop init, **and all watching/detection** (pulling PR conversations,
   CI/ready checks, polling, rebase-detection) stay in the binary at zero token cost.
   These run _inside_ `next`, which **blocks** while watching — there is no "pending"
   surfaced to the harness.
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
│   ONE flat session (= ticket). Phases run in order; repos fan out inside execution/polish:
│     plan:       triage → spec → plans(per repo)         (interactive, versioned artifacts)
│     execution:  per repo, parallel: implement plans via kloop | sub-agent → commit
│     polish:     per repo, parallel: PR → ready-to-merge  (CI green + threads resolved)
│     feedback:   (if feedback) full evolution phase → per-repo rules.md → next epoch (same PR)
▼
BINARY  (codified, zero tokens — one session, one WAL)
   next (BLOCKS on detection/watch) · complete · diff · runStateMachine resume · WAL ·
   snapshots/versioning/epochs · detection (poll/threads/ready/rebase) · artifact paths ·
   prompt config + org overrides · kloop init · per-repo registry in session state
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
  PR. Worktrees persist across epochs; cleanup happens only at the final fully-merged.
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
  "phase": "execution", "step": "resolve", "kind": "interactive",
  "repo": "infra",                 // set when the step is repo-scoped; null for plan/feedback
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

**Driving N repos.** Bare `kautopilot next` advances the shared phases (plan, feedback).
`kautopilot next --repo <repo>` drives one repo's execution/polish loop — so the
controller runs repos in parallel (bounded by `maxParallelRepos`), each in its own
sub-agent driver, reporting via `complete … --repo <repo>`. A repo driver that hits an
`interactive` step **returns it upward to the main chat**, which serializes such prompts
to the one user; other repos keep progressing on mechanical work meanwhile.

`kind` ∈:

- **`code`** — deterministic plumbing + all detection. **Never yielded**; the binary
  runs it (and blocks on watch loops) and moves on.
- **`interactive`** — needs the user (triage, spec, plans, resolve, tty_resolve,
  feedback). Run **inline**; serialized to the user (§7.2).
- **`agent`** — needs an LLM, not the user (reviewers, commit, eval, prereview,
  create_pr, write_fix, amend_plans, and per-repo implement when exec mode = sub-agent).
  **Always a fresh isolated sub-agent.**

### `kautopilot complete <step> [--output <path>] [--metadata <json>] [--repo <repo>]`

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
- **Execution mode** — how each repo's plan is implemented at the `running` step:
  `kloop` (default — multi-reviewer consensus loop) | `sub-agent` (implement the plan
  directly as one isolated sub-agent; lighter, for straightforward plans). Default
  `kloop`; per-invocation override; per-plan opt-in to `sub-agent` when triage tags the
  plan straightforward. Recorded in `session.json`.
- **Parallelism** — `maxParallelRepos` (default small, e.g. 2): at most N repo loops run
  concurrently; the rest queue. Bounds token consumption. Per-invocation override.

## 7. Phases (one flat machine)

### 7.1 plan (interactive; versioned artifacts) — runs once, repo-agnostic for spec

`resolve_org → [brainstorm? → create_ticket?] → fetch_ticket → triage → spec → plans`

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
- **plans** (interactive): plans written from the master spec, **tagged by repo** (each
  repo gets ≥1 plan), still vertical slices. Versioned. Followed by **plan review**.

Each of triage/spec/plans is an interactive debate producing **multiple versions**
(§8). Escalation `amend_spec` (plans found the spec wrong) bumps the epoch and re-runs
spec.

### 7.2 execution (per repo, parallel; interaction queued serially)

When plans are approved, the controller **seeds each repo** (a `code` step): create a
fresh **worktrunk worktree** for that repo (via `wt` — the same mechanism `/rc-session`
uses; one worktree per repo/"sub"), and commit `triage.md` + that repo's **own plans**
(+ the **whole master spec** when the org's `commitSpec` is true) as the **first commit**
on the repo branch. Then, for each repo (dependency order; independents in parallel),
drive its implement loop:

`clear_loop → setup_run → running → (resolve?) → (amend_plans?) → commit → next_plan`

- `running` is `kloop` (default) or a direct `sub-agent` (exec mode). Mechanical.
- These per-repo loops are dispatched as **parallel sub-agent/kloop jobs**, bounded by
  `maxParallelRepos`. They progress independently on `code`/`agent` work. The moment one
  needs an **interactive** step
  (`resolve`, `tty_resolve`) it is **queued**; the **main chat** drains the queue one at
  a time with the user, while other repos keep going. No two interactive prompts compete.
- **Who commits — only the dedicated `commit` sub-agent.** The **main controller agent
  never commits**, and **kloop never commits** (it implements/reviews only). After
  `running`/`run_fix` succeeds, the isolated
  **`commit` agent** does the commit (convention discovery + hook-repair). The binary's
  deterministic **seed-commit** (`code`) is the only non-agent commit. Mechanical
  push/rebase-detection is `code`. No LLM other than the `commit` sub-agent ever commits.

### 7.3 polish (per repo, parallel → ready-to-merge)

Per repo: `commit_pending → (prereview?) → push → create_pr → poll ⇄ (eval → act →
tty_resolve?/write_fix → run_fix → verify_fixes) → …`

- All detection is codified and **blocks inside `next`**: `poll` pulls CI status +
  conversation threads and decides readiness; `eval` (agent) judges each thread for
  false positives; `act` (code) applies replies/resolves; `write_fix`/`run_fix` drive a
  kloop fix cycle; `tty_resolve` (interactive, queued) handles conflicts/ambiguity.
- **`verify_fixes` (code) — reliability gate before pushing.** After fixes are applied,
  the next `next` **re-pulls the thread list / CI and re-checks that the applied fixes
  actually landed** — at least the **non-code** CodeRabbit fixes (replies posted, threads
  resolved) — _before_ committing/pushing. Reported-but-unverified actions **loop back**
  (re-`eval`/`act`) instead of pushing on faith. General principle: **codified detection
  re-verifies every harness-reported action — the binary never trusts "I applied it."**
- **Ready-to-merge** = CI green **and all conversations resolved**, **excluding**
  human-review approval. **PRs are NEVER merged** — `gh pr merge` is forbidden for every
  agent, kloop, and the binary. The user merges, always.

### 7.4 Review fan-out (spec & plans)

A review step's descriptor carries the **set** of reviewer prompts (8 spec / 5 plan) +
a **synthesize** prompt. The controller spawns reviewers as parallel isolated
sub-agents, runs synthesize into one numbered problem list, feeds it back into the
interactive writer. **Gate: every reviewer must approve** (harness-enforced — withhold
`complete` on the writer) unless the user explicitly overrides.

### 7.5 Epoch end (ready-to-merge gate)

- The epoch **ends when every PR — for every repo the plans touched — is ready to
  merge.** No cross-repo merge-gating; the user merges, on their own time.
- **feedback_check** (interactive gate): ask the user — feedback, or done?
  - **No feedback** → ask whether the PRs are **fully merged**. If the user confirms
    **"fully merged,"** run **cleanup** (a `code` step): remove this session's worktrunk
    worktrees (the binary never merges — it only tears down worktrees the user has already
    merged), then `completed`. If not yet merged, go `completed` but **keep the worktrees**
    (cleanup deferred until the user merges).
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
   polish's `create_pr` **updates the existing PR**. Worktrees persist across epochs
   (cleanup only at the final fully-merged).

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
- On repo **seed**, each involved repo's worktree gets, as its first branch commit:
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
    ├── session.json            # ticketId, org, epoch, runMode, execMode, repos[]
    ├── ticket.md               # fetched ticket (epoch-agnostic working copy)
    ├── revisions/{triage,spec,plans/<repo>,feedback}/   # versioned working artifacts (uncommitted)
    ├── artifacts/v<epoch>/     # frozen snapshots (existing scheme)
    └── tmp/kloop.pid
```

No `groups/` dir, no per-member session dirs. Committed artifacts live in each repo's
worktree (§9).

## 13. Binary changes (resolved decisions — these govern)

1. **One flat session machine.** Remove the group/member two-level design entirely.
   Repos are entries in `session.json.repos[]`; execution/polish steps are repo-scoped
   (descriptor carries `repo`). No `group` CLI namespace, no per-member session/WAL.
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
   `commit`/`commit_pending` stay **agent** steps; the rest of push/poll/act/rebase is `code`.
10. **Epoch ends when every PR (for every repo the plans touched) is ready to merge** —
    CI green + all threads resolved, **excluding human review**. No merge-gating between
    repos. Never merge.
11. **Parallel repos, serialized interaction.** Per-repo loops run in parallel as
    sub-agent/kloop jobs, **bounded by `maxParallelRepos`** (default small) to cap token
    use; a repo driver returns interactive steps upward to the main chat, which **queues
    and drains them one at a time** with the user.
12. **feedback → per-repo `rules.md`**: distilled, generalized, scope-reasoned,
    user-confirmed; linked from `CLAUDE.md`/`AGENTS.md`; injected into that repo's future
    prompts (`vars.rules`).
13. **Drop the ticket-delivery path** (`deliveryKind`, `ticket_draft/review/publish`).
    Every task is build → PR(s). Drop per-step run-artifact/transcript logging — git +
    the PR are the record.
14. **What stays as-is**: `runStateMachine` resume/replay, WAL reducer, versioning/epochs,
    `amend_spec`/`revisit_spec`, snapshot validation, artifact paths, `buildPromptVars` +
    per-org prompt overrides, kloop init/config. Only spawn call sites and the
    group/member + init machinery change.
15. **Brainstorm before ticket (ad-hoc only).** The no-ticket flow inserts an interactive
    `brainstorm` step (superpowers methodology: one question at a time, multiple-choice,
    explore the problem before solutions, 2–3 approaches with trade-offs) → `brainstorm.md`
    seeds `create_ticket`. Versioned. Skipped when a ticket is given.
16. **Only the `commit` sub-agent commits.** The main controller agent never commits, and
    **kloop never commits** (it implements/reviews only). Commits come from the isolated
    `commit`/`commit_pending` agent or the binary's deterministic seed-commit — nothing else.
17. **`verify_fixes` reliability gate.** Before pushing fixes, a `code` step re-pulls
    thread/CI state to confirm the (at least non-code) fixes landed; unverified actions
    loop back. Codified detection re-verifies every harness-reported action.
18. **PRs are NEVER merged** by any agent, kloop, or the binary; `gh pr merge` is
    forbidden. Ready-to-merge is the finish line; the user merges.
19. **Worktrunk worktrees + cleanup.** Each repo gets its own `wt` (worktrunk) worktree
    (the `/rc-session` mechanism). When the user reports **fully merged** with no feedback,
    a `cleanup` code step removes the worktrees; otherwise the worktrees are kept.
20. **Feedback / evolution is a full phase** — entered only when the user has feedback:
    feedback artifact → generalized per-repo `rules.md` → bump epoch → next epoch. With no
    feedback, the session completes (cleanup if fully merged).
21. **Epochs 2+ reuse the same branch + PR** per repo (no new PR/branch); fresh seed-commit
    per epoch on the existing branch, `create_pr` updates the existing PR; worktrees persist
    until the final fully-merged cleanup.

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
`resolve_org → fetch_ticket → triage → spec → plans → seed(worktrunk) → execution(kloop)
→ polish → ready-to-merge`.

**Phase 2 — artifacts, diffs, org/ticket.** `revisions/` snapshots for
triage/spec/plans/feedback + `kautopilot diff`; org config `liftoff|atomicloud` with
`commitSpec` + resolution precedence (`--org` → ticket → ask); ticket ops harness-side
(`jira|clickup|none`); drop `deliveryKind`/ticket-delivery and `removeSpecOnPush`.

**Phase 3 — quality + evolution.** Reviewer fan-out (all-approve) + synthesize;
`brainstorm` step (no-ticket, superpowers methodology); `verify_fixes` reliability gate;
feedback/evolution full phase → generalized per-repo `rules.md`; commits only via the
`commit` sub-agent / seed-commit; never merge.

**Phase 4 — multi-repo.** `next --repo`, `session.json.repos[]`, `maxParallelRepos`,
worktrunk worktrees, queued/serialized interaction, epochs 2+ reuse the same branch + PR,
`cleanup` on fully-merged.

**Tests.** Remove init/spawn-path tests; add coverage for `next`/`complete` describe-mode,
resume-after-kill idempotency, `create_ticket` dedupe, blocking-`next` detection,
versioned-artifact diff, and multi-repo `next --repo` + parallelism. Net suite green.

**Completion bar = §13 (all 21 resolved decisions) + §15 (every DoD bullet).** Done only
when all are implemented and the verify gate is green.
