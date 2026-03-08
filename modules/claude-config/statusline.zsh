#!/bin/zsh
# Prettified Claude Code statusline - p10k inspired with emoji + colors
# Receives JSON input via stdin with session info

input=$(cat)

# ANSI color helpers
cyan=$'\e[36m'
green=$'\e[32m'
yellow=$'\e[33m'
blue=$'\e[34m'
magenta=$'\e[35m'
dim=$'\e[2m'
reset=$'\e[0m'

# Extract information from JSON
model_display=$(echo "$input" | jq -r '.model.display_name // empty')
model_id=$(echo "$input" | jq -r '.model.id // empty')
current_dir=$(echo "$input" | jq -r '.workspace.current_dir // empty')
project_dir=$(echo "$input" | jq -r '.workspace.project_dir // empty')
context_remaining=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')

# Token usage for cost estimation
input_tokens=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
output_tokens=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')

# Shorten directory path for display
if [[ -n "$current_dir" ]]; then
  display_dir="${current_dir/#$HOME/~}"
  if [[ -n "$project_dir" && "$current_dir" != "$project_dir" ]]; then
    relative_dir="${current_dir#$project_dir/}"
    if [[ "$relative_dir" != "$current_dir" ]]; then
      project_name=$(basename "$project_dir")
      display_dir="$project_name/$relative_dir"
    fi
  elif [[ -n "$project_dir" ]]; then
    display_dir=$(basename "$project_dir")
  fi
fi

# Get git branch (used for PR/ticket detection, not displayed directly)
git_branch=""
if [[ -d "$current_dir/.git" || -f "$current_dir/.git" ]]; then
  git_branch=$(git -C "$current_dir" -c core.fsmonitor=false rev-parse --abbrev-ref HEAD 2>/dev/null)
fi

# Cached external lookup helper (PR, ticket, etc.)
# Usage: cached_lookup <cache_key> <ttl_seconds> <command...>
# Returns cached stdout or runs command and caches result
cache_dir="/tmp/claude-statusline-cache"
mkdir -p "$cache_dir" 2>/dev/null

cached_lookup() {
  local cache_key=$1 ttl=$2; shift 2
  local cache_file="$cache_dir/${cache_key//\//_}"

  if [[ -f "$cache_file" ]]; then
    local cache_mtime
    if [[ "$(uname)" == "Darwin" ]]; then
      cache_mtime=$(stat -f %m "$cache_file" 2>/dev/null)
    else
      cache_mtime=$(stat -c %Y "$cache_file" 2>/dev/null)
    fi
    if (( $(date +%s) - ${cache_mtime:-0} < ttl )); then
      cat "$cache_file"
      return
    fi
  fi

  local result
  result=$(eval "$@" 2>/dev/null) || result=""
  echo "$result" > "$cache_file"
  echo "$result"
}

# PR detection with caching
pr_segment=""
if [[ -n "$git_branch" && "$git_branch" != "HEAD" ]]; then
  pr_json=$(cached_lookup "pr-${git_branch}" 60 \
    "GIT_DIR='$current_dir/.git' GIT_WORK_TREE='$current_dir' gh pr view --json number,url")

  if [[ -n "$pr_json" ]]; then
    pr_number=$(echo "$pr_json" | jq -r '.number // empty' 2>/dev/null)
    pr_url=$(echo "$pr_json" | jq -r '.url // empty' 2>/dev/null)
    if [[ -n "$pr_number" && -n "$pr_url" ]]; then
      pr_segment="${dim}│${reset} \e]8;;${pr_url}\a${blue}🔗 #${pr_number}${reset}\e]8;;\a"
    fi
  fi
fi

# Ticket detection from branch name
# Supports: JIRA (PE-1234) → vungle.atlassian.net, ClickUp (CU-xxxxxx) → app.clickup.com
ticket_segment=""
if [[ -n "$git_branch" ]]; then
  ticket_id=""
  ticket_url=""

  # Check for ClickUp ticket first (e.g., CU-86ewu0yd1) - must be before JIRA
  # since JIRA pattern would partially match CU-86 as a JIRA ticket
  if [[ "$git_branch" =~ CU-([a-z0-9]+) ]]; then
    local cu_id="${match[1]}"
    ticket_id="CU-${cu_id}"
    ticket_url="https://app.clickup.com/t/${cu_id}"
  # Check for JIRA ticket (e.g., PE-1234, any UPPERCASE-DIGITS pattern)
  elif [[ "$git_branch" =~ ([A-Z][A-Z0-9]+-[0-9]+) ]]; then
    ticket_id="${match[1]}"
    ticket_url="https://vungle.atlassian.net/browse/${ticket_id}"
  fi

  if [[ -n "$ticket_id" && -n "$ticket_url" ]]; then
    # OSC 8 clickable hyperlink
    ticket_segment="\e]8;;${ticket_url}\a${cyan}🎫 ${ticket_id}${reset}\e]8;;\a"
  fi
fi

# Calculate estimated cost
estimate_cost() {
  local model=$1 in_toks=$2 out_toks=$3
  case $model in
    *opus*)   input_rate=15.0; output_rate=75.0 ;;
    *sonnet*) input_rate=3.0;  output_rate=15.0 ;;
    *haiku*)  input_rate=0.25; output_rate=1.25 ;;
    *gpt-4*)  input_rate=2.5;  output_rate=10.0 ;;
    *)        input_rate=1.0;  output_rate=1.0 ;;
  esac
  local total=$(echo "scale=4; $in_toks * $input_rate / 1000000 + $out_toks * $output_rate / 1000000" | bc 2>/dev/null || echo 0)
  if (( $(echo "$total >= 0.01" | bc -l 2>/dev/null || echo 0) )); then
    printf "\$%.2f" "$total"
  elif (( $(echo "$total > 0" | bc -l 2>/dev/null || echo 0) )); then
    printf "\$%.3f" "$total"
  fi
}

# Calculate session duration
calculate_duration() {
  local transcript=$(echo "$input" | jq -r '.transcript_path // empty')
  if [[ -f "$transcript" ]]; then
    local start_time
    if [[ "$(uname)" == "Darwin" ]]; then
      start_time=$(stat -f %m "$transcript" 2>/dev/null)
    else
      start_time=$(stat -c %Y "$transcript" 2>/dev/null)
    fi
    local elapsed=$(( $(date +%s) - start_time ))
    if (( elapsed >= 3600 )); then
      printf "%dh %dm" $((elapsed / 3600)) $(((elapsed % 3600) / 60))
    elif (( elapsed >= 60 )); then
      printf "%dm" $((elapsed / 60))
    elif (( elapsed > 0 )); then
      printf "%ds" "$elapsed"
    fi
  fi
}

estimated_cost=$(estimate_cost "$model_id" "$input_tokens" "$output_tokens")
session_duration=$(calculate_duration)

# Build the statusline (two lines)
sep="${dim}│${reset}"
line1=""
line2=""

# Line 1: model, directory, git branch, PR
if [[ -n "$model_display" ]]; then
  line1+="${cyan}🤖 ${model_display}${reset}"
fi

if [[ -n "$display_dir" ]]; then
  line1+=" ${sep} ${green}📂 ${display_dir}${reset}"
fi

if [[ -n "$ticket_segment" ]]; then
  line1+=" ${sep} ${ticket_segment}"
fi

if [[ -n "$pr_segment" ]]; then
  line1+=" ${pr_segment}"
fi

# Line 2: duration, context, cost
if [[ -n "$session_duration" ]]; then
  line2+="${dim}⏱ ${session_duration}${reset}"
fi

if [[ -n "$context_remaining" ]] && (( context_remaining < 90 )); then
  [[ -n "$line2" ]] && line2+=" ${sep} "
  line2+="${blue}📊 ${context_remaining}%${reset}"
fi

if [[ -n "$estimated_cost" ]]; then
  [[ -n "$line2" ]] && line2+=" ${sep} "
  line2+="${magenta}💰 ${estimated_cost}${reset}"
fi

# Output - each echo produces a separate row in Claude Code's status area
echo -e "$line1"
[[ -n "$line2" ]] && echo -e "$line2"
