---
name: { skill-name }
description: '{What it does}. Use when {trigger conditions}.'
argument-hint: '{argument format}'
---

# {Skill Title}

## User Entry Points

```
/{skill-name}                    → {default behavior}
/{skill-name} {arg}              → {with argument}
/{skill-name} --phase {phase}    → {skip to phase}
```

## Agent Taxonomy

| Type           | Spawning                        | State transition            | Purpose                               |
| -------------- | ------------------------------- | --------------------------- | ------------------------------------- |
| **Sub-agent**  | `Task` (no team), direct result | No                          | Mechanical: state management, cleanup |
| **Team agent** | `Task` (with team), messaging   | Yes — corresponds to a step | Complex work for a specific step      |

## Orchestrator Model

```
ORCHESTRATOR (you = team lead)
├── SUB-AGENTS (stateless, direct result):
│   ├── {phase1}-state-agent (haiku) — {phase1} phase state reads/writes
│   ├── {phase2}-state-agent (haiku) — {phase2} phase state reads/writes
│   └── {shared-sub-agent} (haiku) — {description}
│
├── TEAM AGENTS (spawned via Task tool):
│   ├── {agent-name} ({model}) — {description}
│   └── {agent-name} ({model}) — {description}
│
└── State: Per-phase state-agents handle state writes. Bootstrap exceptions noted per step.
```

**Key principle:** The orchestrator NEVER reads step files directly. Always spawn a team agent and tell it which step file to read and execute. This saves context on the main orchestrator.

## Glossary

| Term       | Scope   | Description   |
| ---------- | ------- | ------------- |
| **{Term}** | {scope} | {description} |

## Two-Level State

```
.{state-dir}/
├── task-state.json          # Overall: which phase, identifiers, config
├── {phase1}-state.json      # Phase 1 steps
├── {phase2}-state.json      # Phase 2 steps
└── transitions.log          # Append-only step transition log
```

## Top-Level State Machine

```
task-state.json.currentPhase:
  {phase1} → {phase2} → {phase3} → completed
```

### Phase 1: {Phase Name}

```
[step_a] → [step_b] → [step_c]
  team(H)    inline     team(S)
```

### Phase 2: {Phase Name}

```
[step_d] → [step_e] → [step_f]
  team(S)    team(O)    team(H)
```

## Phase Dispatch

**On invocation, read `.{state-dir}/task-state.json` and dispatch to the current phase:**

| `currentPhase` | Action                                                       |
| -------------- | ------------------------------------------------------------ |
| No state file  | Start Phase 1                                                |
| `{phase1}`     | Read `{phase1}-state.json`, dispatch per `{phase1}/PHASE.md` |
| `{phase2}`     | Read `{phase2}-state.json`, dispatch per `{phase2}/PHASE.md` |
| `completed`    | Report completion                                            |
| `failed`       | Report error, offer retry                                    |

**Transition logging:** When advancing `task-state.currentPhase`, append:

```bash
echo "$(date -Iseconds) phase-transition from={old_phase} to={new_phase}" >> .{state-dir}/transitions.log
```

Each phase has its own PHASE.md with step dispatch logic, state file schema, and step descriptions.

## Key State Fields (`.{state-dir}/task-state.json`)

| Field          | Type   | Description   |
| -------------- | ------ | ------------- |
| `currentPhase` | string | Active phase  |
| {field}        | {type} | {description} |

## Rules

### Autonomy

1. {Rule about when to ask user vs proceed autonomously}

### Safety

2. {Rule about destructive operations}

### Conventions

3. {Rule about project conventions}

## Prerequisites

- {Required tool 1}
- {Required tool 2}
