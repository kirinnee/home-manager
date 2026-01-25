#!/usr/bin/env bash
set -euo pipefail

LOOP_DIR=".claude/dev-loop"
SESSIONS_FILE="$LOOP_DIR/sessions.json"

show_help() {
  cat <<'EOF'
dev-loop logs - View dev-loop execution history

Usage:
  dev-loop logs              Interactive selector (iteration → role)
  dev-loop logs list         List all sessions
  dev-loop logs view <iter> <role>  View specific session
  dev-loop logs tail <iter> <role>  Tail session in real-time
  dev-loop logs history      Show conversation history
EOF
}

# Get project hash (/ and . replaced with -)
get_project_hash() {
  pwd | tr '/.' '-'
}

PROJECT_HASH=$(get_project_hash)

# Get session file path from session entry
get_session_file_from_entry() {
  local entry="$1"
  local config_dir session_id
  config_dir=$(echo "$entry" | jq -r '.config_dir')
  session_id=$(echo "$entry" | jq -r '.session_id')
  echo "$config_dir/projects/$PROJECT_HASH/$session_id.jsonl"
}

# ANSI color codes
C_RESET='\033[0m'
C_BOLD='\033[1m'
C_DIM='\033[2m'
C_BLUE='\033[34m'
C_GREEN='\033[32m'
C_YELLOW='\033[33m'
C_RED='\033[31m'
C_MAGENTA='\033[35m'

# Format tool call for display
format_tool_call() {
  local name="$1"
  local input="$2"

  case "$name" in
  Read)
    local file_path
    file_path=$(echo "$input" | jq -r '.file_path // empty')
    echo -e "${C_YELLOW}📖 Read${C_RESET} ${C_DIM}${file_path}${C_RESET}"
    ;;
  Write)
    local file_path
    file_path=$(echo "$input" | jq -r '.file_path // empty')
    echo -e "${C_YELLOW}📝 Write${C_RESET} ${C_DIM}${file_path}${C_RESET}"
    ;;
  Edit)
    local file_path
    file_path=$(echo "$input" | jq -r '.file_path // empty')
    echo -e "${C_YELLOW}✏️  Edit${C_RESET} ${C_DIM}${file_path}${C_RESET}"
    ;;
  Bash)
    local cmd desc
    cmd=$(echo "$input" | jq -r '.command // empty' | head -1 | cut -c1-80)
    desc=$(echo "$input" | jq -r '.description // empty')
    if [[ -n $desc ]]; then
      echo -e "${C_YELLOW}⚡ Bash${C_RESET} ${C_DIM}${desc}${C_RESET}"
    else
      echo -e "${C_YELLOW}⚡ Bash${C_RESET} ${C_DIM}${cmd}${C_RESET}"
    fi
    ;;
  Glob)
    local pattern
    pattern=$(echo "$input" | jq -r '.pattern // empty')
    echo -e "${C_YELLOW}🔍 Glob${C_RESET} ${C_DIM}${pattern}${C_RESET}"
    ;;
  Grep)
    local pattern
    pattern=$(echo "$input" | jq -r '.pattern // empty')
    echo -e "${C_YELLOW}🔎 Grep${C_RESET} ${C_DIM}${pattern}${C_RESET}"
    ;;
  Task)
    local desc
    desc=$(echo "$input" | jq -r '.description // empty')
    echo -e "${C_YELLOW}🤖 Task${C_RESET} ${C_DIM}${desc}${C_RESET}"
    ;;
  TodoWrite)
    echo -e "${C_YELLOW}📋 TodoWrite${C_RESET}"
    ;;
  *)
    echo -e "${C_YELLOW}🔧 ${name}${C_RESET}"
    ;;
  esac
}

# Format tool result for display
format_tool_result() {
  local tool_use_result="$1"
  local content="$2"

  # Check toolUseResult type
  local result_type
  result_type=$(echo "$tool_use_result" | jq -r '.type // empty' 2>/dev/null)

  case "$result_type" in
  text)
    # Read result - show file path and line count
    local file_path num_lines
    file_path=$(echo "$tool_use_result" | jq -r '.file.filePath // empty')
    num_lines=$(echo "$tool_use_result" | jq -r '.file.numLines // empty')
    if [[ -n $file_path ]]; then
      echo -e "  ${C_DIM}↳ Read ${num_lines} lines from ${file_path}${C_RESET}"
    fi
    ;;
  update)
    # Edit/Write result - show file path
    local file_path
    file_path=$(echo "$tool_use_result" | jq -r '.filePath // empty')
    echo -e "  ${C_DIM}↳ Updated ${file_path}${C_RESET}"
    ;;
  "")
    # Bash or other - check if content has error
    if echo "$content" | grep -qi "error\|failed\|exception" 2>/dev/null; then
      echo -e "  ${C_RED}↳ Completed with errors${C_RESET}"
    else
      echo -e "  ${C_DIM}↳ Completed${C_RESET}"
    fi
    ;;
  esac
}

# Format a JSONL session file into readable output
format_session() {
  local session_file="$1"
  [[ -f $session_file ]] || {
    echo "❌ Session file not found: $session_file"
    return 1
  }

  while IFS= read -r line; do
    local msg_type
    msg_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)

    case "$msg_type" in
    user)
      local tool_use_result content_type
      tool_use_result=$(echo "$line" | jq -c '.toolUseResult // empty' 2>/dev/null)

      if [[ -z $tool_use_result || $tool_use_result == "null" ]]; then
        # Actual user prompt
        local content
        content=$(echo "$line" | jq -r '.message.content // empty' 2>/dev/null)
        content_type=$(echo "$line" | jq -r '.message.content | type' 2>/dev/null)

        if [[ $content_type == "string" && -n $content ]]; then
          echo ""
          echo -e "${C_BOLD}${C_BLUE}━━━ 👤 USER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
          echo -e "${C_BLUE}$(echo "$content" | head -30)${C_RESET}"
        fi
      else
        # Tool result
        local content
        content=$(echo "$line" | jq -r '.message.content[0].content // empty' 2>/dev/null)
        format_tool_result "$tool_use_result" "$content"
      fi
      ;;

    assistant)
      # Process text content
      local text
      text=$(echo "$line" | jq -r '.message.content[]? | select(.type=="text") | .text // empty' 2>/dev/null)

      if [[ -n $text ]]; then
        echo ""
        echo -e "${C_BOLD}${C_GREEN}━━━ 🤖 CLAUDE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
        echo -e "${C_GREEN}$(echo "$text" | head -50)${C_RESET}"
      fi

      # Process tool calls
      echo "$line" | jq -c '.message.content[]? | select(.type=="tool_use")' 2>/dev/null | while IFS= read -r tool; do
        local name input
        name=$(echo "$tool" | jq -r '.name // empty')
        input=$(echo "$tool" | jq -c '.input // {}')
        format_tool_call "$name" "$input"
      done
      ;;
    esac
  done <"$session_file"

  echo ""
}

# Get unique iterations
get_iterations() {
  jq -r '[.[].iteration] | unique | .[]' "$SESSIONS_FILE" 2>/dev/null
}

# Get sessions for a specific iteration
get_sessions_for_iteration() {
  local iter="$1"
  jq -c ".[] | select(.iteration == $iter)" "$SESSIONS_FILE" 2>/dev/null
}

# Find session by iteration and role/name
find_session() {
  local iter="$1"
  local role_or_name="$2"

  # Try exact role match first (implementer), then name match (reviewer name)
  local entry
  entry=$(jq -c ".[] | select(.iteration == $iter and (.role == \"$role_or_name\" or .name == \"$role_or_name\"))" "$SESSIONS_FILE" 2>/dev/null | head -1)
  echo "$entry"
}

list_sessions() {
  if [[ ! -f $SESSIONS_FILE ]]; then
    echo "ℹ️ No sessions recorded yet."
    exit 0
  fi

  echo "📋 Dev Loop Sessions"
  echo ""

  local current_iter=""
  jq -c '.[]' "$SESSIONS_FILE" 2>/dev/null | while IFS= read -r entry; do
    local iter role name time
    iter=$(echo "$entry" | jq -r '.iteration')
    role=$(echo "$entry" | jq -r '.role')
    name=$(echo "$entry" | jq -r '.name')
    time=$(echo "$entry" | jq -r '.time' | cut -d'T' -f2 | cut -d'+' -f1 | cut -d'-' -f1)

    if [[ $iter != "$current_iter" ]]; then
      current_iter=$iter
      echo ""
      echo "═══ Iteration $iter ═══"
    fi

    local emoji="📄"
    [[ $role == "implementer" ]] && emoji="🔨"
    [[ $role == "reviewer" ]] && emoji="🔍"

    printf "  %s %-12s │ %-20s │ %s\n" "$emoji" "$role" "$name" "$time"
  done
}

view_session_by_iter_role() {
  local iter="$1"
  local role_or_name="$2"

  [[ ! -f $SESSIONS_FILE ]] && {
    echo "❌ No sessions"
    exit 1
  }

  local entry
  entry=$(find_session "$iter" "$role_or_name")
  [[ -z $entry ]] && {
    echo "❌ Session not found: iteration $iter, $role_or_name"
    exit 1
  }

  local session_file role name
  session_file=$(get_session_file_from_entry "$entry")
  role=$(echo "$entry" | jq -r '.role')
  name=$(echo "$entry" | jq -r '.name')

  local emoji="📄"
  [[ $role == "implementer" ]] && emoji="🔨"
  [[ $role == "reviewer" ]] && emoji="🔍"

  if [[ -f $session_file ]]; then
    {
      echo -e "${C_BOLD}${C_MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
      echo -e "${C_BOLD}${C_MAGENTA}$emoji Iteration $iter: $name ($role)${C_RESET}"
      echo -e "${C_BOLD}${C_MAGENTA}📄 $session_file${C_RESET}"
      echo -e "${C_BOLD}${C_MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
      format_session "$session_file"
    } | less -R
  else
    echo "❌ Session file not found: $session_file"
  fi
}

tail_session() {
  local iter="$1"
  local role_or_name="$2"

  [[ ! -f $SESSIONS_FILE ]] && {
    echo "❌ No sessions"
    exit 1
  }

  local entry
  entry=$(find_session "$iter" "$role_or_name")
  [[ -z $entry ]] && {
    echo "❌ Session not found: iteration $iter, $role_or_name"
    exit 1
  }

  local session_file
  session_file=$(get_session_file_from_entry "$entry")

  echo "📡 Tailing: $session_file"
  echo "   (Ctrl+C to stop)"
  echo ""
  tail -f "$session_file" 2>/dev/null || echo "❌ File not found or not accessible"
}

show_history() {
  if [[ ! -f $SESSIONS_FILE ]]; then
    echo "ℹ️ No sessions yet."
    exit 0
  fi

  echo "📜 Dev Loop History"
  echo ""

  local current_iter=""
  jq -c '.[]' "$SESSIONS_FILE" 2>/dev/null | while IFS= read -r entry; do
    local iter role name session_file
    iter=$(echo "$entry" | jq -r '.iteration')
    role=$(echo "$entry" | jq -r '.role')
    name=$(echo "$entry" | jq -r '.name')
    session_file=$(get_session_file_from_entry "$entry")

    if [[ $iter != "$current_iter" ]]; then
      current_iter=$iter
      echo ""
      echo "═══════════════════════════════════════════════════════════"
      echo "  ITERATION $iter"
      echo "═══════════════════════════════════════════════════════════"
    fi

    local emoji="📄"
    [[ $role == "implementer" ]] && emoji="🔨"
    [[ $role == "reviewer" ]] && emoji="🔍"

    echo ""
    echo "$emoji $name ($role)"
    echo "───────────────────────────────────────────────────────────"

    if [[ -f $session_file ]]; then
      if [[ $role == "reviewer" ]]; then
        if grep -q "VERDICT: APPROVED" "$session_file" 2>/dev/null; then
          echo "  ✅ APPROVED"
        elif grep -q "VERDICT: REJECTED" "$session_file" 2>/dev/null; then
          echo "  ❌ REJECTED"
        fi
      fi
      echo "  📄 $session_file"
    else
      echo "  ⚠️ Session file not found"
    fi
  done

  echo ""
  echo "───────────────────────────────────────────────────────────"
  echo "💡 Use 'dev-loop logs view <iter> <role>' to see full session"
}

interactive_select() {
  [[ ! -f $SESSIONS_FILE ]] && {
    echo "❌ No sessions"
    exit 0
  }

  if ! command -v fzf &>/dev/null; then
    list_sessions
    echo ""
    echo "💡 Install fzf for interactive selection"
    echo "💡 Or use: dev-loop logs view <iter> <role>"
    exit 0
  fi

  # Step 1: Select iteration
  local iterations
  iterations=$(get_iterations)
  [[ -z $iterations ]] && {
    echo "❌ No iterations found"
    exit 0
  }

  local selected_iter
  selected_iter=$(echo "$iterations" | while read -r iter; do
    local count
    count=$(jq "[.[] | select(.iteration == $iter)] | length" "$SESSIONS_FILE")
    printf "%s\t│ %s sessions\n" "$iter" "$count"
  done | fzf --ansi --header="🔢 Select Iteration" --prompt="Iteration> " | cut -f1)

  [[ -z $selected_iter ]] && exit 0

  # Step 2: Select role within iteration
  local selected_session
  selected_session=$(get_sessions_for_iteration "$selected_iter" | while IFS= read -r entry; do
    local role name time
    role=$(echo "$entry" | jq -r '.role')
    name=$(echo "$entry" | jq -r '.name')
    time=$(echo "$entry" | jq -r '.time' | cut -d'T' -f2 | cut -d'+' -f1)

    local emoji="📄"
    [[ $role == "implementer" ]] && emoji="🔨"
    [[ $role == "reviewer" ]] && emoji="🔍"

    # Use name as identifier (works for both implementer and reviewer names)
    printf "%s\t%s %s │ %s\n" "$name" "$emoji" "$role" "$time"
  done | fzf --ansi --header="📋 Iteration $selected_iter - Select Session" --prompt="Session> " | cut -f1)

  [[ -z $selected_session ]] && exit 0

  view_session_by_iter_role "$selected_iter" "$selected_session"
}

# Main
case "${1:-}" in
-h | --help) show_help ;;
list | ls) list_sessions ;;
view)
  [[ -z ${2:-} || -z ${3:-} ]] && {
    echo "Usage: dev-loop logs view <iteration> <role|name>"
    exit 1
  }
  view_session_by_iter_role "$2" "$3"
  ;;
tail | -f)
  [[ -z ${2:-} || -z ${3:-} ]] && {
    echo "Usage: dev-loop logs tail <iteration> <role|name>"
    exit 1
  }
  tail_session "$2" "$3"
  ;;
history | hist) show_history ;;
"") interactive_select ;;
*)
  show_help
  ;;
esac
