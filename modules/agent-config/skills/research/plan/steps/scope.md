# Scope & Write Spec — Team Agent (Sonnet)

## Agent Context

- Working directory: project root
- Topic: {provided by orchestrator}
- Domain (if known): {provided by orchestrator, may be null}
- User feedback (if revising): {provided by orchestrator, may be null}
- Spec template: `<skill-dir>/templates/spec-template.md`
- Reputation system reference: `<skill-dir>/common/reputation-system.md`

## Agent Report Format

```
RESULT: <spec_written|needs_revision|error>
DOMAIN: <detected domain>
STEP: <write_spec|approve>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

Understand the research topic, detect the domain, ask clarifying questions, and write a research spec that defines **goals and quality bar only** — NOT how to investigate.

## Steps

### 1. Understand the Topic

Analyze the topic to determine:

- What domain does this fall into? (software, legal/tax, travel, academic, news, general)
- What are the implicit questions the user wants answered?
- What level of depth is expected?

Read `<skill-dir>/common/reputation-system.md` to understand domain options.

### 2. Ask Clarifying Questions

Use `AskUserQuestion` to gather:

1. **Depth**: How deep should we go?
   - "Quick overview — key facts and top sources"
   - "Standard — thorough coverage with verification"
   - "Deep dive — exhaustive, academic-grade rigor"

2. **Constraints** (if not obvious from topic):
   - Recency requirements?
   - Geographic scope?
   - Any specific angles or exclusions?

### 3. Write the Spec

Read `<skill-dir>/templates/spec-template.md` for the structure.

Write `research/spec.md` containing:

- **Research goals** — concrete questions to answer (derived from topic + user input)
- **Definition of Done** — quality bar calibrated to requested depth:
  - Quick: 2+ sources per claim, Rep 3+ average
  - Standard: 3+ sources per claim, Rep 3.5+ average, medium confidence
  - Deep: 4+ sources per claim, Rep 4+ average, high confidence
- **Domain** — for reputation scoring calibration
- **Constraints** — from user input

**The spec must NOT contain:**

- Sub-questions or decomposition of goals
- Search strategies or keywords
- Intermediate steps or methodology
- Source lists or starting points

The research agent gets creative freedom to explore. The spec defines the destination, not the path.

### 4. Handle Revision (if user feedback provided)

If the orchestrator provides user feedback:

1. Read the existing `research/spec.md`
2. Apply the user's feedback
3. Rewrite the spec
4. Report `STEP: approve` so user can re-approve

## Resumability

If resuming into this step:

- Check if `research/spec.md` already exists
- If yes and no revision feedback: report `RESULT: spec_written, STEP: approve`
- If yes and revision feedback: apply feedback, rewrite
- If no: start from Step 1

## Important

- Do NOT update state files (`task-state.json`, `plan-state.json`)
- Do NOT include methodology, search strategies, or sub-questions in the spec
- Do NOT start researching — only write the spec
- The spec defines WHAT to find, not HOW to find it
