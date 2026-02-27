# Phase: Sub-Planning (Optional)

This phase **ONLY runs when necessary**. Most tasks should be implemented as a single plan.

## Entry Condition

This phase is entered from `setup.md` (after spec approval with `phase: "approved"`).

## Quick Check: Skip Sub-Planning?

**Default to single plan.** Only consider sub-plans if ALL of these are true:

1. **Multiple bounded contexts** — Task spans 2+ distinct domain boundaries (check DDD skill)
2. **Clearly separate deliverables** — Each phase can be tested and shipped independently
3. **Significant complexity** — 15+ distinct requirements OR explicit phases in ticket
4. **User explicitly requested phased delivery**

**If ANY condition is NOT met:**

```
Update state: phase: "run_spec" (keep subPlans: null)
Skip directly to phases/run-spec.md
```

## When Sub-Planning Makes Sense

| Scenario                  | Example                                  | Why Sub-Plan?                             |
| ------------------------- | ---------------------------------------- | ----------------------------------------- |
| Multi-bounded context     | Auth API + Dashboard UI                  | Different domains, can ship incrementally |
| Explicit phases in ticket | "Phase 1: Backend, Phase 2: Frontend"    | Already defined by product                |
| Very large epic           | 20+ requirements, 3+ weeks work          | Manageable chunks                         |
| User request              | "I want to review after the API is done" | Stakeholder wants checkpoints             |

## When to AVOID Sub-Planning

| Scenario            | Why Skip                                      |
| ------------------- | --------------------------------------------- |
| Single feature      | No benefit to splitting                       |
| Tight coupling      | Changes interdependent, can't test separately |
| Small-medium ticket | Overhead outweighs benefit                    |
| Unclear boundaries  | Will cause confusion and rework               |

## Step 1: Update State and Propose Sub-Plans

Update state: `phase: "sub_planning"` (for resumability).

1. Read `{specDir}/task-spec.md` and identify potential independent work streams

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

## Step 2: Iterative Plan Clarification (Chat-Based)

**For EACH proposed sub-plan, challenge and clarify before writing.**

### Per-Plan Clarification Loop

Present each plan and ask targeted questions (in chat, not AskUserQuestion):

```
I'm proposing to break this into 3 phases:

## Phase 1: [Name]
**Goal:** [What this accomplishes]
**Files:** [Likely files touched]
**Dependencies:** [What it needs]

**Questions for this phase:**
1. [Ambiguity about this specific phase]
2. [Technical decision needed]
3. [Edge case to consider]

## Phase 2: ...
```

### What to Challenge Per Plan

| Category        | Questions                                                              |
| --------------- | ---------------------------------------------------------------------- |
| **Boundaries**  | "Phase 1 touches X, but Y depends on it. Should Y be in phase 1 or 2?" |
| **Files**       | "Both phases touch file Z. How should we handle the conflict?"         |
| **Testing**     | "How do we test phase 1 independently before phase 2 is done?"         |
| **Rollback**    | "If phase 2 fails, can we ship phase 1 alone?"                         |
| **Integration** | "How do phases integrate? What's the contract?"                        |

### Iterate Until Each Plan is Firm

For each plan, ensure:

- [ ] Clear, unambiguous goal
- [ ] File boundaries don't overlap (or overlap is explicit)
- [ ] Can be tested independently
- [ ] Implementation approach is decided
- [ ] Edge cases addressed

## Step 3: Handle User Decision

**If user approves sub-plans:**

1. Write each sub-plan using [templates/sub-plan-template.md](../templates/sub-plan-template.md):

   ```bash
   mkdir -p {specDir}/plans
   ```

   Each plan file should include (from clarifications):
   - Goal and scope (clear, single purpose)
   - Specific files to modify (with paths)
   - Technical approach (step-by-step)
   - Edge cases to handle
   - How to test independently
   - Integration points with other phases

2. Commit the spec files:

   ```bash
   git add spec/<task-id>/
   git commit -m "docs: add sub-plans for <task-id> v{specVersion}"
   ```

3. Update state:
   ```json
   {
     "phase": "run_spec",
     "subPlans": [
       { "id": "phase-1", "file": "{specDir}/plans/phase-1.md", "status": "pending" },
       { "id": "phase-2", "file": "{specDir}/plans/phase-2.md", "status": "pending" }
     ],
     "currentSubPlanIndex": 0
   }
   ```

**If user rejects (wants single plan):**

1. Leave `subPlans: null` and `currentSubPlanIndex: null` in state
2. Update state: `phase: "run_spec"`

**If user requests changes:**

1. Incorporate feedback and re-clarify affected plans
2. Repeat until approved or user chooses single plan

## Resumability

If resuming into this phase (`phase: "sub_planning"`): Re-propose the sub-plans and re-clarify.

## Next

Read `phases/run-spec.md` and follow it.
