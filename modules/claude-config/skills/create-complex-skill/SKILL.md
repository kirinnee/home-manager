---
name: create-complex-skill
description: Create multi-phase, state-machine-driven Claude Code skills with orchestrator, sub-agents, and team agents. Use when building complex workflow skills, multi-phase automation, or stateful agent orchestration.
---

# Create Complex Skill

Guides the creation of complex, multi-phase Claude Code skills that use state machines, agent delegation, and context-rot-aware orchestration. These skills follow the patterns proven in `kagent-autopilot`.

## When to Use

- Building a skill with multiple distinct phases
- Workflow requires state persistence and resumability
- Tasks are too large for a single agent context window
- Need to orchestrate multiple sub-agents or team agents

## Core Principles

1. **Phases are independent** — each phase has its own state file, can be entered/cleared independently
2. **Steps are idempotent** — sub-agents and team agents don't know they're in a state machine; they execute, report, and exit
3. **Orchestrator stays lean** — NEVER read step files directly; spawn a teammate and tell it which step file to read. This saves context on the main orchestrator
4. **State agents own state writes** — the orchestrator never reads/writes state JSON directly (bootstrap exceptions documented per step)

## Process

### Step 1: Map the Workflow

Work with the user to decompose the workflow into phases and steps.

**Questions to ask (in chat, not AskUserQuestion):**

1. What are the major stages? (These become **phases**)
2. Within each stage, what are the discrete actions? (These become **steps**)
3. Which steps need user interaction? (These must be **inline**)
4. Which steps are expensive but mechanical? (Good candidates for **team agents**)
5. What state needs to persist across re-invocations? (Shapes the **state model**)
6. Where might failures occur? What's the recovery path?

**Output:** A phase diagram like:

```
Phase 1: {name}
  [step_a] → [step_b] → [step_c] → APPROVAL
    team(H)    inline     team(S)

Phase 2: {name}
  [step_d] → [step_e] → [step_f]
    team(S)    team(O)    team(H)
```

Where `H` = haiku, `S` = sonnet, `O` = opus. Annotate inline steps.

### Step 2: Design the State Model

Two-level state: **task-level** (shared across phases) + **per-phase** (independent).

```
.{state-dir}/
├── task-state.json          # Shared: current phase, config, identifiers
├── {phase1}-state.json      # Phase 1 steps
├── {phase2}-state.json      # Phase 2 steps
├── {phase3}-state.json      # Phase 3 steps
└── transitions.log          # Append-only observability log
```

For each state file, define:

- Fields and their types
- Valid values for the `step` field
- Which fields are mutable vs immutable

See [patterns.md](patterns.md) for state design guidelines.

### Step 3: Choose Agent Types for Each Step

Use the decision framework in [patterns.md](patterns.md) — Agent Type Decision Framework.

For each step, determine:

- **Type**: inline, sub-agent, or team agent
- **Model**: haiku (mechanical), sonnet (moderate reasoning), opus (complex reasoning)
- **What it reads**: which files/state
- **What it reports**: structured output format
- **What it does NOT do**: boundaries (no state writes, no commits, etc.)

### Step 4: Create Directory Structure

```bash
mkdir -p .claude/skills/{skill-name}/{phase1}/steps
mkdir -p .claude/skills/{skill-name}/{phase2}/steps
mkdir -p .claude/skills/{skill-name}/common
mkdir -p .claude/skills/{skill-name}/templates
```

Standard layout:

```
{skill-name}/
├── SKILL.md                        # Top-level: entry points, agent taxonomy, phase overview, rules
├── {phase1}/
│   ├── PHASE.md                    # Phase state machine, step dispatch table, dispatch logic
│   ├── state-agent.md              # State agent: assess + update modes
│   └── steps/
│       ├── {step-a}.md             # One file per step
│       └── {step-b}.md
├── {phase2}/
│   ├── PHASE.md
│   ├── state-agent.md
│   └── steps/
│       └── ...
├── common/                         # Agents shared across phases
│   └── {shared-step}.md
└── templates/                      # Output templates
    └── {template}.md
```

### Step 5: Write Files Using Templates

Use templates from this skill's `templates/` directory:

1. **SKILL.md** — [templates/SKILL-TEMPLATE.md](templates/SKILL-TEMPLATE.md)
2. **PHASE.md** per phase — [templates/PHASE-TEMPLATE.md](templates/PHASE-TEMPLATE.md)
3. **state-agent.md** per phase — [templates/state-agent-TEMPLATE.md](templates/state-agent-TEMPLATE.md)
4. **Step files** — choose per step type:
   - Team agent: [templates/step-team-TEMPLATE.md](templates/step-team-TEMPLATE.md)
   - Inline: [templates/step-inline-TEMPLATE.md](templates/step-inline-TEMPLATE.md)
   - Sub-agent: [templates/step-sub-TEMPLATE.md](templates/step-sub-TEMPLATE.md)

### Step 6: Verify

1. Every step file has a clear report format
2. Every step file has an "Important" section with boundaries (what it does NOT do)
3. State agent validation rules cover all step values
4. PHASE.md dispatch table covers all step values including edge cases
5. SKILL.md agent taxonomy matches actual files
6. Inline steps are only those needing user interaction
7. Bootstrap exceptions (if any) are documented in both the step file and PHASE.md

## Architecture Patterns

See [patterns.md](patterns.md) for detailed architecture patterns including:

- Phase decomposition
- Two-level state
- Agent taxonomy and decision framework
- Context rot prevention
- Idempotent step design
- Transition logging / observability
- Resumability
- Context clearing

## Related Skills

- [create-skill](../create-skill/SKILL.md) — for simple, single-file skills
