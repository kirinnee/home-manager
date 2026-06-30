---
name: kautopilot
description: 'Drive the kautopilot binary as a thin in-session controller: ticket/free-form request → merge-ready PRs across one or more repos, as ONE flat session. The binary owns all state, prompts, detection, and next-step decisions; this skill just runs what `kautopilot next` yields. Use when running /kautopilot.'
argument-hint: '[TICKET_ID | "free-form request" | --org liftoff|atomicloud | --diff triage|spec|plan|feedback | --session ID]'
---

# kautopilot — Thin Controller

This skill is a **thin driver**. It holds **no dispatch tables and no prompts** — the
`kautopilot` binary owns the state machine, the WAL, every step prompt, all detection,
and the decision of what's next. The skill's only job: ask the binary for the next step,
run it (inline if interactive, isolated sub-agent if not), and report completion.

kautopilot is **one flat session** (= a ticket) that may touch several repos. Repos are
a detail, not a separate concept. See `CLI-CONTRACT.md` / `SPEC-kautopilot.md` in the
`kautopilot-ts` binary for the full contract; this file is controller behavior only.

## The loop

```
loop:
  d = json(`kautopilot next --json`)
  if d.done:                 # see "Reading `done`" — NOT always session-complete
      handle(d); break/continue accordingly
  if d.kind == "interactive":
      run d.prompt INLINE; for WRITER steps run the per-revision loop below
      (reviewers → `kautopilot revise` to mint+present each version → user feedback)
  else:  # d.kind == "agent"
      run d.prompt in a FRESH context that writes d.contract.outputFile (see "Agent steps — by harness")
  kautopilot complete --output d.contract.outputFile [--metadata {…}]
  if d.kind == "interactive" and the step was a WRITER (an approval gate):
      STOP the turn and hand the user the context reset (see "Context reset at
      every approval gate") — do NOT loop straight into the next `next`.
  else:
      continue the loop.
```

**Agent steps & reviewer fan-out — by harness.** The binary loop above is
harness-agnostic; only _how you run a fresh-context step/reviewer_ differs:

- **Claude Code:** spawn an isolated `Task` subagent (`Agent` tool) per agent-step
  and per reviewer (parallel fan-out), as described throughout this doc.
- **Codex:** ask Codex to start native subagents via explicit delegation for the
  agent-step and reviewer fan-out. Delegate each with its own prompt; the agent-step
  subagent writes `d.contract.outputFile`. Do not shell out to Codex for these if
  native subagents are available.
  Interactive (`d.kind == "interactive"`) steps run inline either way.

Wherever this doc says "spawn a `Task`/`Agent`/`Explore` subagent", read it as
"start a fresh-context run" — `Task`/`Agent` on Claude, a delegated native subagent
on Codex.

**The binary owns the sequence — you never track it.** Do NOT name the step on
`complete`: omit it and the binary completes whatever step is actually pending
(the WAL cursor is the source of truth). Do **not** remember "what step I'm on",
infer the next step, or skip ahead — that is exactly how the loop corrupts
itself. The ONLY way to learn the current step is `kautopilot next`; the ONLY way
to advance is `kautopilot complete`.

**Do whatever `next` says.** The descriptor's `prompt` is fully resolved (paths
substituted). `next` **blocks** while the binary watches the world (CI, threads);
there is no `pending` — just wait for it to return a step or `done`. If the
session dies, or you lose track, or a `complete` comes back with
`ok:false`/`stale step`, **STOP and call `next` again** — it returns the exact
pending step until its `completionEvent` is logged. Re-sync from `next`; never
guess. (You may still pass the step name as an assertion, e.g. `complete spec`,
if you want the binary to confirm you're where you think — but a mismatch is an
error, not an override.)

### Context reset at every approval gate (REQUIRED)

After you `kautopilot complete` an **interactive writer step** (triage, spec,
master_plan, write_plans, feedback — anything the user explicitly **"approve"**d),
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

**Why this is safe (lossless).** All state lives on disk (the WAL + `revisions/`),
and each step's prompt re-reads what it needs from disk — e.g. the spec step is
handed the ticket and the latest triage as file paths; the next step is handed the
approved artifact. The conversation history carries **nothing the next step needs**;
keeping it only burns tokens and rots context. Clearing between gates loses nothing.

**Always print the explicit `--session <id>`** — never tell the user to rely on bare
`continue`/cwd. One folder can host several sessions, so cwd cannot disambiguate; the
id in the command is the only reliable anchor across a `/clear`.

**Make sure the approved decisions are in the artifact, not just the chat.** Since the
chat is about to be cleared, before you `complete` confirm the agreed direction +
any open-items/assumptions are written into the artifact file (the writer prompt
already requires this) — anything that lived only in the conversation is gone after
`/clear`.

(Agent steps, the `code` steps, and the DAG `schedule`/`record` loop do **not** stop
for a reset — only the interactive approval gates do.)

### Reading `done` — a `{done:true}` is not always "finished"

`next` returns either a step descriptor or `{done:true, phase, reason}`. The `done`
shapes mean different things — branch on `phase`:

- **bare `next` → `phase:"execution"`** = the **plan→DAG handoff**. The master plan is
  approved; now **drive the DAG with `kautopilot schedule`/`record`** (see "Driving the
  DAG"). The reason string includes the current frontier. Do **not** stop and do **not**
  try repo-scoped `next` — that path has been removed. When `schedule` reports `allReady`
  with no `toMerge` entries, call bare `next` again — it advances to feedback.
- **bare `next` → `phase:"feedback"` step** (e.g. `feedback_check`) — handle normally.
- **bare `next` → `phase:"done"`** = the session is truly complete. Report and stop.

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
/kautopilot --diff spec                 → kautopilot diff spec  (what changed between versions)
```

**Default = a brand-new session. Only "continue" resumes.** Unless the user's message
says **continue** (or `--session <id>` is given), **always start a fresh session** — do
NOT auto-resume an in-progress one, even if one exists for this folder/ticket. When the
user **does** say "continue", resume per **"Continue (this folder)"** below.

Org is `liftoff` or `atomicloud`, resolved by `--org` → detect-from-ticket → ask.

**Merge policy (per session).** `mergeMode` is `manual` (default — drive PRs to
ready-to-merge and the user merges) or `auto` (the controller merges scheduled ready PRs to clear
downstream gates). Set it at start with `kautopilot start … --merge auto|manual`, or confirm
it in the master plan. Either way ready-to-merge is always reached; `auto` is what lets
cross-repo `merged`/`released` gates progress without a human merge in between.

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
be any directory (a hub) with access to many repos. **Triage** decides which repos the
task touches and records each repo's absolute path (`repoPaths`). During execution, you
create or locate each repo's worktree on demand via worktrunk. So you don't pre-pick a
repo at start; triage does, and it must locate (or clone, with the user's OK) each repo.

### After triage: confirm repos + paths, name the branch (REQUIRED)

Triage is interactive — before you `kautopilot complete` it, you MUST:

1. **Confirm the repo set + each path with the user.** Show, via `AskUserQuestion`, the
   exact list triage produced: every repo and its **absolute filesystem path** (the
   `repoPaths` you'll pass). The user must confirm these are the repos/paths to work on
   before any worktree is seeded — a wrong/missing path otherwise seeds a no-op repo.
   Fix or re-triage anything they correct.
2. **Propose a branch name.** Derive an **apt, short** slug from the ticket title (you
   choose it — concise and descriptive, e.g. ticket "Add dark mode to portal" →
   `dark-mode`). Confirm it in the same question. The binary builds the final branch as
   **`<git-user>/<ticket-id>-<slug>`** (e.g. `kirinnee/PE-1234-dark-mode`), the **same
   branch across all the task's repos**; you create each repo's worktree on that branch via
   worktrunk (`wt`) when `schedule` makes a plan ready. You only supply the slug — the binary fills in the `<git-user>/`
   prefix and the **`<ticket-id>`** automatically. When you show the proposed branch to the
   user, make clear that **the `<ticket-id>` part is the session's ticket reference** (the
   variable prefix, e.g. `PE-1234`), not a literal word — so e.g. `PE-1234-i18n`, with only
   `i18n` being the slug they're choosing. (No ticket id → it falls back to a literal
   `ticket-` prefix.)

Then complete triage passing the confirmed values, including the slug:

```
kautopilot complete --output <triage> --metadata '{"repos":[…],"repoPaths":{…},"dependsOn":{…},"branchSlug":"dark-mode"}'
```

`branchSlug` is optional in the schema, but for a normal ticket-to-PR run you should
always supply it; omitting it falls back to the legacy `<repo>-<ticketId>` branch name.

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
   stored `lpsm`): periodic-table **element → Service** (neon, carbon, iron…);
   **functional group → Platform** (nitrite, sulfoxide, halogen…); **Pokémon → Landscape**
   (pichu, pikachu, raichu…); **gemstone → Cluster** (diamond, ruby…).
3. **Matching rule:** a session matches a tag if the value (case-insensitive) **equals**
   — or, failing exact, is a **substring of** — ANY of its lpsm field values
   (landscape/cluster/platform/service/module) **OR** any of its free-form `tags[]`.
   With multiple `--tag`s, **ALL** must match (each somewhere across LPSM or free-form tags).
4. Then:
   - **exactly 1 match** → resume it: drive `kautopilot next --session <id>` per the
     normal loop above.
   - **multiple** → list them (ticket + L/P/S) and ask the user which via `AskUserQuestion`.
   - **none** → tell the user nothing matched.

## Driving the phases (one flat session)

- **Plan + feedback (shared phases)** — drive with bare `kautopilot next` / `complete`
  (triage → spec → master_plan → plans; later, feedback). Same loop as above.
- **Execution (the DAG)** — once the master plan is approved, bare `next` hands off with
  `phase:"execution"` and tells you to **drive the DAG yourself with `kautopilot
schedule`/`record`**. **kautopilot does NOT drive kloop** anymore — it's a record-keeper +
  scheduler. YOU run kloop, resolve conflicts, open/merge PRs per `mergeMode`, and **record** each
  transition. See "Driving the DAG" below.
- When `schedule` reports the execution frontier is clear (`allReady`), call bare
  `kautopilot next` again — it advances to the **feedback** phase.

## Driving the DAG (execution + PRs) — `schedule` + `record`

The master plan is a **multi-stage DAG** of plans grouped into PRs, with gate-leveled
edges. You drive it; the binary tells you what's runnable and tracks progress. Loop:

```
loop:
  s = json(`kautopilot schedule --json`)
  if s.done or s.allReady:
      `kautopilot next --json`           # → feedback_check
      break
  # 1. RUN ready plans (deps satisfied), up to maxParallelRepos at once.
  for plan in s.ready:
      provision/locate the repo's worktree off the LATEST base (worktrunk `wt`)
      `kautopilot record started --repo <r> --plan <p> --kloop <runId>`
      drive kloop for that plan (init → run → `kloop wait`); RESOLVE CONFLICTS yourself
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
when s.allReady: `kautopilot next`   # → feedback phase; s.toMerge is empty
```

- **`schedule --json` returns** `{ ready[], running[], blocked[], toPolish[], toMerge[],
allReady, done, mergeMode }`. `ready` = run now. `toPolish[]` = PRs whose plans are
  implemented and whose PR polish is not complete (`pending` means open the PR; `open`
  means keep fighting CI/CodeRabbit/review threads). `toMerge[].gate` = `merged` or
  `released`; `toMerge[].unblocks` = which downstream plans that gate frees (gate-clearing
  entries are listed first; terminal ready PRs may also appear). `allReady` is true only
  after no scheduled merge/release remains. `blocked[].waitingOn`
  = why a plan waits.
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

- **`code`** — never appears. The binary ran it (including all detection/waiting).
- **`interactive`** (brainstorm, triage, write_spec, **write_master_plan**, write_plans, feedback_check, feedback, **create_ticket**) —
  run **inline** in the main session. Be a **devil's advocate**: propose first, debate,
  surface conflicts; never open with "what do you want to do?" For the **writer artifacts**
  run the **per-revision review loop** below — re-present + re-ask after EVERY update and
  only `complete` once feedback is exhausted and the user **explicitly** approves
  ("approve" — not "ok/sure"). Spawn `Explore` subagents for heavy research so the
  conversation stays lean.
  - **`create_ticket`** is interactive but NOT a revise-loop artifact: its prompt says to
    **draft the ticket, show it, and get explicit confirmation before creating** — do that
    inline (a subagent can't talk to the user), then run the creation command and `complete`
    with the `ticketId`. (Don't spawn a subagent for it.)
  - **`write_master_plan`** is the **orchestration artifact**, presented and approved
    **before** `write_plans` (it locks the order of execution first). Run the normal
    per-revision loop (revise → visual → present → approve). It must lay out: the **PR/branch
    layout** (a repo MAY open several PRs on several branches — give each PR an id, repo,
    branch, title, and the `plan-<N>`s it ships); the **dependency DAG with gate levels**
    (`completed` | `merged` | `released`, edges may span repos); and a **mermaid `graph TD`**
    of the DAG (the dashboard renders it). Confirm the **merge policy** (`manual` asks before
    merging / `auto` merges ready PRs) here too. On approval, `complete write_master_plan` with
    metadata `{ mergeMode?, prs[], nodes[], deps[] }` — the binary freezes it into
    `orchestration.yaml` (the resumable record that also tracks each plan's exec status + kloop
    run). The `plan-<N>` ids you choose here are the ids `write_plans` then writes bodies for.
  - **`write_plans`** writes one FOLDER per plan. Every plan folder MUST be named
    `plan-<N>` or `plan-<N>-<short-slug>` (the literal **`plan-<N>` prefix is required**,
    e.g. `plan-1`, `plan-2-api`). That ordinal is what the schedule/record execution loop
    uses to find each plan's spec file — a folder missing the prefix (e.g. `auth/` or
    `1-auth/`) won't be located and the dev loop will fail to init. If the
    plan-writer proposes a breakdown with non-conforming folder names, correct it before
    approving.
- **`agent`** (fetch_ticket, plus the skill-owned kloop/commit/PR-polish subagents you spawn
  from `schedule`) — **always** a fresh isolated `Task` subagent, never inline. (The
  reviewer fan-out isn't a step — it rides on the write_spec/write_plans interactive steps
  and you spawn each reviewer as a subagent.)

### Running kloop for a ready plan (you drive it)

In the DAG model the binary does **not** run or watch kloop. For each `ready` plan from
`kautopilot schedule`, spawn a sub-agent that **drives kloop for that one plan** in the
repo's worktree (off the latest base) and keeps its noisy output out of the conversation:

1. `kautopilot record started --repo <r> --plan <p> --kloop <runId>` (after init prints it).
2. `kloop init --workspace <worktree> --spec <plan>` → note the Run ID.
3. `kloop run -d <id>` (**daemon** — output goes to kloop's logs, not your context).
4. **Wait for the run WITHOUT polling.** `kloop wait <runId>` blocks until the run is
   **terminal** (completed / conflict / failed / cancelled / crashed) and streams **one
   line per status/phase change** — a poll→stream conversion. **Never** sit in a
   `kloop status` poll loop (that burns tokens every tick). How you park on it differs by
   harness:
   - **Claude:** arm a **`Monitor`** with `command: kloop wait <runId> --json` — one event
     per phase change, and the monitor **ends itself** when the run goes terminal. Keep
     working (hand other `ready` plans off in parallel); the terminal event wakes you. Use
     a long `timeout_ms` (kloop runs take many minutes) or `persistent: true`.
   - **Codex:** delegate a **cheap, fast subagent** (e.g. `gpt-5.3-spark` or `gpt-5.4-mini`)
     whose only job is to run `kloop wait <runId>` and return the final status line. The
     **main thread blocks on that subagent** — parked, not polling — and resumes when it
     returns. A cheap model is fine: it only relays kloop's terminal state.

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

**For spec and plans, the checkpointer litmus test (see "Litmus test — will it run to
completion unattended?" below) is a REQUIRED review lens** — at least one reviewer must
confirm the artifact can run to its DoD unattended: no unsatisfiable DoD (capability/permission
gap) and no contradictory verification criteria. A litmus failure blocks the version, same as
any other unresolved finding.

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
3. **Generate the visual** for THIS version — see "Generate the visual" below —
   BEFORE presenting. This is a **required, non-skippable step**: confirm the HTML file(s)
   exist before you present, or the **Visual** link will 404. Applies to **every** artifact:
   brainstorm / triage / spec / master_plan / feedback get one `vN.html` next to the `vN.md`
   (one sub-agent — for the **master plan**, render the DAG as a mermaid/diagram so the
   PR/branch + gate-level dependencies are visual); **plans** get one `vN.html` **per plan**
   (`<plan>/vN.html`) — spawn **one sub-agent per plan**, not merged.
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

(`kautopilot config` with no flag prints the whole resolved config as JSON. The binary's
fallback defaults are `http://localhost:47317` / `http://localhost:47316` — but the user
runs a public domain set in `~/.kautopilot/config.yaml`, so always read it, don't guess.)

**Give the FULL link for EACH artifact type, not just the session.** Every artifact
has its own shareable URL — when you present links (incl. the end-of-message summary
table, see "End every message with a links table"), list the full per-artifact URLs
that apply:

- ticket → `<viewerBaseUrl>/sessions/<id>/ticket`
- ticket-draft (ad-hoc, after brainstorm) → `<viewerBaseUrl>/sessions/<id>/ticket-draft`
- brainstorm / triage / spec / master_plan / feedback → use the `revise` `url`/`diffUrl` (current version, full URL)
- plans → `<viewerBaseUrl>/sessions/<id>/plans/<repo>`
- a kloop run → **`<kloopBaseUrl>/kloop/<runId>`** (the kloop dashboard, NOT kautopilot)

The viewer must be running (`kautopilot dash up` / `kloop dash up`) for links to load;
it shows the session's current epoch. Revisions are machine-local and never committed.

### Generate the visual (HTML infographic) — a sub-agent, every version

Before presenting **each** artifact version, spawn a fresh isolated `Task` sub-agent to
produce a **visual, infographic-style** HTML version of the same content. Single-file
artifacts need **one** sub-agent; **plans need one sub-agent per plan** (each plan is a
separate file — see "Plans" below) — spawn those in parallel. The audience is **ADHD +
dyslexic**, so the HTML must be scannable and visual, NOT a wall of text. For **v1** the
sub-agent has free rein on the _layout_ — clarity beats fidelity; jarring-but-clear is OK —
but the **bright-mode + Claude design style** and **completeness** rules below always apply.
For **v2+** it should instead **keep the previous version's design** and edit it (see
"Reuse the prior design" below), so versions look like siblings.

Spawn it with the `Task` tool (`subagent_type: general-purpose`), and tell it to **use the
`frontend-design` skill if available** — and if that skill isn't installed, to apply the
same accessible visual-design principles directly (don't fail). Pass it these explicit
inputs in the prompt: the `path` that `revise` returned, and the Read URL (`revise`'s
returned `url`) to use verbatim as the source link. The brief:

- **Cover every segment (completeness).** **Every** section/segment of the source markdown
  must be reflected in the visual — do not drop, merge-away, or silently summarize content
  out. Reshaping a wall of text into scannable cards/callouts is the goal, but the
  information from each original section must still be present.
- **Bright mode + Claude design style.** Always render in **bright (light) mode** using the
  **Claude design style** — warm off-white/cream background, dark high-contrast text, Claude's
  coral/terracotta accent for highlights, generous whitespace, rounded cards. Never dark mode.
- **Reuse the prior design (v2+ — do this FIRST).** When a previous HTML exists
  (`v{N-1}.html`, the **same path** the new file goes — for single-file that's next to the
  `.md`; for plans it's that plan's own `<plan>/v{N-1}.html`), **start by copying it to
  `vN.html`**, then **edit only the parts the markdown changed** — keep the
  same CSS, colors, layout, and components so the look-and-feel stays consistent and the diff
  is cheap (you edit snippets, not regenerate the whole page). Refresh the **"What changed"**
  callout each time. **Before reusing, sanity-check** the copied file still meets the
  Output-format and Mobile constraints below (no JS, no remote resources, responsive); if it
  doesn't (e.g. an old file predating these rules), fix those bits or regenerate. **Escape
  hatch:** if the markdown changed shape so drastically that editing the old layout is more
  work than starting over, regenerate from scratch instead. (For **v1**, or when no prior
  HTML exists, generate from scratch.)
- **Input & output location** depends on the artifact:
  - **Single-file** (brainstorm, triage, spec, master_plan, feedback) — `path` is a `vN.md`. Write a
    sibling **`vN.html`** in the **same directory, same basename** (just `.md` → `.html`).
    For **v2+**, also read the previous version (`v{N-1}.md` in the same dir) and, at the
    **TOP**, show a short **"What changed"** callout summarizing the diff (key changes only).
  - **Plans** — `path` is the repo's **plans dir**, which contains one subfolder per plan,
    each with a `vN.md`. Treat each plan exactly like a single-file artifact: **spawn one
    sub-agent per plan**, and each writes a sibling **`<plan>/vN.html`** next to that plan's
    `<plan>/vN.md`. **Do NOT merge** plans into one file — one infographic per plan. Pass each
    sub-agent only its own plan's `vN.md` path. For **v2+**, each compares against its own
    `<plan>/v{N-1}.md` and adds the "What changed" callout at the top of that plan's page.
    The dashboard shows a **"View visual"** link on each plan's tab.
- **Output format** — a **standalone** HTML file: fully self-contained inline CSS, no build
  step, **no JavaScript** (it is served with a script-blocking CSP — any JS is silently
  dropped, so the page must work with zero scripts). **No remote resources** either: the CSP
  blocks all external hosts, so use a **system font stack** (no Google Fonts / CDN `<link>` /
  `@import`) and embed any images as inline SVG or `data:` URIs. Design for dyslexia:
  generous spacing, high contrast, sans-serif, left-aligned (never justified), short lines,
  icons/cards/callouts, strong visual hierarchy.
- **Mobile-friendly / responsive** — it WILL be viewed on phones. Include
  `<meta name="viewport" content="width=device-width, initial-scale=1">`; use a fluid,
  single-column-on-narrow layout (e.g. CSS flex/grid that wraps, `max-width` containers,
  relative units, `@media` breakpoints); never rely on fixed pixel widths or horizontal
  scrolling; tap targets and text must stay comfortably readable on a small screen.
- **Cross-link back to source** — put a clear **"← View source (markdown)"** link near the
  top of the HTML. Use the **Read URL you were handed** (`revise`'s `url`) verbatim as the
  `href` (add `target="_top"` — harmless full-page navigation). Do NOT hand-construct this
  URL — use the one passed in. The dashboard's "View visual" link is the reverse direction.
- Do this for **every** version of **every** artifact before you present that version. The
  dashboard auto-detects each HTML sibling and shows a **"View visual"** link that opens the
  full-page infographic — on the Read page for single-file artifacts, and on each plan's tab
  for plans.

## The per-revision review loop (don't just move on)

Every interactive writer artifact is **iterated until the user has no more
feedback** — never auto-advance after one draft. A new version is NOT approval;
it's the start of another review round. For a single artifact step, loop like this
and do **not** `complete` (which lets the binary move to the next step) until the
user explicitly approves:

1. **Draft / update** the working version, then run the **reviewers** (above) and
   fix until review-clean — these rounds are not versioned.
2. **Mint + generate visual + present.** Run `kautopilot revise` to snapshot this as
   the next version, generate the `vN.html` visual(s) (above), then post: **Read** (the
   returned `url`/`diffUrl` so they see what changed) and — for single-file artifacts —
   **Visual** (the returned `visualUrl`); for **plans**, present just the Read link (each
   plan's visual is on its tab, no `visualUrl`). Add a **2–4 line summary** of what changed
   and a short **TODO / open-items** list (what's unresolved, and which of the user's last
   feedback this version did / did NOT address).
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

**Re-present after EVERY interaction — including `AskUserQuestion`.** Any time you turn
back to the user mid-artifact — even to ask a clarifying question via the question tool —
you must **re-present the current version** (both Read + Visual links + summary) in that
same message. Never ask a question without the live version in front of them, and never
treat a question's answer as approval. Only the explicit word "approve" advances the step.

So: v1 presented → feedback → `revise` → v2 — you do **not** silently overwrite v1;
you mint v2, present it (both links), ask if v2 is OK, and so on until the user says
**"approve"**.

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
questions" in the step prompt, that change lives in the `modules/kautopilot-ts/` step prompts
— a subfolder of _this_ repo, not a separate one — not here.)

## Litmus test — will it run to completion unattended? (spec + plans)

Before approving **spec** and **plans**, run the **checkpointer litmus test** on the artifact:

> If a kloop **implementer + reviewer** — **neither of which may ever commit, push, or open a
> PR** (those are the controller / commit-subagent's job) — ran this to the end, would the
> Definition of Done (DoD) / verification criteria **eventually** be satisfiable? Or is there
> a **fundamental logic flaw or blindspot** that traps the loop forever?

kloop is autonomous: it implements + self-reviews against the DoD until the DoD passes. If the
DoD can **never** pass — because it demands something the loop structurally can't do, or
because two criteria contradict — kloop spins to max-iter and needs a human. The litmus test
catches that **before** approval so the run stays hands-off. Two failure classes to scan for:

1. **Unsatisfiable DoD — capability / permission gap.** The DoD requires an action the loop
   cannot perform, or a resource that doesn't exist, so the implementer can **never** clear it.
   - DoD says "the implementer commits / pushes / opens the PR" — but implementers **never**
     commit (the commit subagent does). The loop can't tick that box. → reword the DoD to be
     verifiable from the **working tree** (files changed, tests/build pass), not from a
     commit/PR.
   - DoD says "ssh into the DigitalOcean box and run X" — but the box doesn't exist / the loop
     has no creds. → provision/verify out-of-band (a controller step), or drop it from the
     loop's DoD.
2. **Logical conflict — two criteria that can't both hold.**
   - "Remove all container/docker logic (infra moves to another repo); **verify** by grepping
     `container` → must not exist." **But** integration tests use the **testcontainers**
     package → `container` **will** still exist (for testing, unrelated to infra), so the grep
     is never empty. → scope the check (grep only infra dirs / exclude test deps) or change the
     criterion.
   - "**Do not change any existing code** + add tests to reach **100% coverage**." If there's
     **unreachable** code, 100% is impossible without deleting it — the two rules conflict. →
     relax one (allow deleting dead code, or exclude the unreachable lines / target < 100%).

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
diff). Then you **must `complete` the step with metadata `{ "rules": ["…", …] }`** — the
binary appends rules to each repo's `rules.md` (linked from `CLAUDE.md`/`AGENTS.md`) ONLY
from that metadata. Omit it and nothing is recorded. These inject into future runs.

## End every message with a links table

**End EVERY message that presents artifacts with one SIMPLE, FLAT summary table of
ALL the session's shareable links** — so every live artifact, plan, and run is in
one place, one click away, easy to scan and keep track of. The audience is **ADHD +
dyslexic**, so this table must be **minimal and uniform**: ONE row per thing, never a
two-column **Read | Visual** layout. (Keep the inline per-artifact **Read**/**Visual**
guidance from the body above — that's for presenting the artifact in the message; this
end-of-message table is a single flat index of links, the one source of truth for the
summary.)

**Exact layout — ONE column. Each row is the label, hyperlinked to its URL.** Do NOT use a
separate "Link" column and do NOT paste raw URLs — the visible text IS the link
(`[Label](url)`), one row per thing:

| Links              |
| ------------------ |
| [Spec](url)        |
| [Plans — api](url) |

Read **`viewerBaseUrl`** / **`kloopBaseUrl`** from `kautopilot config --field viewerBaseUrl` /
`--field kloopBaseUrl` — **never hardcode a domain** (the host is the user's public domain, not a
guess). Build the hand-made links from that; **never hand-construct version URLs** — use the exact
`url`/`diffUrl` `revise` handed back (already full URLs) for the current versioned artifacts.

**Rows to include** (only the ones that apply, one row each, label hyperlinked):

- **Each current versioned artifact** — spec, triage, brainstorm, **master plan**, feedback —
  using the latest `revise` `url` (or `diffUrl` once a prior version exists, so they see what changed).
- **Ticket** → `<viewerBaseUrl>/sessions/<id>/ticket` (or `…/ticket-draft` for an ad-hoc
  draft after brainstorm).
- **One row PER REPO that has plans** → `<viewerBaseUrl>/sessions/<id>/plans/<repo>`. The
  plans link is **per-repo, not per-plan** — that one page tabs between all of that repo's
  plans, and there is **no per-plan URL**. So give each _repo's_ plans a row (label it, e.g.
  `Plans — api`); do NOT emit one row per plan with the same repo link (duplicate hrefs).
- **One row PER kloop run** → **`<kloopBaseUrl>/kloop/<runId>`** — the kloop "plink"/permalink
  on the **kloop** dashboard (NOT the kautopilot viewer). One row per run.
- **PR(s)** — each repo's/PR's URL, **only once it exists** (one row per PR, labelled by
  repo — and by PR when a repo has several); omit the row when there's no PR yet.

**Concrete example** (sample rows — yours reflect the actual session state; labels are the
links, no second column):

| Links                                                         |
| ------------------------------------------------------------- |
| [Spec](<viewerBaseUrl>/sessions/abc123/spec/v3)               |
| [Master plan](<viewerBaseUrl>/sessions/abc123/master_plan/v2) |
| [Triage](<viewerBaseUrl>/sessions/abc123/triage/v2)           |
| [Plans — api](<viewerBaseUrl>/sessions/abc123/plans/api)      |
| [Plans — web](<viewerBaseUrl>/sessions/abc123/plans/web)      |
| [kloop run — api](<kloopBaseUrl>/kloop/run-9f2c)              |
| [PR — api](https://github.com/org/api/pull/42)                |

(The `spec/v3` / `master_plan/v2` hrefs are illustrative — use the exact `url`/`diffUrl` from
`revise`, don't build version paths by hand.)

If there is genuinely nothing to link yet (e.g. the very first turn, before any
artifact/ticket exists), say so in one line instead of an empty table.

## Rules

1. **Only merge when scheduled.** Ready-to-merge (CI green + all actionable threads resolved,
   excluding human-review approval) is always the floor, and the epoch ends when **every** PR
   is ready. `mergeMode` decides ownership: in `manual`, ask/wait for the user merge; in
   `auto`, the controller may merge only PRs returned by `schedule.toMerge`. Always record the
   result with `kautopilot record merged --pr <prId>`. If `toMerge[].gate` is `released`,
   wait for the release boundary and record `kautopilot record released --pr <prId>`.
2. **Never push to `main`/`master`;** never force-push except `--force-with-lease`.
3. **Poll with `gh api graphql`**, never `gh pr watch` (the binary does detection anyway).
4. **Ask before cloning** a repo.
5. **Only `complete` after the contract is satisfied** — and, for interactive steps,
   after explicit approval. The binary checks the artifact; you guarantee consent.
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

- `kautopilot` + `gh` CLI in PATH and authenticated; `kloop` for the default exec mode.
- Jira: `acli` authenticated. ClickUp: the **`cup` CLI** (`ClickUp CLI for AI agents`) —
  prefer it over any ClickUp MCP for reading/creating tickets (`cup task <id>`, `cup create`,
  `cup subtasks`/`cup activity`).
