#!/usr/bin/env bash
# Usage: mark-done.sh <state-file> <action> <filename>
# Actions: mark-checked, mark-fixed
set -euo pipefail
STATE_FILE="$1"
ACTION="$2"
FILENAME="$3"
TEMP=$(mktemp "${STATE_FILE}.XXXXXX")
case "$ACTION" in
mark-checked)
  jq --arg f "$FILENAME" \
    '.pendingFiles -= [$f] | .checkedFiles += [$f] | .checkedFiles |= unique' \
    "$STATE_FILE" >"$TEMP"
  ;;
mark-fixed)
  jq --arg f "$FILENAME" \
    '.pendingFiles -= [$f] | .fixedFiles += [$f] | .fixedFiles |= unique' \
    "$STATE_FILE" >"$TEMP"
  ;;
*)
  echo "Unknown action: $ACTION" >&2
  rm -f "$TEMP"
  exit 1
  ;;
esac
mv "$TEMP" "$STATE_FILE"
