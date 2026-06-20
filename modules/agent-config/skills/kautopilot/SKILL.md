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
  d = json(`kautopilot next --json [--repo <repo>]`)
  if d.done:                 # see "Reading `done`" — NOT always session-complete
      handle(d); break/continue accordingly
  if d.kind == "interactive":
      run d.prompt INLINE, conversing with the user; satisfy d.contract (approval gate)
  else:  # d.kind == "agent"
      spawn a fresh isolated Task subagent with d.prompt; it writes d.contract.outputFile
  kautopilot complete --output d.contract.outputFile [--metadata {…}] [--repo <repo>]
```

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

### Reading `done` — a `{done:true}` is not always "finished"

`next` returns either a step descriptor or `{done:true, phase, reason}`. The `done`
shapes mean different things — branch on `phase`:

- **bare `next` → `phase:"execution"`** = the **plan→repos handoff**. Plans are approved;
  now drive each repo. Run `kautopilot status --json`, read `repos[]`, and start a
  `next --repo <repo>` driver for each repo whose `status` is not `ready` (up to
  `maxParallelRepos` at once — the binary also queues the rest, see below). Do **not**
  stop. When **every** repo is `ready`, call bare `next` again — it advances to feedback.
- **bare `next` → `phase:"feedback"` step** (e.g. `feedback_check`) — handle normally.
- **bare `next` → `phase:"done"`** = the session is truly complete. Report and stop.
- **`next --repo R` → `phase:"polish"`, reason "ready to merge"** = repo R is done; stop
  that repo's driver (don't merge — that's the finish line).
- **`next --repo R` → `phase:"execution"`, reason "queued"** = R is waiting on the
  `maxParallelRepos` cap. Don't error; let a slot free up (another repo reaching `ready`)
  and retry `next --repo R` then.

## Start

```
/kautopilot PE-1234                     → org detected from the ticket; resume or start
/kautopilot "add dark mode to portal"   → ad-hoc: brainstorm (superpowers-style) → create_ticket first
/kautopilot --org liftoff "…"           → org passed explicitly (else detected from ticket, else asked)
/kautopilot                             → resume in-progress session, else ask what to build
/kautopilot --diff spec                 → kautopilot diff spec  (what changed between versions)
```

Org is `liftoff` or `atomicloud`, resolved by `--org` → detect-from-ticket → ask.

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

- **Shared phases** (plan, feedback) — drive with bare `kautopilot next`.
- **Per-repo phases** (execution, polish) — once bare `next` hands off (`phase:"execution"`,
  see "Reading `done`"), get the repo set + each repo's `status` from
  `kautopilot status --json` (`repos[]`), and drive each not-yet-`ready` repo with
  `kautopilot next --repo <repo>`, **in parallel up to `maxParallelRepos`** (the binary's
  cap — it returns a `queued` done for repos over the cap; respect it to bound tokens).
  Run each repo's loop as a sub-agent driver.
- **Serialize interaction.** A repo's `next --repo` may yield an `interactive` step — a
  sub-agent can't talk to the user, so **return it to the main chat** and handle it
  inline there, one at a time, while other repos keep progressing on mechanical work.

## Per-`kind` execution

- **`code`** — never appears. The binary ran it (including all detection/waiting).
- **`interactive`** (triage, write_spec, write_plans, resolve, tty_resolve, feedback) —
  run **inline** in the main session. Be a **devil's advocate**: propose first, debate,
  surface conflicts; never open with "what do you want to do?" Run the
  **per-revision review loop** below — re-present + re-ask after EVERY update and
  only `complete` once feedback is exhausted and the user **explicitly** approves
  ("approve" — not "ok/sure"). Spawn `Explore` subagents for heavy research so the
  conversation stays lean.
- **`agent`** (create_ticket, fetch_ticket, commit, eval, create_pr, prereview,
  write_fix, amend_plans, reviewers, per-repo implement) — **always** a fresh isolated
  `Task` subagent, never inline.

## Review steps (fan-out)

When a descriptor carries `review`: spawn **every reviewer** as a parallel sub-agent, run
the **synthesize** sub-agent into one numbered list, feed it back into the interactive
writer. Gate = **all reviewers approve** — withhold `complete` until they do, unless the
user overrides (`complete … --metadata '{"reviewOverride": true}'`).

## Review = send the viewer link, not the file

Artifacts live in a live web viewer. Whenever you ask the user to **review or
approve** any artifact (brainstorm, triage, spec, plans, feedback, ticket), do
**not** paste the file contents or raw `kautopilot diff` output into chat.
Instead give them a **clickable link** to that artifact in the viewer — it
renders markdown, mermaid, and colored diffs, and is mobile-friendly — then wait
for their explicit approval.

**Viewer base URL** (configured for this machine — change here if it moves):

```
https://kauto.ernest.atomi.cloud
```

Build `<base> + path`. `<id>` is the session id. The viewer always shows the
session's **current epoch** for epoch-scoped artifacts, so the epoch is
implicit — you only choose the **version** (omit it for the latest, which is
what's under review):

| Artifact   | Link                                |
| ---------- | ----------------------------------- |
| Ticket     | `<base>/sessions/<id>/ticket`       |
| Brainstorm | `<base>/sessions/<id>/brainstorm`   |
| Triage     | `<base>/sessions/<id>/triage`       |
| Spec       | `<base>/sessions/<id>/spec`         |
| Feedback   | `<base>/sessions/<id>/feedback`     |
| Plans      | `<base>/sessions/<id>/plans/<repo>` |

- **Pin a version** with `/v<n>` (e.g. `…/spec/v3`); omit `/v<n>` for the latest.
- **Show what changed**: append `/diff` (`…/spec/diff`, `…/plans/<repo>/diff`).
  Use the diff link on every revision after the first instead of pasting
  `kautopilot diff` text.
- Present it as a real clickable link with a short label, e.g.
  `Review the spec → https://kauto.ernest.atomi.cloud/sessions/ab12cd34/spec/diff`.
- The viewer must be running (`kautopilot dash up`) for the link to load.

Revisions are machine-local and never committed.

## The per-revision review loop (don't just move on)

Every interactive writer artifact (brainstorm, triage, spec, plans, feedback) is
**iterated until the user has no more feedback** — never auto-advance after one
draft. A new version is NOT approval; it's the start of another review round.
For a single artifact step, loop like this and do **not** `complete` (which lets
the binary move to the next step) until step 5:

1. **Write / update** the artifact (the writer produces the new version — v1, then
   v2 after feedback, then v3, …).
2. **Present it — don't move on.** In chat, post:
   - the **viewer link** to the new version (the doc link for v1; the `/diff` link
     once a prior version exists, so they see exactly what changed),
   - a **2–4 line summary** of what this version says / what changed since the last,
   - a short **TODO / open-items list**: anything unresolved, decisions still
     needed, and which pieces of the user's last feedback this version addressed
     (and any it did NOT, with why).
3. **Ask** for feedback or approval.
4. **Any feedback = not approved.** Address it → that produces the next version →
   go back to step 2. Re-present (new link/diff + summary + updated open-items) and
   re-ask **every** round. Keep looping: v2 ok? → feedback → v3 ok? → feedback → …
5. **Only when the user has no further feedback AND explicitly approves**, and the
   open-items list is empty (all feedback addressed) → `complete` the step. The
   binary then advances to the next step.

So: v1 presented → feedback → v2 — you do **not** silently jump to v2 and proceed;
you present v2, ask if v2 is OK, and so on until there's nothing left to change.

## Feedback → `rules.md`

At `feedback` (a versioned artifact), don't apply feedback literally. Distill candidate
**rules**, reasoning about scope (task- vs repo-specific; code-writing vs
solution-thinking) and generalizing; confirm with `AskUserQuestion` (show a `rules.md`
diff); the binary appends confirmed rules to each repo's `rules.md` + links it from
`CLAUDE.md`/`AGENTS.md`. These inject into future runs.

## Rules

1. **No merging, ever.** Ready-to-merge (CI green + all threads resolved, excluding
   human-review approval) is the finish line. The epoch ends when **every** repo's PR is
   ready. Never run `gh pr merge`.
2. **Never push to `main`/`master`;** never force-push except `--force-with-lease`.
3. **Poll with `gh api graphql`**, never `gh pr watch` (the binary does detection anyway).
4. **Ask before cloning** a repo.
5. **Only `complete` after the contract is satisfied** — and, for interactive steps,
   after explicit approval. The binary checks the artifact; you guarantee consent.
6. **Bot signature** on PR replies: `"By Claude Code kautopilot 🤖"`.
7. **Never hand-edit binary state** (`~/.kautopilot/…`). Drive only via
   `next`/`complete`/`diff`/`status`.
8. **Never commit or create worktrees yourself.** Commits are the binary's `commit`
   sub-agent / seed-commit; worktrees (worktrunk `wt`) and cleanup are binary `code`
   steps. You only run what `next` yields.

## Prerequisites

- `kautopilot` + `gh` CLI in PATH and authenticated; `kloop` for the default exec mode.
- Jira: `acli` authenticated. ClickUp: MCP configured (also used to create ad-hoc tickets).
