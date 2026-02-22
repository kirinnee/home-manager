#!/usr/bin/env bash
# Poll a GitHub PR for CI checks, reviews, conflicts, and conversation status.
# Exits when a terminal state is reached.
#
# Usage: poll-pr.sh <pr-number> [poll-interval-seconds] [--repo owner/repo]
#
# Exit codes:
#   0 - Ready to merge (CI pass, reviews OK, no conflicts, conversations resolved)
#   1 - At least one CI check failed
#   2 - Reviewer requested changes
#   3 - Usage error or gh CLI not available
#   4 - Merge conflict or branch behind (needs rebase)
#   5 - Unresolved conversations blocking merge
#   6 - PR is closed or merged
#
# Output format:
#   First line is always STATUS:<status>
#   Followed by relevant details (check table, review JSON, thread details)

set -uo pipefail

PR=""
INTERVAL=60
REPO=""

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
  --repo)
    REPO="$2"
    shift 2
    ;;
  *)
    if [ -z "$PR" ]; then
      PR="$1"
    else
      INTERVAL="$1"
    fi
    shift
    ;;
  esac
done

if [ -z "$PR" ]; then
  echo "Usage: poll-pr.sh <pr-number> [poll-interval-seconds] [--repo owner/repo]" >&2
  exit 3
fi

if ! command -v gh &>/dev/null; then
  echo "Error: gh CLI not found" >&2
  exit 3
fi

# Build repo args for gh CLI commands
REPO_ARGS=()
if [ -n "$REPO" ]; then
  REPO_ARGS=(--repo "$REPO")
fi

# Resolve owner/repo for GraphQL
if [ -n "$REPO" ]; then
  GH_OWNER="${REPO%%/*}"
  GH_REPO="${REPO##*/}"
else
  GH_OWNER=$(gh repo view --json owner -q '.owner.login' 2>/dev/null)
  GH_REPO=$(gh repo view --json name -q '.name' 2>/dev/null)
fi

if [ -z "$GH_OWNER" ] || [ -z "$GH_REPO" ]; then
  echo "Error: could not determine repo owner/name" >&2
  exit 3
fi

# GraphQL query (temp file, cleaned up on exit)
QUERY_FILE=$(mktemp)
trap 'rm -f "$QUERY_FILE"' EXIT

cat >"$QUERY_FILE" <<'GRAPHQL'
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      state
      mergeable
      mergeStateStatus
      reviewDecision
      reviewThreads(first: 100) {
        nodes {
          isResolved
          path
          line
          comments(first: 3) {
            nodes {
              author { login }
              body
            }
          }
        }
      }
    }
  }
}
GRAPHQL

while true; do
  # --- 1. CI checks (tabular output for fix spec details) ---
  CHECKS=$(gh pr checks "$PR" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} 2>/dev/null)
  GH_EXIT=$?

  # If gh itself errored (not a failed check), retry
  if [ $GH_EXIT -ne 0 ] && ! echo "$CHECKS" | grep -qiE 'pass|fail|pending|running|queued'; then
    sleep "$INTERVAL"
    continue
  fi

  # --- 2. PR status via single GraphQL call (merge state + reviews + threads) ---
  FIELDS=$(gh api graphql -F query=@"$QUERY_FILE" \
    -f owner="$GH_OWNER" -f repo="$GH_REPO" -F pr="$PR" \
    -q '.data.repository.pullRequest |
      "PR_STATE=\(.state)",
      "REVIEW=\(.reviewDecision // "null")",
      "MERGEABLE=\(.mergeable // "UNKNOWN")",
      "MERGE_STATE=\(.mergeStateStatus // "UNKNOWN")",
      "UNRESOLVED_COUNT=\([.reviewThreads.nodes[] | select(.isResolved == false)] | length)"
    ' 2>/dev/null)

  if [ -z "$FIELDS" ]; then
    sleep "$INTERVAL"
    continue
  fi

  # Parse the KEY=VALUE lines
  eval "$FIELDS"

  # --- PR closed or merged? Exit immediately. ---
  if [ "$PR_STATE" = "CLOSED" ]; then
    echo "STATUS:closed"
    echo "PR is closed."
    exit 6
  fi
  if [ "$PR_STATE" = "MERGED" ]; then
    echo "STATUS:merged"
    echo "PR is already merged."
    exit 6
  fi

  # --- Still pending? Wait. ---
  if echo "$CHECKS" | grep -qiE 'pending|running|queued|in_progress'; then
    sleep "$INTERVAL"
    continue
  fi

  # Wait if mergeable state is still being computed
  if [ "$MERGEABLE" = "UNKNOWN" ]; then
    sleep "$INTERVAL"
    continue
  fi

  # --- Evaluate terminal states (priority order) ---
  # Merge/branch issues first — CI failures on a stale branch are noise.

  # Merge conflict?
  if [ "$MERGEABLE" = "CONFLICTING" ]; then
    echo "STATUS:merge_conflict"
    echo "MERGEABLE:CONFLICTING"
    echo "MERGE_STATE:$MERGE_STATE"
    exit 4
  fi

  # Branch behind base?
  if [ "$MERGE_STATE" = "BEHIND" ]; then
    echo "STATUS:behind"
    echo "MERGE_STATE:BEHIND"
    echo "Branch is behind the base branch and needs rebase or update."
    exit 4
  fi

  # CI failed?
  if echo "$CHECKS" | grep -qi 'fail'; then
    echo "STATUS:ci_failed"
    echo "$CHECKS"
    exit 1
  fi

  # Changes requested?
  if [ "$REVIEW" = "CHANGES_REQUESTED" ]; then
    echo "STATUS:changes_requested"
    gh pr view "$PR" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --json reviews 2>/dev/null || true
    exit 2
  fi

  # Unresolved conversations blocking merge?
  if [ "$MERGE_STATE" = "BLOCKED" ] && [ "${UNRESOLVED_COUNT:-0}" -gt 0 ] 2>/dev/null; then
    echo "STATUS:conversations_blocking"
    echo "UNRESOLVED_THREADS:$UNRESOLVED_COUNT"
    # Fetch thread details (separate call for clean -q output)
    gh api graphql -F query=@"$QUERY_FILE" \
      -f owner="$GH_OWNER" -f repo="$GH_REPO" -F pr="$PR" \
      -q '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) |
           {path, line, author: .comments.nodes[0].author.login,
            body: (.comments.nodes[0].body | if length > 200 then .[:200] + "..." else . end)}]
      ' 2>/dev/null || true
    exit 5
  fi

  # All clear — ready to merge
  if [ "$MERGE_STATE" = "CLEAN" ] || [ "$MERGE_STATE" = "HAS_HOOKS" ] || [ "$MERGE_STATE" = "UNSTABLE" ]; then
    echo "STATUS:all_pass"
    echo "$CHECKS"
    echo "MERGE_STATE:$MERGE_STATE"
    [ "${UNRESOLVED_COUNT:-0}" -gt 0 ] && echo "UNRESOLVED_THREADS:$UNRESOLVED_COUNT (non-blocking)"
    exit 0
  fi

  # BLOCKED for unknown reason (required approvals not met, other branch protection)
  if [ "$MERGE_STATE" = "BLOCKED" ]; then
    echo "STATUS:blocked"
    echo "MERGE_STATE:BLOCKED"
    echo "REVIEW_DECISION:${REVIEW}"
    echo "UNRESOLVED_THREADS:${UNRESOLVED_COUNT:-0}"
    echo "$CHECKS"
    exit 5
  fi

  sleep "$INTERVAL"
done
