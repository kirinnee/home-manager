# Fact Check Example Output

This shows what a completed fact-check report looks like.

---

# Fact Check Report

> Generated: 2026-03-01
> Docs: `content/docs/` (3 files)
> Sources: `src/`, `../api/src/`
> Agents: 3 concurrent

## Overall Summary

| Category                    | Total Issues |
| --------------------------- | ------------ |
| 🔴 Source Code Inaccuracies | 3            |
| 🟡 Documentation Issues     | 2            |
| 🟠 Other Problems           | 1            |

## Files Checked

| File               | 🔴  | 🟡  | 🟠  | Total |
| ------------------ | --- | --- | --- | ----- |
| getting-started.md | 1   | 1   | 0   | 2     |
| api-reference.md   | 2   | 0   | 1   | 3     |
| configuration.md   | 0   | 1   | 0   | 1     |

---

## 📄 File: `content/docs/getting-started.md`

> Contains one source inaccuracy and one broken link.

### 🔴 Source Code Inaccuracies

#### 1. Incorrect Default Port

| Aspect         | Details                                   |
| -------------- | ----------------------------------------- |
| **Documented** | "The server runs on port 3000 by default" |
| **Actual**     | Default port is 8080 (changed in v2.0)    |
| **Evidence**   | `[main@src/server/config.ts:15]`          |

### 🟡 Documentation Issues

#### 1. Broken Link to Examples

| Aspect       | Details                                |
| ------------ | -------------------------------------- |
| **Problem**  | Link to `/examples/quickstart` 404s    |
| **Location** | Line 42                                |
| **Fix**      | Update to `/docs/tutorials/quickstart` |

---

## 📄 File: `content/docs/api-reference.md`

> Multiple inaccuracies in API endpoint documentation.

### 🔴 Source Code Inaccuracies

#### 1. Missing Required Header

| Aspect         | Details                                     |
| -------------- | ------------------------------------------- |
| **Documented** | "POST /users accepts optional X-Request-ID" |
| **Actual**     | X-Request-ID is required, not optional      |
| **Evidence**   | `[api@src/routes/users.ts:45]`              |

#### 2. Incorrect Response Type

| Aspect         | Details                                          |
| -------------- | ------------------------------------------------ |
| **Documented** | "Returns User object with `id`, `name`, `email`" |
| **Actual**     | Also returns `createdAt` and `updatedAt` fields  |
| **Evidence**   | `[api@src/types/user.ts:12-18]`                  |

### 🟠 Other Problems

#### 1. Empty Authentication Section

| Aspect             | Details                                |
| ------------------ | -------------------------------------- |
| **Problem**        | "Authentication" header has no content |
| **Recommendation** | Add auth flow documentation or remove  |

---

## 📄 File: `content/docs/configuration.md`

> Minor link issue only.

### 🟡 Documentation Issues

#### 1. Outdated Configuration Reference

| Aspect       | Details                                     |
| ------------ | ------------------------------------------- |
| **Problem**  | Links to v1 config schema, now on v3        |
| **Location** | "See schema" link in Config Options section |
| **Fix**      | Update URL to `schemas/config.v3.json`      |

---

## Recommendations

1. **High Priority**: Fix the port default documentation - users may be confused
2. **High Priority**: Update API docs to reflect required headers
3. **Medium Priority**: Fix broken links across all docs
4. **Low Priority**: Fill in or remove empty authentication section
