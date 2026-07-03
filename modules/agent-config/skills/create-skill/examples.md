# Examples of Creating Skills

## Example 1: Simple Single-File Skill

A minimal skill with just SKILL.md:

### Directory Structure

```
.claude/skills/git-commit-helper/
└── SKILL.md
```

### SKILL.md

````markdown
---
name: git-commit-helper
description: Generate conventional commit messages. Use when committing code, writing commit messages, or asking for commit help.
---

# Git Commit Helper

Generate well-formatted conventional commit messages.

## When to Use

- User asks to commit changes
- User wants help with commit message
- User mentions "conventional commits"

## Instructions

### Step 1: Analyze Changes

```bash
git diff --staged
```
````

### Step 2: Generate Message

Format: `type(scope): description`

Types:

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `refactor`: Code refactoring
- `test`: Adding tests

### Step 3: Commit

```bash
git commit -m "type(scope): description"
```

```

---

## Example 2: Multi-File Skill with Templates

A more complex skill with supporting files:

### Directory Structure
```

.claude/skills/create-k8s-deployment/
├── SKILL.md
├── reference.md
├── examples.md
└── templates/
├── deployment.yaml
└── service.yaml

````

### SKILL.md
```markdown
---
name: create-k8s-deployment
description: Create Kubernetes deployments with services. Use when deploying apps to k8s, creating deployments, or setting up services.
---

# Create Kubernetes Deployment

Generate Kubernetes deployment and service manifests.

## When to Use

- User wants to deploy an application to Kubernetes
- User asks for deployment YAML
- User needs a service manifest

## Instructions

### Step 1: Gather Information

Ask for:
- Application name
- Container image
- Port number
- Replica count
- Namespace

### Step 2: Generate Deployment

Use template at [templates/deployment.yaml](templates/deployment.yaml)

### Step 3: Generate Service

Use template at [templates/service.yaml](templates/service.yaml)

## Reference

See [reference.md](reference.md) for field specifications.
````

### templates/deployment.yaml

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: { app-name }
  namespace: { namespace }
spec:
  replicas: { replica-count }
  selector:
    matchLabels:
      app: { app-name }
  template:
    metadata:
      labels:
        app: { app-name }
    spec:
      containers:
        - name: { app-name }
          image: { image }
          ports:
            - containerPort: { port }
```

### templates/service.yaml

```yaml
apiVersion: v1
kind: Service
metadata:
  name: { app-name }
  namespace: { namespace }
spec:
  selector:
    app: { app-name }
  ports:
    - port: { port }
      targetPort: { port }
```

---

## Example 3: Read-Only Skill with Tool Restrictions

A skill that only reads files:

### SKILL.md

````markdown
---
name: code-analyzer
description: Analyze code structure and patterns. Use when reviewing code, understanding codebase, or finding patterns.
allowed-tools: Read, Grep, Glob
---

# Code Analyzer

Analyze code without making changes.

## When to Use

- User wants to understand code structure
- User asks "how does X work"
- User wants to find patterns

## Instructions

### Step 1: Find Relevant Files

```bash
# This skill cannot use Bash, use Glob instead
```
````

Use Glob to find files matching patterns.

### Step 2: Read and Analyze

Use Read to examine file contents.

### Step 3: Report Findings

Summarize:

- File structure
- Key patterns
- Dependencies

````

---

## Example 4: Skill with Scripts

A skill that includes helper scripts:

### Directory Structure
```text

.claude/skills/data-processor/
├── SKILL.md
└── scripts/
    ├── validate.ts
    └── transform.ts

````

### SKILL.md

````markdown
---
name: data-processor
description: Process and transform data files. Use when transforming CSV, JSON, or processing data.
---

# Data Processor

Transform and validate data files.

## Prerequisites

- Bun

## Instructions

### Step 1: Validate Data

```bash
bun .claude/skills/data-processor/scripts/validate.ts input.csv
```

### Step 2: Transform Data

```bash
bun .claude/skills/data-processor/scripts/transform.ts input.csv output.csv
```
````

### scripts/validate.ts

```typescript
#!/usr/bin/env bun

const file = Bun.argv[2];
if (!file) throw new Error('usage: bun validate.ts <input.csv>');

const text = await Bun.file(file).text();
const rows = text.trim().split(/\r?\n/);
if (rows.length < 2) throw new Error('expected a header row and at least one data row');

console.log(`Validated ${rows.length - 1} rows`);
```

### scripts/transform.ts

```typescript
#!/usr/bin/env bun

const [input, output] = Bun.argv.slice(2);
if (!input || !output) throw new Error('usage: bun transform.ts <input.csv> <output.csv>');

const text = await Bun.file(input).text();
await Bun.write(output, text.trim().toUpperCase() + '\n');
console.log(`Wrote ${output}`);
```

**Note:** Ensure scripts have execute permissions:

```bash
chmod +x .claude/skills/data-processor/scripts/*.ts
```
