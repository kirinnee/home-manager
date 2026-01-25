#!/usr/bin/env bash
set -euo pipefail

LOOP_DIR=".claude/dev-loop"
LOOP_STATE="$LOOP_DIR/loop-state.json"
SPEC_FILE="$LOOP_DIR/spec.md"
REVIEW_DIR="$LOOP_DIR/reviews"
SESSIONS_FILE="$LOOP_DIR/sessions.json"
VERDICTS_DIR="$LOOP_DIR/verdicts"
REVIEWER_STATUS="$LOOP_DIR/reviewer-status.txt"

# Get project hash (/ and . replaced with -)
get_project_hash() {
  pwd | tr '/.' '-'
}

PROJECT_HASH=$(get_project_hash)

if [[ ! -f $LOOP_STATE ]]; then
  echo "ℹ️ No dev-loop found."
  exit 0
fi

status=$(jq -r '.status' "$LOOP_STATE")
phase=$(jq -r '.phase // "unknown"' "$LOOP_STATE")
loop=$(jq -r '.loop' "$LOOP_STATE")
max_loops=$(jq -r '.max_loops' "$LOOP_STATE")
reviewers=$(jq -r '.reviewers | join(", ")' "$LOOP_STATE")

echo "📊 Dev Loop Status"
echo ""
echo "🔄 Status: $status"
echo "📍 Phase: $phase"
echo "🔢 Iteration: $loop / $max_loops"
echo "👥 Reviewers: $reviewers"
echo ""

# Show reviewer states if in review phase
if [[ -f $REVIEWER_STATUS ]]; then
  echo "📋 Reviewer Progress:"
  while IFS= read -r line; do
    name=$(echo "$line" | cut -d: -f1)
    state=$(echo "$line" | cut -d: -f2 | tr -d ' ')
    case $state in
    reviewing) echo "  🔄 $name: reviewing..." ;;
    approved) echo "  ✅ $name: approved" ;;
    rejected) echo "  ❌ $name: rejected" ;;
    not_found) echo "  ⚠️ $name: binary not found" ;;
    no_verdict) echo "  ⚠️ $name: no verdict file" ;;
    invalid) echo "  ⚠️ $name: invalid verdict" ;;
    *) echo "  ❓ $name: $state" ;;
    esac
  done <"$REVIEWER_STATUS"
  echo ""
fi

# Show verdicts from individual files
if [[ -d $VERDICTS_DIR ]]; then
  approved=0
  rejected=0
  for f in "$VERDICTS_DIR"/*.txt; do
    [[ -f $f ]] || continue
    verdict=$(cat "$f" | tr -d '[:space:]')
    [[ $verdict == "APPROVED" ]] && ((approved++)) || true
    [[ $verdict == "REJECTED" ]] && ((rejected++)) || true
  done
  if [[ $approved -gt 0 || $rejected -gt 0 ]]; then
    echo "📊 Verdicts: $approved approved, $rejected rejected"
    echo ""
  fi
fi

# Show review files
if [[ -d $REVIEW_DIR ]] && ls "$REVIEW_DIR"/*.md &>/dev/null; then
  echo "📁 Review files:"
  for f in "$REVIEW_DIR"/*.md; do
    echo "  - $(basename "$f")"
  done
  echo ""
fi

# Show sessions for current iteration
if [[ -f $SESSIONS_FILE ]] && [[ $loop -gt 0 ]]; then
  echo "📜 Sessions (Iteration $loop):"
  jq -c ".[] | select(.iteration == $loop)" "$SESSIONS_FILE" 2>/dev/null | while IFS= read -r entry; do
    role=$(echo "$entry" | jq -r '.role')
    name=$(echo "$entry" | jq -r '.name')
    session_id=$(echo "$entry" | jq -r '.session_id')
    config_dir=$(echo "$entry" | jq -r '.config_dir')
    session_file="$config_dir/projects/$PROJECT_HASH/$session_id.jsonl"

    emoji="📄"
    [[ $role == "implementer" ]] && emoji="🔨"
    [[ $role == "reviewer" ]] && emoji="🔍"

    if [[ -f $session_file ]]; then
      echo "  $emoji $name: $session_id"
    else
      echo "  $emoji $name: $session_id (pending)"
    fi
  done
  echo ""
fi

echo "📄 Files:"
echo "  Spec: $SPEC_FILE"
echo "  State: $LOOP_STATE"
echo "  Reviews: $REVIEW_DIR/"
echo "  Verdicts: $VERDICTS_DIR/"
echo "  Sessions: $SESSIONS_FILE"
echo ""
echo "💡 Use 'dev-loop logs' to view session history"
