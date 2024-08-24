#!/usr/bin/env bash

set -eou pipefail

echo "🔎 Fetching Zed..."

# Define the GitHub tags page URL
url="https://github.com/zed-industries/zed/tags"

# Fetch the page content and filter out SemVer tags
tags=$(curl -s "${url}" | grep -oP '(?<=/zed-industries/zed/releases/tag/)[vV]?([0-9]+\.){2}[0-9]+"' | sed 's/["]$//' | sed 's/^v//' | sort -V)

# Get the latest tag
latest_tag=$(echo "${tags}" | tail -n 1)

# generate the url
dl_url="https://github.com/zed-industries/zed/releases/download/v${latest_tag}/Zed-aarch64.dmg"

# calculate the hash
hash=$(nix-prefetch-url --type sha256 "${dl_url}")

echo "url: ${url}"
echo "latest_tag: ${latest_tag}"
echo "dl_url: ${dl_url}"
echo "hash: ${hash}"

export VERSION="$latest_tag"
export HASH="$hash"

gomplate -f ./modules/macos/zed/default.nix.tmpl -o ./modules/macos/zed/default.nix
echo "🔎 Done!"
