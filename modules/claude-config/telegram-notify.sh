#!/usr/bin/env bash

# telegram-notify.sh - Send Telegram notification when Claude needs attention
# Usage: telegram-notify.sh <reason>

set -euo pipefail

REASON="${1:-attention}"

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
