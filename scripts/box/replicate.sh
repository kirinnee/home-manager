#!/usr/bin/env bash

set -eou pipefail

# Replicate onto a box = the ONLY two things git cannot deliver:
#
#   1. the age key   (unlocks every secret on the box)
#   2. the Workspace (clones the sops-manifest repos into ~/Workspace)
#
# plus one `home-manager switch` so the freshly-seeded key materializes
# secrets. Everything else is owned by the layers underneath:
#   - cloud-init userdata (infra/cloud-init.yaml.tftpl): user + SSH key, Nix,
#     home-manager bootstrap, tailscaled, systemd lingering
#   - home-manager (home-template.nix): packages, zsh, terminfo, backup timer
#
# Usage, FROM this machine:
#
#   ./scripts/box/replicate.sh <user@host> [profile]
#
# profile defaults to the remote username (must match a profiles.nix entry;
# the stock Linux box profile is `kirin`). Extra ssh flags via SSH_OPTS.
# Works on any box, not just ours: if home-manager is absent (no cloud-init
# bootstrap ran), scripts/setup.sh is run remotely as a fallback.

TARGET="${1:?usage: replicate.sh <user@host> [profile]}"
PROFILE="${2:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
# shellcheck disable=SC2016  # $HOME/$PATH must expand on the REMOTE side
REMOTE_PATH='export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH";'

# SSH_OPTS is intentionally word-split into ssh/scp flags.
# shellcheck disable=SC2206
SSH=(ssh ${SSH_OPTS:-} "$TARGET")
# shellcheck disable=SC2206
SCP=(scp ${SSH_OPTS:-})

if [ ! -f "$AGE_KEY_FILE" ]; then
  echo "❌ No age key at $AGE_KEY_FILE — the box cannot decrypt secrets without it."
  exit 1
fi

if [ -z "$PROFILE" ]; then
  # shellcheck disable=SC2016  # $USER must expand on the REMOTE side
  PROFILE="$("${SSH[@]}" 'echo "$USER"')"
fi
echo "🎯 Target: $TARGET  |  Profile: $PROFILE"

# cloud-init's userdata bootstraps Nix + home-manager on first boot; wait for
# it so we never run a second concurrent nix install / switch.
echo "⏳ Waiting for cloud-init (first-boot bootstrap) to finish..."
"${SSH[@]}" 'command -v cloud-init >/dev/null 2>&1 && sudo cloud-init status --wait >/dev/null 2>&1 || true'

echo "🔑 [1/3] Seeding age key..."
"${SSH[@]}" 'mkdir -p ~/.config/sops/age && chmod 700 ~/.config/sops/age'
"${SCP[@]}" "$AGE_KEY_FILE" "$TARGET:.config/sops/age/keys.txt"
"${SSH[@]}" 'chmod 600 ~/.config/sops/age/keys.txt'

echo "🏗  [2/3] Converging home-manager (materializes secrets with the new key)..."
if "${SSH[@]}" "$REMOTE_PATH command -v home-manager >/dev/null 2>&1"; then
  "${SSH[@]}" "$REMOTE_PATH cd ~/.config/home-manager && git pull -q && home-manager switch --flake '.#$PROFILE' -b hm-backup" | tail -3
else
  echo "   (no home-manager yet — running full bootstrap via scripts/setup.sh)"
  "${SCP[@]}" "$ROOT/scripts/setup.sh" "$TARGET:/tmp/hm-setup.sh"
  "${SSH[@]}" "bash /tmp/hm-setup.sh '$PROFILE'"
fi

echo "📦 [3/3] Cloning Workspace repos from the sops manifest..."
"${SCP[@]}" "$ROOT/scripts/box/clone-stuff.sh" "$TARGET:/tmp/hm-clone-stuff.sh"
"${SSH[@]}" 'bash /tmp/hm-clone-stuff.sh'

echo ""
echo "✨ Box replicated. SSH in and run zsh — home-manager owns the rest."
echo "   To join your tailnet: ssh in, then: sudo tailscale up"
