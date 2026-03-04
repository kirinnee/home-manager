---
name: create-skill
description: Create new Claude Code skills with proper structure. Use when asked to create a skill, make a skill, or build automation for Claude. Generates SKILL.md with front matter and supporting files.
---

# Create Claude Code Skill

This skill helps you create new Claude Code skills with proper directory structure, front matter, and supporting files.

## When to Use

- User asks to "create a skill" or "make a skill"
- User wants to automate a workflow for Claude
- User needs to document a repeatable process for Claude to follow

## Skill Structure

Skills are directories containing a `SKILL.md` file and optional supporting files:

```
.claude/skills/skill-name/
├── SKILL.md              # Required - main skill file
├── reference.md          # Optional - detailed documentation
├── examples.md           # Optional - usage examples
├── templates/            # Optional - template files
│   └── template.yaml
└── scripts/              # Optional - helper scripts
    └── helper.py
```

## Techniques

Create-skill supports two specialized techniques for common skill patterns. When the user's requirements match a technique, delegate to it instead of building the skill from scratch.

| Technique          | When to Use                                                                                                                                          | Skill                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **File Processor** | Skill processes many files independently with parallel agents (divide-and-conquer). E.g., doc checking, link validation, spell checking.             | [create-file-processor-skill](../create-file-processor-skill/SKILL.md) |
| **Multi-State**    | Skill has multiple phases, needs state persistence/resumability, orchestrates sub-agents/team agents. E.g., multi-cycle automation, CI/review loops. | [create-multi-state-skill](../create-multi-state-skill/SKILL.md)       |

**How to decide:** After Step 1, if the gathered requirements clearly match a technique, read that technique's SKILL.md and follow its process instead. If requirements don't match either technique, continue with Step 2 below.

## Instructions

### Step 1: Gather Information

Ask the user:

1. **Skill Name**: Lowercase, hyphens allowed (e.g., `create-runbook`, `deploy-service`)
2. **Description**: What it does AND when Claude should use it (critical for discovery)
3. **Purpose**: Detailed explanation of the skill's function
4. **Steps/Process**: What steps should Claude follow?
5. **Supporting Files**: Does it need templates, examples, or reference docs?
6. **Tool Restrictions**: Should Claude be limited to specific tools? (optional)

### Step 2: Create Directory Structure

```bash
mkdir -p .claude/skills/{skill-name}
```

### Step 3: Create SKILL.md

Use this template (see [templates/SKILL-TEMPLATE.md](templates/SKILL-TEMPLATE.md)):

```markdown
---
name: {skill-name}
description: {What it does}. Use when {trigger conditions}.
allowed-tools: {optional - comma-separated tool list}
---

# {Skill Title}

{Brief overview of what this skill does}

## When to Use

- {Trigger condition 1}
- {Trigger condition 2}

## Instructions

### Step 1: {First Step}

{Detailed instructions}

### Step 2: {Second Step}

{Detailed instructions}

## Reference

For detailed documentation, see [reference.md](reference.md).

## Examples

See [examples.md](examples.md) for usage examples.
```

### Step 4: Create Supporting Files (if needed)

**reference.md** - Detailed documentation, specifications, formats
**examples.md** - Concrete examples of the skill in action
**templates/** - Reusable templates for the skill
**scripts/** - Helper scripts (ensure execute permissions)

### Step 5: Verify

1. Check YAML syntax is valid
2. Ensure description includes what + when triggers
3. Test by asking Claude something that matches the description

## Front Matter Reference

| Field           | Required | Description                                |
| --------------- | -------- | ------------------------------------------ |
| `name`          | Yes      | Lowercase, hyphens, max 64 chars           |
| `description`   | Yes      | What it does + when to use, max 1024 chars |
| `allowed-tools` | No       | Comma-separated list to restrict tools     |

## Best Practices

See [best-practices.md](best-practices.md) for guidelines on writing effective skills.

## Output Location

- **Project skills**: `.claude/skills/{name}/SKILL.md`
- **Personal skills**: `~/.claude/skills/{name}/SKILL.md`

## Related Skills

- [create-file-processor-skill](../create-file-processor-skill/SKILL.md) — file-processor technique
- [create-multi-state-skill](../create-multi-state-skill/SKILL.md) — multi-state technique
