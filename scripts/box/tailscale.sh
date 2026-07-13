#!/usr/bin/env bash

set -eou pipefail

# Install the Tailscale CLI + daemon on the box — INSTALL ONLY, never joins a
# tailnet (the user runs `sudo tailscale up` themselves; e.g. joining a company
# tailnet via interactive SSO). Runs ON the box (Ubuntu), invoked by
# scripts/box/replicate.sh. Idempotent: skips when tailscale already exists.

if command -v tailscale >/dev/null 2>&1; then
  echo "✅ Tailscale already installed ($(tailscale version | head -1))."
  exit 0
fi

echo "⏬ Installing tailscale (CLI + daemon, not joining anything)..."
curl -fsSL https://tailscale.com/install.sh | sh
echo "✅ Tailscale installed. Join manually with: sudo tailscale up"
