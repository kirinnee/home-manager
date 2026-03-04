#!/usr/bin/env bash
# Usage: init-fix-state.sh <state-file> <mode> <concurrent>
# mode: auto-apply or preview
set -euo pipefail
STATE_FILE="$1"
MODE="$2"
CONCURRENT="$3"

FINDINGS_DIR=".fact-check/findings"
[[ ! -d $FINDINGS_DIR ]] && echo "No findings. Run /fact-check first." >&2 && exit 1

# Extract original paths from <!-- source: path --> metadata line
FILES_JSON=$(for f in "$FINDINGS_DIR"/*.md; do
  sed -n 's/^<!-- source: \(.*\) -->$/\1/p' "$f"
done | jq -R -s 'split("\n") | map(select(. != ""))')

jq -n \
  --arg findingsDir "$FINDINGS_DIR" \
  --arg mode "$MODE" \
  --argjson concurrent "$CONCURRENT" \
  --argjson files "$FILES_JSON" \
  --arg startTime "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    findingsDir: $findingsDir,
    fixesDir: ".fact-check/fixes",
    mode: $mode,
    concurrentAgents: $concurrent,
    filesToFix: $files,
    fixedFiles: [],
    pendingFiles: $files,
    startTime: $startTime
  }' >"$STATE_FILE"

echo "Initialized with $(echo "$FILES_JSON" | jq length) files to fix"
