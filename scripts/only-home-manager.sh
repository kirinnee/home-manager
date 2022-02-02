#!/bin/sh

# Update channels
bash --login -c "nix-channel --add https://github.com/nix-community/home-manager/archive/master.tar.gz home-manager && nix-channel --update"

# Fix some problems when installing
bash --login -c "NIX_PATH=$HOME/.nix-defexpr/channels:/nix/var/nix/profiles/per-user/root/channels${NIX_PATH:+:$NIX_PATH} nix-shell '<home-manager>' -A install"
