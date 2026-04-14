# Source Reputation System

Domain-adaptive scoring for evaluating source credibility. Every evidence item in a research finding must include a reputation score with rationale.

## Scoring Scale (1-5)

| Score | Label      | Meaning                                                  |
| ----- | ---------- | -------------------------------------------------------- |
| **5** | Top-Tier   | Primary/authoritative source, highest credibility        |
| **4** | High       | Strong credibility, well-established source              |
| **3** | Medium     | Credible but secondary, moderate authority               |
| **2** | Low        | Weak credibility, limited verification                   |
| **1** | Unreliable | No verification possible, anonymous, or known unreliable |

## Domain-Specific Calibration

### Software / Technology

| Score | Examples                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 5     | Official docs, RFC specs, GitHub repos with 10k+ stars, core maintainer posts                                                        |
| 4     | GitHub 1k+ stars well-maintained, reputable tech blogs (official engineering blogs), Stack Overflow accepted answers with high votes |
| 3     | Blog posts with working code examples, SO answers with moderate votes, conference talks                                              |
| 2     | Personal blogs without code, forum posts, unverified tutorials                                                                       |
| 1     | AI-generated content without source, outdated docs (>2 years for fast-moving tech)                                                   |

### Legal / Tax / Regulatory

| Score | Examples                                                                     |
| ----- | ---------------------------------------------------------------------------- |
| 5     | Statute text, IRS/government publications, court rulings, regulatory filings |
| 4     | CPA/attorney publications, Big 4 guidance, bar association resources         |
| 3     | News articles citing official sources, professional association guidance     |
| 2     | Forum advice, non-professional commentary, generic "legal tips"              |
| 1     | Outdated guidance (>2 years for tax), anonymous advice, social media         |

### Travel / Local

| Score | Examples                                                                          |
| ----- | --------------------------------------------------------------------------------- |
| 5     | Official venue/business site, Yelp 4.5+ with 500+ reviews, government tourism     |
| 4     | Google 4.5+ with 200+ reviews, TripAdvisor top-rated, guidebooks (recent edition) |
| 3     | Yelp 3.5+ moderate reviews, travel blogs with photos/dates, local news            |
| 2     | Old reviews (>1 year), low-count reviews, undated blog posts                      |
| 1     | Anonymous tips, social media without verification, SEO spam                       |

### Academic / Scientific

| Score | Examples                                                                      |
| ----- | ----------------------------------------------------------------------------- |
| 5     | Peer-reviewed journal (high impact factor), systematic reviews, meta-analyses |
| 4     | Preprints with citations, reputable journal (moderate impact), textbooks      |
| 3     | Conference papers, well-cited working papers, expert commentary               |
| 2     | Theses, low-citation working papers, institutional reports                    |
| 1     | Blog posts without peer review, predatory journal publications                |

### News / Current Events

| Score | Examples                                                                   |
| ----- | -------------------------------------------------------------------------- |
| 5     | Wire services (Reuters, AP), primary source documents, official statements |
| 4     | Major publications with named sources, investigative journalism            |
| 3     | Regional news, industry publications, named-source reporting               |
| 2     | Aggregator sites, unnamed sources, opinion columns                         |
| 1     | Tabloids, clickbait, social media rumors                                   |

### General / Cross-Domain

| Score | Examples                                                           |
| ----- | ------------------------------------------------------------------ |
| 5     | Primary source, official organization publication, government data |
| 4     | Expert with verifiable credentials, established institution        |
| 3     | Reputable publication, secondary source with citations             |
| 2     | Unverified secondary source, self-published without credentials    |
| 1     | Anonymous, no attribution, known unreliable source                 |

## How to Apply

1. **Identify the domain** from the research spec
2. **Use the domain-specific table** as the primary reference
3. **Fall back to General** for sources that don't fit a specific domain
4. **Cross-domain research**: Use the most relevant domain table for each individual source
5. **Always include rationale** — don't just assign a number, explain why

## Format

When scoring a source, use this inline format:

```
[Source Title](URL) — Rep: {score}/5 ({rationale})
```

Example:

```
[React Documentation](https://react.dev) — Rep: 5/5 (official docs, maintained by core team)
[Dev.to Blog Post](https://dev.to/...) — Rep: 3/5 (working code examples, but personal blog)
```
