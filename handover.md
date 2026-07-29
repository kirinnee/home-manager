# kteam — handover

Every open feature, rewritten from the 2026-07-29 review. This is the single source of truth — it supersedes the earlier features and remaining-features docs, which are deleted.

Nothing here is done until the human says so. "Shipped" is a fact about the repo, not acceptance.

---

## 0. Decisions that apply everywhere

### 0.1 Reference syntax — one standard, all surfaces

Writing syntax. What gets inserted is the literal token; the preview links it.

| Kind      | Sigil | Example                               |
| --------- | ----- | ------------------------------------- |
| Agent     | `:`   | `:zelda`                              |
| File      | `@`   | `@handover.md`, `@src/api.ts:120-140` |
| Task      | `&`   | `&F12`                                |
| Attention | `!`   | `!A3`                                 |

- `@@@`-style repetition is for **picking** a reference, not for writing one. The inserted text is always the sigil form.
- **All four are clickable in every rendered message**, not just some surfaces.
- **Pins are removed from the reference system.** Pinning stays a feature; it is not a sigil.
- The LLM must understand these when reading, and **must emit them when writing**. Agents currently write filenames in backticks, which renders as unreadable inline code instead of a link. Files always use `@` with the `:line` suffix where a line matters.
- This belongs in the agent skill (see 69/70), not just the UI.

### 0.2 Caching

- Every kteam-managed resource is **cached in memory, loaded at startup**.
- Writes go **to cache first, then persist to file**. The daemon is a sole-writer singleton, so invalidation is exact — no TTLs.
- Memory cost is accepted.
- **A settings flag controls it.**

### 0.3 Cross-cutting rot to fix, not work around

- Tasks lose everything after the first ask: 61/74 have no description, **0/74 have any clarification**.
- `git status` hides untracked files (`status.showuntrackedfiles=no`) — has broken `main` four times.
- kteam's own source is live-executed, so a half-finished edit in `modules/kteam-ts/src/**` is a **fleet-wide outage**, not a failed build. Always work in a worktree.
- `a-gitlint` can't run in a worktree, so commit linting is effectively off.

---

## 1. Composer and references

### 3 — Remove `/clear`

Don't fix it. **Delete it.** It currently passes an empty boundary list and silently does nothing. Remove the command, its UI, and its autocomplete entry. `/compact` stays.

### 4–8 — Standardise every reference (merged)

One implementation covering agents, files, tasks and attention per **0.1**. Replaces the current split between `remark-task-references`, session references and composer highlighting.

- Same parse, same render, same click behaviour for all four.
- Clickable **everywhere** — messages, notices, task descriptions, warden reports, attention items, and the composer.
- Remove pins from the reference layer.
- Keep prove-before-link: a reference becomes a link only when it provably resolves.

### 9 — Custom composer

Replace opt-in preview-while-typing with a **purpose-built composer**.

- References render inline as you type, so they take one token of space instead of a full expanded string.
- **Vim mode**, toggleable in settings.
- Must not regress: the underlying control stays a real textarea for IME, autocomplete, dictation and mobile keyboards.

### 45, 51, 52 — Runtime controls on the composer

Model switch, effort, and **fast mode** must all be reachable **by clicking on the composer**, on **desktop and mobile**. Today the runtime block renders only in compact mode and tells desktop users to open Details. That's the bug.

---

## 2. Attachments

### 11, 12 — Verbatim, unless encrypted

- PDF, DOCX and text go to the daemon and the agent **verbatim**.
- **Encrypted files get a decryption flow**, not a rejection: prompt the user, decrypt **in memory**, attach the decrypted PDF, and give it to the agent.
- The decrypted copy is **never written to disk**. Original bytes stay stored as-is.
- Keep the existing named failure reasons for genuinely unreadable files (scan, corrupt, timeout, oversize).

---

## 3. Tasks

### 27, 28 — What a task must carry

Five requirements, in the human's order:

1. **Searchable** — find any task by text.
2. **Short title** — the five-word cap stays.
3. **Description** — mandatory in practice, not optional.
4. **Where the ask is** — the original ask, verbatim, plus every clarification, in order, with provenance.
5. **Who triggered it** — human or another agent. Agent-triggered is detectable from `kteam send`; use that rather than guessing.

Descriptions must render **outside `full` mode** too — today they're invisible in the compact views ([@TaskPresentation.tsx:292](modules/kteam-ts/ui/src/components/TaskPresentation.tsx#L292)).

### 25 — need-to / wait-for

- **need to** = hard blocker. Cannot start.
- **wait for** = advisory serial ordering, usually to stop two agents colliding on the same files. The scheduler may override with a reason.
- Board derives **ready / blocked / queued / in progress**. An unassigned `todo` must stop reading as neglected.
- `kteam task list --ready` answers "what should be done next" in one call.
- Design was approved; partial build is rescued at `~/.kteam/ms5o4r2f-63c523d3/`.

### 26 — Free status and priority

- **Any status to any status**, `--reason` still required.
- **Two guards survive:** human-gated phases stay human-only (an agent must never certify its own work), and dropping a task with dependents warns and names what it orphans.
- Assignee always optional.
- Priority: `urgent / high / normal / low`, settable by human or agent.
- On completion, surface **"Now ready: &F13…"**.

---

## 4. Warden

### 31 + warden reporting

1. **The report lists model and CLI automatically.** The warden must not have to write them into its own report text.
2. Use **`:agent` syntax** so agents render as links.
3. **Only scan running sessions.** Stopped sessions are not scanned.
4. **Raise attention only when the warden is unsure it may kill something.** By default it _can_ kill. Today's "needs attention" fires far too often and is far too long.

---

## 5. Attention and notifications

### 32 — Every attention item has one shape

| Field                 | Contents                                               |
| --------------------- | ------------------------------------------------------ |
| **Title**             | The ask, in one line                                   |
| **Context**           | Background for someone who hasn't followed the session |
| **Jargon**            | Every codename or term of art, expanded                |
| **What I need to do** | The concrete action                                    |

Enforce it in the type, not in a comment. The current guidance sits at [@attention-types.ts:29-42](modules/kteam-ts/src/attention-types.ts#L29-L42) and nothing makes agents follow it.

### 33 — Four kinds, by what the human does

| Kind                | The human's action                                       |
| ------------------- | -------------------------------------------------------- |
| **Permission**      | Approve or reject                                        |
| **Multiple choice** | Pick an answer                                           |
| **Answer review**   | Say whether the answer is good, or ask for clarification |
| **Open question**   | Write a full answer                                      |

This replaces the dead `permission` source, which is declared but has **no producer** ([@attention-sources.ts:194](modules/kteam-ts/src/attention-sources.ts#L194)).

### 34 — Dismissal

**Both agents and the human can dismiss.** (Supersedes the earlier retract-only proposal.)

### Notifications

A **separate feature** agents can call directly.

- Anything needing attention notifies automatically.
- Agents may also notify for other things, including completions.

### Attention UI — swipe to answer

- A **dedicated button, outside the side pane.**
- **Mobile only: tinder-style swipe** — up / down / left / right maps to the answer options.
- **Typing questions open a text box instead of swiping.**
- Items can also be resolved **outside** the swipe UI, by referencing and answering directly (`!A3`).

---

## 6. Browser

### Performance — the actual task

Improve it. Ranked by measurement:

1. Box runs at **~6× CPU capacity** — see **74**.
2. Transport sends **standalone JPEGs per frame** instead of a video codec.
3. Software rendering (SwiftShader), no GPU.
4. Network round trip per interaction.
5. Headless is **not** a factor — it isn't headless on Linux.

### Expand to max

The real browser must **expand to full size**. Today it is constrained by its pane; the human wants to give it the whole viewport when they are actually looking at it.

### 39 — Parked

Revisit once performance improves.

### 38 — Approved verdict

Keep headful Xvfb + governed CDP/JPEG. Don't build alternative modes.

---

## 7. Terminal, control and worktrees

### 41 — Control contract

Proceed. Browser attribution already ships ([@browser-service.ts:395](modules/kteam-ts/src/browser-service.ts#L395)). Missing: terminal attribution, `LastControl`, `control.updated`, `humanHold`, and the shared-control UI. Stage 2 auth widening still needs explicit approval.

### 42, 43 — Worktrees as a first-class primitive

- Worktrees follow **worktrunk** and become a **full primitive**, not helper functions.
- In the UI, **every worktree still lives under its root folder** — do not scatter them.
- Folder gets a **small logo showing whether it's a git repo**.
- Each session working in a worktree shows a **worktree icon**; hovering reveals its `PWD`.
- A worktree session **flows back to the root folder** in the tree.

---

## 8. Fleet controls

### 44 — Cascade and label kill in the UI

CLI already works. Build the **right-click controls**: kill children, kill cascade, kill all under a label.

### 53 — kfleet and MCP UI

Runtime controls ship. **MCP management UI does not exist** — build it.

### 54 — Native UI for kteam commands

Render kteam invocations as real UI instead of anonymous bash.

---

## 9. Analytics

### 46–50 — Rebuild the pipeline

**Both a global page and a per-session page.**

1. **Fix ingestion first.** When a session ends, pipe its analytics into **DuckDB** (or equivalent) so it is actually queryable. **Must work for both Claude and Codex.**
2. **Ship a default API list** the user can read through, rather than having to invent queries.
3. **Fix the model-id bug.** The transcript's model id differs from the session's. Cause: the model selector requires `[1m]` to request the 1M context, but the underlying model may just be `fable`. Normalise so both agree.
4. **Scope by pane.** A query run inside a session returns **that session and its descendants only**. Only the global page runs fleet-wide queries and renders the full graph.

---

## 10. Voice

### 57 — Waveform and latency

- **Build the mini waveform** — it existed and was unmounted by [12279d0](https://github.com/kirinnee/home-manager/commit/12279d0). This is a re-mount plus the missing UI.
- **STT is still too slow and laggy on desktop.** Mobile will be worse. Treat latency as the primary task, not the waveform.

---

## 11. Platform and UI shell

### 62 — PWA name and logo is unreachable

Shipped, but **there is nowhere to configure it.** Surface the control.

### 63 — Mobile text selection still broken

**The context menu that appears blocks everything.** Not fixed.

### 64 — Side pane and top bar rework — SEQUENCED

Too large and too shared to fan out. Seven tasks in three waves. Agents in the same wave never touch the same files; each wave finishes before the next starts.

**Mobile is a requirement of every task here, not a follow-up.** On mobile, **tabs are never a horizontal strip** — tapping the tab control opens a **modal to switch tabs**. This applies to the side pane tabs and to the top bar alike. A tab row that scrolls sideways on a phone is the thing being replaced.

**Wave 1 — foundation (serial, blocks everything else)**

| Task                             | Scope                                                                                                                                                                   | Owns                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **&F130** Unified side pane tabs | Web, files, tasks, terminals and friends become **one tab system** with a **+ button** to pick what you see. Default tabs: pins, tasks, skills, tree, mcp, needs, cost. | @SidePane.tsx, @SidePaneTabs.tsx, @SidePaneResizeHandle.tsx, tab identity and state |

Every other side pane task plugs into this tab model, so nothing below can start until it lands.

**Wave 2 — per-surface (parallel, disjoint files)**

| Task                                | Scope                                                                                                                                                              | Owns                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| **&F131** Compress browser HUD      | The HUD eats far too much space — collapse it to **a single bar**.                                                                                                 | browser surface components                 |
| **&F132** Files bar and tree        | Same single-bar treatment, **plus a collapsible tree pane** for fast navigation.                                                                                   | @FilesTab.tsx, @files.css, @files-model.ts |
| **&F133** Skills grouped and badged | Split into **global vs project** groups; badge each **claude / codex / both**.                                                                                     | skills surface                             |
| **&B53** Side pane search bars      | The side pane UI is broken, **search bars especially**. Build **one shared search primitive** rather than fixing each surface separately, so they stay consistent. | shared search component                    |

**Wave 3 — top bar (serial, independent of waves 1 and 2)**

| Task                                        | Scope                                                                                                                                               | Owns                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **&F134** Restructure the top bar           | **Tabs all on one side, Cmd-K search in the middle.** Mobile collapses tabs into a **bento/hamburger on the right** opening a select/dismiss modal. | @AppBar.tsx         |
| **&F135** Command palette covers everything | Analytics, warden, learning and settings become **Cmd-K searchable**. **Pull down on mobile opens Cmd-K.**                                          | @CommandPalette.tsx |

&F134 and &F135 both touch the top bar, so they run one after the other, not together. Wave 3 may run alongside waves 1 and 2 — it shares no files with them.

### 65, 66, 67

- **65** Side tab misalignment.
- **66** Back/forward follows the last-touched panel.
- **67** Daemon status must show the **deployed source SHA**, not a static version string.

---

## 12. Reliability

### 72 — Land the Tasks-pane fix

`/v1/tasks` does **2×187 sequential file reads** → **~14s**. Parallelising gives **~1s** (16× on the live mechanism). Patch written and verified at `~/.kteam/ms5o60ez-f9c5cd55/f128-part0.patch`. **Unlanded.**

### 71 — Caching

Implements **0.2**. Design approved.

### 73 — Route guard

Fail loudly when the UI calls a route the daemon never mounts. **This class has bitten five separate features.**

### 74 — cgroup caps, two levels

The measured cause of browser lag and of two bootstrap phase timeouts.

**Two separate caps, not one:**

1. **Fleet cap** — all agents together, ~90% CPU and RAM, so the fleet can never starve the box or the daemon.
2. **Per-agent cap** — each agent is also capped individually, so one runaway session cannot consume the whole fleet allowance.

**Requirements:**

- **Configurable** — both limits are settings, not constants.
- **Restartable** — changing a limit applies without tearing down running agents where possible; where a restart is genuinely required, say so plainly rather than silently doing nothing.
- **Disableable** — a single switch turns the whole thing off, and when off the code path is genuinely bypassed rather than set to an unlimited value.
- The daemon itself must stay serviceable when the fleet cap is hit. Starving `kteamd` would take the CLI down with it, which is the outage class already logged in **0.3**.

### 69, 70 — Agent skill

- **69** is built and needs `hms` (ships via `kfleet apply`/`hms`, not a UI release).
- **70** must additionally teach **0.1**: always write `@file:line`, `:agent`, `&task`, `!attention` — never bare backticks — plus the notify / needs / browser / files / terminals reference suite.

### 13, 14 — Proceed

- **13** Agent visual blocks: canvas, HTML, SVG.
- **14** Compaction progress: real stages and a progress bar, not a relabelled spinner.

### 75 — Fleet performance review

Parked until the backlog clears.

---

## 13. Security

### 76 — Peer token hardening

Shipped, awaiting the human's check.

### 77 — Shared bearer

**Open hole.** Any peer can stop, purge or hijack another session. Provenance now comes from the resolved server-side actor, but the token model is unfixed.

---

## Suggested order

Not a plan — a ranking.

1. **72** — one file, already verified, instant 14× on a pane used constantly.
2. **3** — deleting `/clear` is smaller than fixing it and removes a lie.
3. **0.1 / 4–8** — the reference standard blocks the skill, the composer and the warden report.
4. **60, 63** — both are "the UI does the opposite of what it says".
5. **74** — fixes the browser and the bootstrap timeouts together.
6. **27, 32** — both are "we lose what you actually said", the reason work returns a third time.

---

## Appendix — closed on 2026-07-29

Accepted by the human. Not open work; kept here so the record survives.

**1** message ordering · **2** stale send ageing · **10** content width ·
**15** task board · **16** real DAG · **17** task card design · **18** short titles ·
**19** markdown descriptions · **20** ADHD-friendly summary · **21** ask provenance ·
**22** clickable working agent · **23** human-verified phase · **24** task reopen ·
**29** warden · **30** warden report · **35** real browsing · **36** frame governor ·
**37** login banner · **40** web terminals · **55** live dictation · **56** STT off switch ·
**58** pins · **59** pin authority audit · **61** installable PWA

Closed means the human accepted it, not that code shipped. Numbers are never reused: a
number absent from this handover and absent from this appendix does not exist.

Note on **58**/**59**: pins are closed and the durable store genuinely is server-side, but
the browser can still diverge from it — that is **60**, still open above.
