#!/usr/bin/env bash
# Usage: init-state.sh <state-file> <docs-path> <extensions> <source-paths-json> <concurrent> <output-file>
# extensions: comma-separated, e.g. "md,mdx"
set -euo pipefail
STATE_FILE="$1"
DOCS_PATH="$2"
EXTENSIONS="$3"
SOURCE_PATHS="$4"
CONCURRENT="$5"
OUTPUT_FILE="$6"

FIND_ARGS=()
IFS=',' read -ra EXTS <<<"$EXTENSIONS"
for i in "${!EXTS[@]}"; do
  [[ $i -gt 0 ]] && FIND_ARGS+=("-o")
  FIND_ARGS+=("-name" "*.${EXTS[$i]}")
done

FILES_JSON=$(find "$DOCS_PATH" -type f \( "${FIND_ARGS[@]}" \) | sort | jq -R -s 'split("\n") | map(select(. != ""))')

jq -n \
  --arg docsPath "$DOCS_PATH" \
  --argjson sourcePaths "$SOURCE_PATHS" \
  --arg outputFile "$OUTPUT_FILE" \
  --argjson concurrent "$CONCURRENT" \
  --argjson files "$FILES_JSON" \
  --arg startTime "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    docsPath: $docsPath,
    sourcePaths: $sourcePaths,
    outputFile: $outputFile,
    concurrentAgents: $concurrent,
    filesToCheck: $files,
    checkedFiles: [],
    pendingFiles: $files,
    startTime: $startTime
  }' >"$STATE_FILE"

echo "Initialized with $(echo "$FILES_JSON" | jq length) files"
