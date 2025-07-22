#!/usr/bin/env bash

set -eou pipefail

branch="$1"
# Extract ticket by first removing prefix, then removing suffix
temp="${branch#*/}"
ticket="${temp%%/*}"

path="../$(basename "$PWD")-${ticket}"
git worktree add "$path" -b "$branch"
echo "✅ Created: $path"
