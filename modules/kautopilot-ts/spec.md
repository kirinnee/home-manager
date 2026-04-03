# Phase 1: Configurable Prompts + Triage Phase

## 1. Problem

Phase 1 has two issues:

1. **Spec/plan writer prompts aren't configurable.** They are referenced via `typeConfig.spec_writer.prompt` and `typeConfig.plan_writer.prompt`, but `typeConfig` and `config.types` do not exist in the Config schema. This crashes at runtime. Prompts must live in config so orgs can customize them.

2. **No triage step.** The flow jumps from `pull_ticket` straight into spec writing. A trivial config change gets the same heavy debate treatment as a risky cross-cutting refactor. There is no assessment of what the ticket actually needs before writing begins.

---

## 2. Config: `prompts` field

Add a top-level `prompts` field to `configSchema`:

```typescript
prompts: z.object({
  triage: z.string().default(DEFAULT_TRIAGE_PROMPT),
  spec_writer: z.string().default(DEFAULT_SPEC_WRITER_PROMPT),
  plan_writer: z.string().default(DEFAULT_PLAN_WRITER_PROMPT),
}).default({});
```

This replaces the broken `config.types[ticketType]` indirection. Flat, simple, overridable per-org via `~/.kautopilot/orgs/{org}/config.yaml`.

Example override:

```yaml
prompts:
  triage: |
    Custom triage prompt for this org...
  spec_writer: |
    Custom spec writer prompt...
```

---

## 3. Prompt variable substitution

All three prompts support these variables, resolved at runtime:

| Variable     | Resolves to                                  |
| ------------ | -------------------------------------------- |
| `{ticket}`   | `{worktree}/spec/ticket.md`                  |
| `{spec}`     | `{worktree}/spec/v{version}/task-spec.md`    |
| `{specDir}`  | `{worktree}/spec/v{version}`                 |
| `{plans}`    | `{worktree}/spec/v{version}/plans`           |
| `{worktree}` | absolute worktree path                       |
| `{triage}`   | `{worktree}/spec/v{version}/triage.md` (new) |

---

## 4. Phase 1 flow (updated)

```
[code] pull_ticket     → fetch ticket to {worktree}/spec/ticket.md
[tty]  triage          → assess scope, classify delivery, clarify with user
[tty]  write_spec      → write spec informed by triage output
[code] finalize_spec   → snapshot spec draft to task-spec.md
[tty]  write_plans     → write plans from approved spec
[code] finalize_plans  → snapshot plans, git commit (terminal)
```

---

## 5. Triage phase

### 5.1 Purpose

A TTY session that reads the ticket and does **lightweight** codebase exploration — just enough to assess scope, not to solve the problem. It produces a triage document that shapes everything downstream.

### 5.2 What triage evaluates

- **Complexity** — how many moving parts, how many files likely touched
- **Parallelizability** — can this be split into independent streams of work
- **Risk factors** — blast radius, backward compatibility, data migration
- **Manual work** — infra changes, config deployments, manual verification needed
- **Known/unknown ratio** — is the approach clear or does it need research first
- **Disambiguate with user** — if the ticket is vague or under-specified, firm it up through conversation

### 5.3 Triage outputs

**Delivery kind:**

| Kind     | Meaning                                                         | Downstream behavior                                            |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| `pr`     | Straightforward implement-and-ship                              | Normal spec → plans → dev-loop → PR                            |
| `ticket` | Needs research first, or should decompose into multiple tickets | Spec describes investigation/decomposition, not implementation |

**Complexity assessment:**

| Level             | Meaning                                   | Downstream behavior                                 |
| ----------------- | ----------------------------------------- | --------------------------------------------------- |
| `straightforward` | Clear what to do, small surface           | Spec writer keeps it brief, minimal debate          |
| `moderate`        | Some exploration needed, manageable scope | Spec writer does moderate discussion                |
| `complex`         | Large scope, many unknowns, high risk     | Spec writer does thorough debate and de-ambiguation |

**Written artifact:** `{specDir}/triage.md`

### 5.4 Loop contract

Triage must NOT do research or implementation — it classifies so the downstream loop handles it:

- If it is a research task → set delivery kind to `ticket`, describe what research is needed
- If it is an implementation task → set delivery kind to `pr`, describe approach at high level
- If it is a breakdown task → set delivery kind to `ticket`, describe how to split

### 5.5 Fast path for simple tasks

If the ticket is clearly straightforward (e.g., "change config value X to Y", "bump version of dependency Z"), triage says so and moves on. No forced multi-turn debate. The user confirms and exits.

---

## 6. Triage mechanics (hardcoded, non-configurable)

Same pattern as SPEC_MECHANICS and PLAN_MECHANICS — always prepended by the runner so the pipeline contract is never broken by custom prompts:

```
## CRITICAL: Triage Output & Approval Mechanics

### Output File

Write your triage assessment to: {specDir}/triage.md

The triage document MUST include these sections:

    # Triage: [ticket summary]

    ## Delivery Kind
    pr | ticket

    ## Complexity
    straightforward | moderate | complex

    ## Assessment
    [2-5 sentence summary of what needs to happen]

    ## Clarifications
    [Any points clarified with the user, or "None needed"]

    ## Risks
    [Risk factors, or "Low risk — straightforward change"]

### Approval Protocol

When the user confirms the triage assessment:
1. Write the approval event:
   `kautopilot log-event triage:approved --metadata '{"deliveryKind": "pr|ticket", "complexity": "..."}'`
2. THEN tell the user to /exit

CRITICAL: Do NOT tell the user to /exit before writing the approval event.
```

---

## 7. Spec writer behavior (informed by triage)

The spec writer prompt receives `{triage}` and adapts:

- **If triage says "straightforward"**: write a focused, concise spec. No heavy debate — triage already confirmed scope. Cover what to change, acceptance criteria, and proof of completion.
- **If triage says "moderate" or "complex"**: do thorough exploration and debate. Walk through requirements, identify hidden assumptions, conflicts, and risks. Clarify until nothing is ambiguous.
- **If delivery kind is "ticket"**: spec the research or decomposition, NOT the implementation.

---

## 8. Plan writer behavior (informed by triage)

The plan writer prompt also receives `{triage}`:

- Plans must be vertically split (by domain/feature, not by layer)
- Each plan is one isolated, committable unit of work
- For `ticket` delivery: plans describe investigation steps or ticket creation, not code changes

---

## 9. Dead code cleanup

Remove:

- `typeConfig` references from `Phase1Context`, `write-spec.ts`, `write-plans.ts`
- `config.types[ticketType]` from `index.ts` `runPhase1()`
- `route_type` references from flow comments
- `ticketType` from status context restoration in `runPhase1()`

---

## 10. Files affected

| File                               | Change                                                 |
| ---------------------------------- | ------------------------------------------------------ |
| `src/core/types.ts`                | Add `prompts` to configSchema + DEFAULT_CONFIG         |
| `src/core/type-config.ts`          | Add `triage` to PromptVars + buildPromptVars           |
| `src/phases/phase1/triage.ts`      | **NEW** — triage TTY handler                           |
| `src/phases/phase1/write-spec.ts`  | Use `config.prompts.spec_writer`, remove typeConfig    |
| `src/phases/phase1/write-plans.ts` | Use `config.prompts.plan_writer`, remove typeConfig    |
| `src/phases/phase1/types.ts`       | Clean up dead typeConfig references                    |
| `src/phases/phase1/index.ts`       | Add triage to state map, remove dead code, update flow |
| `src/phases/phase1/pull-ticket.ts` | Return `'triage'` instead of `'write_spec'`            |

---

## 11. Definition of done

### A. Configurable prompts

Expected: triage, spec_writer, and plan_writer prompts are defined in `config.prompts` with sensible defaults. Org configs can override any prompt via the `prompts:` field in `config.yaml`.

How to test: override `prompts.triage` in org config, run init, confirm custom prompt is used.

### B. Triage phase works

Expected: after pull_ticket, a triage TTY session launches. It assesses the ticket, writes `triage.md`, and the user confirms with approval protocol.

How to test: run `kautopilot start` on a ticket. Confirm triage TTY appears, produces `triage.md`, logs `triage:approved`, and flows into spec writing.

### C. Triage informs spec writer

Expected: spec writer reads `{triage}` and adapts its behavior. Straightforward tasks get brief specs. Complex tasks get thorough debate.

How to test: triage a simple ticket as "straightforward" — confirm spec writer does not force heavy debate.

### D. Delivery kind propagates

Expected: triage sets delivery kind. `finalize_plans` writes it to `contract.json` and `delivery.json`.

How to test: triage as "ticket" delivery — confirm downstream manifests reflect `ticket` delivery kind.

### E. Crash recovery

Expected: triage uses the same approval-event pattern as spec/plan writing. If TTY exits before `triage:approved`, the step re-runs on next start.

How to test: kill the triage TTY before approval, restart, confirm triage resumes.

### F. Dead code removed

Expected: no references to `typeConfig`, `config.types`, `ticketType`, or `route_type` remain in phase1 code.

How to test: grep confirms no matches.
