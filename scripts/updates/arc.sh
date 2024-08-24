#!/usr/bin/env bash

set -eou pipefail

echo "🔎 Fetching Arc..."
# Fetch the headers and filter for Location
result=$(curl -sIL https://releases.arc.net/release/Arc-latest.dmg | grep -i Location)
# Extract the URL
url=$(echo "$result" | tail -n 1 | sed 's/location: //I' | tr -d '\r')
# Extract the version
version=$(echo "$url" | grep -oP '(Arc-)\K[0-9.]+-[0-9]+')
# calculate the hash
hash=$(nix-prefetch-url --type sha256 "${url}")

echo "url: ${url}"
echo "version: ${version}"
echo "hash: ${hash}"

export VERSION="$version"
export HASH="$hash"

gomplate -f ./modules/macos/arc/default.nix.tmpl -o ./modules/macos/arc/default.nix
echo "🔎 Done!"
