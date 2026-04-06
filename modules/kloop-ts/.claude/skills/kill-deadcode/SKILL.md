---
name: kill-deadcode
description: 'Find and remove dead code using Knip (expansive) + TS Language Server verification. Use when running /kill-deadcode, removing unused exports/types, or cleaning up dead code.'
argument-hint: '[--auto-remove] [--include-extra]'
---

# Kill Dead Code

Find dead code with Knip in expansive mode, verify each finding with grep and TS Language Server, then remove confirmed dead code.

## When to Use

- Running `/kill-deadcode`
- Removing unused exports, types, enum members, or class members
- Cleaning up dead code

## Prerequisites

The project must have (already configured in kloop-ts):

- `knip` installed (dependency)
- `typescript-language-server` installed (dependency)
- `typescript` installed (devDependency)
- `knip.json` configured at project root
- `tsconfig.json` at project root

## Process

> **`<skill-dir>`** = the directory containing this SKILL.md. Resolve once at start and reuse.
> **`<project-root>`** = current working directory (must contain `package.json`).

### Step 1: Run Knip

```bash
bunx knip --reporter json
```

The `knip.json` already configures expansive mode (`includeEntryExports: true`, `ignoreExportsUsedInFile: false`).

Parse the JSON output. The structure is:

```json
{
  "issues": [
    {
      "file": "src/types.ts",
      "exports": [{ "name": "foo", "line": 10, "col": 5 }],
      "types": [{ "name": "Bar", "line": 20, "col": 3 }],
      "nsExports": [...], "nsTypes": [...],
      "enumMembers": [...], "namespaceMembers": [...],
      "duplicates": [...],
      "files": [{ "name": "..." }],
      "dependencies": [{ "name": "..." }]
    }
  ]
}
```

Each issue has a `file` and arrays of symbols per category. Categories with `line`/`col` are **verifiable** (exports, types, nsExports, nsTypes, enumMembers, namespaceMembers). Categories without positions (files, dependencies, devDependencies, binaries) are **not verifiable** via LSP.

### Step 2: Verify Each Finding

For each verifiable finding (has line + col):

**2a. Quick grep check** — Search for the symbol name across the codebase:

```
Grep: pattern="<symbol-name>", path="<project-root>/src", output_mode="content"
```

If the symbol appears to be clearly used in production code (not just its declaration, not only in test files), mark as **false positive** and skip. Usage only in `*.test.ts` or `__tests__/` does NOT count as "used".

**2b. LSP reference check** — For ambiguous cases or when grep is inconclusive (re-exports, barrel files, namespace imports):

```bash
node <skill-dir>/scripts/tsp-refs.mjs <file> <line> <col>
```

This outputs JSON:

```json
{ "references": N, "locations": [{ "file": "...", "line": N }] }
```

- `references <= 1` → confirmed dead (only the declaration itself)
- `references > 1` → check if ALL references are in test files (e.g. `*.test.ts`, `__tests__/`). If yes, still count as **dead** — usage only in tests doesn't count. If any reference is in production code (`src/`), mark as **false positive**.

**Note:** This spawns a new LSP process per call. For large batches, prefer grep first and only use LSP for ambiguous cases.

**2c. Read for context** — For anything still unclear, Read the file around the finding to understand the code structure before deciding.

### Step 3: Present Findings

Show a summary table:

```
| Category       | Count |
|----------------|-------|
| Confirmed dead | N     |
| False positives| N     |
| Not verifiable | N     |
```

List each confirmed dead item:

```
src/types.ts:42  export function unusedHelper()
src/state.ts:15  type UnusedConfig
```

If `--auto-remove` was NOT passed, ASK the user for confirmation before proceeding.

### Step 4: Remove Dead Code

For each confirmed dead item, use the Edit tool:

- **Unused export function/variable**: Remove the entire declaration. Check if removing it makes its imports dead too.
- **Unused type/interface**: Remove the entire type declaration.
- **Unused enum member**: Remove just the member from the enum.
- **Unused class member**: Remove the property or method.
- **Unused `export` keyword only** (symbol is used locally): Just remove the `export` keyword.

After each removal, check if any imports of the removed symbol became unused — if so, remove those imports too.

### Step 5: Re-verify

After all removals:

```bash
bunx knip --reporter json
```

If new cascade findings appear, repeat Steps 2-4. Cascade removals are common — removing an export may reveal its import is now dead.

### Step 6: Summary

Show final diff summary:

```
Removed N dead code items across M files:
- src/types.ts: removed 3 unused types
- src/deps.ts: removed 1 unused export
- src/cli.ts: removed 2 unused functions
```

## Important Rules

- NEVER remove items from the "not verifiable" section (unused files, unused dependencies) without explicit user approval.
- Always check for cascade effects after removals.
- If the LSP helper fails (exit code 1), fall back to grep-only verification — do NOT assume dead.
- The `tsp-refs.mjs` script is at `<skill-dir>/scripts/tsp-refs.mjs`.
- Run `bunx knip` (not plain `knip`) to ensure the correct binary is used.
