#!/bin/sh

# clone and symlink to folder
git clone https://github.com/kirinnee/home-manager.git "$HOME/home-manager-config"

cd "$HOME/.config" && rm -rf nixpkgs && ln -s "$HOME/home-manager-config" nixpkgs && cd ..

bash --login -c "home-manager switch"
