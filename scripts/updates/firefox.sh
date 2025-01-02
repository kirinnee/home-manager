#!/usr/bin/env bash

set -euo pipefail

echo "🔎 Fetching Firefox..."
# Get the HTML content of the Firefox release notes page
html_content=$(curl -s https://www.mozilla.org/en-US/firefox/releases/)

# Extract all version numbers in the format major.minor.patch
version_numbers=$(echo "$html_content" | grep -oP '(?<=<li><a href="\.\./)[0-9]+\.[0-9]+\.[0-9]+(?=/releasenotes/)')

# Sort the version numbers and get the latest one
latest_version=$(echo "$version_numbers" | sort -V | tail -n 1)

# generate the download link
dl_link="https://download-installer.cdn.mozilla.net/pub/firefox/releases/${latest_version}/mac/en-US/Firefox%20${latest_version}.dmg"

# hash
hash=$(nix-prefetch-url --type sha256 "${dl_link}" --name "firefox-${latest_version}.dmg")

echo "version: ${latest_version}"
echo "link: ${dl_link}"
echo "hash: ${hash}"

export VERSION="${latest_version}"
export HASH="${hash}"

gomplate -f ./modules/macos/firefox/default.nix.tmpl -o ./modules/macos/firefox/default.nix
echo "🔎 Done!"
