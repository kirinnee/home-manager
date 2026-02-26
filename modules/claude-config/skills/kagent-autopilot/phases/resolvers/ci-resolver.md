# Resolver: CI Failures

Handles failing CI checks (tests, build, lint, type check, etc.).

## Context

- Working directory: {WORKDIR}
- PR Number: {prNumber}
- CI Issues: {CI_ISSUES}
- Mode: {MODE} (autopilot/manual)

## Output Format

```json
{
  "resolver_type": "ci",

  "immediate_actions": [],

  "code_fixes": [
    {
      "id": "ci-fix-1",
      "file": "src/auth.ts",
      "line": 42,
      "description": "Add null check before accessing user.name",
      "priority": 1,
      "source": "ci",
      "source_detail": "Test failure: auth.test.ts - 'expected true to be false'"
    }
  ],

  "post_push_actions": []
}
```

**Note:** CI resolver only produces code fixes. No thread actions.

## Step 1: Fetch Full CI Details

For each failing check, get detailed logs:

```bash
gh run view {runId} --log-failed
```

If CI_ISSUES already contain log summaries, you can skip this step.

## Step 2: Classify Failures

| Type          | Indicators                       | Approach                             |
| ------------- | -------------------------------- | ------------------------------------ |
| Test failure  | test, spec, jest, vitest, pytest | Find test file, understand assertion |
| Build failure | build, compile, webpack, esbuild | Fix compilation/syntax errors        |
| Lint failure  | lint, eslint, prettier, biome    | Fix style/convention issues          |
| Type check    | type, tsc, typescript            | Fix type errors                      |
| Security      | security, snyk, dependabot       | Address vulnerability                |

## Step 3: Read Relevant Code

Before proposing fixes, read the relevant source files:

```
Use Read tool to understand:
- The failing test file
- The source code being tested
- The error context
```

## Step 4: Propose Fixes

For each failure, propose a fix with:

| Field           | Description                   |
| --------------- | ----------------------------- |
| `id`            | Unique identifier: `ci-fix-N` |
| `file`          | File to modify                |
| `line`          | Approximate line number       |
| `description`   | What needs to change          |
| `priority`      | Always `1` for CI (highest)   |
| `source`        | `"ci"`                        |
| `source_detail` | Error message or test name    |

## Priority

CI fixes are **priority 1** (highest) because:

- PR cannot merge with failing CI
- Other fixes may depend on CI passing

## Example Analysis

```bash
# Test failure output
FAIL src/auth.test.ts
  ● Authentication > login > should reject invalid credentials

  AssertionError: expected true to be false

  42 |   expect(result.success).toBe(false)
```

Analysis:

1. Read `src/auth.test.ts` line ~42
2. Understand what `result.success` should be
3. Find the bug in `src/auth.ts`
4. Propose fix

## Report Format

```json
{
  "resolver_type": "ci",

  "immediate_actions": [],

  "code_fixes": [
    {
      "id": "ci-fix-1",
      "file": "src/auth.ts",
      "line": 15,
      "description": "Fix validateCredentials to return false for invalid users instead of true",
      "priority": 1,
      "source": "ci",
      "source_detail": "Test 'should reject invalid credentials' expects result.success to be false"
    }
  ],

  "post_push_actions": [],

  "summary": {
    "failures_analyzed": 1,
    "fixes_proposed": 1
  }
}
```

## Important

- **Do NOT fix code directly** - just propose fixes
- CI fixes are always priority 1
- Read relevant code before proposing
- Understand root cause, don't just patch symptoms
