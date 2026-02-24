# Phase: Setup (Interactive)

This phase runs when no `.kagent/task-state.json` exists.

## Step 0: Choose Mode

Use `AskUserQuestion`:

- **Autopilot** — full ticket-to-PR: fetch ticket, generate spec, dev-loop implements, push, CI/review loop
- **Manual** — you already implemented the code, autopilot handles push → CI/review → fix loop

If **Manual**: skip to [Manual Mode Setup](#manual-mode-setup) below.

---

## Autopilot Mode Setup

### Step 1: Auto-Detect Ticket ID

Check in order:

1. Argument passed to `/kagent-autopilot PE-1234`
2. Branch: `git branch --show-current` — match `PE-\d{4}` (Jira) or `CU-?[a-zA-Z0-9]+` (ClickUp)
3. Worktree: `wt current 2>/dev/null || true`

If not detected, use `AskUserQuestion` to ask for the ticket ID.

### Step 2: Fetch Ticket Details

**Jira (PE-XXXX):**

```bash
acli jira workitem view PE-1234 --fields '*all' --json
```

Extract: `fields.summary` (title), `fields.description`, `fields.comment.comments[].body`, acceptance criteria from description or custom fields.

**ClickUp (CU-XXXXX):**

**IMPORTANT:** When searching ClickUp, strip the `CU-` prefix and search by the raw ID only. The ClickUp MCP does not recognize the `CU-` prefix format.

```bash
# If ticket ID is "CU-abc123", search for just "abc123"
```

Use ClickUp MCP `clickup_search` tool with keywords set to the ID **without** the `CU-` prefix. Then use `clickup_get_task` to get full details.

Extract: `name` (title), `description`, `status.status`, comments via `clickup_get_task_comments`.

If auth fails: Jira → `acli jira auth`. ClickUp → check MCP server configuration.

**Note:** The `CU-` prefix is only used internally for identification. Always store `ticketId` with the `CU-` prefix (e.g., `"CU-abc123"`) in state and use it when creating spec directories.

### Step 3: Gather Configuration

Discover available binaries: `compgen -c | grep '^claude' | sort -u`

Use `AskUserQuestion` for:

- **Implementer binary** — which claude binary implements code
- **Reviewer binaries** (multi-select) — which binaries review code
- **Conflict checker binary** — which binary analyzes spec conflicts when iterations stall
- **Loop parameters:**
  - Max push cycles (default 5) — outer loop limit
  - Max iterations (default 10) — inner loop limit per dev-loop run
  - Conflict check threshold (default 3) — consecutive failures before conflict check
  - Implementer timeout (default 30 min)
  - Reviewer timeout (default 15 min)
- **Obsidian symlink** (default yes) — symlink `.kagent` to `~/Documents/Main/kagent/...`

### Step 4: Clarifying Questions

Before generating spec, ask about unclear requirements, technical approach, or scope. **This is the last chance for user input before the autonomous loop.**

### Step 5: Generate task-spec.md

Create `spec/<task-id>/task-spec.md` using [templates/task-spec-template.md](../templates/task-spec-template.md) populated with ticket data and clarifications.

**IMPORTANT:** The `<task-id>` must include the prefix:

- Jira: `PE-1234` (or whatever project prefix)
- ClickUp: `CU-abc123` (always include `CU-` prefix for ClickUp)

```bash
mkdir -p spec/<task-id>  # e.g., spec/PE-1234 or spec/CU-abc123
```

**Check for Domain-Driven Design skill before generating:**

```bash
ls ~/.claude/skills/domain-driven-design/SKILL.md 2>/dev/null || \
ls ./.claude/skills/domain-driven-design/SKILL.md 2>/dev/null
```

- **If DDD skill exists:** Read it and include in the spec:
  - Bounded context(s) this task belongs to
  - Relevant Ubiquitous Language terms from that context
  - Any domain events if applicable
- **If no DDD skill:** Omit the DDD section from the spec

**MANDATORY:** Present spec and get user approval via `AskUserQuestion` before proceeding.

### Step 6: Initialize State

On approval:

1. Ensure only `.kagent` is in `.gitignore` (NOT `spec/` — specs are committed):
   ```bash
   grep -qx '.kagent' .gitignore || echo '.kagent' >> .gitignore
   ```
2. If Obsidian symlink opted in:
   ```bash
   PROJECT_DIR=$(pwd)
   REL_PATH="${PROJECT_DIR#$HOME/Workspace/}"
   OBSIDIAN_TARGET="$HOME/Documents/Main/kagent/$REL_PATH"
   mkdir -p "$OBSIDIAN_TARGET"
   [ -d ".kagent" ] && [ ! -L ".kagent" ] && cp -a .kagent/. "$OBSIDIAN_TARGET/" && rm -rf .kagent
   [ ! -L ".kagent" ] && ln -s "$OBSIDIAN_TARGET" .kagent
   ```
3. Verify on feature branch (not main/master) — fail if not
4. Commit the spec files:
   ```bash
   git add spec/<task-id>/
   git commit -m "docs: add task spec for <task-id>"
   ```
5. Write `.kagent/task-state.json`:

```json
{
  "version": 1,
  "phase": "approved",
  "mode": "autopilot",
  "ticketId": "PE-1234",
  "ticketSystem": "jira",
  "ticketTitle": "Add user auth",
  "ticketBody": "Full ticket description...",
  "branch": "PE-1234-add-auth",
  "prNumber": null,
  "pushCycle": 0,
  "maxPushCycles": 5,
  "lastRunId": null,
  "lastRunExitCode": null,
  "lastRunStatus": null,
  "lastError": null,
  "conflictContext": null,
  "devLoopInitialized": false,
  "obsidianLinked": true,
  "implementer": "claude",
  "reviewers": ["claude-reviewer-zai"],
  "maxIterations": 10,
  "implementerTimeout": 30,
  "reviewerTimeout": 15,
  "conflictCheckThreshold": 3,
  "conflictChecker": "claude",
  "specDir": "spec/PE-1234",
  "subPlans": null,
  "currentSubPlanIndex": null,
  "tmuxSession": null
}
```

**Note:** For ClickUp tickets, `ticketId` should include the `CU-` prefix (e.g., `"CU-abc123"`), and `specDir` should be `"spec/CU-abc123"`.

**Next:** Read `phases/sub-planning.md` and follow it.

---

## Manual Mode Setup

For when you already implemented the code and want autopilot to handle push → CI/review → fix.

### Step 1: Gather Minimal Info

Use `AskUserQuestion` for:

- **Max push cycles** (default 5)
- **Obsidian symlink** (default yes)

Optionally detect ticket ID from branch (same patterns as autopilot). If found, store it. If not, that's fine — ticketId can be null.

### Step 2: Initialize State

1. Ensure only `.kagent` is in `.gitignore` (NOT `spec/`)
2. Set up Obsidian symlink if opted in (same as autopilot Step 6)
3. Verify on feature branch (not main/master) — fail if not
4. Write `.kagent/task-state.json`:

```json
{
  "version": 1,
  "phase": "pushing",
  "mode": "manual",
  "ticketId": null,
  "ticketSystem": null,
  "ticketTitle": null,
  "ticketBody": null,
  "branch": "feature/my-thing",
  "prNumber": null,
  "pushCycle": 0,
  "maxPushCycles": 5,
  "lastRunId": null,
  "lastRunExitCode": null,
  "lastRunStatus": null,
  "lastError": null,
  "conflictContext": null,
  "devLoopInitialized": false,
  "obsidianLinked": false,
  "implementer": null,
  "reviewers": [],
  "maxIterations": null,
  "implementerTimeout": null,
  "reviewerTimeout": null,
  "conflictCheckThreshold": null,
  "conflictChecker": null,
  "specDir": null,
  "subPlans": null,
  "currentSubPlanIndex": null,
  "tmuxSession": null
}
```

**Next:** Read `phases/pushing.md` and follow it.
