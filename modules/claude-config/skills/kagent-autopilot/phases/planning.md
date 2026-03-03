# Phase: Planning — Orchestrator Inline

This phase runs inline with the orchestrator when `phase: "planning"`. It creates the high-level task specification (WHAT to build).

## Entry Condition

- `phase: "planning"` in state (set by repo-setup after config + ticket detection)

## Step 1: Gather Repository Context

Before writing the spec, read ALL relevant files to understand conventions:

1. **Read CLAUDE.md files** (in order of precedence):
   - `.claude/CLAUDE.md` (project-level, highest precedence)
   - `CLAUDE.md` (repo root)
   - `~/.claude/CLAUDE.md` (global user defaults)

2. **Read ALL skills** in the repository:

   ```bash
   find .claude/skills ~/.claude/skills -name "SKILL.md" 2>/dev/null
   ```

3. **Check for project conventions**:
   - `CONTRIBUTING.md` — commit conventions, PR guidelines
   - `.commitlint.*` — commit message rules
   - `package.json` scripts — test, lint, build commands
   - `Makefile` — build targets
   - CI/CD files (`.github/workflows/`, `.gitlab-ci.yml`, etc.)

## Step 2: Clarify the Task (Chat-Based)

**This is a focused spec-generation phase. Your ONLY job here is to nail down WHAT to build.**

### Philosophy

- **Challenge everything** — be the devil's advocate
- **Don't assume** — if something could be interpreted multiple ways, ask
- **Think ahead** — what will bite us during implementation?
- **Stay in chat** — use natural back-and-forth, NOT AskUserQuestion
- **Apply relevant skills** — ensure all relevant skills in skill folders are applied

### Clarification Loop

1. **First pass analysis** — Read the ticket and identify:
   - Ambiguous requirements (could mean A or B)
   - Missing acceptance criteria
   - Technical decisions that need user input
   - Edge cases not covered
   - Dependencies on other systems/tasks
   - Scope creep risks

2. **Challenge the user** (in chat, not AskUserQuestion):

   ```
   Looking at the ticket, I have some concerns before we proceed:

   1. [Ambiguity] The ticket says "X" — does this mean A or B?
   2. [Missing info] What about [edge case]?
   3. [Technical decision] For [feature], should we [option A] or [option B]?
   4. [Scope check] The ticket mentions X but also hints at Y. Should Y be in scope?
   ```

3. **Iterate until firm** — Keep asking until all ambiguities resolved, technical approach decided, scope clearly bounded, acceptance criteria complete.

4. **Confirm understanding** — Summarize back to user.

### What to Challenge

| Category           | Questions to Ask                         |
| ------------------ | ---------------------------------------- |
| **Ambiguity**      | "This could mean X or Y — which?"        |
| **Missing info**   | "What happens when Z?"                   |
| **Technical**      | "For auth, JWT or session? Why?"         |
| **Scope**          | "Is X in scope? The ticket hints at it." |
| **Dependencies**   | "Does this depend on task Y?"            |
| **Edge cases**     | "What if the user does X?"               |
| **Error handling** | "How should failures be handled?"        |
| **Performance**    | "Any latency/throughput requirements?"   |

## Step 3: Research with Explore Subagents

**Spawn Explore subagents** (parallel, via Task tool) to research the codebase:

- Existing patterns, testing conventions, architecture
- Files/modules likely involved
- Domain-specific patterns (if DDD skill exists)

```
Task(
  subagent_type: "Explore",
  description: "Research codebase patterns for {area}",
  prompt: "Search for {specific patterns} in the codebase..."
)
```

Collect results and incorporate findings into the spec.

## Step 4: Generate task-spec.md

Create `{specDir}/task-spec.md` using the task-spec template.

**Content rules:**

- Describes WHAT to build — acceptance criteria, edge cases, constraints, context
- NO exact code, NO implementation steps — suggestions only
- Include context from Explore research

**Check for Domain-Driven Design skill:**

```bash
ls ~/.claude/skills/domain-driven-design/SKILL.md 2>/dev/null || \
ls ./.claude/skills/domain-driven-design/SKILL.md 2>/dev/null
```

If DDD skill exists: read it and include bounded contexts, ubiquitous language, domain events.

## Step 5: Spec Approval

**MANDATORY:** Present spec and get user approval via `AskUserQuestion`.

### On approval:

1. Commit the spec files:
   ```bash
   git add spec/{ticketId}/
   git commit -m "docs: add task spec for {ticketId}"
   ```
2. Update state: `phase: "approved"`
3. Continue inline to sub-planning phase

### On rejection:

Iterate with user feedback, loop back to clarification.

## Resumability

If resuming into `phase: "planning"`:

- Check if `{specDir}/task-spec.md` exists
- If exists: present for approval (skip to Step 5)
- If not: start from Step 1
