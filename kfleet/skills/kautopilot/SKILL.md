---
name: kautopilot
description: 'Drive the kautopilot binary as a thin in-session controller: ticket/free-form request → merge-ready PRs across one or more repos, as ONE flat session. The binary owns all state, prompts, and next-step decisions; this skill just runs what `kautopilot next` yields. Use when running /kautopilot.'
argument-hint: '[TICKET_ID | "free-form request" | --org liftoff|atomicloud | --diff brainstorm|triage|spec|plan[:<repo>]|feedback | --session ID]'
---

# kautopilot — Thin Controller

This skill is a **thin driver**. It holds **no dispatch tables and no prompts** — the
`kautopilot` binary owns the state machine, the WAL, every step prompt, and the
decision of what's next. The skill's only job: ask the binary for the next step,
run it (inline if interactive, isolated sub-agent if not), and report completion.
**Detection is YOURS**: the binary does NOT watch CI, checks, or review threads —
you do that yourself while babysitting PRs during execution.

kautopilot is **one flat session** (= a ticket) that may touch several repos. Repos are
a detail, not a separate concept. Full contract:
`/Users/erng/.config/home-manager/modules/kautopilot-ts/CLI-CONTRACT.md` and
`…/SPEC-kautopilot.md`; this file is controller behavior only.

Supporting files (same folder as this skill): [`visual.md`](visual.md) — the full
HTML-infographic design brief; [`links-table.md`](links-table.md) — the exact
end-of-message links-table spec; [`relay.md`](relay.md) — the **deferred-writer
relay loop** (used when a descriptor carries `execution: "deferred"`).

## The loop

```
loop:
  d = json(`kautopilot next --json`)
  if d.done:                 # see "Reading `done`" — NOT always session-complete
      handle(d); break/continue accordingly
  if d.execution == "deferred":   # deferred writer step — do NOT run d.prompt
      follow relay.md VERBATIM: drive turns with `kautopilot relay` (parked in
      the background), present each envelope, complete after approval. The
      reviewer fan-out, visuals, spikes, and `revise` are the WRITER's job in
      this mode — never yours. Deferred mode needs **NO context reset** — the
      writer session holds the heavy context, so the main session stays lean;
      just continue the loop after the relay approval flow completes.
  elif d.kind == "interactive":
      run d.prompt INLINE; for WRITER steps run the per-revision loop below
      (reviewers → `kautopilot revise` to mint+present each version → user feedback)
  else:  # d.kind == "agent"
      run d.prompt in a FRESH context that writes d.contract.outputFile (see "By harness")
  kautopilot complete [--output d.contract.outputFile] [--metadata {…}]
      # --output ONLY when the contract HAS an outputFile (feedback_check has none)
      # feedback_check REQUIRES --metadata '{"choice":"feedback"}' or '{"choice":"done"}'
  if d.kind == "interactive" and the step was a WRITER (an approval gate):
      STOP the turn and hand the user the context reset (see "Context reset at
      every approval gate") — do NOT loop straight into the next `next`.
  else:
      continue the loop.
```

### Push a notification EVERY time you need the user (hard rule)

kautopilot sessions run long and the user steps away (often to their phone).
**Whenever the session transitions to WAITING ON THE USER — for anything at
all — send a push notification** (Claude: the `PushNotification` tool; Codex:
whatever notify mechanism the harness offers, else skip) in the SAME turn you
present the ask. One line, lead with what they must do. This includes (not
exhaustive — the rule is "any human input or human-relevant milestone"):

- a relay envelope lands with **questions** or a new **version to review/approve**
  (e.g. `spec v3 ready — 2 questions`)
- an inline writer version is presented for review/approval
- triage repo/path/branch confirmation, metadata confirmation, `feedback_check`
- a **kloop run finishes** (completed OR conflict/failed — e.g. `kloop api/plan-1
done — commit next` / `kloop conflict in web/plan-2 — needs your call`)
- a **conflict or decision** comes back from any sub-agent/driver
- **PR babysitting hits a problem** you can't fix (blocked CI, human-review
  thread, permissions) or a PR reaches **ready-to-merge** in `manual` mode
- a **merge/release gate** waits on the user; **feedback** is requested
- any error/remediation choice (e.g. deferred-writer failure options)

Don't push for things that need nothing from them (routine progress, a step you
immediately continue past). If in doubt whether they're waiting on you or you're
waiting on them — if it's the latter, push.

### How to run a fresh-context step/reviewer — kteam first

The binary loop above is harness-agnostic. **Default to kteam** for every
fresh-context run (agent-steps, reviewer fan-out): each is a detached
`kteam start` session on an auto-mode fleet wrapper, prompted to write
`d.contract.outputFile` and `kteam signal done`. Pick wrappers with
`kteam recommend` (usage-aware); fan out reviewers as parallel kteam sessions
and park on `kteam wait <id> --timeout ...`. This keeps the main thread lean,
survives harness restarts, and gets kteamd's auth/quota preflight and
stall/login-wall fail-fast for free.

Fall back to a native subagent (`Task`/`Agent` on Claude; delegated native
subagent on Codex) only when kteamd is unavailable or the step is too small to
justify a session (single quick read/summarize).
Interactive (`d.kind == "interactive"`) steps run inline either way.

Wherever this doc names a Claude-only tool, translate:

- **"spawn a `Task`/`Agent`/`Explore` subagent"** = start a fresh-context run —
  a detached kteam session by default (see above); `Task`/`Agent` on Claude or a
  delegated native subagent on Codex as the fallback.
- **"`AskUserQuestion`"** = Claude's structured question tool. On Codex: ask
  inline as a plain numbered question in the chat and wait for the user's reply.
- **"arm a `Monitor`"** = Claude's background watcher. On Codex: delegate a
  cheap, fast subagent that blocks on the command and returns its final line
  (see "Running kloop for a ready plan").

### The binary owns the sequence — you never track it

Do NOT name the step on `complete`: omit it and the binary completes whatever step
is actually pending (the WAL cursor is the source of truth). Do **not** remember
"what step I'm on", infer the next step, or skip ahead — that is exactly how the
loop corrupts itself. The ONLY way to learn the current step is `kautopilot next`;
the ONLY way to advance is `kautopilot complete`.

You may still pass the step name as an assertion (e.g. `complete write_spec`) if
you want the binary to confirm you're where you think — but a mismatch is an
error, not an override. **Step names are NOT artifact names.** The completable
step names are: `brainstorm`, `create_ticket` (ad-hoc only), `fetch_ticket`,
`triage`, `write_spec`, `write_master_plan`, `write_plans`, `feedback_check`,
`feedback`. (`resolve_org` and `finalize_plans` are internal `code` steps that
never yield.) So it's `complete write_spec`, never `complete spec`.

**Do whatever `next` says.** The descriptor's `prompt` is fully resolved (paths
substituted). `next` runs the binary's internal `code` steps inline and returns
the next interactive/agent step or a `done` shape; there is no `pending`. If the
session dies, or you lose track, or a `complete` comes back with
`ok:false`/`stale step`, **STOP and call `next` again** — it returns the exact
pending step until its `completionEvent` is logged. Re-sync from `next`; never
guess.

**Session lock:** if a command exits 1 with `Session <id> is busy (PID <n>)`,
another kautopilot invocation holds the session lock. Don't delete anything —
wait for it to finish and re-run. A stale lock (dead PID, or heartbeat older
than the TTL) auto-cleans on the next command, so a crash never wedges the
session; just retry after a moment.

### Context reset at every approval gate (REQUIRED)

After you `kautopilot complete` an **interactive writer step** (triage, write_spec,
write_master_plan, write_plans, feedback — anything the user explicitly **"approve"**d),
do **NOT** loop straight into the next `next`. **STOP the turn** and hand the user a
context reset — **every single approval gate, no exceptions**. Post exactly this
(substitute the real session id):

> ✅ **Approved & recorded.** To keep context lean for the next phase, run:
>
> ```
> /clear
> /kautopilot --session <id>
> ```

Then end the turn. Re-invoking with `--session <id>` re-enters this loop fresh and
drives `kautopilot next --session <id>`, which resumes at the exact pending step.

**Why this is safe (lossless).** All state lives on disk (the WAL + `revisions/`)
and every step's prompt re-reads what it needs as file paths (ticket, latest triage,
approved artifact). The conversation carries **nothing the next step needs** — keeping
it only burns tokens and rots context; clearing between gates loses nothing.

**Always print the explicit `--session <id>`** — never rely on bare `continue`/cwd:
one folder can host several sessions, so the id is the only reliable anchor across
a `/clear`.

**Make sure the approved decisions are in the artifact, not just the chat.** Before
you `complete`, confirm the agreed direction + open-items/assumptions are written into
the artifact file (the writer prompt already requires this) — anything that lived only
in the conversation is gone after `/clear`.

(Agent steps, the `code` steps, the DAG `schedule`/`record` loop, and **deferred
writer steps** do **not** stop for a reset — only the _inline_ interactive approval
gates do. Deferred mode keeps the main session lean by construction — the writer
holds the heavy context — so its approval gates need no `/clear` + resume.)

### Reading `done` — a `{done:true}` is not always "finished"

`next` returns either a step descriptor or `{done:true, phase, reason}`. Branch on
`phase`:

- **bare `next` → `phase:"execution"`** = the **plan→DAG handoff**. The master plan is
  approved; now **drive the DAG with `kautopilot schedule`/`record`** (see "Driving the
  DAG"). The reason string includes the current frontier. Do **not** stop and do **not**
  try repo-scoped `next` — that path has been removed. When `schedule` reports `allReady`,
  call bare `next` again — it advances to the feedback phase.
- **bare `next` → `phase:"done"`** = the session is truly complete. Report and stop.

The feedback-phase steps (`feedback_check`, `feedback`) arrive as **normal step
descriptors**, not `done` shapes. **`feedback_check` is the end-of-epoch fork** —
ask the user, then complete with an **explicit** choice:

```
kautopilot complete --metadata '{"choice":"feedback"}'   # start a new planning epoch
kautopilot complete --metadata '{"choice":"done"}'       # end the session
```

It has **no `outputFile`** (don't pass `--output`). The binary **rejects** a
`complete` without a valid `choice` — omitting the metadata is an error, never a
silent "done". Only choose `done` after the user confirms and all scheduled
merge/release work is recorded; on `done`, wrap-up (close ticket, clean worktrees)
is yours — see Rule 8.

(If a session has no master plan/orchestration, fix that plan artifact first. New
ticket-to-PR runs use the `schedule`/`record` DAG model.)

## Start

```
/kautopilot PE-1234                     → NEW session for this ticket (org detected from it)
/kautopilot "add dark mode to portal"   → ad-hoc: brainstorm (superpowers-style) → create_ticket first
/kautopilot --org liftoff "…"           → org passed explicitly (else detected from ticket, else asked)
/kautopilot                             → NEW session — ask what to build
/kautopilot continue                    → pick a session for THIS folder to resume (see below)
/kautopilot --session <id>              → resume THAT session directly (drive `next --session <id>`); this is what the post-approve `/clear` handoff tells the user to run
/kautopilot --diff spec                 → kautopilot diff spec  (what changed between versions; also brainstorm|triage|plan[:<repo>]|feedback)
```

**Default = a brand-new session. Only "continue" resumes.** Unless the user's message
says **continue** (or `--session <id>` is given), **always start a fresh session** — do
NOT auto-resume an in-progress one, even if one exists for this folder/ticket. When the
user **does** say "continue", resume per **"Continue (this folder)"** below.

Org is `liftoff` or `atomicloud`, resolved by `--org` → detect-from-ticket → ask.

**The canonical start invocation** (a new session runs this under the hood):

```
kautopilot start <TICKET_ID | "free-form request"> --org <liftoff|atomicloud> \
  [--merge manual|auto] [--max-repos <n>] \
  [--platform … --service … --landscape … --cluster … --module …] [--tag <t>]…
```

`--max-repos <n>` caps how many ready plans you run in parallel
(`maxParallelRepos`). The legacy `--exec kloop|sub-agent` flag still parses but is
**vestigial** — the DAG model ignores it (you always drive kloop yourself); don't
pass it.

**Merge policy (per session).** `mergeMode` is `manual` (default — drive PRs to
ready-to-merge and the user merges) or `auto` (the controller merges scheduled ready PRs to clear
downstream gates). Set it at start with `--merge auto|manual`, or confirm it in the
master plan. Either way ready-to-merge is always reached; `auto` is what lets
cross-repo `merged`/`released` gates progress without a human merge in between.
⚠️ **`auto` merges PRs no human has reviewed** — "ready" means CI green + actionable
(bot) review threads resolved, with NO human-approval gate. Only use `auto` when the
user explicitly accepts merging unreviewed PRs.

### Continue (this folder)

When the user says **continue** (with no explicit `--session <id>`), find the sessions
associated with the **current folder** and let them choose:

1. List candidates: **`kautopilot ps -a --folder "$(pwd)" --json`** — a session is tied to
   the **folder** it was started in (never a repo/worktree); `-a` includes stopped/completed,
   and `--folder` substring-matches each session's associated folder against the current
   directory (so a hub dir also catches sessions started in subfolders under it). If that
   yields nothing, fall back to `kautopilot ps -a --json` and match the current path yourself.
2. **0 matches** → tell the user there's nothing to continue here, and offer to start a new
   session instead.
3. **exactly 1 match** → confirm it (ticket + repo + phase), then resume: drive
   `kautopilot next --session <id>` per the normal loop.
4. **multiple** → present them via `AskUserQuestion` — one option per session showing its
   **id, ticket, repo, and phase** — and resume the chosen one with `--session <id>`.

(If the user said "continue" AND gave LPSM/tag words, use **"Resume (atomicloud LPSM)"**
below instead — that's the tag-filtered variant of the same pick-and-resume flow.)

**Launch from anywhere.** kautopilot need NOT be started inside a repo — the cwd can
be any directory (a hub) with access to many repos. You don't pre-pick a repo at start:
**triage** decides which repos the task touches, locates (or clones, with the user's OK)
each one, and records its absolute path (`repoPaths`); worktrees come later on demand
via worktrunk.

### After triage: confirm repos + paths, name the branch (REQUIRED)

Triage is interactive — before you `kautopilot complete` it, you MUST:

1. **Confirm the repo set + each path with the user.** Show, via `AskUserQuestion`, the
   exact list triage produced: every repo and its **absolute filesystem path** (the
   `repoPaths` you'll pass). The user must confirm these are the repos/paths to work on
   before any worktree is seeded — a wrong/missing path otherwise seeds a no-op repo.
   Fix or re-triage anything they correct. (These paths matter beyond worktrees: the
   feedback step appends confirmed rules to `<repoPath>/rules.md` — see "Feedback →
   `rules.md`".)
2. **Propose a branch name.** Derive an **apt, short** slug from the ticket title
   (e.g. "Add dark mode to portal" → `dark-mode`) and confirm it in the same question.
   The binary builds the final branch as **`<git-user>/<ticket-id>-<slug>`**
   (e.g. `kirinnee/PE-1234-dark-mode`) — the **same branch across all the task's
   repos**; you create each repo's worktree on it via worktrunk (`wt`) when `schedule`
   makes a plan ready. You only supply the slug — the binary fills in the `<git-user>/`
   prefix and the `<ticket-id>` automatically. When showing the proposed branch, make
   clear the `<ticket-id>` part is the session's ticket reference (a variable prefix,
   e.g. `PE-1234`), not a literal word — only the slug is theirs to choose. (No ticket
   id → it falls back to a literal `ticket-` prefix.)

Then complete triage passing the confirmed values, including the slug:

```
kautopilot complete --output <triage> --metadata '{"complexity":"straightforward|moderate|complex","repos":[…],"repoPaths":{…},"dependsOn":{…},"branchSlug":"dark-mode"}'
```

`branchSlug` is marked optional in the schema, but treat it as **effectively
required**: without it the binary records `branch: null` and nothing else ever
names a branch — you'd be left inventing one yourself at `wt` time. Always
confirm and pass a slug.

### LPSM service-tree tags (atomicloud only)

At start, for **atomicloud only**, derive the AtomiCloud LPSM service-tree from the
ClickUp ticket and tag the session with it (liftoff: skip LPSM entirely):

- The ticket's **Space = Platform** (functional-group theme, e.g. `nitrite`).
- Infer **Service** (element/periodic-table theme, e.g. `neon` — typically from the
  repo/component), **Landscape** (env, Pokémon theme, e.g. `pichu`=dev) and **Module**
  (free-form, e.g. `api`/`worker`) when evident.
- **Confirm with the user via `AskUserQuestion`**: show the derived L/C/P/S/M and let
  them correct any tier before proceeding.
- Then pass the confirmed values to start:
  `kautopilot start … --platform <p> --service <s> [--landscape …] [--cluster …] [--module …]`.

All flags are optional; only pass the ones you have. They are harmless for non-atomicloud
sessions but you only set them for atomicloud.

Besides the structured LPSM tiers, a session can also carry **free-form tags** via
repeatable `kautopilot start … --tag <t>` (any org). These are arbitrary labels (e.g.
`urgent`, `spike`) distinct from LPSM.

## Resume (atomicloud LPSM)

When the user asks to resume by service-tree words — e.g. "resume a nitrite session" or
"resume a nitrite neon session" — treat each word as an LPSM **tag value** and find the
matching session(s):

1. List with tags: `kautopilot ps -a --tag <w1> [--tag <w2> …] --json` (or
   `kautopilot ps -a --json` and match yourself). Tag-filtering implies considering all
   sessions, not just running ones.
2. Use the themes to reason about tiers (but ultimately match against each session's
   stored `lpsm`): periodic-table **element → Service** (neon, carbon…); **functional
   group → Platform** (nitrite, sulfoxide…); **Pokémon → Landscape** (pichu, pikachu…);
   **gemstone → Cluster** (diamond, ruby…).
3. **Matching rule:** a tag matches if its value (case-insensitive) **equals** — or,
   failing exact, is a **substring of** — ANY lpsm field value
   (landscape/cluster/platform/service/module) OR any free-form `tags[]` entry. With
   multiple `--tag`s, **ALL** must match (each somewhere).
4. Then: **1 match** → resume it (drive `kautopilot next --session <id>` per the normal
   loop); **multiple** → list them (ticket + L/P/S) and ask via `AskUserQuestion`;
   **none** → tell the user nothing matched.

## Driving the phases (one flat session)

- **Plan + feedback (shared phases)** — drive with bare `kautopilot next` / `complete`
  (triage → spec → master_plan → plans; later, feedback). Same loop as above.
- **Execution (the DAG)** — after the master-plan handoff (see "Reading `done`"), YOU
  drive it: **kautopilot is a record-keeper + scheduler only.** You run kloop, resolve
  conflicts, open/merge PRs per `mergeMode`, do all CI/review-thread detection, and
  `record` each transition — per "Driving the DAG" below. When `schedule` reports
  `allReady`, bare `next` advances to the **feedback** phase.

## Driving the DAG (execution + PRs) — `schedule` + `record`

The master plan is a **multi-stage DAG** of plans grouped into PRs, with gate-leveled
edges. You drive it; the binary tells you what's runnable and tracks progress. Loop:

```
loop:
  s = json(`kautopilot schedule --json`)
  if not s.ok: STOP — surface s.error (usually: no master plan approved yet)
  if s.done or s.allReady:
      `kautopilot next --json`           # → feedback_check
      break
  # 1. RUN ready plans (deps satisfied), up to maxParallelRepos at once.
  for plan in s.ready:
      provision/locate the repo's worktree off the LATEST base (worktrunk `wt`); keep its ABSOLUTE path
      `kloop init --workspace <ABS-worktree> --spec <plan>`  # ABSOLUTE path, never CWD-relative; prints the Run ID
      `kautopilot record started --repo <r> --plan <p> --kloop <runId>`
      `kloop run -d <runId>`; park on `kloop wait`; RESOLVE CONFLICTS yourself
      on success: commit (the commit sub-agent), then
      `kautopilot record implemented --repo <r> --plan <p>`
      (on an unrecoverable failure: `kautopilot record failed --repo <r> --plan <p>`)
  # 2. POLISH PRs from the schedule's PR frontier.
  for p in s.toPolish:
      if p.status == pending:
          open that PR on p.branch
          `kautopilot record pr-opened --pr <p.pr> --number <n> --url <u>`
      babysit the PR to ready-to-merge (CI green + all actionable review threads resolved)
      `kautopilot record pr-ready --pr <p.pr>`
  # 3. MERGE the PRs the schedule says must merge before feedback.
  for m in s.toMerge:
      if m.gate == "merged":
          if mergeMode == auto, merge PR m; if manual, ask/wait for the user merge; then
          `kautopilot record merged --pr <m.pr>`
      if m.gate == "released":
          wait for the release to publish + CI/CD, then
          `kautopilot record released --pr <m.pr>`
  # recording a merge/release re-opens the frontier → next loop runs newly-ready plans
```

- **`schedule --json` returns** `{ ok, ready[], running[], blocked[], toPolish[], toMerge[],
allReady, done, mergeMode }` — or `{ ok:false, error }` (still **exit 0**, e.g. before a
  master plan exists), so **check `ok` first**; never iterate fields of an `ok:false`
  payload. `ready` = run now. `toPolish[]` = PRs whose plans are
  implemented and whose PR polish is not complete (`pending` means open the PR; `open`
  means keep fighting CI/CodeRabbit/review threads). `toMerge[].gate` = `merged` or
  `released`; `toMerge[].unblocks` = which downstream plans that gate frees (gate-clearing
  entries are listed first; terminal ready PRs may also appear). `allReady` is true only
  after no scheduled merge/release remains — it already implies `toMerge` is clear.
  `blocked[].waitingOn` = why a plan waits.
- **Parallelism** — run up to `maxParallelRepos` ready plans at once (each as a sub-agent
  driver); the rest wait. **Serialize user interaction** to the main chat (a conflict that
  needs a human decision comes back inline, one at a time).
- **You own the worktrees now.** Provision each repo's worktrunk worktree (`wt`) off the
  **latest base** before running a plan — for a `merged`/`released`-gated plan the schedule
  only makes it `ready` after the upstream is merged/released, so the base already contains
  the upstream work. Bad/missing repo path → stop and tell the user; don't run on nothing.
- **Multi-PR per repo is real here** — open exactly the PRs the master plan lays out
  (`record pr-opened --pr <id>` per PrPlan), then run the PR polish loop inside that PR
  and record `pr-ready` only after CI is green and actionable review threads are resolved.
  Merge them per their gate after `schedule` lists them in `toMerge`.
- **Resumable any time** — `schedule` recomputes purely from what you've `record`ed, so a
  killed/auto-resumed session just calls `schedule` again and continues from the frontier.

## Per-`kind` execution

- **`code`** — never appears. The binary ran it inline.
- **`interactive`** (brainstorm, triage, write_spec, **write_master_plan**, write_plans, feedback_check, feedback, **create_ticket**) —
  run **inline** in the main session. Be a **devil's advocate**: propose first, debate,
  surface conflicts; never open with "what do you want to do?" For the **writer artifacts**
  run the **per-revision review loop** below (it defines the approval gate — the ONLY way
  a writer step advances). Spawn `Explore` subagents for heavy research so the
  conversation stays lean.
  - **`create_ticket`** is interactive but NOT a revise-loop artifact: its prompt says to
    **draft the ticket, show it, and get explicit confirmation before creating** — do that
    inline (a subagent can't talk to the user), then run the creation command and `complete`
    with the `ticketId`. (Don't spawn a subagent for it.)
  - **`feedback_check`** is a single fork question, not an artifact — see "Reading `done`"
    for its required `choice` metadata.
  - **`write_master_plan`** is the **orchestration artifact**, presented and approved
    **before** `write_plans` (it locks the order of execution first). Run the normal
    per-revision loop (revise → visual → present → approve). It must lay out: the **PR/branch
    layout** (**default ONE PR + ONE plan per repo** — kloop handles a substantial change in
    one pass; split into more plans/PRs only for separate repos, a real merge/release ordering
    gate, a change too big for one kloop run, or independently-releasable units — give each PR
    an id, repo, branch, title, and the `plan-<N>`s it ships); the **dependency DAG with gate levels**
    (`completed` | `merged` | `released`, edges may span repos); and a **mermaid `graph TD`**
    of the DAG (the dashboard renders it). Confirm the **merge policy** (`manual` asks before
    merging / `auto` merges ready PRs — see the ⚠️ in "Start") here too. On approval,
    `complete write_master_plan` with
    metadata `{ mergeMode?, prs[], nodes[], deps[] }` — the binary freezes it into
    `orchestration.yaml` (the resumable record that also tracks each plan's exec status + kloop
    run). The `plan-<N>` ids you choose here are the ids `write_plans` then writes bodies for.
  - **`write_plans`** writes one FOLDER per plan. Every plan folder MUST be named
    `plan-<N>` or `plan-<N>-<short-slug>` (the literal **`plan-<N>` prefix is required**,
    e.g. `plan-1`, `plan-2-api`). That ordinal is what the schedule/record execution loop
    uses to match each plan to the master plan's ids — a folder without the prefix (e.g.
    `auth/` or `1-auth/`) still gets picked up off disk, but its id never matches the
    master plan, so `schedule`/`record` reject it and the dev loop fails to init. If the
    plan-writer proposes a breakdown with non-conforming folder names, correct it before
    approving.
- **`agent`** (fetch_ticket, plus the skill-owned kloop/commit/PR-polish agents you spawn
  from `schedule`) — **always** a fresh isolated run, never inline: a detached kteam
  session by default, `Task` subagent as fallback. (The reviewer fan-out isn't a step —
  it rides on the write_spec/write_plans interactive steps and you spawn each reviewer
  as its own kteam session.)

### Running kloop for a ready plan (you drive it)

In the DAG model the binary does **not** run or watch kloop — YOU drive it. **Do NOT bury the
whole run inside one subagent** (the classic mistake: a subagent blocks on `kloop wait` and
dies at the Bash ~10-min cap, orphaning the daemon and recording nothing). `kloop init` /
`record started` / `kloop run -d` are all **instant** — `run -d` is a daemon that returns
immediately and logs to its own files, so there is **nothing noisy to hide**. So: the **main
thread runs steps 1–3 directly**, then **parks on the wait** (step 4), and only the **commit /
PR-polish are subagents** (step 5). For each `ready` plan from `kautopilot schedule`, in the
repo's worktree (off the latest base):

> ⚠️ **`--workspace` MUST be an ABSOLUTE path.** This bug has burned us many times.
> `kloop init` falls back to the current directory when `--workspace` is missing OR
> relative (`path.resolve(opts.workspace ?? process.cwd())`), and the Bash CWD is the
> session's launch/hub dir that **resets between calls** — so a relative/omitted workspace
> inits the run in the HUB, not the repo, and the whole plan runs on the wrong tree.
> **`direnv exec <dir>` does NOT help** — it loads that dir's env but does not change the
> working directory. Capture the absolute path `wt` prints and pass it verbatim — an
> absolute `--workspace` makes CWD irrelevant. (`cd` works, but CWD resets between Bash
> calls, so relying on it is fragile — the absolute path is the robust fix.)

1. `kloop init --workspace <ABS-worktree> --spec <plan>` → note the Run ID it prints.
   `<ABS-worktree>` = the **absolute** path `wt` printed for this repo; confirm it exists
   (`test -d`) before init. If you only have a relative path, make it absolute first —
   never pass a bare/relative workspace.
2. `kautopilot record started --repo <r> --plan <p> --kloop <runId>`.
3. `kloop run -d <runId>` (**daemon** — output goes to kloop's logs, not your context).
4. **Wait for the run WITHOUT polling.** `kloop wait <runId>` blocks until the run is
   **terminal** (completed / conflict / failed / cancelled / crashed) and streams **one
   line per status/phase change** — a poll→stream conversion. **Never** sit in a
   `kloop status` poll loop (that burns tokens every tick). How you park on it differs by
   harness:
   - **Claude:** arm a **`Monitor`** with `command: kloop wait <runId> --json` — one event
     per phase change, and the monitor **ends itself** when the run goes terminal. Keep
     working (hand other `ready` plans off in parallel); the terminal event wakes you. Use
     a long `timeout_ms` (kloop runs take many minutes) or `persistent: true`.
   - **Codex (no `Monitor`):** delegate a **cheap, fast subagent** (smallest/cheapest model)
     whose only job is to run `kloop wait <runId>` and return the final status line — the
     **main thread parks on that subagent** (not polling), resuming when it returns. A cheap
     model is fine; it only relays kloop's terminal state. **For parallelism** (several
     `ready` plans at once), delegate one wait-subagent per run **in parallel** via Codex's
     native multi-agent delegation and resume as each returns — don't serialize the waits
     unless you want to.

   Once `kloop wait` returns terminal, read `kloop describe <id>` once for a summary.

5. **You decide + handle the outcome** (the binary won't): completed → commit (commit
   sub-agent) → `kautopilot record implemented`. Conflict / max-iter → **resolve it
   yourself** (or bring a genuine human-decision conflict back to the main chat), then
   re-run / commit. Unrecoverable → `kautopilot record failed`.

kloop still **never commits** (implements/reviews only) — the commit sub-agent commits.
Then `record implemented` so the scheduler advances the DAG.

## Reviewers run BEFORE you present (fan-out)

When the writer descriptor (write_spec / write_plans) carries `review`, run the
reviewers **before** you present a version to the user — so every version the user
sees is already review-checked. On your working draft: spawn **every reviewer** as
a parallel sub-agent, run the **synthesize** sub-agent into one numbered list, and
fix the draft until **all reviewers approve** (or the user overrides via
`complete … --metadata '{"reviewOverride": true}'`). **Reviewer rounds are NOT
versioned** — they refine the draft in place. Only once it's review-clean do you
mint the version (`revise`, below) and present it. There is no separate
`spec_review` / `plan_review` step.

**For spec and plans, the checkpointer litmus test (below) is a REQUIRED review
lens** — a litmus failure blocks the version, same as any other unresolved finding.

## Each user presentation = a new version (`revise`)

A version is a **snapshot the user was shown.** Every time you present a writer
artifact (brainstorm, triage, spec, plans, feedback) to the user, it must be a
**new version** — never silently overwrite what they already saw. The binary mints
versions; you never pick numbers or hand-build URLs:

1. To present, run **`kautopilot revise [--repo <repo>]`**. It returns
   `{version, path, url, diffUrl, visualUrl}`. The binary handles version numbers: the
   **first** call presents the step's working copy as-is (**v1** — no redundant duplicate);
   each **later** call (after the user's feedback) copies the last-shown version forward
   (`vN → vN+1`) so the version they already saw is preserved. So: just run `revise` once
   per presentation round and trust the `version`/`url`/`visualUrl` it hands back.
2. Edit the returned **`path`** to address the user's latest feedback (reviewer
   rounds first, per above — those don't mint versions).
3. **Generate the visual** for THIS version BEFORE presenting — see "Generate the
   visual" below (required, non-skippable; confirm the HTML file(s) exist or the
   **Visual** link will 404).
4. **Present the link(s)**, not the file — the **Read** (markdown) and the **Visual**
   (infographic):
   - **Read**: the returned `url` (or `diffUrl` to show what changed).
   - **Visual** (single-file artifacts): the returned **`visualUrl`** — a standalone
     full-page infographic that links back to the Read view.
   - **Plans**: present just the **Read** link (`url`). `revise` returns no `visualUrl` for
     plans — each plan has its own infographic, reachable from a **"View visual"** link on
     that plan's tab in the dashboard.
     Never construct a version URL yourself — always use exactly what `revise` returns.

**Viewer base URLs** — `revise` already returns FULL URLs (host included), so use its
`url`/`diffUrl`/`visualUrl` verbatim. For the links you DO build by hand (ticket, plans
listing, kloop run), read the configured host — **never hardcode a domain**:

- `kautopilot config --field viewerBaseUrl` → this dashboard's base URL
- `kautopilot config --field kloopBaseUrl` → the **kloop** dashboard's base URL

(`kautopilot config` with no flag prints the whole resolved config as JSON. The binary
has localhost fallbacks, but the user runs a public domain set in
`~/.kautopilot/config.yaml` — so always read the config, don't guess.)

The viewer must be running (`kautopilot dash up` / `kloop dash up`) for links to load;
it shows the session's current epoch. Revisions are machine-local and never committed.

### Generate the visual (HTML infographic) — a sub-agent, every version

Before presenting **each** artifact version, spawn a fresh isolated `Task` sub-agent to
produce a **visual, infographic-style** HTML version of the same content — one `vN.html`
next to each single-file artifact's `vN.md`, and for **plans** one sub-agent per plan
(each writes its own `<plan>/vN.html`), spawned in parallel. Required for **every**
version of **every** artifact; confirm the file(s) exist before presenting.

**The full design brief is in [`visual.md`](visual.md)** — hand the sub-agent that
brief (its path or contents) plus the two inputs it needs: the `path` that `revise`
returned and the Read URL (`revise`'s `url`) to use verbatim as the source link.
Spawn with the `Task` tool (`subagent_type: general-purpose`); it should use the
`frontend-design` skill if available, else apply the brief's principles directly.

## The per-revision review loop (the approval gate)

Every interactive writer artifact is **iterated until the user has no more
feedback** — never auto-advance after one draft. A new version is NOT approval;
it's the start of another review round. For a single artifact step, loop like this
and do **not** `complete` (which lets the binary move to the next step) until the
user explicitly approves:

1. **Draft / update** the working version, then run the **reviewers** (above) and
   fix until review-clean — these rounds are not versioned.
2. **Mint + generate visual + present** — exactly per "Each user presentation = a new
   version" above (`revise` → `vN.html` visual(s) → Read/Visual links). Add a **2–4 line
   summary** of what changed and a short **TODO / open-items** list (what's unresolved,
   and which of the user's last feedback this version did / did NOT address).
3. **Ask** for feedback or approval.
4. **Any feedback = not approved.** Address it → `revise` again → that's the next
   version → go back to step 2. Keep looping: v2 ok? → feedback → v3 ok? → …
5. **Only advance on an explicit "approve".** Move to the next step (`kautopilot
complete`) ONLY after the user literally says **"approve"** (that specific word) for
   the CURRENT version, with open-items empty. Anything short of that — silence, "looks
   good", "nice", a new question — is **not** approval; stay in the loop. (For **triage**
   and **spec** the bar is stricter — see **"No open questions or risks"**: every open
   question must be **user-answered** and every spec risk resolved, and you **spike**
   anything investigable rather than asking. Don't `complete` with items still open even
   on an explicit "approve".)

This section is the **one canonical approval rule** — wherever this doc says "after
explicit approval", it means step 5 here.

**Re-present after EVERY interaction — including `AskUserQuestion`.** Any time you turn
back to the user mid-artifact — even to ask a clarifying question via the question tool —
you must **re-present the current version** (both Read + Visual links + summary) in that
same message. Never ask a question without the live version in front of them, and never
treat a question's answer as approval. Only the explicit word "approve" advances the step.

**Don't assume a later revision's content propagates.** The next step consumes the
artifact at a **specific path** the binary picks (usually the latest version). Before you
`complete`, make sure the **approved content actually lives where the next step will read
it** — if you edited a higher version (e.g. v2) but the next step is wired to read an
earlier one, the downstream step silently uses stale content. When in doubt, confirm the
latest version holds the approved text.

## No open questions or risks — triage + spec gate (REQUIRED before approval)

**Triage and spec are not approvable while anything is still open.** Before you
`kautopilot complete` either step, drive every unknown to closure. Two kinds:

- **Needs investigation → SPIKE it (don't defer, don't ask).** Anything answerable by
  _looking_ — how does X work, does this API/field exist, where's the call site, is this
  approach feasible — is NOT an open question, it's a **spike**. Spawn a fresh-context
  spike sub-agent (Claude: an `Explore`/`Task`; Codex: a delegated read-only subagent) to
  actually investigate the code/docs/APIs, and **fold the finding into the artifact**. Keep
  spiking until only genuine decisions remain. Never hand the user a question you could have
  answered yourself.
- **Needs a human decision → the USER must answer it.** Whatever genuinely needs the user
  (a product/scope/trade-off call you cannot resolve by looking) stays an explicit **open
  question** in the artifact, and **every one must be answered by the user** before you
  `complete`. List them, get the answers, write the answers into the artifact, re-present.

**Spec additionally has zero unaddressed risks.** Every risk the spec — or its reviewers —
identifies must be explicitly resolved with the user (answered, accepted, or mitigated **in
the text**) before approval. A known-but-unhandled risk blocks approval exactly like an
open question.

**The gate (hard):** for triage and spec, "open-items empty" is mandatory, not aspirational.
Do **NOT** `complete` while any open question, un-run spike, or (spec) unmitigated risk
remains — **even if the user says "approve"**. If they approve with items still open, surface
the remaining items and ask them to resolve each one first, then advance. Surface the open
list every time you present (it's part of the per-revision "open-items" summary).

(This is controller-enforced gating. The literal triage/spec **prompt text** is owned by the
`kautopilot` binary — if you want the binary itself to emit "spike it / answer all open
questions" in the step prompt, that change lives in the step prompts under
`/Users/erng/.config/home-manager/modules/kautopilot-ts/src/steps/` — not here.)

## Litmus test — will it run to completion unattended? (spec + plans)

Before approving **spec** and **plans**, run the **checkpointer litmus test** on the artifact:

> If a kloop **implementer + reviewer** — **neither of which may ever commit, push, or open a
> PR** (those are the controller / commit-subagent's job) — ran this to the end, would the
> Definition of Done (DoD) / verification criteria **eventually** be satisfiable? Or is there
> a **fundamental logic flaw or blindspot** that traps the loop forever?

kloop is autonomous: it implements + self-reviews against the DoD until the DoD passes. If
the DoD can **never** pass, kloop spins to max-iter and needs a human — the litmus test
catches that **before** approval so the run stays hands-off. Two failure classes:

1. **Unsatisfiable DoD — capability / permission gap.** The DoD requires an action the loop
   cannot perform, or a resource that doesn't exist, so the implementer can **never** clear it.
   - "The implementer commits / pushes / opens the PR" — implementers **never** commit (the
     commit subagent does). → reword the DoD to be verifiable from the **working tree**
     (files changed, tests/build pass), not from a commit/PR.
   - "ssh into the DigitalOcean box and run X" — the box doesn't exist / the loop has no
     creds. → provision/verify out-of-band (a controller step), or drop it from the loop's DoD.
2. **Logical conflict — two criteria that can't both hold.**
   - "Remove all container/docker logic; **verify** by grepping `container` → must not
     exist" — but integration tests use **testcontainers**, so the grep is never empty. →
     scope the check (grep only infra dirs / exclude test deps) or change the criterion.
   - "**Do not change any existing code** + reach **100% coverage**" — unreachable code makes
     100% impossible without deletion. → relax one (allow deleting dead code, or target < 100%).

When the litmus test fails it's a **fundamental flaw** — treat it like an open question/risk
(per the gate above): fix the spec/plan **with the user** (loosen the verification, make the
DoD tree-verifiable, move the impossible action to a controller step, resolve the
contradiction) and do **not** approve until it passes clean. Apply it to **spec** (is the
overall DoD satisfiable + self-consistent?) and to **each plan** (can this plan's slice reach
its own DoD unattended under kloop's constraints?). It's a **required lens** in the reviewer
fan-out, not optional.

## Feedback → `rules.md`

At `feedback` (a versioned artifact), don't apply feedback literally. Distill candidate
**rules**, reasoning about scope (task- vs repo-specific; code-writing vs
solution-thinking) and generalizing; confirm with `AskUserQuestion` (show a `rules.md`
diff). Then you **must `complete` the step with metadata `{ "rules": ["…", …] }`** —
that metadata is the ONLY way rules are recorded (omit it and nothing is written).

How persistence actually works:

- The binary appends each rule as a bullet to **`rules.md` in each repo's recorded
  path** — the repo's `worktree` if one was recorded, else the `repoPath` captured at
  triage. It creates the file (with a `# Rules` header) if missing.
- `rules.md` is a **plain, standalone file** — the binary does NOT link it from
  `CLAUDE.md`/`AGENTS.md`. If the user wants agents to load it automatically, wire
  that reference up yourself (with their OK) as part of the repo's changes.
- If **no repo has a usable path**, the `complete` **fails loudly** and nothing
  advances: write the rules into each repo's `rules.md` yourself, then re-run
  `kautopilot complete` **without** the rules metadata.

## End every message with a links table

**End EVERY message that presents artifacts with one SIMPLE, FLAT summary table of
ALL the session's shareable links** — one row per thing, the label IS the link, never
a two-column Read|Visual layout. **The exact layout, row inventory, URL-building
rules, and a concrete example are in [`links-table.md`](links-table.md) — follow it
verbatim.** Key invariants: read `viewerBaseUrl`/`kloopBaseUrl` from
`kautopilot config --field …` (never hardcode a domain); never hand-build version
URLs (use `revise`'s returned `url`/`diffUrl`); if there is genuinely nothing to
link yet, say so in one line instead of an empty table.

## Rules

1. **Only merge when scheduled — and the epoch ends at merged/released, not "ready".**
   Ready-to-merge (CI green + all actionable threads resolved, excluding human-review
   approval) is the controller's **floor** — you always drive every PR there. But the
   epoch is only over when **every PR is merged/released as the master plan schedules**:
   `allReady` stays false while any scheduled merge/release is outstanding. `mergeMode`
   decides ownership: in `manual`, ask/wait for the **user** to merge (never merge
   yourself); in `auto`, the controller may merge only PRs returned by `schedule.toMerge`
   (⚠️ unreviewed by humans — see "Start"). Always record the result with `kautopilot
record merged --pr <prId>`; if `toMerge[].gate` is `released`, wait for the release
   boundary and record `kautopilot record released --pr <prId>`.
2. **Never push to `main`/`master`;** never force-push except `--force-with-lease`.
3. **Poll with `gh api graphql`**, never blocking watchers (`gh pr checks --watch`, `gh run watch`) — CI/thread detection is YOURS
   during PR babysitting; the binary does not watch anything.
4. **Ask before cloning** a repo.
5. **Only `complete` after the contract is satisfied** — and, for interactive steps,
   after explicit approval per "The per-revision review loop". The binary checks the
   artifact; you guarantee consent.
6. **Bot signature** on PR replies: `"By Claude Code kautopilot 🤖"`.
7. **Never hand-edit binary state** (`~/.kautopilot/…`). Update the ledger only via
   `record` (and drive via `next`/`complete`/`schedule`); read via `diff`/`status`/`schedule`.
8. **You drive the work; the binary records it.** In the DAG model YOU provision worktrees
   (worktrunk `wt`), run kloop, resolve conflicts, open PRs, and merge them — and `record`
   each transition (`started`/`implemented`/`pr-opened`/`pr-ready`/`merged`/`released`/`failed`).
   **You never commit by hand**; use the commit subagent after kloop completes. Wrap-up is
   skill-owned: after final `feedback_check` says `done`, close the ticket and clean up
   worktrees yourself if appropriate. The binary no longer yields `close_ticket` or `cleanup`.

## Prerequisites

- `kautopilot` + `gh` CLI in PATH and authenticated; `kloop` (you drive it yourself
  during execution — the legacy `kautopilot start --exec kloop|sub-agent` flag is
  vestigial and ignored in the DAG model).
- Jira: `acli` authenticated. ClickUp: the **`cup` CLI** (`ClickUp CLI for AI agents`) —
  prefer it over any ClickUp MCP for reading/creating tickets (`cup task <id>`, `cup create`,
  `cup subtasks`/`cup activity`).
