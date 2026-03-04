# Evidence Format Guide

Standard format for documenting evidence in research findings. Every factual claim must be backed by structured evidence.

## Evidence Item Format

```markdown
**Claim**: {Factual statement being supported}

- **Source**: [Title](URL) — Rep: {score}/5 ({rationale})
- **Quote/Data**: "{Exact quote or data point}" | {Summarized finding}
- **Accessed**: {YYYY-MM-DD}
- **Confidence**: {high|medium|low} — {why}
```

## Confidence Levels

| Level      | Meaning             | Criteria                                                |
| ---------- | ------------------- | ------------------------------------------------------- |
| **High**   | Strong evidence     | 2+ independent sources agree, Rep 4+, recent            |
| **Medium** | Reasonable evidence | 1 strong source or 2+ moderate sources                  |
| **Low**    | Weak evidence       | Single source, low reputation, old, or conflicting info |

## Corroboration

When multiple sources support the same claim, note it:

```markdown
**Claim**: {statement}

- **Source 1**: [Title](URL) — Rep: 4/5 (...)
- **Source 2**: [Title](URL) — Rep: 5/5 (...)
- **Corroboration**: 2 independent sources agree. Confidence: high.
```

## Contradictions

When sources disagree, document both sides:

```markdown
**Claim (disputed)**: {statement}

- **For**: [Title](URL) — Rep: 4/5 — says "{quote}"
- **Against**: [Title](URL) — Rep: 3/5 — says "{quote}"
- **Analysis**: {Which is more credible and why}
- **Confidence**: low — conflicting evidence
```

## Tips

- **Prefer direct quotes** over paraphrasing when the exact wording matters
- **Always include access date** — web content changes
- **One claim per evidence block** — don't bundle multiple claims
- **Link to specific sections** when possible (anchor links, page numbers)
- **Note if a source is behind a paywall** — affects reproducibility during verification
