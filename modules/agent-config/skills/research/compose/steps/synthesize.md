# Synthesize — Team Agent (Opus)

## Agent Context

- Working directory: project root
- Research spec: `research/spec.md`
- Findings directory: `research/findings/`
- Review files: `research/review-cycle-*.md`
- Verification directory: `research/verification/`
- Report template: `<skill-dir>/templates/report-template.md`
- Reputation system: `<skill-dir>/common/reputation-system.md`

## Agent Report Format

```
RESULT: <complete|error>
REPORT_PATH: research/report.md
GOALS_ADDRESSED: <N>/<total>
OVERALL_CONFIDENCE: <high|medium|low>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

Synthesize ALL research findings, reviews, and verification results into a comprehensive final report. Organize by research goals (not by investigation thread).

## Steps

### 1. Read Everything

Read in this order:

1. `research/spec.md` — the research goals and Definition of Done
2. ALL files in `research/findings/` — the raw investigation threads
3. ALL `research/review-cycle-*.md` files — cross-reference reviews
4. ALL files in `research/verification/` — independent verification results
5. The report template at `<skill-dir>/templates/report-template.md`

### 2. Build the Synthesis

For each research goal in the spec:

- Gather ALL relevant findings from ALL threads
- Weight by verification status (verified > partially verified > unverifiable)
- Weight by source reputation
- Note contradictions and how they were resolved
- Assess overall confidence for this goal

### 3. Write the Report

Write `research/report.md` following the report template structure:

**Executive Summary** (3-5 paragraphs):

- Key findings for each goal
- Overall confidence assessment
- Major caveats or limitations
- Written for someone who will only read this section

**Findings by Goal**:

- One section per research goal from the spec
- Synthesized narrative (not just listing thread findings)
- Key evidence with source links, reputation scores, and verification status
- Confidence level per goal

**Contradictions & Disputes** (if any):

- Present both sides with evidence
- Analyze which is more credible and why
- If no contradictions: state "No significant contradictions found."

**Limitations & Caveats**:

- Information gaps
- Low-confidence areas
- Recency concerns
- Scope limitations

**Evidence Appendix**:

- All sources organized by reputation score tier
- Verification summary table per thread
- Total counts: claims verified, unverifiable, contradicted

### 4. Quality Check

Before finishing:

- Does every major claim in the report have a linked source?
- Are confidence levels honest and well-justified?
- Is the executive summary self-contained and useful?
- Does the report address ALL goals from the spec?
- Are contradictions presented fairly?

## Resumability

If resuming into this step:

- Check if `research/report.md` already exists
- If yes and substantive: report success
- If no or empty: start from Step 1

## Important

- Do NOT update state files (`task-state.json`, `compose-state.json`)
- Do NOT do additional research — only synthesize what exists
- Organize findings by GOAL, not by thread — the reader doesn't care about investigation structure
- Be honest about confidence — don't overstate findings
- Include ALL sources in the evidence appendix, even low-reputation ones
- The report should be useful as a standalone document
