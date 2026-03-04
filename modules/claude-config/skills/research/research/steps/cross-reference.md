# Cross-Reference & Review — Team Agent (Sonnet)

## Agent Context

- Working directory: project root
- Research spec: `research/spec.md`
- Current cycle: {provided by orchestrator}
- Findings directory: `research/findings/`
- Prior reviews: `research/review-cycle-*.md` (if any)

## Agent Report Format

```
RESULT: <complete|error>
REVIEW_FILE: <path to review file written>
GOALS_COVERAGE: <summary of which goals are well-covered vs gaps>
OVERALL_CONFIDENCE: <high|medium|low>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

Read ALL findings from ALL research cycles. Cross-reference them, identify patterns, and assess progress against the research goals. Write a cycle review.

## Steps

### 1. Read the Spec

Read `research/spec.md` to understand the research goals and Definition of Done.

### 2. Read ALL Findings

Read every file in `research/findings/`. Build a mental model of:

- What has been discovered
- What sources have been used
- What confidence levels exist

### 3. Cross-Reference Analysis

Analyze the findings for:

**Corroborations** — Where do multiple independent sources agree?

- List claims supported by 2+ independent threads/sources
- These are high-confidence findings

**Contradictions** — Where do sources disagree?

- List claims where threads present conflicting information
- Analyze which side has stronger evidence

**Gaps** — What's missing relative to the DoD?

- Which research goals lack sufficient evidence?
- Which goals have evidence below the confidence threshold?
- What areas haven't been explored yet?

**Patterns** — What themes emerge across threads?

- Recurring findings
- Unexpected connections
- Common limitations

### 4. Rate Confidence Per Goal

For each research goal in the spec, rate:

- **Coverage**: How well is this goal addressed? (fully, partially, minimally)
- **Confidence**: How confident are we in the findings? (high, medium, low)
- **Evidence quality**: Average reputation score of supporting sources
- **Recommendation**: Is more research needed for this goal?

### 5. Write Review

Write `research/review-cycle-{N}.md` (where N = current cycle) containing:

```markdown
# Research Review — Cycle {N}

## Summary

{2-3 paragraph overview}

## Goal Coverage

### Goal 1: {goal}

- Coverage: {fully|partially|minimally}
- Confidence: {high|medium|low}
- Avg source reputation: {N}/5
- Key threads: {list thread numbers}
- Recommendation: {sufficient | needs more research on X}

### Goal 2: {goal}

...

## Corroborations

{Claims confirmed by multiple independent sources}

## Contradictions

{Conflicting findings with analysis}

## Gaps

{What's still missing or underexplored}

## Overall Assessment

- Goals fully covered: {N}/{total}
- Goals partially covered: {N}/{total}
- Goals minimally covered: {N}/{total}
- Overall confidence: {high|medium|low}
- Recommendation: {ready for verification | needs another cycle focusing on X}
```

## Resumability

If resuming into this step:

- Check if `research/review-cycle-{N}.md` already exists
- If yes: report success with the existing review
- If no: start from Step 1

## Important

- Do NOT update state files (`task-state.json`, `research-state.json`)
- Do NOT modify any finding threads — only read them
- Do NOT do additional research — only analyze what exists
- Be honest about gaps — don't inflate confidence
