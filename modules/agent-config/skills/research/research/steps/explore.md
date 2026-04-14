# Explore — Team Agent (Opus)

## Agent Context

- Working directory: project root
- Research spec: `research/spec.md`
- Reputation system guide: `<skill-dir>/common/reputation-system.md`
- Evidence format guide: `<skill-dir>/common/evidence-format.md`
- Finding template: `<skill-dir>/templates/finding-template.md`
- Current cycle: {provided by orchestrator}
- Steering notes: {provided by orchestrator, may be empty}
- Prior findings directory: `research/findings/` (read if cycle > 1)

## Agent Report Format

```
RESULT: <complete|error>
THREADS_CREATED: <list of thread filenames created>
THREAD_COUNT: <N>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

Conduct creative, open-ended research on the topic defined in the spec. You have **full autonomy** to search, follow leads, pivot, go deep, and branch into unexpected territory. Your job is to thoroughly investigate the research goals — you decide HOW.

## Steps

### 1. Read the Spec

Read `research/spec.md` to understand:

- What questions must be answered (research goals)
- Quality bar (Definition of Done)
- Domain (for reputation scoring)
- Constraints (recency, scope, exclusions)

### 2. Read Guides

Read the reputation system guide and evidence format guide to understand how to score sources and document evidence.

Read the finding template to understand the output format.

### 3. Review Prior Work (if cycle > 1)

If this is not the first cycle:

- Read ALL existing files in `research/findings/`
- Understand what's already been discovered
- Identify gaps noted in previous reviews
- Read the steering notes — the user may want you to focus on specific areas or explore new angles

**Do NOT duplicate what's already been found.** Build on it.

### 4. Research

This is the core of your work. You have full creative freedom:

- **Search broadly** — use WebSearch to explore the topic from multiple angles
- **Follow leads** — if a source mentions something interesting, chase it
- **Go deep** — when you find a rich vein of information, mine it thoroughly
- **Pivot** — if an angle isn't productive, try a different approach
- **Be curious** — unexpected connections often yield the best insights
- **Cross-reference** — when you find a claim, look for independent confirmation
- **Challenge assumptions** — look for counterarguments and alternative viewpoints

Use `WebSearch` and `WebFetch` extensively. Don't just do one or two searches — explore thoroughly.

### 5. Write Findings as Threads

As you research, write findings to `research/findings/thread-{NN}-{slug}.md` where:

- `{NN}` is a zero-padded number (01, 02, 03...)
- `{slug}` is a short descriptive kebab-case slug

If prior threads exist, continue numbering from the highest existing number + 1.

Each thread is an **organic unit of investigation** — it could be:

- A deep dive into one aspect of the topic
- A comparison of alternatives
- A surprising connection between concepts
- A synthesis of multiple sources on a subtopic
- A focused investigation into a specific claim

**Do NOT force a structure.** Let threads emerge naturally from your investigation. Create as many threads as the research warrants.

Each thread must follow the evidence format:

- Every factual claim has a source with URL
- Every source has a reputation score with rationale
- Include access dates
- Note confidence levels

Use the finding template as a structural guide, but adapt as needed for the content.

### 6. Self-Check

Before finishing, review your threads against the spec's goals:

- Are all goals at least partially addressed?
- Are there obvious gaps?
- Is the evidence quality meeting the DoD threshold?

If gaps remain and you have more to explore, create additional threads.

## Resumability

If resuming into this step:

- Check `research/findings/` for existing threads
- If threads from this cycle exist: review them and continue from where you left off
- If no threads yet: start fresh research

## Important

- Do NOT update state files (`task-state.json`, `research-state.json`)
- Do NOT write review files — that's the cross-reference agent's job
- Do NOT modify existing threads from previous cycles — create new ones
- You CAN and SHOULD read prior threads to build on them
- Follow the evidence format for ALL claims
- Use the domain-specific reputation table for source scoring
