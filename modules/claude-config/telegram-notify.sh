#!/usr/bin/env bash

# telegram-notify.sh - Send Telegram notification when Claude needs attention
# Reads JSON from stdin with notification_type field
# Usage: telegram-notify.sh [reason] (reason arg overrides stdin, for Stop hook)

set -euo pipefail

# Read stdin if available (Notification hook sends JSON)
NOTIFICATION_TYPE=""
if [[ -t 0 ]]; then
  # No stdin (called directly with arg, e.g., from Stop hook)
  REASON="${1:-attention}"
else
  # Read JSON from stdin
  INPUT=$(cat)
  # Extract notification_type using simple parsing (avoid jq dependency)
  # JSON format: {"notification_type":"permission_prompt",...}
  NOTIFICATION_TYPE=$(echo "$INPUT" | sed -n 's/.*"notification_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  # Map notification_type to reason
  case "$NOTIFICATION_TYPE" in
  permission_prompt) REASON="permission" ;;
  idle_prompt) REASON="idle" ;;
  *) REASON="${1:-attention}" ;;
  esac
fi

# Get path relative to ~
if [[ $PWD == "$HOME"* ]]; then
  REL_PATH="~${PWD#"$HOME"}"
else
  REL_PATH="$PWD"
fi

# Escape path for MarkdownV2: _ * [ ] ( ) ~ ` > # + - = | { } . !
# Only need to escape chars that might appear in paths: . - _ ~ /
ESC_PATH="${REL_PATH//\~/\\~}"
ESC_PATH="${ESC_PATH//\./\\.}"
ESC_PATH="${ESC_PATH//\-/\\-}"
ESC_PATH="${ESC_PATH//_/\\_}"
ESC_PATH="${ESC_PATH//\//\\/}"

# Build message based on reason
case "$REASON" in
permission)
  MSG="🔐 *Hey\! Claude needs your permission*

A tool approval is pending your review\.

📂 Location: $ESC_PATH"
  ;;
idle)
  MSG="👀 *Psst\! Claude is waiting for you*

She's been idle 60\+ seconds\.\.\. probably thinking about the meaning of life\.

📂 Waiting in: $ESC_PATH"
  ;;
elicitation)
  MSG="🎯 *Claude needs your input\!*

An MCP tool is asking for your wisdom\.

📂 Consultation in: $ESC_PATH"
  ;;
auth)
  MSG="✅ *Auth success\!*

Authentication completed successfully\.

📂 Secured in: $ESC_PATH"
  ;;
complete | stop)
  MSG="🎉 *Task complete\!*

Claude finished what she was doing\. Time to celebrate\!

📂 Mission accomplished in: $ESC_PATH"
  ;;
*)
  MSG="🔔 *Claude is calling\!*

Something needs your attention\.

📂 Located in: $ESC_PATH"
  ;;
esac

# Send to Telegram
curl -s -X POST http://localhost:3313/send -d "$MSG"
