---
name: create-skill
description: Create a new agent skill in the open SKILL.md standard (works with Claude Code AND Codex). Use when asked to create a skill, make a skill, or build a reusable agent workflow/automation. Generates a SKILL.md plus optional supporting files.
argument-hint: '[skill name or what it should do]'
---

# Create an agent skill (open SKILL.md standard)

Generates a portable **SKILL.md** skill — the open "Agent Skills" standard read by
Claude Code, Codex CLI, Cursor, Gemini, etc. Keep new skills to the portable core
so they run on any harness; only add a harness's extra frontmatter when you truly
need it (and know that harness will be the one running it).

## When to Use

- User asks to "create a skill" / "make a skill"
- User wants to capture a repeatable workflow for an agent to follow
- User needs domain knowledge or a procedure available on demand

## Skill structure

A skill is a directory containing a `SKILL.md` plus optional supporting files:

```
<skill-name>/
├── SKILL.md          # required — frontmatter + instructions
├── reference.md      # optional — detailed docs loaded on demand
├── examples.md       # optional — concrete examples
├── templates/        # optional — reusable templates
└── scripts/          # optional — helper scripts (chmod +x)
```

## The portable frontmatter (this is what makes it codex-compatible)

**Only `name` + `description` are required, and they're all every harness needs.**
Keep the frontmatter to these two for maximum portability:

```markdown
---
name: { skill-name } # lowercase, hyphens, ≤64 chars
description: { what it does }. Use when { explicit trigger conditions }. # ≤1024 chars; front-load trigger words
---

# { Skill Title }

{ One-line overview. }

## When to Use

- { trigger 1 }
- { trigger 2 }

## Instructions

### Step 1: { ... }

{ detailed steps }
```

**Harness-specific extras (add only when needed — other harnesses ignore them):**

- `argument-hint:` — Claude Code slash-command arg hint (Claude-only; codex ignores it).
- `allowed-tools:` — Claude Code tool restriction (Claude-only).
- `metadata: { short-description: ... }` — Codex app UI label (codex idiom).

Don't make a skill depend on harness-only capabilities (e.g. Claude's `Agent`/`Task`
subagent fan-out, `Skill` tool, or slash-commands; Claude-only wrappers like
`yolo-*`/`crc`) if you want it to run under codex too. If a skill is inherently
single-harness, say so in the first line of the body.

## Instructions

### Step 1: Gather

Ask for (or infer from the request): the **name**, a **description with explicit
triggers** (what it does + exactly when to use it), the **steps**, and any
**supporting files** (templates / scripts / reference).

### Step 2: Create the directory + SKILL.md

```bash
mkdir -p <skill-name>
```

Write `SKILL.md` using the portable frontmatter above (name + description + body).
See [SKILL-TEMPLATE.md](SKILL-TEMPLATE.md) for a fill-in template.

### Step 3: Supporting files (optional)

`reference.md` (deep docs), `examples.md`, `templates/`, `scripts/` (make them
executable). Reference them from the body so they're loaded on demand.

### Step 4: Verify

1. YAML frontmatter is valid and has `name` + `description`.
2. The description front-loads the trigger words (this is what discovery matches on).
3. The skill doesn't silently rely on harness-only features if it's meant to be portable.

## Where skills live

The kfleet fleet's shared skill sources live in this repo under `kfleet/skills/`
and `kfleet/skills-codex/`. Home Manager links them into `~/.kfleet/skills/`
and `~/.kfleet/skills-codex/`, where `kfleet apply` deploys them to claude
(`~/.claude-<name>/skills/`) and codex (`~/.codex-<name>/skills/`).
Per-project skills can also live in `.claude/skills/` (Claude) or
`.agents/skills/` (Codex). `modules/agent-config/skills/` is deprecated legacy
seed material.

## Best practices

See [best-practices.md](best-practices.md). Core rule: be concise — the context
window is shared; front-load triggers in the description and push detail into
on-demand `reference.md`.
