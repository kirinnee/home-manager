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

# Obsidian Sync end-to-end encryption password. Separate secret from the auth
# token above and NOT derivable from it: the token authenticates the account to
# Obsidian's servers, while this password decrypts vault contents client-side —
# by design the servers never hold it, so `ob sync-setup` must be given it
# locally. Materialized to a 0600 file rather than interpolated into the
# activation script, because that script is a /nix/store path and world-readable.
# Absent key => skip, so a box without E2E vaults still activates.
ob_e2e="$(yq -r '.obsidian.e2e_password // ""' <<<"$yaml")"
if [ -n "$ob_e2e" ]; then
  mkdir -p "$HOME/.config/obsidian-headless"
  (
    umask 077
    printf '%s' "$ob_e2e" >"$HOME/.config/obsidian-headless/e2e_password"
  )
  chmod 0600 "$HOME/.config/obsidian-headless/e2e_password"
fi
unset ob_e2e

# Google Workspace CLI (`gws`) per-account credentials. The multi-gws wrappers
# isolate each account with GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws-<acct>
# (see programs.multi-gws in home-template.nix), so dropping the files there is
# all a fresh box needs — and it is the only route that works headlessly:
# `gws auth login` wants a browser, and `gws` defaults to a keyring backend that
# a box with no org.freedesktop.secrets on the user bus cannot use. The plaintext
# credentials.json path is what `gws` falls back to, so that is what we write.
#
# Data-driven: every account under `.gws` is materialized, so adding one is a
# secrets edit with no change to this script. Generate the values with
# `gws auth export --unmasked` on a machine where the account already works.
# Absent key => skip, so a box without gws credentials still activates.
yq -r '.gws // {} | keys[]' <<<"$yaml" | while read -r gws_acct; do
  [ -n "$gws_acct" ] || continue
  gws_dir="$HOME/.config/gws-$gws_acct"
  mkdir -p "$gws_dir"
  # client_secret.json = the OAuth client; credentials.json = the refresh token.
  # Both are needed for a non-interactive account, but write whichever is present
  # so a partially-populated secrets file still makes forward progress.
  for gws_file in client_secret credentials; do
    gws_val="$(yq -r ".gws.\"$gws_acct\".$gws_file // \"\"" <<<"$yaml")"
    [ -n "$gws_val" ] || continue
    (
      umask 077
      printf '%s' "$gws_val" >"$gws_dir/$gws_file.json"
    )
    chmod 0600 "$gws_dir/$gws_file.json"
    echo "🔑 gws: materialized $gws_file.json for account $gws_acct"
  done
done
unset gws_acct gws_dir gws_file gws_val

# GitHub CLI (`gh`) account tokens. All accounts share ONE config dir — the
# multi-gh wrappers only run `gh auth switch -u <user>` before exec'ing gh — so
# one hosts.yml holds every account, and we rebuild it here from the captured
# tokens (see scripts/secrets/capture-auth.sh).
#
# SEED-ONLY, unlike every other secret in this file: gh actively owns hosts.yml
# at runtime (it rewrites the active-account field on every `auth switch`, and
# may refresh tokens in place). Overwriting on each activation would fight the
# tool and could revert a locally-refreshed token to a stale one from sops. So
# write it only when absent — which is exactly the fresh-box case this is for.
# Rotation is therefore deliberate: delete hosts.yml, then re-run the switch.
gh_hosts="$HOME/.config/gh/hosts.yml"
if [ ! -f "$gh_hosts" ] && [ "$(yq -r '.gh.tokens // {} | length' <<<"$yaml")" != "0" ]; then
  mkdir -p "$(dirname "$gh_hosts")"
  # The host-level user/oauth_token pair is gh's "active account". Seed it from
  # the first captured user purely as a starting value — the wrappers set the real
  # one per invocation with `gh auth switch`.
  gh_first="$(yq -r '.gh.tokens | keys | .[0]' <<<"$yaml")"
  (
    umask 077
    {
      echo "github.com:"
      echo "    users:"
      yq -r '.gh.tokens | to_entries[] | "        \(.key):\n            oauth_token: \(.value)"' <<<"$yaml"
      echo "    git_protocol: https"
      echo "    user: $gh_first"
      yq -r ".gh.tokens.\"$gh_first\" | \"    oauth_token: \(.)\"" <<<"$yaml"
    } >"$gh_hosts"
  )
  chmod 0600 "$gh_hosts"
  echo "🔑 gh: seeded hosts.yml with $(yq -r '.gh.tokens | length' <<<"$yaml") account(s)"
  unset gh_first
fi
unset gh_hosts

# Work OCI CLI profile on a never-expiring API signing key. Session-token logins
# (`oci session authenticate`) last ~1 h and refresh only up to a ~24 h max, so
# long-running jobs kept losing access, and a headless box cannot do the browser
# login at all. An API key does not expire; carrying it here gives every box the
# same working profile.
#
# Neutral key names (.oci.work.*) on purpose: sops encrypts VALUES but leaves
# keys readable, and this repo is public, so the profile and tenancy names stay
# values. ~/.oci/config itself stays CLI-owned (session logins rewrite it): only
# the one [<profile>] section is replaced, every other profile is left alone, and
# nothing is written when that section is already current.
# Absent key => skip, so a box without the work key still activates.
oci_key="$(yq -r '.oci.work.private_key // ""' <<<"$yaml")"
if [ -n "$oci_key" ]; then
  oci_cfg="$HOME/.oci/config"
  oci_pem="$HOME/.oci/work_api_key.pem"
  oci_profile="$(yq -r '.oci.work.profile' <<<"$yaml")"
  mkdir -p "$HOME/.oci"
  (
    umask 077
    printf '%s\n' "$oci_key" >"$oci_pem"
  )
  chmod 0600 "$oci_pem"

  oci_section="$(
    echo "[$oci_profile]"
    yq -r '.oci.work | "user=\(.user)\nfingerprint=\(.fingerprint)\ntenancy=\(.tenancy)\nregion=\(.region)"' <<<"$yaml"
    echo "key_file=$oci_pem"
  )"
  # Print this profile's section (1) or everything else (0). Headers match with
  # trailing whitespace ignored, so a hand-edited header can never leave a
  # duplicate section behind (the CLI refuses to parse those).
  oci_section_of() {
    awk -v want="[$oci_profile]" -v keep="$1" '
      { h = $0; sub(/[ \t\r]+$/, "", h) }
      /^\[/ { mine = (h == want) }
      (mine ? 1 : 0) == keep
    ' "$oci_cfg" 2>/dev/null || true
  }
  oci_current="$(oci_section_of 1)"
  if [ "$oci_current" != "$oci_section" ]; then
    oci_rest="$(oci_section_of 0)"
    (
      umask 077
      {
        [ -z "$oci_rest" ] || printf '%s\n\n' "$oci_rest"
        printf '%s\n' "$oci_section"
      } >"$oci_cfg.tmp"
    )
    mv "$oci_cfg.tmp" "$oci_cfg"
    chmod 0600 "$oci_cfg"
    echo "🔑 oci: wrote the work API-key profile into ~/.oci/config"
  fi
  unset -f oci_section_of
  unset oci_cfg oci_pem oci_profile oci_section oci_current oci_rest
fi
unset oci_key

# load gpg keys — batch/loopback so secret-key import also works headless:
# over ssh there is no tty, and gpg-agent's pinentry would otherwise die with
# "Inappropriate ioctl for device" and fail the whole activation
yq -r '.gpg_keys | to_entries[] | .key' <<<"$yaml" | while read -r key; do
  yq -r ".gpg_keys.\"$key\"" <<<"$yaml" | gpg --batch --no-tty --pinentry-mode loopback --import
  fpr=$(gpg --with-colons --fingerprint "$key" | awk -F: '/^pub/ {getline; if ($1 == "fpr") print $10}')
  echo "Imported GPG key: $fpr"
  echo "$fpr:6:" | gpg --batch --no-tty --import-ownertrust
done
