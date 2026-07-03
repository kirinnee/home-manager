---
name: clickup-task
description: Create tasks in ClickUp with support for status changes,
  dependencies, assignees, and tags. Use when the user asks to create a task,
  change task status, add a dependency, or set up task relationships in ClickUp.
---

# ClickUp Task Creator

Create, update, and manage tasks in ClickUp via the `cup` CLI.

## When to Use

- User asks to create a ClickUp task
- User asks to change a task's status (e.g., move to "in progress", "done")
- User asks to add a dependency between tasks ("blocks", "blocked by", "waiting on")
- User asks to set up task relationships or sequencing

## Prerequisites

- `cup` CLI must be installed and authenticated. `cup auth` only validates the
  token and shows the current user; to set up or re-authenticate, run
  `cup init --token <personal-api-token> --team <teamId>` (get the token from
  ClickUp → Settings → Apps)

## Instructions

### Step 1: Determine the Target List

Run `cup spaces` to list spaces, then `cup lists <spaceId>` to find the list ID.

If the user doesn't specify a space/list, ask which one to use.

### Step 2: Create the Task

```bash
cup create -l <listId> -n "Task name" [options]
```

Options:

- `-d, --description <text>` — Task description (markdown supported)
- `-p, --parent <taskId>` — Parent task ID (creates as subtask; list auto-detected from parent)
- `-s, --status <status>` — Initial status (e.g. "in progress")
- `--priority <level>` — `urgent`, `high`, `normal`, `low` (or 1-4)
- `--due-date <YYYY-MM-DD>` — Due date
- `--assignee <userId>` — Assignee user ID or `"me"`
- `--tags <tags>` — Comma-separated tag names (must exist in the space)
- `--custom-item-id <id>` — Custom task type ID
- `--time-estimate <duration>` — e.g. `"2h"`, `"30m"`, `"1h30m"`

### Step 3: Change Task Status

```bash
cup update <taskId> -s "in progress"
cup update <taskId> -s "done"
```

**Note**: `cup update -s` fuzzy-matches status names (e.g. "prog" matches "in progress"). `cup create -s` does not document fuzzy matching, so use the exact configured status name when creating. To discover valid statuses, check an existing task with `cup task <taskId>`.

### Step 4: Set Up Dependencies (if requested)

```bash
# This task is waiting on another task
cup depend <taskId> --on <otherTaskId>

# This task blocks another task
cup depend <taskId> --blocks <otherTaskId>

# Remove a dependency
cup depend <taskId> --on <otherTaskId> --remove
```

### Step 5: Add Additional Context (optional)

```bash
# Post a comment
cup comment <taskId> -m "Comment text"

# Add tags
cup tag <taskId> --add "tag1,tag2"

# Assign users
cup assign <taskId> --to me
cup assign <taskId> --to <userId>
```

### Step 6: Confirm and Link

Report back to the user with:

- Task name and ID/URL
- List/space location
- Current status
- Any dependencies created
- Assignees and due dates if set

## Troubleshooting

| Issue                   | Solution                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Status does not exist" | Use one of the list's configured statuses (`cup update -s` fuzzy-matches; use the exact name with `cup create -s`). Check valid names via `cup task <id>` on an existing task |
| List not found          | Use `cup spaces` then `cup lists <spaceId>` to discover available lists                                                                                                       |
| Tag not found           | Tags must pre-exist in the space. Use `cup tags <spaceId>` to see available tags                                                                                              |
| Assignee not resolved   | Use `cup members` to find user IDs                                                                                                                                            |
| Not authenticated       | `cup auth` only validates; re-authenticate with `cup init --token <personal-api-token> --team <teamId>` (token from ClickUp → Settings → Apps)                                |
