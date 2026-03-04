# {Step Name} — Orchestrator Inline

**This is a reference document, not an agent.** The orchestrator reads this and executes the logic inline.

## Entry Condition

- `{phase}-state.step: "{step_name}"`

## Context Needed

Read from `.{state-dir}/task-state.json`:

- {field 1}
- {field 2}

## Step 1: {First Action}

{Instructions — this runs in the orchestrator's context, so it CAN:

- Chat with the user
- Use AskUserQuestion
- Spawn Explore subagents for research
- Make decisions based on user input}

## Step 2: {Second Action}

{Instructions}

## Step 3: {Advance State}

Update `{phase}-state.json` via state agent: `step: "{next_step}"`, `{other fields}`.

## Resumability

If resuming into this step:

- Check if {expected output} already exists
- If yes: {skip to approval/next action}
- If no: start from Step 1
