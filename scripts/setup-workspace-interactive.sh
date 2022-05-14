#! /bin/sh

# self-install home manager from scratch
curl -L https://raw.githubusercontent.com/kirinnee/home-manager/main/scripts/install-home-manager-interactive.sh | sh

# clone my config
git clone https://github.com/kirinnee/home-manager.git "$HOME/home-manager-config"

export NIXPKGS_ALLOW_UNFREE=1 && home-manager switch --flake "$HOME/home-manager-config#$USER"
