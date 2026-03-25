# Plan Step: Repo Setup — Team Agent (Sonnet)

**Bootstrap exception:** This step writes `repoConfig`, `ticketId`, `ticketTitle`, `ticketBody`, `ticketStatus`, `specDir`, and `specVersion` directly to `task-state.json`.

## Agent Context

- Working directory: {WORKDIR}
- State file: `.kagent/task-state.json`
- Raw argument: {rawArgument}

## Agent Report Format

```
RESULT: <completed|error>
ORG: <org name>
TICKET_ID: <ticket ID or null>
TICKET_TITLE: <title or null>
ERROR: <error message if any>
```

## Step 1: Detect Repository Configuration

Detection order:

1. Check for `SETUP.md` in repo root → read YAML front matter as config
2. Fall back to auto-detection via git remote URL → read matching `repos/*.md`

### Auto-detection rules:

```bash
REMOTE_URL=$(git remote get-url origin 2>/dev/null)
```

| Match condition                                 | Config file           |
| ----------------------------------------------- | --------------------- |
| `$REMOTE_URL` contains `atomicloud` or `/atomi` | `repos/atomicloud.md` |
| `$REMOTE_URL` contains `vungle`                 | `repos/vungle.md`     |
| Everything else                                 | `repos/default.md`    |

Read the matching config file's YAML front matter and populate `repoConfig` with all fields:

- `org`, `baseBranch`, `ticketSystem`, `ticketPattern`
- `ticketFetchAccess`, `ticketFetchCommand`
- `ticketTransitions` (object with `start`, `done`, `feedback`)
- `ticketTransitionAccess`, `ticketTransitionCommand`
- `coderabbit`, `prereviewEnabled`
- `reReviewComment`, `reviewComment`

### Repo-local `SETUP.md`

If repo root has `SETUP.md`, read its YAML front matter. It follows the same format as `repos/*.md` and overrides auto-detection entirely.

## Step 2: Ticket Detection

After repoConfig is populated:

1. Extract ticket ID from (in order):
   - `rawArgument` (match `repoConfig.ticketPattern`)
   - Branch name: `git branch --show-current` (match `repoConfig.ticketPattern`)
   - Worktree: `wt current 2>/dev/null || true`
2. If no ticket and `repoConfig.ticketSystem` is set: ask user via `AskUserQuestion`
3. If no ticket and `repoConfig.ticketSystem` is null: ask if they have a ticket (optional)

### Fetch ticket details

Use `repoConfig.ticketFetchAccess` + `repoConfig.ticketFetchCommand`:

**CLI (`ticketFetchAccess: "cli"`):**

```bash
# Template: repoConfig.ticketFetchCommand with {ticketId} substituted
# Example: acli jira workitem view PE-1234 --fields '*all' --json
```

Extract: title, description, status, comments.

**MCP (`ticketFetchAccess: "mcp"`):**

```
# Use MCP tool named in repoConfig.ticketFetchCommand
# Example: clickup_get_task
```

**IMPORTANT:** For ClickUp tickets, the `cup` CLI uses the native ClickUp task ID directly (e.g., `86ev0gwax`). Store the raw task ID in state as-is.

If auth fails: Jira → `acli jira auth`. ClickUp → check MCP server configuration.

### Set spec directory

- If ticket found: `specDir: "spec/{ticketId}/v1"` (e.g., `spec/PE-1234/v1`)
- If no ticket: `specDir: "spec/manual/v1"`

## Step 2.5: Generate ticket.md

If a ticket was found, pre-fetch the full ticket hierarchy and write it to `spec/{ticketId}/ticket.md`. This file sits one level above the versioned directory and persists across spec versions.

```bash
mkdir -p spec/{ticketId}
```

### ticket.md format

```markdown
# Ticket: {TICKET_ID}

- **Type**: {type}
- **Status**: {status}
- **URL**: {url}
- **Parent**: {parentId or "none"}

## Description

{full description text}

## Comments

{all comments, chronological}

---

# Parent: {PARENT_ID} ({type})

- **Title**: {title}
- **Status**: {status}
- **URL**: {url}

## Description

{parent description}

---

(continue up the chain until no more parents)
```

### Parent walking

Walk up the parent chain and append each parent to the same `ticket.md` file.

**Jira (`ticketFetchAccess: "cli"`):**

```bash
TICKET_JSON=$(acli jira workitem view {ticketId} --fields '*all' --json)
PARENT_KEY=$(echo "$TICKET_JSON" | jq -r '.fields.parent.key // empty')
# If non-empty, fetch parent with same command, append to ticket.md, repeat
```

**ClickUp (`ticketFetchAccess: "mcp"`):**

```
# clickup_get_task response has .parent field (null or task ID string)
# If non-null, fetch parent with clickup_get_task, append to ticket.md, repeat
```

Walk until no more parents are found. Write the full ticket.md file.

## Step 3: Update task-state.json

**Bootstrap exception:** Write directly to `.kagent/task-state.json`:

- `repoConfig`: the full config object from Step 1
- `ticketId`, `ticketTitle`, `ticketBody`, `ticketStatus`: from Step 2
- `specDir`: from Step 2
- `specVersion: 1`

## How Phases Consume repoConfig

| Phase                               | Read from repoConfig                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `polish/steps/prereview.md`         | `prereviewEnabled`, `baseBranch` (for `--base`)                                                |
| `polish/steps/push.md`              | `baseBranch` (for PR target)                                                                   |
| `polish/steps/create-pr.md`         | `reviewComment`                                                                                |
| `polish/steps/poll.md`              | `coderabbit` (whether to spawn coderabbit-resolver)                                            |
| `implementation/steps/setup-run.md` | `ticketTransitions.start`, transition access/command                                           |
| Any ticket ops                      | `ticketFetchAccess`, `ticketFetchCommand`, `ticketTransitionAccess`, `ticketTransitionCommand` |

## Ticket State Transitions

Ticket transitions happen at specific phase boundaries:

| When                                    | Config key                   | Example       |
| --------------------------------------- | ---------------------------- | ------------- |
| First `setup_run` per spec version      | `ticketTransitions.start`    | "in progress" |
| Completed (`currentPhase: "completed"`) | `ticketTransitions.done`     | "review"      |
| Feedback → Phase 1                      | `ticketTransitions.feedback` | "in progress" |

Execute via `repoConfig.ticketTransitionAccess` + `repoConfig.ticketTransitionCommand`.
Store current status in `ticketStatus`. If transition fails: log warning and continue.

### Multi-step transitions

A transition value can be either a **string** (single step) or an **array** (multi-step):

- **String**: Execute one transition to that status.
- **Array**: Execute each status in sequence, left to right. Stop on first failure.

Example:

```yaml
# Single step (ClickUp — bidirectional)
feedback: 'in progress'

# Multi-step (Jira — one-way workflow)
feedback:
  - 'Testing'
  - 'Blocked'
  - 'In Progress'
```

After all steps complete, store the **final** status in `ticketStatus`.

## Resumability

If state already has `repoConfig` populated with non-empty object and `ticketId` is set (or `ticketSystem` is null): skip this step, report as already complete.

If `repoConfig` is empty `{}`: re-run from Step 1.
