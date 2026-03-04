---
name: create-file-processor-skill
description: 'Create skills that process files independently using parallel agents. Use when building divide-and-conquer skills like /fact-check where each file gets its own agent with fresh context.'
argument-hint: '[SKILL_NAME]'
---

# Create File Processor Skill

Generate a Claude Code skill that processes files one-by-one using spawned agents. Each agent gets a single file with fresh context — no pollution from previous files.

## The Pattern

File-processor skills follow a divide-and-conquer strategy:

1. **Init** — agent discovers files, shell script writes state JSON
2. **Loop** — spawn one agent per file (in batches), each writes findings to disk
3. **Aggregate** — combine all per-file findings into a final report

Shell scripts (`init-state.sh`, `next-file.sh`, `mark-done.sh`) manage state, so progress survives context loss and agents never redo completed work.

## When to Use

- Building a skill that checks/processes many files independently
- Examples: documentation checking, link validation, spell checking, research verification
- Any task where files can be processed in isolation and results aggregated

## Instructions

### Step 1: Gather Configuration

If a skill name was provided as argument, use it. Otherwise ask.

Use `AskUserQuestion` to collect all parameters:

| Parameter         | Description                              | Example                                 |
| ----------------- | ---------------------------------------- | --------------------------------------- |
| Skill name        | kebab-case name                          | `spell-check`, `link-check`             |
| File extensions   | For file discovery                       | `md,mdx`                                |
| Source paths      | Reference paths agents should read       | `src/`, `../api/src/`                   |
| Per-file task     | What each agent should DO with each file | "Check all links are valid and resolve" |
| Output format     | Structure of each agent's findings       | "List broken links with line numbers"   |
| Output file       | Final report filename                    | `link-check-report.md`                  |
| Concurrent agents | How many agents run in parallel          | `3`                                     |

Show collected config and get explicit approval before generating.

### Step 2: Create Skill Directory

Determine target:

- If `.claude/skills/` exists in the project root, use it
- Otherwise default to `~/.claude/skills/`

```bash
SKILL_DIR="{skills-root}/{skill-name}"
mkdir -p "$SKILL_DIR/scripts" "$SKILL_DIR/templates"
```

### Step 3: Copy Scripts

Copy the three generic state-management scripts from this skill's templates directory:

```bash
TEMPLATE_DIR="<this-skill-dir>/templates"
cp "$TEMPLATE_DIR/init-state.sh" "$SKILL_DIR/scripts/"
cp "$TEMPLATE_DIR/next-file.sh" "$SKILL_DIR/scripts/"
cp "$TEMPLATE_DIR/mark-done.sh" "$SKILL_DIR/scripts/"
chmod +x "$SKILL_DIR/scripts/"*.sh
```

These scripts are fully generic — they work for any file-processor skill without modification.

Note: `init-state.sh` reads the file list from **stdin** (one file per line). The generated skill's agent handles file discovery — the script itself has no hardcoded paths or exclusions.

### Step 4: Write SKILL.md

Read `<this-skill-dir>/templates/SKILL-TEMPLATE.md` and substitute all `{PLACEHOLDERS}` with gathered config. Write the result to `$SKILL_DIR/SKILL.md`.

Substitutions:

| Placeholder                 | Source                                                                          |
| --------------------------- | ------------------------------------------------------------------------------- |
| `{SKILL_NAME}`              | Skill name (kebab-case)                                                         |
| `{SKILL_TITLE}`             | Title-cased skill name                                                          |
| `{DESCRIPTION}`             | Description derived from per-file task                                          |
| `{USE_CASES}`               | 2-3 "when to use" bullets from the task description                             |
| `{FILE_EXTENSIONS}`         | Comma-separated extensions                                                      |
| `{DEFAULT_CONCURRENT}`      | Default agent count                                                             |
| `{DEFAULT_OUTPUT}`          | Default output filename                                                         |
| `{PROCESSING_INSTRUCTIONS}` | The per-file task prompt (verbatim from user)                                   |
| `{OUTPUT_FORMAT}`           | Per-file output structure (verbatim from user)                                  |
| `{EXAMPLE_OUTPUT}`          | A concrete example of one agent's findings file, derived from the output format |

### Step 5: Write Output Template

Read `<this-skill-dir>/templates/output-template.md` as a skeleton. Customize the Findings section structure based on the user's output format, then write the result to `$SKILL_DIR/templates/output.md`.

### Step 6: Verify

```bash
ls -R "$SKILL_DIR/"
head -5 "$SKILL_DIR/SKILL.md"
```

Report the created skill path and show example invocation: `/{skill-name}`.

## Generated Skill Structure

```
{skill-name}/
├── SKILL.md              # Skill instructions with agent loop
├── scripts/
│   ├── init-state.sh     # Accept file list from stdin, write state JSON
│   ├── next-file.sh      # Get next pending file(s)
│   └── mark-done.sh      # Mark file as processed
└── templates/
    └── output.md         # Report template
```

## Prerequisites

- `jq` for JSON processing in scripts

## Related Skills

- [create-skill](../create-skill/SKILL.md) — base skill creation (invokes this technique when appropriate)
- [create-multi-state-skill](../create-multi-state-skill/SKILL.md) — multi-state technique for phase-based workflows
