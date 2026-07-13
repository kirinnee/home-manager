# Deferred Writer (Relay) — spec/plan thinking in a separate resumable session

Revision 3 — after floop rounds 1 (correctness, blindspot, feasibility) and 2
(correctness/consistency, operational/UX).

## Problem

Interactive writer steps (brainstorm, triage, write_spec, write_master_plan,
write_plans, feedback) run **inline** in the main Claude session today. All the
drafting, reviewer fan-out, spike research, and visual generation pollute the main
context and burn tokens on the **main account** — the only one connected to the
user's mobile. The main session should be a thin **relay**: present a summary +
questions + artifact links, collect the user's answers, forward them.

## Solution shape

For each writer **phase** (per artifact kind, per epoch), the kautopilot binary owns a
long-lived **writer session**: a Claude Code conversation on a **fleet account**
(`claude-auto-<name>` wrapper), driven turn-by-turn through tmux (kloop-interactive
style — TUI, send-keys, sentinel file). No `-p`/`--print` ever. Turn 1 launches
`<binary> --session-id <uuid>`; every later turn launches `<binary> --resume <uuid>`.
The process **exits after each turn** (`/exit`); the conversation persists in the
account's home, so nothing long-running needs babysitting and crash recovery is free.

The writer ends each turn by writing a validated **envelope** (`reply.json`):
summary, answers, new questions, open items, artifact state, proposed completion
metadata. The binary validates it, verifies side effects on disk, enriches it with
real viewer URLs, and prints it. The main session only relays: summary → answers →
questions (AskUserQuestion) → **named hyperlinks** (never raw URLs).

**The writer session NEVER runs kautopilot commands.** The binary is the only
version-minter and the only lock-holder; the writer only edits files it is handed
and writes the envelope. (Kills the revise-vs-relay lock deadlock and the
revise→edit ordering hazard by construction.)

**The writer harness is always Claude** (a `claude-auto-*` wrapper), regardless of
whether the main session is Claude or Codex — the binary drives it as a subprocess.

**Inline mode remains the default and is untouched.** Deferred is opt-in via config
and/or `start --writer deferred`, and can be gated to a subset of steps
(`writer.steps`) for staged rollout.

## Non-goals (v1)

- Reviewer processes on *different accounts*. Reviewers run as subagents **inside
  the writer session** — a different *model* via `writer.reviewerModel`; different
  account is v2.
- Usage-aware account gating (kfleet `/usage`) — v2. v1 fails fast on fatal pane
  signatures (§4) and fails loudly.
- Manual `--rebootstrap` flag — v1 has only the automatic rebootstrap path.
- Changing the DAG/execution model, `schedule`/`record`, kloop driving.
- Streaming the writer's TUI to the user (read-only `tmux attach -r` is documented
  instead).

---

## 1. Disk layout — `scratch/`

Under `sessionDir(id)` (`~/.kautopilot/<sessionId>/`):

```
scratch/
  <phaseKey>/                 # spec@1, triage@1, brainstorm, master_plan@1,
                              # plans@1:<repo>, feedback@1
    writer.json               # pinned account + harness session id + status
    turn-0001/
      message.md              # what the binary sent (user answers + contract)
      reply.json              # the writer's envelope (validated + enriched)
      meta.json               # timestamps, attempts, exit status, tmux name,
                              # messageHash, paneSnapshot (on failure), state
      progress.log            # one-line phase markers appended by the writer
                              # (drafting / reviewers 2/8 / visual / …)
      done                    # sentinel (touched by the writer, unlinked by the
                              # binary before EVERY (re)spawn — stale-marker hazard)
    turn-0002/ …
```

- `phaseKey` = the same scope strings `runRevise` uses for `alreadyPresented`:
  `brainstorm`, `<kind>@<epoch>`, and `plans@<epoch>:<repo>` (repo via
  `authoringRepoName`). New epoch ⇒ new phaseKey ⇒ fresh writer session.
- `writer.json`:

```jsonc
{
  "phaseKey": "spec@1",
  "account": "claude-auto-writer",      // concrete binary — PINNED at turn 1
  "harnessSessionId": "uuid",           // minted by kautopilot; --session-id / --resume
  "cwd": "/hub/folder",                 // session.json.folder — NOT the session store
  "status": "idle|running|interrupted|failed",
  "turns": 3,                            // last completed turn
  "createdAt": "…", "updatedAt": "…"
}
```

- **Writer cwd = `session.json.folder`** (the hub dir) so triage/spec spikes can
  explore repos, direnv loads, and the skip-permissions blast radius matches the
  inline session's. Artifact/scratch paths in prompts are absolute.
- **Same account per phase by construction**: `--resume` state lives in the
  account's own `CLAUDE_CONFIG_DIR` home; the pool is consulted only when
  `writer.json` doesn't exist (or on rebootstrap, where the old conversation is
  gone and the pin buys nothing).
- All `reply.json`/`meta.json`/`writer.json` writes are **temp-file + rename** —
  the dashboard/`discussion` read them live.

## 2. Config

`~/.kautopilot/config.yaml` gains a `writer` section. **The key itself carries
`.default({...})`** (like `orgs`) so existing config files parse unchanged;
`DEFAULT_CONFIG` gains the key and `serializeConfigWithComments` emits the section.

```yaml
writer:
  mode: inline                 # inline | deferred        (default for new sessions)
  steps: [brainstorm, triage, write_spec, write_master_plan, write_plans, feedback]
                               # which writer steps defer (stage with e.g. [write_spec])
  pool:                        # kloop-style weighted account map; single entry = fixed
    claude-auto-writer: 1
  reviewerModel: null          # optional subagent model hint for the writer's fan-out
  turnTimeoutMins: 30          # sentinel wait per (re)spawn attempt
  maxTurnRetries: 2            # corrective respawns per turn
  visualBriefPath: ~/.kfleet/skills/kautopilot/visual.md   # binary-readable brief
```

- **Mode is pinned per session against config flips**: `start` resolves `--writer`
  flag → config default and persists `session.json.writerMode`; later config edits
  never affect an in-flight session. (The pin is not immutable: the explicit
  `relay --fallback-inline` escape hatch mutates it, WAL-visibly — §4.) Pre-existing
  sessions (no `writerMode`) = `inline`.
- Pool resolution = weighted random (kloop semantic). kfleet tie-in is **just
  binaries on PATH** — `claude-auto-<name>` wrappers own their `CLAUDE_CONFIG_DIR`;
  no kfleet code changes.
- `visualBriefPath`: `~/.kfleet/skills/kautopilot/visual.md` is machine-global
  (Home Manager links `kfleet/`), harness-independent. Config-overridable; if
  unreadable, the contract falls back to "use the frontend-design skill + inline
  principles".

## 3. Descriptor changes

`StepDescriptor` gains:

```ts
/** How the harness runs this step: think inline, or relay to the writer session. */
execution: "inline" | "deferred";
```

- Computed in `runNext`: `deferred` iff the step is one of the six `STEP_ARTIFACT`
  writer steps AND `meta.writerMode === "deferred"` AND the step ∈
  `config.writer.steps`. `create_ticket`/`feedback_check` are always `inline`.
- **Deferred descriptors are lightweight**: `prompt` is a short stub ("deferred —
  drive with `kautopilot relay`"), `vars` is trimmed to cheap path entries (no
  `specTemplate`, no inline `lastDiff` text), and `review` is `null` (the writer
  owns the fan-out; the payload travels via `message.md`, not the descriptor).
  `contract` stays (the skill needs `completionEvent` +
  `completionMetadataSchema` for the confirm-and-complete flow). This keeps
  `next --json` cheap in the main context, including after every `/clear`.
- `runNext` still calls `prepare()` for deferred steps (it needs `contract`; the
  trimming happens after), and `runComplete`'s prepare-based contract validation is
  unchanged — prepare's side effects are idempotent.
- **Full-prompt provenance:** the relay resolves the prompt itself — on **turn 1**
  it calls the step's `prepare(ctx)` (same as `runNext` would) **before** version
  prep, so
  `{lastDiff}` (diff of the two latest on-disk revisions) and
  `currentRevisionPath` are computed against the pre-mint state. Prompt assembly
  order inside `relay` is: `prepare()` → mint-or-reuse → compose `message.md` with
  the prepared prompt + the minted working path. `prepare()` for deferred is
  invoked with a flag/context so it assembles with `WRITER_SESSION_GATE` in place
  of `SHARED_APPROVAL_GATE` (helper `approvalGate(ctx)` in `prompt-helpers.ts`) —
  the two mutually-exclusive protocols are never both present.
- Existing consumers ignore the new field; an old skill on a new binary sees
  inline-looking descriptors unless deferred was explicitly enabled.
- **Guard:** `runRevise` rejects (`ok:false`) when the pending step's execution is
  deferred — the relay owns version bookkeeping; a main session running `revise`
  out of habit must not skew it.

## 4. `kautopilot relay` — the turn engine

```
kautopilot relay [--message <text> | --message-file <path>] [--fallback-inline]
                 [--session <id>] [--json]
```

One call = one writer turn. Flow:

1. Resolve session + pending step; require an interactive writer step with
   `execution: deferred`, else `{ok:false,error}`.
2. Acquire the session lock; **heartbeat-touch during the sentinel wait** (same TTL
   mechanics as `next`'s inline code steps). The writer never contends for this
   lock (it runs no kautopilot commands).
3. **Recovery / idempotency** (checked in order, before composing anything):
   - **(0) Orphaned-but-alive tmux**: if `meta.json` records a tmux session that is
     still alive (controller was killed; try/finally never ran): when the sentinel
     is present and `reply.json` validates → **adopt** the turn (send `/exit`, kill,
     jump to step 6/7 acceptance); otherwise `/exit` + kill first, then fall
     through to re-attach.
   - Last turn has a validated **and accepted** reply, and the caller passed no new
     message OR a message whose hash equals `meta.json.messageHash` → **return that
     reply idempotently** (crash/`/clear`/double-invoke safe; a re-sent identical
     message never composes a duplicate turn).
   - Last turn has `message.md` but no accepted reply (controller died mid-wait, or
     `status: running|interrupted` with dead tmux) → **re-attach**: unlink sentinel,
     respawn `--resume` with a nudge ("you were sent turn N at <ts> — finish it:
     re-read <message.md>, emit reply.json, touch done").
   - New (different-hash) `--message` while the last turn is unreplied → error
     ("turn N in flight — wait or let it fail"). New message when the last turn is
     complete → compose turn N+1.
   - **Acceptance is idempotently re-runnable**: a crash between validation and
     final enrichment/bookkeeping re-enters step 6/7 from the on-disk `reply.json`;
     `markPresented` is skipped when `alreadyPresented` already holds.
4. **Compose `turn-N/message.md`**:
   - Call the step's `prepare(ctx)` (deferred assembly, §3) — turn 1 only; later
     turns reuse the conversation.
   - **Version prep (binary-minted):** mint-or-reuse via the `runRevise` internals —
     reuse the latest **unpresented** working version if one exists (e.g. left by a
     failed or Q&A turn), else copy vN→vN+1. Hand the writer the resulting path as
     "the working version — edit it ONLY if this turn revises". No presented-marking
     here (step 7, and only for `revised: true`).
   - Turn 1: writer-session contract (§5) + the prepared step prompt + review
     payload (when the step has one) + visual brief + kickoff message.
   - Turn ≥2: the user's answers/feedback verbatim + a **self-sufficient reminder**
     (full envelope schema, working-version path, visual brief path, progress.log
     path, sentinel path — auto-compaction in a long writer session must never
     lose the contract). `prepare()` is only invoked on turn 1 (its side effects —
     mkdir, v1 seed, tmp dir — are idempotent anyway); §3's assembly-order note
     applies to turn 1.
   - **Approval/consistency turns skip version prep** (no mint) — they must not
     leave a phantom unpresented version behind at phase end; the working artifact
     for `complete --output` is the last presented version.
5. **Spawn tmux** (ported kloop mechanics + a new resume path):
   - Turn 1: `<account> --dangerously-skip-permissions --session-id <uuid>`
   - Turn ≥2: `<account> --dangerously-skip-permissions --resume <uuid>`
   - Always: unlink sentinel → launch → waitForPaneReady → inject bootstrap line
     ("Read <message.md> …") → wait for sentinel (timeout `turnTimeoutMins`) →
     on failure snapshot pane into `meta.json.paneSnapshot` → `/exit` → kill
     (try/finally backstop, CLAUDECODE scrub — per kloop).
   - **Fail fast on fatal pane signatures** during the sentinel wait: scan the pane
     each poll tick for rate-limit / auth / "invalid api key" / "no conversation
     found to resume" markers; on match, abort the attempt immediately (don't burn
     the remaining timeout) and classify (retryable-later vs rebootstrap vs
     terminal).
   - On spawn, print a one-line notice (stderr / non-JSON channel) with the tmux
     session name so the skill can tell the user how to watch:
     `watch live: tmux attach -r -t kap-…` (read-only attach documented; the
     session vanishes when the turn completes).
   - ⚠️ The `--resume` launch is **new, not battle-tested kloop code**: the pane
     replays prior transcript, so readiness keys on the input-prompt glyph (not
     just "pane stable") and inject-landed probing must tolerate replayed text.
     Budgeted as its own work item + a manual soak test (real claude, 3+ turns).
6. **Validate `reply.json`** (schema §6) **and side effects**:
   - `artifact.kind` matches the phase; `artifact.version` matches the handed-out
     working version.
   - `revised: true` → the revision file (single-file kinds) or plan-set dir exists
     and differs non-trivially from a blank template; visuals: `vN.html` beside the
     file for single-file kinds, **one `<plan>/vN.html` per plan folder** for plans.
   - `revised: false` → the working version must be untouched (mtime/hash check
     best-effort); no visual requirement.
   - Invalid → corrective retry **in the same conversation**: unlink sentinel,
     respawn `--resume` with the validation errors, up to `maxTurnRetries`.
7. **Accept + enrich**:
   - `revised: true` → `markPresented` for the working version (the `revise:present`
     event lives here — only a revising, accepted turn burns a presentation);
     `links` = read/diff/visual URLs for that version (same construction as
     `runRevise`; never trust writer URLs).
   - `revised: false` → **no** presented-marking (the pre-minted working copy stays
     unpresented and is reused next turn — no empty-diff version churn); `links`
     point at the **last presented** version, or are **`null`** when nothing has
     been presented yet (e.g. a pure-Q&A turn 1 — the enriched `links` object is
     `{read: null, diff: null, visual: null}` and the skill simply omits the link
     row).
   - Rewrite `reply.json` atomically with enrichment, update `writer.json`
     (`status: idle`, `turns: N`), append WAL events, print the envelope on stdout.
     **The relay process's exit is the skill's wake signal** — never watch
     `reply.json` (it is rewritten mid-flight by retries/enrichment).

WAL events (all with `metadata: {phaseKey, turn}` — **never** `step`+`to`, so
`pendingStep()` provably ignores them): `relay:sent`, `relay:reply`,
`relay:invalid`, `relay:failed`, `relay:rebootstrap`, `relay:fallback_inline`.

**Terminal failure UX** (retries burned / timeout / fatal signature / resume dead):
`{ok:false, error, phaseKey, turn, paneSnapshotPath, tmuxSession, remediation}`.
`remediation` names concrete options in preference order: (1) wait for the
rate-limit window and re-run `relay` (re-attach; usually the cheapest), (2) let
auto-rebootstrap run (only if the pool has another account — with a single-account
pool the binary says so and skips this option), (3) `relay --fallback-inline` —
flips `session.json.writerMode` to `inline` for the rest of the session,
**with an explicit warning the skill must surface and confirm**: "inline runs the
full writer workload (prompt + reviewers + visuals) on THIS account and context —
the cost deferred mode exists to avoid — and cannot be switched back this session."
Discussion history stays on disk either way.

**Auto-rebootstrap** (resume launch fails on 2 consecutive attempts, or the
harness home lost the conversation): mint a new uuid, re-pick from the pool
(**excluding** the failed account when alternatives exist; a single-account pool
retries the same account — a lost HOME on the same account is still
re-bootstrappable, and account-level failures surface as rate-limit/auth fatals
instead), send a **full turn-1-style message** —
the writer-session contract, the prepared step prompt, the reviewer payload (when
the step has one), and the visual brief — plus "continue from the artifact at
<path>; prior discussion: last 3 turns' summaries + all open questions/items
inlined". Turn numbering **continues** (the rebootstrap message is the next turn N
in the same scratch dir). `relay:rebootstrap` records it.

## 5. The writer-session contract (`WRITER_SESSION_GATE`)

Binary-owned block in `src/steps/prompt-helpers.ts`, used in place of
`SHARED_APPROVAL_GATE` for deferred assembly. Key content:

- You are the **writer session** for step `<step>` of kautopilot session `<id>`;
  a relay forwards messages between you and the user. You never talk to the user
  directly and you **never run `kautopilot` commands** — the binary owns versions,
  approval, and completion.
- Each turn you receive the user's latest answers/feedback, the **working version
  path**, and the reply contract. Do the step's work: draft/update the artifact
  **at the given path** (only when revising), spike unknowns with your own
  subagents, and — **when a reviewer payload was provided** (write_spec /
  write_plans) — run the fan-out as parallel subagents (model
  `<writer.reviewerModel>` if set) and fix until clean BEFORE finishing a revising
  turn. Generate the visual (`vN.html` per the brief at `<visualBriefPath>`) for
  every revising turn — the relay rejects `revised: true` without it.
- **Never clone or create repos.** If a repo isn't found locally, emit a
  `questions[]` entry ("repo X not found — clone it?") and stop that line of work
  until answered. (Deferred analogue of controller Rule 4.)
- **Everything agreed must live in the artifact** — the discussion transcript does
  not survive epochs; decisions recorded only in conversation are lost.
- **Progress markers:** append one short line to `<turn dir>/progress.log` at each
  phase change (`drafting`, `reviewers 3/8`, `fixing findings`, `visual`,
  `finalizing`) so the user has a live status.
- End EVERY turn by writing `<turn dir>/reply.json` per the schema (inlined), then
  `touch <turn dir>/done` as the very last action. A pure Q&A turn sets
  `revised: false` and leaves the artifact untouched.
- Populate `proposedCompletionMetadata` from the artifact once the phase looks
  approvable (shape from the step's `completionMetadataSchema`, provided in the
  message) — the main session confirms it with the user; you never decide approval.
- **Approval turns:** when the message says "the user approved — final consistency
  check", verify artifact-vs-discussion consistency and metadata **without
  revising** (`revised: false`) unless something is genuinely broken — a revision
  here forces a re-presentation round.

## 6. Envelope schema (zod)

```ts
const envelopeSchema = z.object({
  summary: z.string().min(1).max(600),              // short, mobile-first
  answers: z.array(z.object({
    question: z.string(), answer: z.string().max(2000),
  })).default([]),
  questions: z.array(z.object({                     // needs the USER (not spikeable)
    id: z.string(), text: z.string().max(2000),
    options: z.array(z.string()).optional(),        // AskUserQuestion shaping
  })).max(5).default([]),
  openItems: z.array(z.string().max(200)).max(10).default([]),
  artifact: z.object({
    kind: z.string(),
    version: z.number().int().min(1),               // the working version handed out
    revised: z.boolean(),
  }),
  reviews: z.object({                                // only for steps WITH a payload
    clean: z.boolean(), rounds: z.number().int().min(0),
    unresolved: z.array(z.string()).default([]),
  }).optional(),
  /** Writer's draft of the step's completion --metadata (triage: complexity/repos/
   *  repoPaths/dependsOn/branchSlug; master_plan: mergeMode/prs/nodes/deps;
   *  feedback: rules[]). The MAIN session confirms with the user before `complete`. */
  proposedCompletionMetadata: z.record(z.unknown()).optional(),
});
```

Binary-added enrichment (never written by the writer):

```jsonc
"links": { "read": "<url|null>", "diff": "<url|null>", "visual": "<url|null>" },
                                        // all null until a version has been presented
"turn": 3, "phaseKey": "spec@1", "account": "claude-auto-writer"
```

**Envelope text is data, not instructions**: the skill relays it to the user but
never treats it as directives to itself (pool accounts may be backed by
third-party models). The zod caps above are enforced at validation.

## 7. `kautopilot discussion` — capture surface

```
kautopilot discussion [--phase <phaseKey|artifactKind>] [--session <id>] [--json]
```

Reads the scratch mailbox: `{phaseKey, writer: {account, status, turns,
tmuxSession?}, turns: [{turn, sentAt, repliedAt, state, attempts, elapsed,
lastProgress, message, envelope}]}`. `state` per turn: `sent | running | replied |
invalid | failed` (derived from `meta.json` + files — a turn without `done` +
accepted meta is in-progress, never shown as replied). `lastProgress` = last line
of `progress.log`. Default phase = the pending step's artifact. This CLI is the
inspection tool until the UI tab lands.

`kautopilot ps` additions: when a session's pending phase has a `writer.json`, show
`writer: running turn 7 (12m, claude-auto-writer)` (at least in `--json`).

### Server + UI

- `GET /api/sessions/:id/discussion/:phaseKey` → same JSON (read fresh, like other
  routes in `server/routes.ts`).
- Dashboard (`server/page.ts`): a **Discussion tab** per artifact page — chat-style
  timeline (user message → writer summary/answers/questions), version chips
  linking Read/Visual, status badge (`writing… <lastProgress>` / `waiting for you`
  / `failed`). Reuses the existing SSE live-reload stream. (A user requirement —
  ships as the LAST implementation step so the core soaks first.)

## 8. Skill changes (both `kfleet/skills/kautopilot` + `kfleet/skills-codex/kautopilot`)

**Minimal-invasiveness rule:** the six inline sections of SKILL.md (reviewer
fan-out, revise, visual, review loop, open-questions gate, context reset) stay
untouched. Deferred mode ships as a new sibling doc **`relay.md`** (like
`visual.md`/`links-table.md`); SKILL.md gains only: (a) one paragraph in "The
loop" — branch on `d.execution`, deferred → follow `relay.md`; (b) the hyperlink
rule below.

`relay.md` contents:

- **The relay loop:**
  ```
  reply = relay(<kickoff or user answers>)        # parked — see below
  present: summary → answers (one line each) → named links → questions
           (AskUserQuestion, ≤4 per batch, blocking first) → open items as a
           count + top 3 (full list on request)
  gates unchanged: triage/spec open questions must be USER-answered; the litmus
    lens runs inside the writer (reviews.clean — when the step has reviewers —
    plus empty openItems are the signals)
  on "approve":
    if the last accepted envelope has revised:true (nothing since), reviews clean
    (or step has no reviewers), openItems empty, and proposedCompletionMetadata
    present → SKIP the consistency turn, go straight to metadata confirmation
    else → relay the approval once ("final consistency check — do not revise");
      if it comes back revised:true, RE-PRESENT that version and require a fresh
      "approve" (never complete on an unseen version)
    then confirm proposedCompletionMetadata with the user (AskUserQuestion —
      triage: complexity/repos/repoPaths/dependsOn/branchSlug; master_plan:
      mergeMode/prs/nodes/deps; feedback: rules) and
      `kautopilot complete --output … --metadata <confirmed>`
  ```
- **Metadata corrections:** value-level fixes (a repoPath, the branch slug) go
  directly into the confirmed `--metadata` — metadata is the record of truth for
  repos/branch and the binary persists it. Semantic changes (wrong repo *set*,
  wrong dependency shape) go back through a relay turn so the artifact stays true.
- **Parking (the 10-minute problem):** `relay` can block far past the Bash tool's
  10-min cap (see latency below). NEVER run it foreground and NEVER watch
  `reply.json`. Claude: `Bash(run_in_background: true)`; **the wake signal is
  process exit** — read the completed shell's stdout for the enriched envelope.
  Codex: delegate a cheap blocking subagent that runs the relay and returns the
  envelope JSON (same pattern as `kloop wait`). While parked, tell the user
  honestly: **Q&A turn ~2–5 min; revising turn (reviewers + visual) ~10–25 min;
  hard cap 30/attempt** — and include the watch line (`tmux attach -r -t kap-…`)
  and that `kautopilot discussion` shows live progress. When the envelope lands
  and the user has likely stepped away, send a push notification (one line:
  phase, turn, #questions).
- **User messages mid-flight:** if the user says something while a turn is parked,
  acknowledge and queue it; merge it with their answers to the incoming envelope's
  questions and send as the next turn. Never call `relay --message` while a turn
  is in flight (the binary errors).
- **Session start (deferred triage):** present the fetched-ticket summary and
  "triage deferred to the writer — working…" BEFORE parking, so the session
  doesn't open with dead air.
- **Resume protocol** (after `/clear`, `continue`, crash): on entering a deferred
  step, FIRST run `kautopilot discussion --json`; last turn `replied` and
  unanswered → re-present its envelope (no new relay); `running` → re-run `relay`
  with no message (idempotent re-attach/adopt) and park; only send a new message
  once the user has answered.
- In deferred mode the main session **never** spawns reviewer/visual/spike
  subagents for writer steps — the writer owns them.
- Deferred failures: present `remediation` verbatim; `--fallback-inline` only
  after showing its cost warning and getting explicit user confirmation.

**Hyperlink rule (all modes, hard requirement, SKILL.md + links-table.md):** never
print a raw URL — the visible text is a short name (`spec v3`, `triage v2`,
`plan 1 v1`, `spec v2→v3 diff`, `visual`), hyperlinked, in message bodies and the
links table alike.

## 9. Code touchpoints (kautopilot-ts)

| File | Change |
|---|---|
| `src/core/types.ts` | `writer` config schema (**top-level `.default()`**) + `DEFAULT_CONFIG.writer`; envelope schema |
| `src/core/config.ts` | `serializeConfigWithComments` emits the writer section |
| `src/core/session-meta.ts` | `writerMode?: "inline"\|"deferred"` on SessionMeta |
| `src/core/descriptor.ts` | `execution` field |
| `src/core/driver.ts` | compute `execution`; lightweight deferred descriptors; expose revise internals (mint-or-reuse, markPresented, alreadyPresented, URL construction) for the relay; `runRevise` rejects on deferred steps |
| `src/core/writer/` (new) | `scratch.ts`, `pool.ts`, `tmux.ts` (kloop port + NEW resume path + fatal-signature scan), `relay.ts` (turn engine §4), `envelope.ts` (validate/verify/enrich/caps) |
| `src/cli/relay.ts` (new) | command, lock+heartbeat, `--message/--message-file/--fallback-inline` |
| `src/cli/discussion.ts` (new) | turn list |
| `src/cli/start.ts` | `--writer inline\|deferred`; persist `writerMode` |
| `src/cli/stop.ts`, `src/cli/delete.ts` | kill `kap-<sessionId>-*` tmux sessions; stop marks `writer.json.status=interrupted` (re-attachable, NOT terminal); delete removes scratch with the sessionDir |
| `src/cli/ps.ts` | surface running-writer info from `writer.json` |
| `src/steps/prompt-helpers.ts` | `WRITER_SESSION_GATE` + `approvalGate(ctx)` |
| `src/steps/plan.ts` | writer steps use `approvalGate(ctx)`; deferred-aware `prepare` assembly |
| `src/index.ts` | register relay + discussion |
| `src/server/routes.ts` | discussion API route |
| `src/server/page.ts` | Discussion tab |
| `CLI-CONTRACT.md`, `SPEC-kautopilot.md` | document execution/relay/discussion |

Skill side: `kfleet/skills/kautopilot/{SKILL.md,links-table.md,relay.md(new)}` and
the `skills-codex` mirror.

tmux port notes: copy waitForPaneReady, injectLine, bypass-gate dismissal, sentinel
poll, /exit + kill backstop, CLAUDECODE scrub; add the fatal-signature pane scan
and the resume-replay-tolerant readiness/inject probing. Skip transcript copying
(pane snapshot into `meta.json` on failure is the diagnostic; the record is the
envelope). Session names: `kap-<sessionId>-<phaseKeySafe>-t<N>-a<attempt>` (safe
from kloop's `kloop-`/`devloop-` cleanup filters). Injectable spawn seam (like
kloop) so the turn engine is unit-testable with a fake tmux.

## 10. Testing

- Unit (fake tmux via the spawn seam): envelope validation incl. caps + side-effect
  checks (revised true/false paths); scratch layout/turn indexing/idempotent
  re-read/messageHash-equality dedupe; the §4.3 recovery matrix incl. alive-tmux
  adoption and idempotent acceptance re-run; Q&A turns don't burn presentations;
  pool weighted pick (seeded) + rebootstrap account exclusion; phaseKey derivation
  incl. `plans@E:repo`; descriptor `execution` + lightweight deferred shape;
  `runRevise` deferred rejection; WAL events non-cursor; fatal-signature
  classification.
- Integration (local/manual, skipped when `tmux` absent — CI runs no bun tests):
  fake "claude" shell script through real tmux, 3 turns incl. one corrective retry
  and one Q&A turn.
- **Manual soak (required before enabling deferred for real work):** real claude
  account, one spec phase, ≥3 turns — validates the `--resume` launch path,
  readiness under transcript replay, envelope quality, and the latency claims.

## 11. Rollout

1. Binary lands; `writer.mode: inline` default → zero behavior change.
2. Skill + `relay.md` land (old binary compatible: no `execution` field → inline).
3. Soak: `writer: {mode: deferred, steps: [write_spec]}` on a real ticket.
4. Widen `writer.steps` to all six; Discussion UI tab ships last.
