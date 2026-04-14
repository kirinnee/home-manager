# Polish Step: Create PR — Team Agent (Sonnet)

## Agent Context

- Working directory: {WORKDIR}
- Task ID: {ticketId}
- PR Number: {prNumber} (null if first push)
- Repo Config: {repoConfig}

## Agent Report Format

```
RESULT: <created|updated|exists|error>
PR_NUMBER: <number>
PR_URL: <url>
REVIEW_COMMENT_POSTED: <true|false>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Step 1: Check for Existing PR

```bash
gh pr list --head "$(git branch --show-current)" --json number,url -q '.[0]'
```

- If PR exists: report `RESULT: exists` with PR number and URL
- If no PR: create one

## Step 2: Create PR

Create using the PR template (`templates/pr-template.md`):

```bash
gh pr create --title "[{ticketId}] {Title}" --base {repoConfig.baseBranch} --body "$(cat <<'EOF'
{PR body from template}
EOF
)"
```

Include `{ticketId}` prefix in the title when available. If null, use a descriptive title without prefix.

## Step 3: Post Initial Review Comment

If this is a **new PR** and `repoConfig.reviewComment` is not null:

```bash
gh pr comment {prNumber} --body "$(cat <<'EOF'
{repoConfig.reviewComment}
EOF
)"
```

If `repoConfig.reviewComment` is null: skip.

## Important

- **NEVER merge the PR** — no `gh pr merge`, no merging in any way
- Do NOT push (push step handles that)
- Do NOT update state files — all state files live in `.kagent/`
- Use PR template for body
- Include ticket ID in PR title when available
