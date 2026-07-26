# kteam UI + core — handover

State as of 2026-07-26. Written so a fresh session (or a human) can pick this up cold.

Live UI: <http://127.0.0.1:7337/> — `kteamd` serves `modules/kteam-ts/ui-dist` **directly off disk**.

---

## 1. The one thing that will bite you first

**Any `bun run build` in `ui/` is an instant production deploy.** The daemon reads `ui-dist` per
request, so a routine verification build silently replaces the live page with no commit and no
review. This happened once mid-user-test.

- Verification builds go to a temp `--outDir`.
- `ui-dist` is written **only** by a deliberate deploy commit.

**Concurrent teammates share one git index and one working tree.** This bit three distinct ways in
one batch: a foreign staged file swept into someone else's commit, the build-is-a-deploy incident,
and two agents unknowingly editing the same file.

- Assign explicit per-file ownership; no file owned twice.
- `git commit --only <paths>`, never `-a`, and audit the index first.
- Per-teammate worktree isolation is the proposed real fix — recorded as a feature candidate, not built.

---

## 2. Shipped and live

**UI** — 5 theme families × light/dark, each identifiable in greyscale (a hard ship gate; Mission
Control light failed it once and was reworked, not waved through) · full-bleed desktop · shared SPA
store on one socket, no reloads · persistent agent sidebar with filters · task-first dashboard ·
lineage nesting · chat declutter with right-aligned user bubbles · metadata bottom sheet · compact
system-block rows · ⌘K command palette · installable PWA · mobile: touch-scroll fix, visualViewport
keyboard handling (iOS + Android), 16px inputs, 44px targets.

**Numbers** — dashboard JS 253.8 KB → ~90 KB gzip (−65%). Contrast: 1470 pairs, 0 hard failures;
Neo-Brutalism holds AA, High Contrast holds AAA. Mobile chat content 25% → ~62% with the keyboard open.

**Core / CLI** — `--teammate` + `kteam name` (pick a callsign before launch) · `kteam rename`
(+ `--clear-parent`) · plain Title Case task titles, with kteam composing `[Teammate] Task` for the
**Claude-side** session name only · RC defaults off for `auto`, on for `interactive` · interactive
sessions no longer inherit a parent · chat-pointer self-heal · 13 reliability fixes from the
prob-log batch.

**Fleet** — `klaude`/`kodex` and `modules/klaude-ts` removed entirely; `rc-session` is kteam-only.
`kfleet/CLAUDE.md` and `CLAUDE.auto.md` now carry a kteam how-to (commands, naming, fan-out-by-default,
verify-don't-trust, shared-tree rules) and reach all agent homes as `CLAUDE.md` / `AGENTS.md`.

---

## 3. In flight — mobile round 3

The user's verdict after two mobile rounds: _"the UI interface still sucks… make the mobile better
to use — currently its too shit."_ The lesson: previous rounds compacted the desktop UI instead of
designing for a phone. Their density/settings/nav asks are all one complaint — **the wrong things are
on screen at all.**

Plan (rev 2.1, APPROVED after two independent-audit blocks):
`~/.kteam/ms1glu02-63abd9bf/mobile3-master-plan.md`, audit at
`~/.kteam/ms1ilp2p-397413df/mobile3-master-plan-audit.md`.

### Batch 1 — ship immediately, no audit gate (cause measured, fix known)

| Item | What                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | Reclaim ~80px: a **68px always-reserved hover-timestamp gutter** + 12px hover-rail indent — both dead space on touch. Assistant prose 268px→**≥344px** @390, 238px→**≥314px** @360. Biggest single win. |
| 1    | Theme selector: 5 cards overflow a 420px max-h and crush to 70–81px; plus the popover `display:none`s mid-interaction inside `data-kb-hide`.                                                            |
| 3    | Never autofocus search on touch (raised twice — it summons the keyboard).                                                                                                                               |
| 11   | **Touch: Enter = newline, never sends.** Correctness bug: Shift+Enter doesn't exist on a phone, so multi-line was impossible. Send button becomes mandatory, always visible, 44px, with disabled gates. |
| 5    | Drop the status pill and agent count from the mobile top bar.                                                                                                                                           |

### Batch 2 — audited, reshapes navigation

Settings page with **full / compact / minimal** density (mobile default: **compact**; minimal =
name + task only, on cards _and_ list) · top-bar declutter into a triple-dot · left nav rail
**Sessions · Warden · Settings**, top-left becomes only a bento (Back on leaf routes) · project
scoping (show ONE project, not grouped-among-others) · bottom-sheet tabs · PWA install invitation
(iOS has no `beforeinstallprompt` — manual instructions; never prompt when already standalone;
dismissal must persist).

**Cancelled:** right-click rename, ⌘F.

---

## 4. Decisions worth not re-litigating

- **Themes must differ structurally**, not by palette. Root cause was that **77 of 85 tokens were
  colour** and everything structural was hardcoded Tailwind. ~60 role tokens now cover typography,
  geometry, elevation, density, surface. Ship gate: name the family from a greyscale screenshot.
- **Hover-reserved space is a bug class on touch.** A sweep found exactly two instances (both fixed
  in S1) and a standing gate now prevents regrowth.
- **`data-kb-hide` contract**: only stateless, overlay-free chrome may live there — gated on no open
  dialog / `aria-expanded` / focus inside a hidden subtree.
- **Enter ambiguity resolves to newline.** Send-on-Enter requires positive confidence of a hardware
  keyboard. A user forced to tap a button is inconvenienced; a user whose half-written message fires
  cannot undo it.
- **Brackets belong only to the Claude-side session name.** kteam's TASK column stays plain.
- **Density gates are necessary but not sufficient** — the app passed every budget while the user
  still found it unusable. Chrome-to-content ratio was added after that lesson.

---

## 5. Known-open / deferred

- Two honest CANNOT-TELLs in `kteam-prob.md`, left open with fixture-capture instructions rather than
  closed to flatter the count.
- Feature candidates, not built: **per-teammate worktree isolation**; **question provenance** (a
  teammate once answered a structured question addressed to the human — the lead then cannot
  distinguish a human decision from an agent's inference).
- `/signal`-behind-adoption residual: bounded, riskier locking change deferred.
- A non-required mission-dark semantic-colour diagnostic still reports; the audited contract is green.

---

## 6. Operating notes

- **Never restart `kteamd`** without the human's say-so. When you do: capture a baseline
  (`kteam ps --json`), check nothing is mid-launch, restart, wait for `bootstrapping:false`, diff
  sessions, confirm `monitors == running` and `unmonitoredRunning: 0`, and verify liveness is
  actually ticking — not just that `ps` looks fine. Four clean restarts were done this way.
- **Sending a multi-KB message to a BUSY session can fail** (length-correlated; reproduced 8/8).
  Write the brief to a file, send a short pointer, and confirm delivery in the recipient's
  `channel/inbox.jsonl`. Warnings are unreliable in both directions.
- `completed` is a claim. Read `summary.md`, inspect the diff, run the gates yourself.
- Gates to keep green: `bun run check`; contrast (0 hard failures); horizontal-scroll assertion;
  mobile density budgets; the new hover-reserved-space gate.
- `kteam-prob.md` (repo root) is the running defect log — append, annotate, never delete history.
