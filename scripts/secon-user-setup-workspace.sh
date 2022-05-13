#! /bin/sh

# self-install home manager from scratch
curl -L https://raw.githubusercontent.com/kirinnee/home-manager/main/scripts/only-home-manager.sh | sh

# clone my config
git clone https://github.com/kirinnee/home-manager.git "$HOME/home-manager-config"

cd "$HOME/.config" && rm -rf nixpkgs && ln -s "$HOME/home-manager-config" nixpkgs && cd ..

rm "$HOME/home-manager-config/home.nix"

mv "$HOME/home-manager-config/work.nix" "$HOME/home-manager-config/home.nix"

bash --login -c "export NIXPKGS_ALLOW_UNFREE=1 && home-manager switch"

bash --login -c "tmux new -d -s dockerd 'while true; do sudo $(which dockerd); done'"
