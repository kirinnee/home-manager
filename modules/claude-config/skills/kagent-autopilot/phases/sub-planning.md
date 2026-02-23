# Phase: Sub-Planning (Optional)

This phase evaluates whether to break down a large task into sub-plans. It only runs if the task might benefit from sub-planning.

## Entry Condition

This phase is entered from `setup.md` (after spec approval with `phase: "approved"`).

First, evaluate if the task **might** warrant sub-plans based on:

- **Explicit phases in the ticket** — e.g., "Phase 1: Backend API, Phase 2: Frontend UI"
- **Disjoint components** — work touching completely separate systems
- **Very large tickets** — 15+ distinct requirements
- **User explicitly requested phased delivery**

**If none of these apply:**

1. Update state: `phase: "run_spec"` (keep `subPlans: null`)
2. Skip directly to `phases/run-spec.md`

## Step 1: Update State and Propose Sub-Plans

Update state: `phase: "sub_planning"` (for resumability).

1. Read `spec/<task-id>/task-spec.md` and identify potential independent work streams

2. **Check for Domain-Driven Design skill:**

   ```bash
   ls ~/.claude/skills/domain-driven-design/SKILL.md 2>/dev/null || \
   ls ./.claude/skills/domain-driven-design/SKILL.md 2>/dev/null
   ```

3. **If DDD skill exists:** Read it and use its bounded context definitions to group plans:
   - Group plans by **bounded context** (each context is a cohesive domain boundary)
   - Note: **1 bounded context can have multiple plans** if the context is large or complex
   - Name plans to reflect their bounded context (e.g., `auth-context-1.md`, `auth-context-2.md`)
   - Ensure each plan stays within a single bounded context

4. **If no DDD skill:** Group by technical boundaries or explicit phases from the ticket

5. Propose 2-4 sub-plans, each being:
   - A complete, deliverable unit of work
   - Minimal overlap with other sub-plans (ideally no shared files)
   - Independently testable
   - (If DDD) Contained within a single bounded context

6. Present proposal to user via `AskUserQuestion`:
   - Show the proposed breakdown with titles and summaries
   - If DDD is used, indicate which bounded context each plan belongs to
   - Include option: "No, implement as single plan instead"

## Step 2: Handle User Decision

**If user approves sub-plans:**

1. Create the plans directory and write each sub-plan:

   ```bash
   mkdir -p spec/<task-id>/plans
   ```

   Write files: `spec/<task-id>/plans/phase-1.md`, `phase-2.md`, etc.

2. Commit the spec files:

   ```bash
   git add spec/<task-id>/
   git commit -m "docs: add sub-plans for <task-id>"
   ```

3. Update state:
   ```json
   {
     "phase": "run_spec",
     "subPlans": [
       { "id": "phase-1", "file": "spec/<task-id>/plans/phase-1.md", "status": "pending" },
       { "id": "phase-2", "file": "spec/<task-id>/plans/phase-2.md", "status": "pending" }
     ],
     "currentSubPlanIndex": 0
   }
   ```

**If user rejects (wants single plan):**

1. Leave `subPlans: null` and `currentSubPlanIndex: null` in state
2. Update state: `phase: "run_spec"`

**If user requests changes:**

1. Incorporate feedback and re-propose
2. Repeat until approved or user chooses single plan

## Resumability

If resuming into this phase (`phase: "sub_planning"`): Re-propose the sub-plans to the user.

## Next

Read `phases/run-spec.md` and follow it.
