# Best Practices for Creating Claude Code Skills

## Naming Conventions

### Skill Names

- Use lowercase letters, numbers, and hyphens only
- Maximum 64 characters
- Be descriptive but concise
- Examples: `create-runbook`, `deploy-k8s-app`, `review-terraform`

### File Names

- Use lowercase with hyphens
- Supporting files should be descriptive: `reference.md`, `examples.md`
- Templates should indicate purpose: `alert-template.yaml`, `runbook-template.md`

## Writing Effective Descriptions

The `description` field is **critical** for skill discovery. Claude reads descriptions to decide when to activate a skill.

### Include Both What AND When

**Good:**

```yaml
description: Create Prometheus alerts and runbooks for observability. Use when setting up monitoring, creating alerts, or writing incident runbooks.
```

**Bad:**

```yaml
description: Helps with alerts and runbooks
```

### Use Specific Trigger Words

Include words users would actually say:

- "create", "make", "generate", "build"
- Domain-specific terms: "runbook", "alert", "terraform", "kubernetes"
- File types: "PDF", "YAML", "markdown"

## Structuring Skills

### Keep Skills Focused

One skill = one capability. Split broad skills into focused ones:

**Instead of:** `document-processing`
**Use:**

- `pdf-form-fill`
- `pdf-extract-text`
- `excel-data-analysis`

### Progressive Disclosure

Put essential info in SKILL.md, details in supporting files:

```
create-runbook/
├── SKILL.md           # Quick overview + steps
├── reference.md       # Detailed formats, specifications
├── examples.md        # Complete examples
└── templates/
    ├── alert.yaml     # Alert template
    └── runbook.md     # Runbook template
```

Claude loads supporting files only when needed, saving context.

### Use Relative Links

Reference supporting files with relative paths:

```markdown
See [reference.md](reference.md) for details.
Use the template at [templates/alert.yaml](templates/alert.yaml).
```

## Tool Restrictions

Use `allowed-tools` for:

### Read-Only Skills

```yaml
allowed-tools: Read, Grep, Glob
```

### File Creation Skills

```yaml
allowed-tools: Read, Write, Edit, Glob
```

### Full Access (default)

Omit `allowed-tools` to allow all tools.

## Templates

### Make Templates Complete

Templates should be copy-paste ready with placeholders:

```yaml
# Alert: {AlertName}
# Runbook: ../../runbooks/{AlertName}.md
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: { kebab-case-name }
```

### Use Consistent Placeholder Style

```
{placeholder}           # Simple replacement
{placeholder_name}      # With underscore
{{`{{ go_template }}`}} # Escaped Go templates
```

## Documentation

### SKILL.md Structure

1. Front matter (name, description)
2. Brief overview
3. When to use (triggers)
4. Prerequisites
5. Step-by-step instructions
6. Links to supporting files

### Reference Files

Include in reference.md:

- Detailed specifications
- Format documentation
- Field descriptions
- Validation rules

### Examples

Include in examples.md:

- Complete, working examples
- Multiple scenarios
- Expected outputs

## Testing Skills

1. **Trigger Test**: Ask Claude something matching your description
2. **Step Test**: Walk through each step manually
3. **Output Test**: Verify generated files are correct
4. **Edge Case Test**: Try unusual inputs

## Version Control

### Track Changes

```markdown
## Version History

- v1.0.0 (2025-01-15): Initial release
- v1.1.0 (2025-02-01): Added template support
- v2.0.0 (2025-03-01): Breaking change to format
```

### Git Best Practices

```bash
# Commit skill as a unit
git add .claude/skills/my-skill/
git commit -m "feat: add my-skill for X"
```

## Common Mistakes

| Mistake               | Fix                          |
| --------------------- | ---------------------------- |
| Vague description     | Include what + when triggers |
| Missing prerequisites | List required tools/access   |
| No examples           | Add examples.md              |
| Hardcoded paths       | Use relative paths           |
| No verification step  | Add "how to verify" section  |
