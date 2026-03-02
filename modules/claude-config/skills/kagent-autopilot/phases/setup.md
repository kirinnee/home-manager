# Phase: Setup (Interactive)

This phase runs when no `.kagent/task-state.json` exists.

## Step 0: Detect Mode

Check the argument passed to `/kagent-autopilot`:

1. If argument is `manual` → **Manual mode** — skip to [Manual Mode Setup](#manual-mode-setup)
2. Otherwise (no argument, ticket ID, or any other value) → **Autopilot mode** — continue below

---

## Autopilot Mode Setup

### Step 1: Auto-Detect Ticket ID

Check in order:

1. Argument passed to `/kagent-autopilot PE-1234`
2. Branch: `git branch --show-current` — match `PE-\d{4}` (Jira) or `CU-?[a-zA-Z0-9]+` (ClickUp)
3. Worktree: `wt current 2>/dev/null || true`

If not detected, use `AskUserQuestion` to ask for the ticket ID.

### Step 2: Fetch Ticket Details

**Jira (PE-XXXX):**

```bash
acli jira workitem view PE-1234 --fields '*all' --json
```

Extract: `fields.summary` (title), `fields.description`, `fields.comment.comments[].body`, acceptance criteria from description or custom fields.

**ClickUp (CU-XXXXX):**

**IMPORTANT:** When searching ClickUp, strip the `CU-` prefix and search by the raw ID only. The ClickUp MCP does not recognize the `CU-` prefix format.

```bash
# If ticket ID is "CU-abc123", search for just "abc123"
```

Use ClickUp MCP `clickup_search` tool with keywords set to the ID **without** the `CU-` prefix. Then use `clickup_get_task` to get full details.

Extract: `name` (title), `description`, `status.status`, comments via `clickup_get_task_comments`.

If auth fails: Jira → `acli jira auth`. ClickUp → check MCP server configuration.

**Note:** The `CU-` prefix is only used internally for identification. Always store `ticketId` with the `CU-` prefix (e.g., `"CU-abc123"`) in state and use it when creating spec directories.

### Step 3: Gather Configuration

Discover available binaries: `compgen -c | grep '^claude' | sort -u`

Use `AskUserQuestion` for:

- **Implementer binary** — which claude binary implements code
- **Reviewer binaries** (multi-select) — which binaries review code
- **Conflict checker binary** — which binary analyzes spec conflicts when iterations stall
- **Loop parameters:**
  - Max push cycles (default 5) — outer loop limit
  - Max iterations (default 10) — inner loop limit per dev-loop run
  - Conflict check threshold (default 3) — consecutive failures before conflict check
  - Implementer timeout (default 30 min)
  - Reviewer timeout (default 15 min)
- **Obsidian symlink** (default yes) — symlink `.kagent` to `~/Documents/Main/kagent/...`

### Step 4: Gather Repository Context

Before generating the spec, read ALL relevant files to understand conventions:

1. **Read CLAUDE.md files** (in order of precedence):
   - `.claude/CLAUDE.md` (project-level, highest precedence)
   - `CLAUDE.md` (repo root)
   - `~/.claude/CLAUDE.md` (global user defaults)

2. **Read ALL skills** in the repository:

   ```bash
   # Find all skill files
   find .claude/skills ~/.claude/skills -name "SKILL.md" 2>/dev/null
   ```

   Read each one to understand:
   - Naming conventions
   - Testing patterns
   - Documentation standards
   - Architecture patterns
   - Any domain-specific rules

3. **Check for project conventions**:
   - `CONTRIBUTING.md` — commit conventions, PR guidelines
   - `.commitlint.*` — commit message rules
   - `package.json` scripts — test, lint, build commands
   - `Makefile` — build targets
   - CI/CD files (`.github/workflows/`, `.gitlab-ci.yml`, etc.)

**Output:** Summarize key conventions found and confirm with user which apply to this task.

### Step 5: Iterative Spec Clarification (Chat-Based)

**This is a focused spec-generation phase. Your ONLY job here is to nail down the spec.**

#### Philosophy

- **Challenge everything** — be the devil's advocate
- **Don't assume** — if something could be interpreted multiple ways, ask
- **Think ahead** — what will bite us during implementation?
- **Stay in chat** — use natural back-and-forth, NOT AskUserQuestion
- **Apply relevant skills** — ensure all relevant skills in skill folders are applied

#### Clarification Loop

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
      - If A: [implication]
      - If B: [implication]

   2. [Missing info] What about [edge case]? The ticket doesn't mention it.

   3. [Technical decision] For [feature], should we [option A] or [option B]?
      - Option A: [pros/cons]
      - Option B: [pros/cons]

   4. [Scope check] The ticket mentions X but also hints at Y. Should Y be in scope?
   ```

3. **Iterate until firm** — Keep asking until:
   - All ambiguities resolved
   - Technical approach decided
   - Scope clearly bounded
   - Acceptance criteria complete

4. **Confirm understanding** — Summarize back to user:

   ```
   Let me confirm my understanding:
   - We'll build [X] which does [Y]
   - Scope includes: [list]
   - Out of scope: [list]
   - Technical approach: [decision]
   - Acceptance: [criteria]

   Does that capture it correctly?
   ```

#### What to Challenge

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

#### Anti-Patterns to Avoid

- ❌ "Should I proceed?" (too vague)
- ❌ Asking multiple unrelated questions at once
- ❌ Accepting vague answers without follow-up
- ❌ Using AskUserQuestion for iterative clarification

#### Implementation Checklist (Add to Spec)

**CRITICAL:** Before finalizing the spec, ensure it includes an Implementation Checklist section with these items. Check for precedence in the codebase (some may not apply):

| Priority | Category          | Items to Include in Spec                                     | Check For                                |
| -------- | ----------------- | ------------------------------------------------------------ | ---------------------------------------- |
| 1        | **Documentation** | Inline docs, README updates, API documentation               | Existing doc patterns, `docs/` folder    |
| 2        | **Tests**         | Unit tests, functional tests, integration tests              | Test folder structure, testing framework |
| 3        | **Metrics**       | OTEL metrics OR Prometheus metrics                           | Existing telemetry setup                 |
| 4        | **Logging**       | Structured logging at correct levels (debug/info/warn/error) | Logging library in use                   |
| 5        | **Alerts**        | Grafana alert rules (CRs) + runbook markdown                 | `alerts/`, `monitoring/` folders         |
| 6        | **Dashboards**    | Grafana dashboard CRs with JSON                              | `dashboards/`, `grafana/` folders        |
| 7        | **System Tests**  | Bruno integration tests                                      | `bruno/`, `.bruno/` folders              |

**How to apply:**

1. Check the codebase for existing patterns in each category
2. If patterns exist, the spec MUST include corresponding items
3. If no patterns exist, mark as "N/A - no existing pattern" in the spec
4. Respect precedence — if tests go in `__tests__/` not `tests/`, follow that convention

**Add this section to the spec:**

```markdown
## Implementation Checklist

> Ensure all applicable items are implemented. Mark N/A if not applicable to this task.

### Required

- [ ] Code changes per technical spec above
- [ ] Documentation updated (if applicable)

### Testing (check all that apply)

- [ ] Unit tests
- [ ] Functional tests
- [ ] Integration tests
- [ ] Bruno system tests (if API changes)

### Observability (check all that apply)

- [ ] Metrics: [OTEL | Prometheus] — describe what's measured
- [ ] Logging: correct levels used (debug/info/warn/error)
- [ ] Alerts: Grafana CR + runbook markdown
- [ ] Dashboards: Grafana CR with JSON

### Notes

- Test location: [follow existing pattern, e.g., `__tests__/`, `tests/`, `src/*.test.ts`]
- Metrics pattern: [OTEL | Prometheus | N/A]
- Logging library: [existing library name | N/A]
```

### Step 6: Generate task-spec.md

Create `spec/<task-id>/v1/task-spec.md` using [templates/task-spec-template.md](../templates/task-spec-template.md) populated with ticket data and clarifications.

**IMPORTANT:** The `<task-id>` must include the prefix:

- Jira: `PE-1234` (or whatever project prefix)
- ClickUp: `CU-abc123` (always include `CU-` prefix for ClickUp)

```bash
mkdir -p spec/<task-id>/v1  # e.g., spec/PE-1234/v1 or spec/CU-abc123/v1
```

**Check for Domain-Driven Design skill before generating:**

```bash
ls ~/.claude/skills/domain-driven-design/SKILL.md 2>/dev/null || \
ls ./.claude/skills/domain-driven-design/SKILL.md 2>/dev/null
```

- **If DDD skill exists:** Read it and include in the spec:
  - Bounded context(s) this task belongs to
  - Relevant Ubiquitous Language terms from that context
  - Any domain events if applicable
- **If no DDD skill:** Omit the DDD section from the spec

**MANDATORY:** Present spec and get user approval via `AskUserQuestion` before proceeding.

### Step 6: Initialize State

On approval:

1. Ensure only `.kagent` is in `.gitignore` (NOT `spec/` — specs are committed):
   ```bash
   grep -qx '.kagent' .gitignore || echo '.kagent' >> .gitignore
   ```
2. If Obsidian symlink opted in:
   ```bash
   PROJECT_DIR=$(pwd)
   REL_PATH="${PROJECT_DIR#$HOME/Workspace/}"
   OBSIDIAN_TARGET="$HOME/Documents/Main/kagent/$REL_PATH"
   mkdir -p "$OBSIDIAN_TARGET"
   [ -d ".kagent" ] && [ ! -L ".kagent" ] && cp -a .kagent/. "$OBSIDIAN_TARGET/" && rm -rf .kagent
   [ ! -L ".kagent" ] && ln -s "$OBSIDIAN_TARGET" .kagent
   ```
3. Verify on feature branch (not main/master) — fail if not
4. Commit the spec files:
   ```bash
   git add spec/<task-id>/
   git commit -m "docs: add task spec for <task-id>"
   ```
5. Write `.kagent/task-state.json`:

```json
{
  "version": 1,
  "phase": "approved",
  "mode": "autopilot",
  "ticketId": "PE-1234",
  "ticketSystem": "jira",
  "ticketTitle": "Add user auth",
  "ticketBody": "Full ticket description...",
  "branch": "PE-1234-add-auth",
  "prNumber": null,
  "specVersion": 1,
  "pushCycle": 0,
  "maxPushCycles": 5,
  "lastRunId": null,
  "lastRunExitCode": null,
  "lastRunStatus": null,
  "lastError": null,
  "conflictContext": null,
  "devLoopInitialized": false,
  "obsidianLinked": true,
  "implementer": "claude",
  "reviewers": ["claude-reviewer-zai"],
  "maxIterations": 10,
  "implementerTimeout": 30,
  "reviewerTimeout": 15,
  "conflictCheckThreshold": 3,
  "conflictChecker": "claude",
  "specDir": "spec/PE-1234/v1",
  "subPlans": null,
  "currentSubPlanIndex": null,
  "tmuxSession": null
}
```

**Note:** For ClickUp tickets, `ticketId` should include the `CU-` prefix (e.g., `"CU-abc123"`), and `specDir` should be `"spec/CU-abc123/v1"`.

**Next:** Read `phases/sub-planning.md` and follow it.

---

## Manual Mode Setup

For when you already implemented the code and want autopilot to handle push → CI/review → fix.

### Step 1: Gather Minimal Info

Use `AskUserQuestion` for:

- **Max push cycles** (default 5)
- **Obsidian symlink** (default yes)

Optionally detect ticket ID from branch (same patterns as autopilot). If found, store it. If not, that's fine — ticketId can be null.

### Step 2: Initialize State

1. Ensure only `.kagent` is in `.gitignore` (NOT `spec/`)
2. Set up Obsidian symlink if opted in (same as autopilot Step 6)
3. Verify on feature branch (not main/master) — fail if not
4. Write `.kagent/task-state.json`:

```json
{
  "version": 1,
  "phase": "prereview",
  "mode": "manual",
  "ticketId": null,
  "ticketSystem": null,
  "ticketTitle": null,
  "ticketBody": null,
  "branch": "feature/my-thing",
  "prNumber": null,
  "specVersion": null,
  "pushCycle": 0,
  "maxPushCycles": 5,
  "lastRunId": null,
  "lastRunExitCode": null,
  "lastRunStatus": null,
  "lastError": null,
  "conflictContext": null,
  "devLoopInitialized": false,
  "obsidianLinked": false,
  "implementer": null,
  "reviewers": [],
  "maxIterations": null,
  "implementerTimeout": null,
  "reviewerTimeout": null,
  "conflictCheckThreshold": null,
  "conflictChecker": null,
  "specDir": null,
  "subPlans": null,
  "currentSubPlanIndex": null,
  "tmuxSession": null
}
```

**Next:** Read `phases/prereview.md` and follow it.
