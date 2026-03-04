#!/usr/bin/env bash
# Usage: <file-list> | init-verify.sh <state-file>
# Reads finding files from stdin, one per line. Writes verify state JSON.
set -euo pipefail

STATE_FILE="$1"

FILES_JSON=$(jq -R -s 'split("\n") | map(select(. != ""))')

jq -n \
  --argjson files "$FILES_JSON" \
  --arg startTime "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    step: "verify_loop",
    pendingFiles: $files,
    verifiedFiles: [],
    startTime: $startTime
  }' >"$STATE_FILE"

echo "Initialized verification with $(echo "$FILES_JSON" | jq length) files"
