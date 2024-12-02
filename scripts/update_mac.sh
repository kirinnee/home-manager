#!/usr/bin/env bash

set -eou pipefail

echo "⬆️ Updating nix flakes..."
nix flake update
echo "✅ Done!"

echo "⬆️ Updating all nix definitions..."
./scripts/updates/beekeeper-studio.sh &
./scripts/updates/aptakube.sh &
./scripts/updates/httpie.sh &
./scripts/updates/firefox.sh &
wait
echo "✅ Done!"

echo "🔄 Updating hme-manager..."
home-manager switch
echo "✅ Done!"

echo "🔄 Updating zsh..."
zsh -c "source ~/.zshrc"
echo "✅ Done!"

echo "Close all applications and type 'y' to continue."
read -r response

if [ ! "$response" = "y" ]; then
  echo "❌ Exiting..."
  exit 1
fi

./scripts/delete_cycle.sh

# shellcheck disable=SC2010
hash_path="$(ls /nix/store | grep -P "raycast-.*[^v]$")"
echo "Path: /nix/store${hash_path}"
