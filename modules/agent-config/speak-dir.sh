#!/usr/bin/env bash

# speak-dir.sh - Speak the current directory name in a friendly way
# Usage: speak-dir.sh [message_prefix]
#
# Examples:
#   speak-dir.sh "Claude is waiting for you in"
#   speak-dir.sh "Task complete in"

set -euo pipefail

# Default message if no prefix provided
MESSAGE_PREFIX="${1:-Directory}"

# Get current directory name
DIR_NAME="$(basename "$PWD")"

# Handle empty or root directory
if [[ -z $DIR_NAME ]] || [[ $DIR_NAME == "/" ]]; then
  DIR_NAME="root"
fi

# Transform directory name for better pronunciation:
# 1. Replace dots, dashes, underscores with spaces
# 2. Remove common file extensions
# 3. Convert camelCase to separate words
# 4. Limit to 5 words to keep it brief

CLEAN_NAME="$DIR_NAME"

# Replace separators with spaces
CLEAN_NAME="${CLEAN_NAME//[-._]/ }"

# Add spaces before capital letters (camelCase) but avoid consecutive spaces
CLEAN_NAME="$(echo "$CLEAN_NAME" | sed 's/\([A-Z]\)/ \1/g' | tr -s ' ')"

# Convert to lowercase for more natural speech
CLEAN_NAME="$(echo "$CLEAN_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

# Remove common suffixes that shouldn't be spoken
CLEAN_NAME="${CLEAN_NAME%-ts}"
CLEAN_NAME="${CLEAN_NAME%-js}"
CLEAN_NAME="${CLEAN_NAME%-rs}"
CLEAN_NAME="${CLEAN_NAME% config}"
CLEAN_NAME="${CLEAN_NAME% modules}"

# Limit to first 5 words
read -ra WORDS <<<"$CLEAN_NAME"
if [[ ${#WORDS[@]} -gt 5 ]]; then
  WORDS=("${WORDS[@]:0:5}")
fi

CLEAN_NAME="${WORDS[*]}"

# Final fallback if somehow empty
if [[ -z $CLEAN_NAME ]]; then
  CLEAN_NAME="unknown"
fi

# Speak the message
FULL_MESSAGE="$MESSAGE_PREFIX $CLEAN_NAME"
say "$FULL_MESSAGE"
