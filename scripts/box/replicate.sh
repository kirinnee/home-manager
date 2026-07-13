#!/usr/bin/env bash

set -eou pipefail

# Replicate this WHOLE home-manager setup onto a fresh box, then clone the
# Workspace repos onto it. Run FROM this machine:
#
#   ./scripts/box/replicate.sh <user@host> [profile]
#
# profile defaults to the remote username (must match a profiles.nix entry;
# the stock Linux box profile is `kirin`, x86_64-linux — see cloud-init.yaml).
# Extra ssh flags via SSH_OPTS, e.g. SSH_OPTS="-i ~/.ssh/mykey -p 2222".
#
# What it does, in order:
#   1. Seeds the age private key onto the box — the ONE secret pushed over
#      the wire. Everything else (SSH keys for GitHub, env secrets, GPG keys)
#      is decrypted from the committed secrets.enc.yaml ON the box by the
#      load-secrets home-manager activation step.
#   2. Runs scripts/setup.sh remotely: installs Nix, clones this repo to
#      ~/.config/home-manager, home-manager switch --flake .#<profile>.
#      The switch materializes ~/.ssh/id_ed25519_* (from sops) and the
#      github-personal/github-atomi/... ssh aliases (from home-template.nix).
#   3. Runs scripts/box/clone-stuff.sh remotely: clones every repo listed in
#      the sops-encrypted manifest (.box.repos in secrets) into ~/Workspace,
#      authenticating with those sops-provided SSH keys.

TARGET="${1:?usage: replicate.sh <user@host> [profile]}"
PROFILE="${2:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

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

REMOTE_ARCH="$("${SSH[@]}" 'uname -m')"
if [ "$REMOTE_ARCH" != "x86_64" ]; then
  echo "⚠️  Box arch is $REMOTE_ARCH — check profiles.nix has a matching ${REMOTE_ARCH}-linux profile."
fi

echo "🔑 [1/3] Seeding age key..."
"${SSH[@]}" 'mkdir -p ~/.config/sops/age && chmod 700 ~/.config/sops/age'
"${SCP[@]}" "$AGE_KEY_FILE" "$TARGET:.config/sops/age/keys.txt"
"${SSH[@]}" 'chmod 600 ~/.config/sops/age/keys.txt'

# Teach the box this machine's terminal type (e.g. Ghostty's xterm-ghostty is
# absent from Ubuntu's terminfo DB — without it tput fails, zle key lookups
# break, and backspace/Tab misbehave in zsh). User-level ~/.terminfo is
# honored by both Ubuntu's and nix's ncurses. Best-effort: skip unknown TERM.
if [ -n "${TERM:-}" ] && infocmp -x "$TERM" >/dev/null 2>&1; then
  echo "⌨️  Syncing terminfo for '$TERM'..."
  infocmp -x "$TERM" | "${SSH[@]}" 'mkdir -p ~/.terminfo && tic -x - 2>/dev/null || true'
fi

echo "🏗  [2/3] Bootstrapping Nix + home-manager (this takes a while)..."
"${SCP[@]}" "$ROOT/scripts/setup.sh" "$TARGET:/tmp/hm-setup.sh"
"${SSH[@]}" "bash /tmp/hm-setup.sh '$PROFILE'"

echo "📦 [3/3] Cloning Workspace repos from the sops manifest..."
# Sync the LOCAL encrypted secrets over the box's cloned copy: local may hold
# newer content (e.g. a fresh .box.repos manifest) than what GitHub has.
"${SCP[@]}" "$ROOT/secrets.enc.yaml" "$TARGET:.config/home-manager/secrets.enc.yaml"
"${SCP[@]}" "$ROOT/scripts/box/clone-stuff.sh" "$TARGET:/tmp/hm-clone-stuff.sh"
"${SSH[@]}" 'bash /tmp/hm-clone-stuff.sh'

# Install the Tailscale CLI (install only — joining a tailnet is manual:
# `sudo tailscale up` on the box).
echo "🔗 [+] Installing Tailscale CLI (no auto-join)..."
"${SCP[@]}" "$ROOT/scripts/box/tailscale.sh" "$TARGET:/tmp/hm-tailscale.sh"
"${SSH[@]}" 'bash /tmp/hm-tailscale.sh'

# Nightly restic backup of ~/Workspace -> R2 (03:00, keep 7 days).
echo "💾 [+] Installing nightly backup job..."
"${SSH[@]}" 'mkdir -p ~/.local/bin'
"${SCP[@]}" "$ROOT/scripts/box/backup.sh" "$TARGET:.local/bin/box-backup"
"${SCP[@]}" "$ROOT/scripts/box/backup-install.sh" "$TARGET:/tmp/hm-backup-install.sh"
"${SSH[@]}" 'chmod +x ~/.local/bin/box-backup && bash /tmp/hm-backup-install.sh'

echo ""
echo "✨ Box replicated. SSH in and run zsh — home-manager owns the rest."
echo "   To join your tailnet: ssh in, then: sudo tailscale up"
