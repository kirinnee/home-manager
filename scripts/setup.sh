#!/usr/bin/env bash

set -eou pipefail

# Detect OS
KERNEL=$(uname -s)
ARCH=$(uname -m)
REPO_URL="https://github.com/kirinnee/home-manager.git"
CONFIG_DIR="$HOME/.config/home-manager"

echo "🖥  Detected: $KERNEL-$ARCH"

# 1. Install Nix if not present
if command -v nix >/dev/null 2>&1; then
  echo "✅ Nix is found"
else
  echo "⏬ Installing Nix..."
  curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install --no-confirm
  echo "✅ Nix installation completed!"
fi

# Source nix environment
set +eou
# shellcheck disable=SC1091
if [ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]; then
  . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
elif [ -f "$HOME/.nix-profile/etc/profile.d/nix.sh" ]; then
  . "$HOME/.nix-profile/etc/profile.d/nix.sh"
fi
set -eou

# 2. Clone the repo (delete and retry for idempotence)
echo "🔄 Syncing home-manager config..."
rm -rf "$CONFIG_DIR"
nix run nixpkgs#git -- clone "$REPO_URL" "$CONFIG_DIR"
echo "✅ Synced!"

# 3. Determine profile (default to current user)
PROFILE="${1:-$USER}"
echo "👤 Using profile: $PROFILE"

# 4. Bootstrap based on platform
if [ "$KERNEL" = "Darwin" ]; then
  echo "🍎 Setting up nix-darwin..."

  # Check if darwin-rebuild exists
  if ! command -v darwin-rebuild >/dev/null 2>&1; then
    echo "🔧 Bootstrapping nix-darwin..."
    cd "$CONFIG_DIR"

    # Build the darwin configuration
    nix build ".#darwinConfigurations.$PROFILE.config.system.build.toplevel"

    # Activate it (this installs darwin-rebuild)
    sudo ./result/sw/bin/darwin-rebuild switch --flake "$CONFIG_DIR#$PROFILE"

    # Cleanup result symlink
    rm -f result

    echo "✅ nix-darwin bootstrapped!"
  else
    echo "🔄 Switching darwin configuration..."
    cd "$CONFIG_DIR"
    sudo /run/current-system/sw/bin/darwin-rebuild switch --flake ".#$PROFILE"
    echo "✅ Darwin configuration switched!"
  fi
else
  echo "🐧 Setting up home-manager (standalone)..."

  # Install home-manager if not present
  if ! command -v home-manager >/dev/null 2>&1; then
    echo "⏬ Installing Home Manager..."
    nix run home-manager/release-25.11 -- init --switch
    echo "✅ Home Manager installed!"
  fi

  echo "🔄 Switching home-manager configuration..."
  cd "$CONFIG_DIR"
  home-manager switch --flake ".#$PROFILE"
  echo "✅ Home Manager switched!"
fi

# 5. Handle age key (only if not exists)
AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"
if [ -f "$AGE_KEY_FILE" ]; then
  echo "🔑 Age key already exists, skipping..."
elif [ -n "${AGE_KEY:-}" ]; then
  echo "🔑 Using AGE_KEY from environment..."
  mkdir -p "$(dirname "$AGE_KEY_FILE")"
  echo "$AGE_KEY" >"$AGE_KEY_FILE"
  chmod 0600 "$AGE_KEY_FILE"
  echo "✅ Age key installed!"
elif [ -t 0 ]; then
  # Only prompt if running interactively (tty)
  echo "🔑 Enter your age key (or press Enter to skip):"
  read -r age_key
  if [ -n "$age_key" ]; then
    mkdir -p "$(dirname "$AGE_KEY_FILE")"
    echo "$age_key" >"$AGE_KEY_FILE"
    chmod 0600 "$AGE_KEY_FILE"
    echo "✅ Age key installed!"
  else
    echo "⚠️  Age key skipped. You can add it later."
  fi
else
  echo "⚠️  Non-interactive environment, skipping age key setup."
  echo "   Set AGE_KEY environment variable to provide it."
fi

echo ""
echo "✨ Setup complete!"
echo ""
echo "Commands:"
if [ "$KERNEL" = "Darwin" ]; then
  echo "  sudo darwin-rebuild switch --flake ~/.config/home-manager#$PROFILE"
else
  echo "  home-manager switch --flake ~/.config/home-manager#$PROFILE"
fi
echo "  hmsz  - apply config and reload zsh"
echo ""
