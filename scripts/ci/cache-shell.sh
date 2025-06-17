#!/usr/bin/env bash

cache="$1"

set -eou pipefail

if [ -z "$cache" ]; then
  echo "Usage: $0 <cache>"
  exit 1
fi

# Get the current system
SYSTEM=$(nix eval --raw --impure --expr 'builtins.currentSystem')

# Get all available devShells
echo "🔍 Discovering available devShells..."
SHELLS=$(nix eval --raw --impure --expr "builtins.concatStringsSep \" \" (builtins.attrNames (builtins.getFlake (toString ./.)).outputs.devShells.${SYSTEM})")
echo "📦 Found shells: $SHELLS"

# Build all devShells in a single command
BUILD_TARGETS=""
for shell in $SHELLS; do
  BUILD_TARGETS="$BUILD_TARGETS .#devShells.$SYSTEM.$shell"
done

echo "🔨 Building $BUILD_TARGETS"
# shellcheck disable=SC2086
TO_PUSH=$(nix build $BUILD_TARGETS --print-out-paths)
echo "✅ Successfully built all devShells"

echo "🫸 Pushing all shells to Attic $cache"
# shellcheck disable=SC2086
attic push "$cache" $TO_PUSH
echo "✅ Successfully pushed all shells to Attic $cache"

echo "🎉 All devShells have been built and pushed to cache!"
