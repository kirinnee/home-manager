#!/usr/bin/env bash
# Usage: <file-list> | init-state.sh <state-file> <source-paths-json> <concurrent> <output-file>
# Reads file list from stdin, one file per line.
set -euo pipefail

STATE_FILE="$1"
SOURCE_PATHS="$2"
CONCURRENT="$3"
OUTPUT_FILE="$4"

FILES_JSON=$(jq -R -s 'split("\n") | map(select(. != ""))')

jq -n \
  --argjson sourcePaths "$SOURCE_PATHS" \
  --arg outputFile "$OUTPUT_FILE" \
  --argjson concurrent "$CONCURRENT" \
  --argjson files "$FILES_JSON" \
  --arg startTime "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    sourcePaths: $sourcePaths,
    outputFile: $outputFile,
    concurrentAgents: $concurrent,
    filesToProcess: $files,
    processedFiles: [],
    pendingFiles: $files,
    startTime: $startTime
  }' >"$STATE_FILE"

echo "Initialized with $(echo "$FILES_JSON" | jq length) files"
