#!/bin/sh

# shellcheck disable=SC2154

which sed

if [ "$1" = "" ]; then
  ssh_key=$(cat "$HOME"/.ssh/id_rsa.pub)
else
  ssh_key=$(cat "$HOME"/ssh/"$1")
fi

get-uuid

# Get Github Username
github_user=$(git config --get user.name)

stty -echo
while true; do
  echo "Personal Access Token (Please ensure permissions are given to modify SSH Keys):"
  read -r github_PAT
  if [ "$github_PAT" != "" ]; then
    break
  else
    echo "Empty PAT!"
  fi
done
stty echo

title="$USER-DevBox-$(get-uuid)"

curl \
  -X POST \
  -H "Accept: application/vnd.github.v3+json" \
  -u "$github_user:$github_PAT" \
  https://api.github.com/user/keys \
  -d "{\"key\":\"$ssh_key\", \"title\":\"$title\"}"

gpg_key=$(git config --get user.signingkey | gpg --armour --export | sed ':a;N;$!ba;s/\n/\\n/g')

curl \
  -X POST \
  -H "Accept: application/vnd.github.v3+json" \
  -u "$github_user:$github_PAT" \
  https://api.github.com/user/gpg_keys \
  -d "{\"armored_public_key\":\"$gpg_key\"}"

echo "Updating Nix configurations to use PAT..."
sudo echo "Sudo Permission obtained!"

echo "access-tokens = github.com=${github_PAT}" | sudo tee -a /etc/nix/nix.conf >/dev/null
