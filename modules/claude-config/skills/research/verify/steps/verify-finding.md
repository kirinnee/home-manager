# Verify Finding — Team Agent (Sonnet)

## Agent Context

- Working directory: project root
- Finding file: {provided by orchestrator}
- Verification output path: {provided by orchestrator}
- Reputation system: `<skill-dir>/common/reputation-system.md`
- Verification template: `<skill-dir>/templates/verification-template.md`

## Agent Report Format

```
RESULT: <complete|error>
CLAIMS_TOTAL: <N>
CLAIMS_VERIFIED: <N>
CLAIMS_UNVERIFIABLE: <N>
CLAIMS_CONTRADICTED: <N>
OVERALL_CONFIDENCE: <high|medium|low>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

Independently verify every factual claim in a research finding thread. You have **NO prior context** about this research — you are checking claims fresh, as if encountering them for the first time.

## Steps

### 1. Read the Finding

Read the finding file provided. Extract every factual claim that can be verified, along with its cited source and reputation score.

### 2. Read the Reputation System

Read the reputation system guide to understand scoring criteria for the research domain.

### 3. Verify Each Claim

For EACH factual claim in the finding:

1. **Attempt independent verification**: Use `WebSearch` and `WebFetch` to find the same information from different sources. Do NOT just re-visit the original source.

2. **Check the original source**: Visit the cited URL to confirm:
   - The source still exists and is accessible
   - The quoted/cited information is accurate
   - The source says what the finding claims it says

3. **Validate the reputation score**: Based on the reputation system guide, does the assigned score seem correct?

4. **Check recency**: Is the information still current? Has anything changed since the source was published or accessed?

5. **Assign verification status**:
   - `verified` — independently confirmed by another source
   - `partially verified` — some aspects confirmed, others not checkable
   - `unverifiable` — cannot independently confirm (not necessarily wrong)
   - `contradicted` — found evidence that disagrees with the claim

### 4. Write Verification Report

Read the verification template for structure guidance.

Write the verification report to the output path provided. Include:

- Overall verdict and confidence
- Claim-by-claim verification results
- Reputation score validation (any adjustments?)
- Recency check results
- Flags for problematic claims

### 5. Be Thorough

- Don't just do a surface check — try multiple search queries
- If a claim seems surprising, work harder to verify it
- If you find contradicting information, document it clearly
- If a source is behind a paywall, note this affects verifiability

## Resumability

If resuming into this step:

- Check if the verification output file already exists
- If yes and non-empty: report success without re-doing work
- If no: start from Step 1

## Important

- Do NOT update state files (`task-state.json`, `verify-state.json`)
- Do NOT modify the original finding file — only read it
- Do NOT have any bias from other findings — verify this thread in isolation
- Be honest — if you can't verify something, say so
- Use fresh web searches — do NOT rely on cached or remembered information
