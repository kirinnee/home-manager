# Phase: Sub-Planning — Implementation Plans (HOW) — Orchestrator Inline

**Always runs.** Every task gets at least 1 implementation plan. Runs inline with the orchestrator.

## Entry Condition

- `phase: "approved"` in state (after spec approval in planning phase)
- Also entered from `phases/feedback.md` (after feedback, `phase: "approved"`, `specVersion: N+1`)

## Content Separation

|                  | Task Spec (`task-spec.md`)                            | Plan (`plan-N.md`)                                 |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------- |
| Answers          | WHAT to build                                         | HOW to build it                                    |
| Contains         | Acceptance criteria, edge cases, constraints, context | Files to modify, approach, patterns, test strategy |
| Does NOT contain | Implementation details, exact code                    | Exact code — only suggestions/examples             |

## Step 1: Read Task Spec and Assess Complexity

1. Read `{specDir}/task-spec.md` for requirements
2. Decide plan count (1-4 based on complexity):
   - **1 plan**: Most tasks — single feature, focused scope
   - **2-3 plans**: Multi-bounded context, explicit phases in ticket, significant complexity
   - **4 plans**: Very large epics only

3. **Check for Domain-Driven Design skill:**
   ```bash
   ls ~/.claude/skills/domain-driven-design/SKILL.md 2>/dev/null || \
   ls ./.claude/skills/domain-driven-design/SKILL.md 2>/dev/null
   ```
   If DDD skill exists: use bounded context definitions to group plans.

## Step 2: Research with Explore Subagents

**Spawn Explore subagents** (parallel, via Task tool) for deep research per plan area:

```
Task(
  subagent_type: "Explore",
  description: "Research {plan area} implementation",
  prompt: "Search the codebase for: {specific patterns, files, conventions relevant to this plan area}"
)
```

Research targets per plan:

- Files that will need modification
- Existing patterns and conventions in those areas
- Testing patterns for similar code
- Integration points with other components

## Step 3: Write Plan Files

Create plan files in `{specDir}/plans/`:

```bash
mkdir -p {specDir}/plans
```

Each plan file (`plan-1.md`, `plan-2.md`, etc.) should include:

- Goal and scope (clear, single purpose)
- Specific files to modify (with paths)
- Suggested approach (direction, NOT exact code)
- Edge cases to handle
- How to test independently
- Integration points with other plans
- **Implementation Checklist** (copy from task-spec)

Use the sub-plan template as a guide.

**Content rules:**

- Describe HOW to build, not exact code
- Provide direction and suggestions, not implementations
- Include examples only as illustrations, not copy-paste solutions

## Step 4: Discover Claude Binaries

```bash
direnv exec . bash -c "compgen -c | grep '^claude' | sort -u"
```

This provides the list of available implementer and reviewer binaries for the config prompt.

## Step 5: Present Plans + Config for Approval

Present to the user:

1. **All plan files** — show content of each plan
2. **Dev-loop config** with discovered binaries:
   - Implementer binary (current default from state)
   - Reviewer binaries (current defaults from state)
   - Timeouts, maxPushCycles
   - "Here's the default config. Want to change anything?"

If user wants config changes: use `AskUserQuestion` with available binaries:

- Multi-select for reviewers
- Single-select for implementer

## Step 6: On Approval

1. Commit plan files:

   ```bash
   git add spec/{ticketId}/
   git commit -m "docs: add implementation plans for {ticketId} v{specVersion}"
   ```

2. Update state with any config overrides:

   ```json
   {
     "phase": "run_spec",
     "subPlans": [
       { "id": "plan-1", "file": "{specDir}/plans/plan-1.md", "status": "pending" },
       ...
     ],
     "currentSubPlanIndex": 0
   }
   ```

   Also update `implementer`, `reviewers`, timeouts if user changed them.

3. **Request context clear:**

   ```
   Plans approved! Please clear context and re-invoke:
   /kagent-autopilot

   State file has everything needed to resume from the execution phase.
   ```

## On Rejection

Iterate with user feedback. Loop back to Step 3 (research) or Step 5 (re-present) depending on the nature of feedback.

## Iterative Clarification (Chat-Based)

For EACH proposed plan, challenge and clarify before writing:

| Category        | Questions                                                            |
| --------------- | -------------------------------------------------------------------- |
| **Boundaries**  | "Plan 1 touches X, but Y depends on it. Should Y be in plan 1 or 2?" |
| **Files**       | "Both plans touch file Z. How should we handle the conflict?"        |
| **Testing**     | "How do we test plan 1 independently before plan 2 is done?"         |
| **Integration** | "How do plans integrate? What's the contract?"                       |

## Resumability

If resuming into `phase: "sub_planning"`:

- Check if plan files exist in `{specDir}/plans/`
- If plans exist: present for approval (skip to Step 5)
- If no plans: start from Step 1
