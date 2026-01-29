#!/usr/bin/env bash
set -euo pipefail

LOOP_DIR=".claude/dev-loop"
LOOP_STATE="$LOOP_DIR/loop-state.json"
SPEC_FILE="$LOOP_DIR/spec.md"
REVIEW_DIR="$LOOP_DIR/reviews"
LEARNINGS_FILE="$LOOP_DIR/learnings.md"
SESSIONS_FILE="$LOOP_DIR/sessions.json"
VERDICTS_DIR="$LOOP_DIR/verdicts"
REVIEWER_STATUS="$LOOP_DIR/reviewer-status.txt"
TIMEOUT_MINS="${DEV_LOOP_TIMEOUT_MINS:-20}"

[[ -f $LOOP_STATE ]] || {
  echo "❌ No dev-loop. Run: dev-loop init" >&2
  exit 1
}

status=$(jq -r '.status // ""' "$LOOP_STATE")
[[ $status == "pending_approval" ]] && jq '.status = "running" | .phase = "starting"' "$LOOP_STATE" >"$LOOP_STATE.tmp" && mv "$LOOP_STATE.tmp" "$LOOP_STATE"
[[ $status == "pending_approval" || $status == "running" ]] || {
  echo "❌ Invalid status: $status" >&2
  exit 1
}

loop_num=$(jq -r '.loop // 0' "$LOOP_STATE")
max_loops=$(jq -r '.max_loops // 40' "$LOOP_STATE")
CLAUDE_CMD=$(jq -r '.claude // "claude"' "$LOOP_STATE")
mapfile -t reviewers < <(jq -r '.reviewers[]' "$LOOP_STATE" 2>/dev/null)
[[ ${#reviewers[@]} -eq 0 ]] && reviewers=("claude-reviewer")

mkdir -p "$REVIEW_DIR" "$VERDICTS_DIR"
[[ -f $SESSIONS_FILE ]] || echo '[]' >"$SESSIONS_FILE"

echo "🔄 DEV LOOP: ${#reviewers[@]} reviewers (parallel), max $max_loops loops, ${TIMEOUT_MINS}m timeout"

# Get config dir from claude binary name
# claude -> ~/.claude, claude-foo -> ~/.claude-foo
get_config_dir() {
  local binary="$1"
  local name
  name=$(basename "$binary")
  if [[ $name == "claude" ]]; then
    echo "$HOME/.claude"
  else
    echo "$HOME/.${name}"
  fi
}

# Get project hash (/ and . replaced with -)
get_project_hash() {
  pwd | tr '/.' '-'
}

PROJECT_HASH=$(get_project_hash)

update_phase() {
  jq --arg phase "$1" '.phase = $phase' "$LOOP_STATE" >"$LOOP_STATE.tmp" && mv "$LOOP_STATE.tmp" "$LOOP_STATE"
}

# Find actual session ID after claude runs (handles --session-id not working)
find_actual_session() {
  local config_dir="$1"
  local expected_id="$2"
  local project_dir="$config_dir/projects/$PROJECT_HASH"

  # First check if the expected session file exists (--session-id worked)
  if [[ -f "$project_dir/$expected_id.jsonl" ]]; then
    echo "$expected_id"
    return
  fi

  # Otherwise, find the most recently modified session file
  local latest
  latest=$(find "$project_dir" -maxdepth 1 -name "*.jsonl" -type f -printf '%T@ %f\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2 | sed 's/.jsonl$//')

  # macOS doesn't support -printf, try alternative
  if [[ -z $latest ]]; then
    # shellcheck disable=SC2012
    latest=$(ls -t "$project_dir"/*.jsonl 2>/dev/null | head -1 | xargs basename 2>/dev/null | sed 's/.jsonl$//')
  fi

  echo "${latest:-$expected_id}"
}

# Record multiple sessions at once (avoids race condition)
record_sessions_batch() {
  local json_additions="$1"
  jq --argjson additions "$json_additions" '. += $additions' "$SESSIONS_FILE" >"$SESSIONS_FILE.tmp" && mv "$SESSIONS_FILE.tmp" "$SESSIONS_FILE"
}

# Update session ID in sessions.json (when actual differs from expected)
update_session_id() {
  local iter="$1"
  local role="$2"
  local name="$3"
  local new_session_id="$4"

  jq --argjson iter "$iter" --arg role "$role" --arg name "$name" --arg new_id "$new_session_id" \
    '(.[] | select(.iteration == $iter and .role == $role and .name == $name)) .session_id = $new_id' \
    "$SESSIONS_FILE" >"$SESSIONS_FILE.tmp" && mv "$SESSIONS_FILE.tmp" "$SESSIONS_FILE"
}

# Save learnings to loop state
save_learnings() {
  local iter="$1"
  if [[ -f $LEARNINGS_FILE ]]; then
    local learning
    learning=$(cat "$LEARNINGS_FILE")
    jq --arg iter "$iter" --arg learning "$learning" \
      '.learnings += [{"iteration": ($iter | tonumber), "content": $learning}]' \
      "$LOOP_STATE" >"$LOOP_STATE.tmp" && mv "$LOOP_STATE.tmp" "$LOOP_STATE"
    echo "📝 Saved learnings for iteration $iter"
  fi
}

# Run reviewer with pre-assigned session ID
run_reviewer() {
  local reviewer="$1"
  local current_loop="$2"
  local expected_session_id="$3"
  local reviewer_name
  reviewer_name=$(basename "$reviewer")
  local review_file="$REVIEW_DIR/${reviewer_name}.md"

  echo "$reviewer_name: reviewing" >>"$REVIEWER_STATUS"

  if ! command -v "$reviewer" &>/dev/null; then
    echo "$reviewer_name: not_found" >>"$REVIEWER_STATUS"
    echo "⚠️ $reviewer_name: NOT FOUND"
    return
  fi

  local config_dir
  config_dir=$(get_config_dir "$reviewer")

  echo "🔍 $reviewer_name (session: $expected_session_id)"

  local verdict_file="$VERDICTS_DIR/${reviewer_name}.txt"

  timeout "${TIMEOUT_MINS}m" "$reviewer" --dangerously-skip-permissions --print --session-id "$expected_session_id" -p "You are reviewing iteration $current_loop.

TASKS:
1. Read spec: $SPEC_FILE
2. Run: git diff
3. Check ALL acceptance criteria

OUTPUT (MANDATORY):
1. Create $review_file with:
   # Review: $reviewer_name (Iteration $current_loop)
   ## Criteria: [x] or [ ] each
   ## Issues: list or None
   ## Verdict: APPROVED or REJECTED

2. Write your final verdict to $verdict_file:
   - Write exactly 'APPROVED' if all criteria pass (nothing else in the file)
   - Write exactly 'REJECTED' if any criteria fail (nothing else in the file)
   This file MUST be created - it is read by the automation to determine the outcome.
" || true

  # Find actual session ID (may differ if --session-id wasn't respected)
  local actual_session_id
  actual_session_id=$(find_actual_session "$config_dir" "$expected_session_id")

  if [[ $actual_session_id != "$expected_session_id" ]]; then
    echo "  ⚠️ Session ID changed: $actual_session_id"
    update_session_id "$current_loop" "reviewer" "$reviewer_name" "$actual_session_id"
  fi

  # Read verdict from file (written by reviewer)
  if [[ -f $verdict_file ]]; then
    local verdict
    verdict=$(tr -d '[:space:]' <"$verdict_file")
    if [[ $verdict == "APPROVED" ]]; then
      sed -i.bak "s/$reviewer_name: reviewing/$reviewer_name: approved/" "$REVIEWER_STATUS" 2>/dev/null || true
      echo "✅ $reviewer_name: APPROVED"
    elif [[ $verdict == "REJECTED" ]]; then
      sed -i.bak "s/$reviewer_name: reviewing/$reviewer_name: rejected/" "$REVIEWER_STATUS" 2>/dev/null || true
      echo "❌ $reviewer_name: REJECTED"
    else
      sed -i.bak "s/$reviewer_name: reviewing/$reviewer_name: invalid/" "$REVIEWER_STATUS" 2>/dev/null || true
      echo "⚠️ $reviewer_name: INVALID VERDICT ($verdict)"
    fi
  else
    sed -i.bak "s/$reviewer_name: reviewing/$reviewer_name: no_verdict/" "$REVIEWER_STATUS" 2>/dev/null || true
    echo "⚠️ $reviewer_name: NO VERDICT FILE"
  fi
  rm -f "$REVIEWER_STATUS.bak"
}

# Build implementer prompt based on iteration
build_implementer_prompt() {
  local current_loop="$1"
  local prompt=""

  if [[ $current_loop -eq 1 ]]; then
    prompt="You are the IMPLEMENTER for iteration 1 (first iteration).

READ FIRST:
- Spec: $SPEC_FILE

TASK:
1. Implement the spec requirements
2. Do NOT modify the spec
3. Do NOT commit changes

Be concise and focused."
  else
    # Get previous learnings
    local prev_learnings=""
    if [[ -f $LOOP_STATE ]]; then
      prev_learnings=$(jq -r '.learnings // [] | .[] | "- Iteration \(.iteration): \(.content)"' "$LOOP_STATE" 2>/dev/null | head -20)
    fi

    prompt="You are the IMPLEMENTER for iteration $current_loop.

READ FIRST (in order):
1. Spec: $SPEC_FILE
2. Review feedback: $REVIEW_DIR/*.md (IMPORTANT - address ALL issues raised)
3. Previous learnings from loop-state.json

PREVIOUS LEARNINGS:
${prev_learnings:-None yet}

TASKS:
1. Read and understand ALL review feedback carefully
2. Address EVERY issue raised by reviewers
3. Implement fixes and improvements
4. Write learnings to $LEARNINGS_FILE (1-3 bullet points of what you learned)

LEARNINGS FILE FORMAT ($LEARNINGS_FILE):
- Brief bullet points of key insights from this iteration
- What went wrong and how you fixed it
- Patterns to remember for future iterations

Do NOT modify the spec. Do NOT commit changes. Be concise."
  fi

  echo "$prompt"
}

current_loop=$loop_num
while [[ $current_loop -lt $max_loops ]]; do
  current_loop=$((current_loop + 1))
  echo "🔁 Iteration $current_loop / $max_loops"

  jq --argjson loop "$current_loop" '.loop = $loop' "$LOOP_STATE" >"$LOOP_STATE.tmp" && mv "$LOOP_STATE.tmp" "$LOOP_STATE"

  update_phase "implementing"
  rm -f "$VERDICTS_DIR"/*.txt "$REVIEWER_STATUS" "$LEARNINGS_FILE" 2>/dev/null || true

  impl_config_dir=$(get_config_dir "$CLAUDE_CMD")
  expected_impl_session_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
  impl_prompt=$(build_implementer_prompt "$current_loop")

  echo "🔨 Implementing (session: $expected_impl_session_id)"

  # Record implementer session before starting
  impl_session_json="[{\"iteration\": $current_loop, \"role\": \"implementer\", \"name\": \"$(basename "$CLAUDE_CMD")\", \"session_id\": \"$expected_impl_session_id\", \"config_dir\": \"$impl_config_dir\", \"time\": \"$(date -Iseconds)\"}]"
  record_sessions_batch "$impl_session_json"

  timeout "${TIMEOUT_MINS}m" "$CLAUDE_CMD" --dangerously-skip-permissions --print --session-id "$expected_impl_session_id" -p "$impl_prompt" || true

  # Find actual session ID
  actual_impl_session_id=$(find_actual_session "$impl_config_dir" "$expected_impl_session_id")
  if [[ $actual_impl_session_id != "$expected_impl_session_id" ]]; then
    echo "  ⚠️ Session ID changed: $actual_impl_session_id"
    update_session_id "$current_loop" "implementer" "$(basename "$CLAUDE_CMD")" "$actual_impl_session_id"
  fi

  # Save learnings after implementation
  save_learnings "$current_loop"

  # Remove reviews right before review phase starts
  update_phase "reviewing"
  rm -f "$REVIEW_DIR"/*.md 2>/dev/null || true
  rm -f "$REVIEWER_STATUS"

  echo "📋 Reviewing (${#reviewers[@]} parallel)"

  # Pre-generate all reviewer session IDs and record them BEFORE starting (avoids race condition)
  declare -A reviewer_sessions
  reviewer_batch_json="["
  first=true
  for reviewer in "${reviewers[@]}"; do
    reviewer_name=$(basename "$reviewer")
    session_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
    config_dir=$(get_config_dir "$reviewer")
    reviewer_sessions[$reviewer_name]=$session_id

    [[ $first == true ]] && first=false || reviewer_batch_json+=","
    reviewer_batch_json+="{\"iteration\": $current_loop, \"role\": \"reviewer\", \"name\": \"$reviewer_name\", \"session_id\": \"$session_id\", \"config_dir\": \"$config_dir\", \"time\": \"$(date -Iseconds)\"}"
  done
  reviewer_batch_json+="]"

  # Record all reviewer sessions at once
  record_sessions_batch "$reviewer_batch_json"

  # Start reviewers in parallel with pre-assigned session IDs
  for reviewer in "${reviewers[@]}"; do
    reviewer_name=$(basename "$reviewer")
    run_reviewer "$reviewer" "$current_loop" "${reviewer_sessions[$reviewer_name]}" &
  done
  wait

  update_phase "checking"

  # Count verdicts from individual files
  approved_count=0
  rejected_count=0
  for verdict_file in "$VERDICTS_DIR"/*.txt; do
    [[ -f $verdict_file ]] || continue
    verdict=$(cat "$verdict_file" | tr -d '[:space:]')
    [[ $verdict == "APPROVED" ]] && ((approved_count++)) || true
    [[ $verdict == "REJECTED" ]] && ((rejected_count++)) || true
  done

  echo "📊 Verdicts: $approved_count approved, $rejected_count rejected"

  # Success = unanimous (no rejections) AND at least one approval
  if [[ $rejected_count -eq 0 && $approved_count -gt 0 ]]; then
    jq '.status = "completed" | .phase = "done"' "$LOOP_STATE" >"$LOOP_STATE.tmp" && mv "$LOOP_STATE.tmp" "$LOOP_STATE"
    echo "🎉 UNANIMOUS APPROVAL. Done."
    exit 0
  fi
done

jq '.status = "max_loops_reached" | .phase = "stopped"' "$LOOP_STATE" >"$LOOP_STATE.tmp" && mv "$LOOP_STATE.tmp" "$LOOP_STATE"
echo "⚠️ Max loops reached."
exit 1
