---
name: research
description: 'Deep research on any topic with academic-grade rigor, source reputation scoring, and independent verification. Use when running /research.'
argument-hint: '"TOPIC" [--phase PHASE]'
---

# Deep Research

Academic-grade research on any topic. 4-phase state machine: plan the goals, explore creatively, verify independently, compose a report.

## User Entry Points

```
/research "topic"                → Start new research
/research                        → Resume in-progress research
/research --phase verify         → Skip to verification phase
```

## Agent Taxonomy

| Type           | Spawning                        | State transition            | Purpose                              |
| -------------- | ------------------------------- | --------------------------- | ------------------------------------ |
| **Sub-agent**  | `Task` (no team), direct result | No                          | State management, file discovery     |
| **Team agent** | `Task` (with team), messaging   | Yes — corresponds to a step | Research, review, verify, synthesize |

## Orchestrator Model

```
ORCHESTRATOR (you = team lead)
├── SUB-AGENTS (stateless, direct result):
│   ├── plan-state-agent (haiku) — plan phase state reads/writes
│   ├── research-state-agent (haiku) — research phase state reads/writes
│   └── compose-state-agent (haiku) — compose phase state reads/writes
│
├── TEAM AGENTS (spawned via Task tool):
│   ├── scope-agent (sonnet) — domain detection, spec writing, user approval
│   ├── explore-agent (opus) — creative open-ended research
│   ├── cross-ref-agent (sonnet) — cross-reference findings, gap analysis
│   ├── verify-agent (sonnet) — independent claim verification (1 per thread)
│   ├── triage-agent (sonnet) — summarize verification results
│   └── synthesize-agent (opus) — compose final report
│
└── State: Per-phase state-agents handle state writes. Bootstrap exceptions noted per step.
```

**Key principle:** The orchestrator NEVER reads step files directly. Always spawn a team agent and tell it which step file to read and execute. This saves context on the main orchestrator.

## Glossary

| Term          | Scope    | Description                                                                         |
| ------------- | -------- | ----------------------------------------------------------------------------------- |
| **Thread**    | Research | An organic unit of investigation discovery — a comparison, deep dive, or connection |
| **Cycle**     | Research | One round of explore + review + checkpoint                                          |
| **DoD**       | Spec     | Definition of Done — quality bar for the research                                   |
| **Rep score** | Evidence | Source reputation score (1-5) per domain calibration                                |

## Two-Level State

```
.research/                   # Hidden — machine state only
├── task-state.json          # Overall: which phase, topic, domain, researchId
├── plan-state.json          # Plan phase steps
├── research-state.json      # Research phase steps + cycle tracking
├── verify-state.json        # Verify phase steps + file processing state
├── compose-state.json       # Compose phase steps
└── transitions.log          # Append-only step transition log

research/                    # Visible — plans, findings, reports
├── spec.md                  # Research specification (persistent)
├── findings/                # Investigation threads
│   ├── thread-01-{slug}.md
│   └── ...
├── review-cycle-1.md        # Cross-reference reviews (per cycle)
├── verification/            # Independent verification results
│   ├── thread-01-{slug}.md
│   └── ...
└── report.md                # Final report (output)
```

## Top-Level State Machine

```
task-state.json.currentPhase:
  plan → research → verify → compose → completed
```

### Phase 1: Plan

```
[scope] → [write_spec] → [approve]
 team(S)    team(S)        inline
```

### Phase 2: Research (repeatable cycles)

```
[explore] → [review] → [checkpoint]
 team(O)     team(S)     inline
         ↑_______________|  (cycle if user says "go deeper")
```

### Phase 3: Verify (file-processor pattern)

```
[init_verify] → [verify_loop] → [triage]
   inline         file-proc(S)    team(S)
```

### Phase 4: Compose

```
[synthesize] → [present]
   team(O)      inline
```

## Phase Dispatch

**On invocation, read `.research/task-state.json` and dispatch to the current phase:**

| `currentPhase` | Action                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| No state file  | Parse topic from argument, create directories, init `task-state.json` with `currentPhase: "plan"`, dispatch to plan |
| `plan`         | Read `plan-state.json`, dispatch per `plan/PHASE.md`                                                                |
| `research`     | Read `research-state.json`, dispatch per `research/PHASE.md`                                                        |
| `verify`       | Read `verify-state.json`, dispatch per `verify/PHASE.md`                                                            |
| `compose`      | Read `compose-state.json`, dispatch per `compose/PHASE.md`                                                          |
| `completed`    | Report: "Research complete. Report at `research/report.md`"                                                         |

**Bootstrap (no state file):**

1. `mkdir -p .research && mkdir -p research/findings research/verification`
2. Write `task-state.json`:
   ```json
   {
     "currentPhase": "plan",
     "topic": "{from argument}",
     "domain": null,
     "researchId": "{timestamp-based ID}"
   }
   ```
3. Write `plan-state.json`: `{"step": "scope"}`
4. Dispatch to plan phase

**Transition logging:** When advancing `task-state.currentPhase`, append:

```bash
echo "$(date -Iseconds) phase-transition from={old_phase} to={new_phase}" >> .research/transitions.log
```

## Key State Fields (`task-state.json`)

| Field          | Type         | Description                                              |
| -------------- | ------------ | -------------------------------------------------------- |
| `currentPhase` | string       | Active phase: plan, research, verify, compose, completed |
| `topic`        | string       | The research topic (from user argument)                  |
| `domain`       | string\|null | Detected domain for reputation scoring                   |
| `researchId`   | string       | Unique identifier for this research session              |

## Rules

### Autonomy

1. **Always get user approval** for the research spec before starting exploration
2. **Always checkpoint** after each research cycle — never auto-continue without user input
3. The explore agent has full autonomy to search, follow leads, and create threads as needed

### Quality

4. Every factual claim must have a source with a reputation score
5. Use the [reputation system](common/reputation-system.md) for all source scoring
6. Use the [evidence format](common/evidence-format.md) for all evidence documentation
7. Verifiers must have NO prior context — they check claims fresh

### State

8. Machine state directory is `.research/` (hidden). Research artifacts go in `research/` (visible in Finder/Obsidian)
9. Per-phase state agents handle state writes (orchestrator never reads/writes state JSON directly except during bootstrap)
10. All step transitions logged to `.research/transitions.log`

## Prerequisites

- Web search and web fetch capabilities
- `jq` for verify phase shell scripts
