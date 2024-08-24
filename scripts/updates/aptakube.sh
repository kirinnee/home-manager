#!/usr/bin/env bash

set -eou pipefail

echo "🔎 Fetching Aptakube..."

# Define the GitHub tags page URL
url="https://github.com/aptakube/aptakube/tags"

# Fetch the page content and filter out SemVer tags
tags=$(curl -s "$url" | grep -oP '(?<=/aptakube/aptakube/releases/tag/)[vV]?([0-9]+\.){2}[0-9]+' | sed 's/^v//' | sort -V)

# Get the latest tag
latest_tag=$(echo "${tags}" | tail -n 1)

# generate the url
dl_url="https://github.com/aptakube/aptakube/releases/download/${latest_tag}/Aptakube_${latest_tag}_universal.dmg"

# calculate the hash
hash=$(nix-prefetch-url --type sha256 "${dl_url}")

echo "url: ${url}"
echo "latest_tag: ${latest_tag}"
echo "dl_url: ${dl_url}"
echo "hash: ${hash}"

export VERSION="$latest_tag"
export HASH="$hash"

gomplate -f ./modules/macos/aptakube/default.nix.tmpl -o ./modules/macos/aptakube/default.nix
echo "🔎 Done!"
