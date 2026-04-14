#!/usr/bin/env bash
# Usage: mark-done.sh <state-file> <filename>
# Moves filename from pendingFiles to processedFiles.
set -euo pipefail

STATE_FILE="$1"
FILENAME="$2"
TEMP=$(mktemp "${STATE_FILE}.XXXXXX")
jq --arg f "$FILENAME" \
  '.pendingFiles -= [$f] | .processedFiles += [$f] | .processedFiles |= unique' \
  "$STATE_FILE" >"$TEMP"
mv "$TEMP" "$STATE_FILE"
