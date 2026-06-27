---
name: rc-session
description: 'Start a session: spin up a detached Claude Code remote-control (--rc) session via a yolo-* wrapper, in a worktrunk worktree, inside zellij. Use when the user says "start a session" / "start a new session", runs /rc-session, wants a remote-control / yolo session to drive remotely, or is kicking off work on a ticket in a fresh worktree.'
argument-hint: '[session name or ticket id]'
---

# Start a Remote-Control Session

Worktrunk-style flow that spins up a Claude Code **remote-control** session via a
`yolo-*` wrapper, running **detached inside zellij** so it survives this Claude
session and can be attached to (`zellij attach <slug>`) or driven remotely from the
phone.

The launched command is:

```bash
yolo-<harness> --rc --name "<session name>" --chrome
```

**Harness note.** `--rc` (remote-control, phone-driveable via claude.ai) and the
`yolo-*`/`crc` wrappers are **Claude Code** features. On **Codex** there is no
remote-control, so the codex equivalent is a _detached local_ session: launch the
codex wrapper inside zellij directly and attach to it locally —

```bash
zellij --session "<slug>" --new-session-with-layout <(printf 'layout { pane command="codex-<account>" { cwd "%s" } }' "$PWD")
# later: zellij attach "<slug>"
```

i.e. it survives this session and is attachable, but is **not** phone-driveable
(no `--rc`). Everything else below (worktree creation, naming, category routing)
is identical for both harnesses.

## Order of Operations

1. **Gather information** from the user (category, ticket, names).
2. **Go to the repo** for that category.
3. **Create the worktrunk worktree** (`wt switch --create`).
4. **Start the session** with `--rc`, detached, in that worktree.

## When to Use

- User runs `/rc-session`
- User wants to start a remote-control / yolo session to drive remotely
- User wants to kick off work on a ticket in a fresh worktree as a remote session

## Step 1 — Gather Information (use `AskUserQuestion`)

Reuse anything the user already gave in the argument/prompt; only ask for what's missing.

### Category

The category drives the repo root, ticket system, harness, and base branch:

| Category           | User's wording                                                   | Repo root                                                                   | Ticket system / id           | Harness        | Base branch |
| ------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------- | -------------- | ----------- |
| **Work – Vungle**  | "liftoff" (usually), "vungle"                                    | `~/Workspace/work/vungle`                                                   | Jira (`acli`), `PE-XXXX`     | `yolo-liftoff` | `master`    |
| **Work – Liftoff** | "accelerate"                                                     | `~/Workspace/work/liftoff`                                                  | Jira (`acli`), `PE-XXXX`     | `yolo-liftoff` | `master`    |
| **Atomicloud**     | "atomi", "LPSM", or a platform/service pair (e.g. "nitroso tin") | `~/Workspace/atomi/runbook/platforms/<platform>/<service>` (see LPSM below) | ClickUp (`cup`), `CU-xxxxxx` | `yolo-atomi`   | `main`      |
| **Personal**       | "personal"                                                       | `~/Workspace/personal`                                                      | ClickUp Personal (`cup`)     | `yolo-kirin`   | `main`      |
| **Admin / notes**  | trips, claims, notes, administrative                             | `~/Documents/Main` (Obsidian — no worktree)                                 | ClickUp Personal (`cup`)     | `yolo-kirin`   | —           |

Notes on the confusing work naming: when the user says **"liftoff"** they almost
always mean the **Vungle** sub-company (`work/vungle`); **"accelerate"** means the
**Liftoff** sub-company (`work/liftoff`). Both are under the same parent and both use
Jira `PE-XXXX` tickets and `yolo-liftoff`. Confirm which sub-company if ambiguous.

### Atomicloud / LPSM addressing

AtomiCloud's Service Tree is **LPSM** = `{landscape}-{cluster}-{platform}-{service}-{module}`.
The canonical, authoritative spec lives at
**`~/Workspace/atomi/shared/docs/developer/standard/service-tree.md`** — read it when you
need the full naming law; the chemistry below is just enough to resolve a repo path.

Two levels matter for "go to the repo":

- **Platform = functional group** — the dirs under `~/Workspace/atomi/runbook/platforms/`
  (e.g. `sulfoxide`, `nitroso`, `nitrite`, `cyanate`, `halogen`, `noble-gas`, …).
- **Service = element (periodic table)** — the subdir inside a platform; this is **the git
  repo** (e.g. `tin`, `zinc`, `helium`, `argon`, `carbon`, `hydrogen`, `iron`, `silicon`, …).

So when the user names a platform and a service (e.g. **"nitroso tin"** or "nitrite zinc"),
the repo is `~/Workspace/atomi/runbook/platforms/<platform>/<service>`. Don't hardcode the
theme lists — discover them by listing the dirs (the doc explains _why_ each is named so).
Each platform may also have a human brand (e.g. `nitrite` → "SnatcherSeal") — that's UI copy,
not a path.

If only a platform is given, list its service repos and ask which one. If only a service is
given, it's ambiguous (e.g. `tin`, `zinc`, `helium` exist under several platforms) — ask
which platform.

### Ticket

Ask whether it's tied to a ticket.

- **Yes:** get the ticket id and **fetch** it (Step 2 names below).
- **No:** ask for an id in the org's format (`PE-XXXX` for Work, `CU-xxxxxx` for Atomicloud).
  If the user leaves it blank, fall back to a name-only worktree (`<simple-name>`).

### Harness (always ask)

**Always ask which `yolo-*` wrapper to use** — never pick it silently. Present all three
options, putting the category-appropriate default first (and labelling it recommended):

| Category                 | Recommended default |
| ------------------------ | ------------------- |
| Work – Vungle / Liftoff  | `yolo-liftoff`      |
| Atomicloud               | `yolo-atomi`        |
| Personal / Admin / notes | `yolo-kirin`        |

Options are always: `yolo-kirin`, `yolo-atomi`, `yolo-liftoff`. The user may pick any of
them regardless of category.

### Worktree (ask)

**Always ask whether to open a worktree** (default **yes**, recommended for ticket work):

- **Yes** → create a worktrunk worktree in Step 4 and run the session there.
- **No** → skip Step 4; run the session in the **repo root on the current branch**. `WORK_DIR`
  is the repo path, and the `<slug>` comes from `<simple-name>` (or `<ticketId>-<simple-name>`).

For **Admin / notes** there is never a worktree — don't ask; run in `~/Documents/Main`.

### Names

- **`<simple-name>`** — short kebab-case slug for the worktree/branch/zellij session (no spaces).
- **Display name** (`--name`) — human-readable; spaces are fine.

## Step 2 — Ticket Handling (if a ticket id is given)

Fetch the ticket (run from inside the repo so the right auth/env is loaded):

| Org                           | Fetch command                                              |
| ----------------------------- | ---------------------------------------------------------- |
| Work (Jira)                   | `acli jira workitem view <PE-XXXX> --fields '*all' --json` |
| Atomicloud/Personal (ClickUp) | `cup task <taskId> --json`                                 |

From the result, extract the title/summary and **suggest** (confirm with the user):

- **Display name** (`--name`): `"<ticketId>: <title>"`
- **Worktree / branch / zellij slug**: `<ticketId>-<simple-name>` (kebab-case the title for `<simple-name>` if the user didn't give one)

If the fetch fails (auth / not found), report it and continue with names the user provides.
Jira auth: `acli jira auth`. ClickUp uses the `cup` CLI directly.

## Step 3 — Go to the Repo

Find candidate repos under the category's root and present them as `AskUserQuestion`
options (with "Other" for a manual path):

```bash
find <root> -maxdepth 3 -type d -name .git -prune 2>/dev/null | sed 's|/.git$||'
```

**Atomicloud / LPSM:** the repo is the **service (element)** dir, one level below the
**platform (functional group)** dir — `~/Workspace/atomi/runbook/platforms/<platform>/<service>`.
Resolve from what the user said (e.g. "nitroso tin" → `.../nitroso/tin`); if a piece is
missing or ambiguous, list and ask:

```bash
PLAT=~/Workspace/atomi/runbook/platforms
ls "$PLAT"                       # platforms (functional groups)
ls "$PLAT/<platform>"            # services (elements) — the git repos
```

For **Admin / notes**, the repo is always `~/Documents/Main` and there is **no worktree** —
skip Step 4 and run the session directly in that directory.

## Step 4 — Create the Worktrunk Worktree (only if worktree = yes)

Skip this whole step if the user chose **no worktree** (or Admin / notes): `WORK_DIR` is the
repo root and the session runs on the current branch — go straight to Step 5.

From the repo, branch from an up-to-date base (never `git checkout -b` — use worktrunk):

```bash
git -C "<repo>" switch "<baseBranch>" 2>/dev/null      # master (work) or main (atomi/personal)
git -C "<repo>" pull --ff-only 2>/dev/null || true
( cd "<repo>" && wt switch --create "<worktree-name>" --no-cd )
```

`<worktree-name>` is `<ticketId>-<simple-name>` when there's a ticket id, otherwise `<simple-name>`.
worktrunk places the worktree as a **sibling** named after the repo dir, i.e.
`<service>.<worktree-name>` for LPSM services (e.g. `nitroso/zinc` → `nitroso/zinc.CU-1234-foo`) —
you don't add the `<service>.` prefix yourself; worktrunk does.

Resolve the worktree path (this becomes `WORK_DIR`):

```bash
git -C "<repo>" worktree list --porcelain | awk -v b="refs/heads/<worktree-name>" '
  /^worktree / { wt = substr($0, 10) }
  /^branch / && $2 == b { print wt; exit }'
```

If worktrunk says the branch already exists, use `wt switch "<worktree-name>" --no-cd` and resolve the path the same way.

## Step 5 — Launch (detached `--rc`, inside zellij)

Run the bundled helper. It boots zellij inside a throwaway detached tmux session (zellij
needs a PTY), waits for the session to come up, then kills the tmux client so the zellij
session keeps running independently of this Claude session:

```bash
bash "<this skill's directory>/launch-rc.sh" "<WORK_DIR>" "<slug>" "<display name>" "<yolo-harness>"
```

- arg 1 `WORK_DIR` — the worktree path; or the repo root (no worktree); or `~/Documents/Main` (admin)
- arg 2 `slug` — zellij session name = `<worktree-name>`; **no spaces**
- arg 3 `display name` — value for `--name`; spaces/apostrophes are fine (quoted safely)
- arg 4 `yolo-harness` — `yolo-kirin` | `yolo-liftoff` | `yolo-atomi`

The helper exits non-zero with a clear message if the harness/zellij/tmux is missing, if a
zellij session with that slug already exists, or if the session doesn't come up.

## Step 6 — Report

```
Remote-control session started!
  Harness : yolo-<harness>
  Category: <category>
  Ticket  : <ticketId — title | none>
  Repo    : <repo path>
  Worktree: <path | n/a (admin, ran in ~/Documents/Main)>
  Branch  : <worktree-name | n/a>
  zellij  : <slug>   →  attach with:  zellij attach "<slug>"
```

## Tooling Reference

- **Jira** — `acli` (e.g. `acli jira workitem view PE-1234 --fields '*all' --json`)
- **ClickUp** — `cup` (`cup task <id> --json`, `cup search <q>`, `cup update <id>`, `cup create -l <listId> -n <name>`, `cup spaces`, ...)
- **Google Workspace** — `gws-lo` (Liftoff work) and `gws-per` (personal) for mail/Drive/Calendar/Docs
- **Worktrees** — worktrunk `wt` (`wt switch --create <name> --no-cd`)
- **Global tools** — always add via home-manager (`modules/`), cross-platform unless the tool is mac-specific

## Rules

1. **Confirm suggested names** derived from a ticket before launching — don't assume.
2. **Slug / worktree name has no spaces**; the `--name` display value may.
3. **Never `git checkout -b`** for worktrees — use `wt switch --create` (worktrunk).
4. **Admin / notes → no worktree**; run directly in `~/Documents/Main`.
5. **Don't clobber** an existing zellij session — the helper refuses; pick another slug or attach.
6. **Report the attach command** so the user can pick the session up locally.
