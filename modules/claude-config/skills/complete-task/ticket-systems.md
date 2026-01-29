# Ticket Systems Reference

## Jira

### Setup

1. Install `acli` (Atlassian CLI)
2. Run authentication: `acli jira auth`
3. Follow the OAuth flow

### Ticket ID Format

Pattern: `PE-XXXX` (4 digits)

Examples: `PE-1234`, `PE-5678`

### Fetching Tickets

```bash
# Basic view
acli jira workitem view PE-1234 --json

# All fields
acli jira workitem view PE-1234 --fields '*all' --json

# Specific fields
acli jira workitem view PE-1234 --fields 'summary,description,comment,acceptance-criteria' --json
```

### Response Structure

```json
{
  "key": "PE-1234",
  "fields": {
    "summary": "Add user authentication",
    "description": "Implement JWT-based auth...",
    "status": { "name": "In Progress" },
    "assignee": { "displayName": "John Doe" },
    "comment": {
      "comments": [
        { "body": "Comment text...", "author": {...} }
      ]
    },
    "customfield_10001": "Acceptance criteria..."
  }
}
```

### Extracting Information

- **Title**: `fields.summary`
- **Description**: `fields.description`
- **Status**: `fields.status.name`
- **Comments**: `fields.comment.comments[].body`
- **Acceptance Criteria**: May be in description or custom field

### Ticket URL Format

```
https://liftoff.atlassian.net/browse/PE-1234
```

---

## ClickUp

### Setup

1. Configure the official ClickUp MCP server in Claude settings
2. Authenticate through the MCP server

### Ticket ID Format

Pattern: `CU-XXXXX` or `CUXXXXX` (alphanumeric)

Examples: `CU-abc123`, `CUxyz789`

### Fetching Tickets

Use the ClickUp MCP server tools. The MCP server provides:

- Get task details
- Get task comments
- Get subtasks

### Response Structure

```json
{
  "id": "abc123",
  "name": "Add user authentication",
  "description": "Implement JWT-based auth...",
  "status": { "status": "in progress" },
  "assignees": [...],
  "custom_fields": [...],
  "comments": [...]
}
```

### Extracting Information

- **Title**: `name`
- **Description**: `description`
- **Status**: `status.status`
- **Comments**: Via separate API call
- **Acceptance Criteria**: Usually in description or checklist

### Ticket URL Format

```
https://app.clickup.com/t/abc123
```

---

## Detection Logic

```
if branch/worktree contains "PE-\d{4}":
    system = Jira
    ticket_id = matched pattern
elif branch/worktree contains "CU-?" followed by alphanumeric:
    system = ClickUp
    ticket_id = matched pattern
else:
    ask user for ticket ID
```

### Regex Patterns

```bash
# Jira
PE-[0-9]{4}

# ClickUp
CU-?[a-zA-Z0-9]+
```

---

## Common Fields to Extract

| Field       | Jira Path                     | ClickUp Path           |
| ----------- | ----------------------------- | ---------------------- |
| Title       | `fields.summary`              | `name`                 |
| Description | `fields.description`          | `description`          |
| Status      | `fields.status.name`          | `status.status`        |
| Assignee    | `fields.assignee.displayName` | `assignees[].username` |
| Comments    | `fields.comment.comments`     | Separate API           |

---

## Error Handling

### Jira Auth Expired

```
Error: Authentication required
```

Solution: Run `acli jira auth` again

### ClickUp MCP Not Configured

```
ClickUp MCP server is not configured.
```

Solution: Add ClickUp MCP server to Claude settings

### Ticket Not Found

```
Error: Issue PE-9999 not found
```

Solution: Verify ticket ID is correct

### Permission Denied

```
Error: You do not have permission to view this issue
```

Solution: Check Jira/ClickUp permissions
