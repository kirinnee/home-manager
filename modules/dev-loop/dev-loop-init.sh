#!/usr/bin/env bash
set -euo pipefail

# Dev Loop - Initialize
# Creates spec template and loop state

LOOP_DIR=".claude/dev-loop"
LOOP_STATE="$LOOP_DIR/loop-state.json"
SPEC_FILE="$LOOP_DIR/spec.md"

# Defaults
max_loops=10
reviewers="${DEV_LOOP_REVIEWERS:-claude-reviewer}"
claude_cmd="${DEV_LOOP_CLAUDE:-claude}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
  --max-loops)
    max_loops="$2"
    shift 2
    ;;
  --reviewers)
    reviewers="$2"
    shift 2
    ;;
  --claude)
    claude_cmd="$2"
    shift 2
    ;;
  *)
    shift
    ;;
  esac
done

# Check if already running
if [[ -f $LOOP_STATE ]]; then
  status=$(jq -r '.status' "$LOOP_STATE" 2>/dev/null || echo "")
  if [[ $status == "running" ]]; then
    echo "❌ Dev loop already running. Use: dev-loop cancel" >&2
    exit 1
  fi
fi

# Create directory
mkdir -p "$LOOP_DIR"

# Create spec template
if [[ ! -f $SPEC_FILE ]]; then
  cat >"$SPEC_FILE" <<'EOF'
# Specification: [Title]

## Objective

[Clear, concise description of what to build]

## Acceptance Criteria

- [ ] Criterion 1 (specific, measurable)
- [ ] Criterion 2
- [ ] Criterion 3

## Definition of Done

- [ ] All acceptance criteria met
- [ ] Tests pass (if applicable)
- [ ] No lint/type errors (if applicable)

## Out of Scope

- [What this task does NOT include]

## Technical Constraints

- [Any specific requirements or limitations]
EOF
  echo "📝 Created spec template: $SPEC_FILE"
fi

# Convert reviewers to JSON array
reviewers_json=$(echo "$reviewers" | tr ',' '\n' | jq -R . | jq -s .)

# Create loop state
cat >"$LOOP_STATE" <<EOF
{
  "loop": 0,
  "max_loops": $max_loops,
  "status": "pending_approval",
  "phase": "init",
  "claude": "$claude_cmd",
  "reviewers": $reviewers_json
}
EOF

echo "✅ Dev Loop Initialized"
echo "📄 Spec: $SPEC_FILE"
echo "🔢 Max loops: $max_loops"
echo "👥 Reviewers: $reviewers"
echo "🤖 Claude: $claude_cmd"
echo "👉 Next: edit spec, then run: dev-loop run"
