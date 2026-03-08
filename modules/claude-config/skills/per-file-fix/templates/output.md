# Per-File Fix Report

**Session**: {session}
**Generated**: {timestamp}
**Instruction**: {instruction}

## Summary

| Metric            | Count          |
| ----------------- | -------------- |
| Files scanned     | {totalScanned} |
| Files with issues | {withIssues}   |
| Files fixed       | {fixed}        |
| Failed fixes      | {failed}       |
| Clean files       | {clean}        |

## Phase 1: Scan Results

### Files with Issues

{for each file with issues}

#### `{file-path}`

{summary of issues found}

---

### Clean Files

{list of files with no issues}

## Phase 2: Fix Results

### Successfully Fixed

{for each fixed file}

- `{file-path}`: {brief description of changes}

### Failed Fixes

{for each failed file}

- `{file-path}`: {reason for failure}

## Reports Location

Individual scan reports: `.per-file-fix/reports/{session}/`

Each report contains:

- Detailed issue analysis
- Recommended changes
- Implementation notes
