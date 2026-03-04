# {Step Name} — Team Agent ({Model})

## Agent Context

- Working directory: {WORKDIR}
- {Input 1}: {description}
- {Input 2}: {description}

## Agent Report Format

```
RESULT: <{success_value}|{failure_value}|error>
{FIELD_1}: <value>
{FIELD_2}: <value>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

{One-sentence description of what this step does.}

## Steps

### 1. {First Action}

{Instructions with specific commands or tool usage}

### 2. {Second Action}

{Instructions}

### 3. {Third Action}

{Instructions}

## Resumability

If resuming into this step:

- Check if {expected output} already exists
- If yes: report success without re-doing work
- If no: start from Step 1

## Important

- Do NOT update state files (`task-state.json`, `{phase}-state.json`)
- Do NOT {boundary specific to this step}
- Only {what this step actually does}
