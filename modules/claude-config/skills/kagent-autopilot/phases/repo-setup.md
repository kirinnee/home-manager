# Phase: Repo Setup — Team Member

**Agent Mode:** Spawned as repo-setup-agent. Execute this phase and report back to orchestrator.

## Agent Context (when spawned)

- Working directory: {WORKDIR}
- State file: `.kagent/task-state.json`
- Raw argument: {rawArgument}

## Agent Report Format

```
RESULT: <completed|error>
ORG: <org name>
TICKET_ID: <ticket ID or null>
TICKET_TITLE: <title or null>
PHASE: <planning|prereview>
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

**IMPORTANT:** For ClickUp tickets, strip the `CU-` prefix when searching. The ClickUp MCP does not recognize the `CU-` prefix format. Always store `ticketId` with the `CU-` prefix in state.

If auth fails: Jira → `acli jira auth`. ClickUp → check MCP server configuration.

### Set spec directory

- If ticket found: `specDir: "spec/{ticketId}/v1"` (e.g., `spec/PE-1234/v1`)
- If no ticket in autopilot mode: `specDir: "spec/manual/v1"`

## Step 3: Update State

Update `.kagent/task-state.json` with:

- `repoConfig`: the full config object from Step 1
- `ticketId`, `ticketTitle`, `ticketBody`, `ticketStatus`: from Step 2
- `specDir`: from Step 2
- `specVersion: 1`

### Set next phase:

- **Autopilot mode:** set `phase: "planning"`
- **Manual mode:** set `phase: "prereview"`

## Ticket State Transitions

Ticket transitions happen at specific phase boundaries (autopilot only, skipped in manual mode):

| When                                            | Config key                   | Example       |
| ----------------------------------------------- | ---------------------------- | ------------- |
| `run_spec` starts (first time per spec version) | `ticketTransitions.start`    | "in progress" |
| Autopilot completes (`phase: "completed"`)      | `ticketTransitions.done`     | "review"      |
| Feedback → next `run_spec`                      | `ticketTransitions.feedback` | "in progress" |

Execute via `repoConfig.ticketTransitionAccess` + `repoConfig.ticketTransitionCommand`.
Store current status in `ticketStatus`. If transition fails: log warning and continue.

## How Phases Consume repoConfig

| Phase              | Read from repoConfig                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| **prereview.md**   | `prereviewEnabled`, `baseBranch` (for `--base`)                                                |
| **pushing.md**     | `reReviewComment`, `baseBranch` (for PR target)                                                |
| **polling.md**     | `coderabbit` (whether to spawn coderabbit-resolver)                                            |
| **run-spec.md**    | `ticketTransitions.start`, transition access/command                                           |
| **Any ticket ops** | `ticketFetchAccess`, `ticketFetchCommand`, `ticketTransitionAccess`, `ticketTransitionCommand` |

## Resumability

If state already has `repoConfig` populated with non-empty object and `ticketId` is set (or `ticketSystem` is null): skip this phase, report as already complete.

If `repoConfig` is empty `{}`: re-run from Step 1.
