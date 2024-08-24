#!/usr/bin/env bash

set -eou pipefail

echo "🔎 Fetching HTTPie..."

# Define the GitHub tags page URL
url="https://github.com/httpie/desktop/tags"

# Fetch the page content and filter out SemVer tags
tags=$(curl -s "${url}" | grep -oP '(?<=/httpie/desktop/releases/tag/)[vV]?([0-9]+\.){2}[0-9]+' | sed 's/^v//' | sort -V)

# Get the latest tag
latest_tag=$(echo "${tags}" | tail -n 1)

# generate the url
dl_url="https://github.com/httpie/desktop/releases/download/v${latest_tag}/HTTPie-${latest_tag}-arm64.dmg"

# calculate the hash
hash=$(nix-prefetch-url --type sha256 "${dl_url}")

echo "url: ${url}"
echo "latest_tag: ${latest_tag}"
echo "dl_url: ${dl_url}"
echo "hash: ${hash}"

export VERSION="$latest_tag"
export HASH="$hash"

gomplate -f ./modules/macos/httpie/default.nix.tmpl -o ./modules/macos/httpie/default.nix
echo "🔎 Done!"
