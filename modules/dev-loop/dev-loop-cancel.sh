#!/usr/bin/env bash
set -euo pipefail

# Dev Loop - Cancel
# Removes dev-loop state and files

LOOP_DIR=".claude/dev-loop"

if [[ ! -d $LOOP_DIR ]]; then
  echo "ℹ️ No dev-loop found."
  exit 0
fi

rm -rf "$LOOP_DIR"
echo "🗑️ Dev loop cancelled."
