# {Step Name} — Sub-Agent ({Model})

**Sub-agent. Stateless.** Returns result directly to orchestrator.

Used by: {which phases/steps use this}

## Agent Context

- Working directory: {WORKDIR}

## Task

{One-sentence description of what this sub-agent does.}

## Steps

### 1. {First Action}

{Instructions}

### 2. {Second Action}

{Instructions}

### 3. Report

```
RESULT: <{success_value}|{failure_value}>
{FIELD}: <value>
```

## Important

- Do NOT update any state files
- Do NOT commit anything
- Do NOT modify code files
- Only {what this sub-agent does}
