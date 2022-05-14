#!/bin/sh

# Install Nix
{
	curl -L "https://nixos.org/nix/install"
	printf '%s\n%s\n%s\n%s\n\n' "y" "y" "y" "y"
} | sh -s -- --daemon

# Update channels
bash --login -c "nix-channel --add https://github.com/nix-community/home-manager/archive/release-21.11.tar.gz home-manager && nix-channel --update"

# Fix some problems when installing
bash --login -c "NIX_PATH=$HOME/.nix-defexpr/channels:/nix/var/nix/profiles/per-user/root/channels${NIX_PATH:+:$NIX_PATH} nix-shell '<home-manager>' -A install"
