#!/usr/bin/env bash
# Usage: next-file.sh <state-file> [--batch N]
# Prints next pending file(s), one per line. Empty output if none remain.
set -euo pipefail

STATE_FILE="$1"
shift
BATCH=1
while [[ $# -gt 0 ]]; do
  case "$1" in --batch)
    BATCH="$2"
    shift 2
    ;;
  *) shift ;; esac
done
PENDING=$(jq -r ".pendingFiles[:$BATCH][]" "$STATE_FILE")
[[ -z $PENDING ]] && exit 0
echo "$PENDING"
