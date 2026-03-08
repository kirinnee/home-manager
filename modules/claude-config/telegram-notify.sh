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

# Escape MarkdownV2 reserved characters
escape_md() {
  # Escape MarkdownV2 reserved chars: _ * [ ] ( ) ~ ` > # + - = | { } . !
  # shellcheck disable=SC2016
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/_/\\_/g; s/\*/\\*/g; s/\[/\\[/g; s/\]/\\]/g; s/(/\\(/g; s/)/\\)/g; s/~/\\~/g; s/`/\\`/g; s/>/\\>/g; s/#/\\#/g; s/+/\\+/g; s/-/\\-/g; s/=/\\=/g; s/|/\\|/g; s/{/\\{/g; s/}/\\}/g; s/\./\\./g; s/!/\\!/g'
}

# Get path relative to ~
if [[ $PWD == "$HOME"* ]]; then
  REL_PATH="~${PWD#"$HOME"}"
else
  REL_PATH="$PWD"
fi

# Get last 2 directory components for display (e.g., "playground/deeplink-zed")
SHORT_PATH="$(basename "$(dirname "$PWD")")/$(basename "$PWD")"

# Build clickable path link (escape display text, but URL doesn't need escaping in MarkdownV2)
ESC_SHORT_PATH=$(escape_md "$SHORT_PATH")
ESC_URL="http://localhost:7621/${REL_PATH}"
ESC_URL=$(escape_md "http://localhost:7621/${REL_PATH}")
PATH_LINES="📂 ${ESC_SHORT_PATH}
🔗 ${ESC_URL}"

# Build message based on reason
case "$REASON" in
permission)
  MSG="🔐 *Hey\! Claude needs your permission*

A tool approval is pending your review\.

$PATH_LINES"
  ;;
idle)
  MSG="👀 *Psst\! Claude is waiting for you*

She's been idle 60\+ seconds\.\.\. probably thinking about the meaning of life\.

$PATH_LINES"
  ;;
elicitation)
  MSG="🎯 *Claude needs your input\!*

An MCP tool is asking for your wisdom\.

$PATH_LINES"
  ;;
auth)
  MSG="✅ *Auth success\!*

Authentication completed successfully\.

$PATH_LINES"
  ;;
complete | stop)
  MSG="🎉 *Task complete\!*

Claude finished what she was doing\. Time to celebrate\!

$PATH_LINES"
  ;;
*)
  MSG="🔔 *Claude is calling\!*

Something needs your attention\.

$PATH_LINES"
  ;;
esac

# Send to Telegram (Markdown parse mode)
curl -s -X POST http://localhost:3313/send -d "$MSG"
