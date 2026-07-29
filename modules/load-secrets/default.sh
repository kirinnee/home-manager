#!/usr/bin/env bash

set -eou pipefail

export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"

# No age key yet (e.g. cloud-init bootstrapped home-manager before the key was
# seeded): skip gracefully — the switch must still succeed so the box gets its
# environment. Secrets materialize on the next switch once the key exists
# (scripts/box/replicate.sh seeds it and re-runs the switch).
if [ ! -f "$SOPS_AGE_KEY_FILE" ]; then
  echo "⚠️  load-secrets: no age key at $SOPS_AGE_KEY_FILE — skipping secrets materialization."
  exit 0
fi

yaml=$(sops -d "${SECRETS_FILE}")

# general secrets
[ -f "$HOME/.secrets" ] && rm "$HOME/.secrets"
# Create provider credentials as 0600 from the first byte; chmod-after-write
# would leave a world-readable window under a permissive activation umask.
# @sh shell-quotes the value, so secrets containing spaces or shell
# metacharacters (passwords, not just API tokens) survive being sourced.
(
  umask 077
  yq -r '.env | to_entries[] | "export \(.key)=\(.value|@sh)"' <<<"$yaml" >>"$HOME/.secrets"
)

# nix secrets
[ -f "$HOME/nix.conf" ] && rm "$HOME/nix.conf"
yq -r '.nix | to_entries[] | "\(.key) = \(.value)"' <<<"$yaml" >>"$HOME/nix.conf"

# load SSH keys
mkdir -p "$HOME/.ssh"
yq -r '.ssh_keys | to_entries[] | .key' <<<"$yaml" | while read -r key; do
  yq -r ".ssh_keys.\"$key\".private" <<<"$yaml" >"$HOME/.ssh/$key"
  chmod 0600 "$HOME/.ssh/$key"

  yq -r ".ssh_keys.\"$key\".public" <<<"$yaml" >"$HOME/.ssh/$key.pub"
  chmod 0644 "$HOME/.ssh/$key.pub"
done

# Obsidian Sync headless auth token (`ob`). There is no service-account or API
# token in `ob login` — only email/password/MFA — so what is persisted here is
# the long-lived token `ob` derives after an interactive login. That is
# deliberately safer than storing the password: it is scoped to sync, and it
# still works on accounts with MFA enabled, which a stored password would not.
#
# Written with printf, NOT echo/yq redirection: the token is exactly 32 bytes
# with no trailing newline, and `ob` rejects it if a newline is appended.
# Absent key => skip, so a box without Obsidian Sync configured still activates.
ob_token="$(yq -r '.obsidian.auth_token // ""' <<<"$yaml")"
if [ -n "$ob_token" ]; then
  mkdir -p "$HOME/.config/obsidian-headless"
  (
    umask 077
    printf '%s' "$ob_token" >"$HOME/.config/obsidian-headless/auth_token"
  )
  chmod 0600 "$HOME/.config/obsidian-headless/auth_token"
fi
unset ob_token

# load gpg keys — batch/loopback so secret-key import also works headless:
# over ssh there is no tty, and gpg-agent's pinentry would otherwise die with
# "Inappropriate ioctl for device" and fail the whole activation
yq -r '.gpg_keys | to_entries[] | .key' <<<"$yaml" | while read -r key; do
  yq -r ".gpg_keys.\"$key\"" <<<"$yaml" | gpg --batch --no-tty --pinentry-mode loopback --import
  fpr=$(gpg --with-colons --fingerprint "$key" | awk -F: '/^pub/ {getline; if ($1 == "fpr") print $10}')
  echo "Imported GPG key: $fpr"
  echo "$fpr:6:" | gpg --batch --no-tty --import-ownertrust
done
