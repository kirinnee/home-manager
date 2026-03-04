# Architecture Patterns for Complex Skills

## Phase Decomposition

Break the workflow into phases that represent major, independent stages. Each phase:

- Has its own state file
- Can be entered independently (via `--phase {name}` or re-invocation)
- Clears its state on completion
- Transitions to the next phase by updating `task-state.currentPhase`

**When to split into a new phase:**

- The work requires a context clear (too much accumulated context)
- The stage has fundamentally different concerns (planning vs executing vs reviewing)
- The stage could be skipped or entered independently

**When NOT to split:**

- The steps are tightly coupled and share intermediate results
- A context clear would lose essential information

## Two-Level State

### Task-level state (`task-state.json`)

Shared across all phases. Contains:

- `currentPhase` — which phase is active
- Identifiers (ticket ID, PR number, branch, etc.)
- Configuration (immutable per session)
- Cross-phase data (plan references, version numbers)

### Per-phase state (`{phase}-state.json`)

Independent per phase. Contains:

- `step` — current step within the phase
- Step-specific data (last run ID, exit codes, etc.)
- Phase-local flags

### Invariant

At any point, exactly one per-phase state file is "active." The active file is determined by `task-state.currentPhase`. Stale phase files from previous phases may exist but are ignored.

### State directory

```
.{state-dir}/
├── task-state.json
├── {phase1}-state.json
├── {phase2}-state.json
├── {phase3}-state.json
└── transitions.log
```

The state directory should be gitignored.

## Agent Taxonomy

### Three agent types

| Type           | How spawned                          | Can chat with user? | State writes?   | Purpose                               |
| -------------- | ------------------------------------ | ------------------- | --------------- | ------------------------------------- |
| **Inline**     | Orchestrator reads file and executes | Yes                 | Via state agent | User interaction, complex dispatch    |
| **Sub-agent**  | `Task` (no team), direct result      | No                  | No              | Mechanical: state management, cleanup |
| **Team agent** | `Task` (with team), messaging        | No                  | No              | Complex work for a specific step      |

### Key constraint

**Only inline steps can interact with the user.** Sub-agents and team agents communicate only via their report format back to the orchestrator. If a step needs user input (approval, clarification, feedback), it MUST be inline.

## Agent Type Decision Framework

For each step, ask:

```
Does this step need to chat with the user?
  YES → INLINE (orchestrator executes it)
  NO →
    Is this a simple, mechanical task (state read/write, file cleanup, copy)?
      YES → SUB-AGENT (haiku, no team, direct result)
      NO →
        Does this require reading/writing many files or complex reasoning?
          YES → TEAM AGENT
            How much reasoning?
              Mechanical (copy, commit, init) → haiku
              Moderate (fetch data, create PR, push) → sonnet
              Complex (review code, rewrite specs, analyze) → opus
```

## Context Rot Prevention

The orchestrator's context window accumulates everything it reads or receives. Over a long session (many steps, many phases), this degrades response quality.

### Strategy: Delegate reads/writes to sub-agents

**Problem:** Orchestrator reads `task-state.json` (30+ fields), applies one update, writes it back. The full JSON is now in context forever.

**Solution:** Spawn a state agent sub-agent. Orchestrator sends: "Update impl state: `{step: 'running'}`". Sub-agent reads the file, applies the update, reports back "RESULT: updated, NEW_STEP: running". The orchestrator's context only contains the small prompt and small report — never the raw JSON.

### When this matters

- State files with many fields (10+)
- Steps that read large files (logs, reviews, specs)
- Long-running sessions (20+ step transitions)

### When this is overkill

- State files with few fields (<5)
- Short-lived sessions (3-4 steps)
- Steps where the orchestrator needs the data for an immediate decision

## State Agents

Each phase gets a state agent (sub-agent, haiku) with two modes:

### Assess mode

Reads the phase state file + inspects repo state. Reports facts:

- Current step
- Relevant context (files exist? changes committed? etc.)

The state agent does NOT make dispatch decisions — it reports facts. The PHASE.md dispatch table is the single source of truth for "what step comes next."

### Update mode

Applies field updates to the phase state file. Also appends to the transition log when `step` changes:

```bash
echo "$(date -Iseconds) phase={phase} from={old_step} to={new_step}" >> .{state-dir}/transitions.log
```

### Bootstrap exceptions

Some steps need to create or write shared state (`task-state.json`) during initial setup. Document these explicitly in both the step file and PHASE.md.

## Idempotent Step Design

Every step (sub-agent or team agent) should be safe to re-run:

1. **Check before acting** — if the work is already done, report success without re-doing it
2. **No side knowledge** — the step file contains everything the agent needs; it doesn't know about the state machine
3. **Report, don't transition** — agents report results; the orchestrator decides the next step
4. **Clear boundaries** — every step file has an "Important" section listing what it does NOT do

### Step file anatomy

```markdown
# {Step Name} — {Agent Type} ({Model})

## Agent Context

- Working directory: {WORKDIR}
- {relevant inputs from orchestrator prompt}

## Agent Report Format

{structured output format}

**Do NOT update state files.** Report back to orchestrator only.

## Task

{what this step does}

## Steps

{numbered procedure}

## Resumability

{what to check if re-entering this step}

## Important

- Do NOT {boundary 1}
- Do NOT {boundary 2}
- Only {what this step actually does}
```

## Transition Logging

Append-only log for observability. Never read by the orchestrator (zero context rot). Written by state agents during update mode.

```
2026-03-03T14:30:00+08:00 phase=plan from=setup to=repo_setup
2026-03-03T14:30:15+08:00 phase=plan from=repo_setup to=write_spec
2026-03-03T14:32:00+08:00 phase=plan from=write_spec to=write_plans
2026-03-03T14:35:00+08:00 phase=plan from=write_plans to=approved
2026-03-03T14:35:01+08:00 phase-transition from=plan to=implementation
```

Phase-level transitions are logged by the orchestrator when updating `task-state.currentPhase`:

```bash
echo "$(date -Iseconds) phase-transition from={old} to={new}" >> .{state-dir}/transitions.log
```

After a run, inspect with `cat .{state-dir}/transitions.log` to see the full timeline.

## Resumability

Every step must handle re-entry gracefully:

1. **Phase dispatch:** Read `task-state.currentPhase`, dispatch to the right PHASE.md
2. **Step dispatch:** Read per-phase state, dispatch to the current step
3. **Step re-entry:** Each step checks "am I already done?" before executing

This means a crashed session can resume from the exact step it was on, without re-doing previous work.

### Context clearing

Between phases (or when context is too large), request the user to clear context and re-invoke. The state files bridge the gap — all necessary information is persisted.

## SKILL.md Structure for Complex Skills

The top-level SKILL.md should contain:

1. **Entry points** — how users invoke the skill (with arguments)
2. **Agent taxonomy** — table of agent types and their purpose
3. **Orchestrator model** — tree diagram of all agents
4. **Glossary** — domain terms used across the skill
5. **State file overview** — directory listing with descriptions
6. **Top-level state machine** — phase transitions
7. **Phase summaries** — brief state machine per phase (details in PHASE.md)
8. **Phase dispatch table** — what to do for each `currentPhase` value
9. **Key state fields** — schema for `task-state.json`
10. **Rules** — grouped by category (autonomy, safety, conventions, etc.)
11. **Prerequisites** — required tools, CLIs, access

Keep phase details in PHASE.md files. SKILL.md provides the overview; PHASE.md provides the dispatch logic.
