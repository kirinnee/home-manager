---
name: clickup-task
description: Create tasks in ClickUp with support for status changes, dependencies, assignees, and tags. Use when the user asks to create a task, change task status, add a dependency, or set up task relationships in ClickUp.
---

# ClickUp Task Creator

Create, update, and manage tasks in ClickUp via MCP with optional dependency relationships (blocks/waiting_on), status changes, and more.

## When to Use

- User asks to create a ClickUp task
- User asks to change a task's status (e.g., move to "in progress", "done")
- User asks to add a dependency between tasks ("blocks", "blocked by", "waiting on")
- User asks to set up task relationships or sequencing

## Prerequisites

- ClickUp MCP server must be configured (mcp\_\_clickup tools available)

## Instructions

### Step 1: Determine the Target List

Use `clickup_get_list` to find the list ID. Ask the user which list/space to create the task in if not specified.

If the user references a space name, use `clickup_get_workspace_hierarchy` to find the correct space and its lists.

### Step 2: Create the Task

Use `clickup_create_task` with the following parameters:

- `name` (required): Task name
- `list_id` (required): List ID from Step 1
- `description` or `markdown_description`: Task description (prefer markdown if rich formatting needed)
- `assignees`: Array of user IDs, emails, usernames, or "me" (use `clickup_resolve_assignees` if needed)
- `priority`: "urgent", "high", "normal", or "low"
- `due_date`: YYYY-MM-DD or YYYY-MM-DD HH:MM format
- `start_date`: YYYY-MM-DD or YYYY-MM-DD HH:MM format
- `tags`: Array of tag names (tags must already exist in the space)
- `status`: Override default status (must be valid for the list)
- `parent`: Task ID if creating a subtask
- `custom_fields`: Array of `{id, value}` objects
- `task_type`: Name of the task type (e.g., 'Bug', 'Feature')

### Step 3: Change Task Status

Use `clickup_update_task` with the `status` parameter to change a task's status.

The `status` field accepts the **exact status name** as configured in the list. Common status names include:

- `"backlog"` — not yet started
- `"in progress"` — actively being worked on
- `"review"` — in review/PR
- `"done"` — completed (sets `date_done` and `date_closed`)

**Important**: Status names must match exactly what's configured in the list. If you get "Status does not exist", the status name is wrong for that list.

To discover valid status names for a list, check an existing task in that list via `clickup_get_task` — the response includes `status.status` (the name) and `status.id`.

```json
// Example: move task to "in progress"
clickup_update_task(task_id="abc123", status="in progress")

// Example: mark task as done
clickup_update_task(task_id="abc123", status="done")
```

### Step 4: Set Up Dependencies (if requested)

After creating tasks, use `clickup_add_task_dependency` to link them:

- `task_id`: The task to set the dependency on
- `depends_on`: The target task ID
- `type`:
  - `"blocking"` — task_id blocks depends_on (task_id must finish before depends_on can start)
  - `"waiting_on"` — task_id is waiting on depends_on (task_id cannot start until depends_on finishes)

To remove a dependency, use `clickup_remove_task_dependency`.

### Step 5: Add Additional Context (optional)

- Use `clickup_create_task_comment` to add comments
- Use `clickup_add_tag_to_task` to add tags
- Use `clickup_start_time_tracking` to begin timing the task

### Step 6: Confirm and Link

Report back to the user with:

- Task name and URL
- List/space location
- Current status
- Any dependencies created
- Assignees and due dates if set

## Troubleshooting

| Issue                     | Solution                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Status does not exist"   | Status name must exactly match the list's configured statuses. Use `clickup_get_task` on any task in the list to see valid `status.status` names. Case-insensitive but spaces matter — use `"in progress"` not `"In Progress"` |
| List not found            | Use `clickup_get_workspace_hierarchy` to discover available lists                                                                                                                                                              |
| Invalid status            | Omit status param to use list default, or check valid statuses via `clickup_get_list` or `clickup_get_task` on an existing task                                                                                                |
| Tag not found             | Tags must pre-exist in the space                                                                                                                                                                                               |
| Assignee not resolved     | Use `clickup_resolve_assignees` to convert names/emails to numeric IDs                                                                                                                                                         |
| Dependency creation fails | Verify both task IDs are valid regular or custom IDs                                                                                                                                                                           |
