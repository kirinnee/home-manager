#!/usr/bin/env bash

# Capture `gh` + `gws` credentials from THIS machine straight into sops, so a
# fresh box inherits them without an interactive login. Run this on a machine
# where the accounts already work (i.e. one with a browser and a keyring — the
# Mac), then commit + push; `load-secrets` materializes them on every other box.
#
# Exists because the accounts cannot be authenticated on a headless box at all:
# `gh auth login` and `gws auth login` both want a browser, and `gws` defaults to
# a keyring backend that a box with no org.freedesktop.secrets cannot use. So the
# credentials have to be minted somewhere interactive and carried in sops.
#
# Reads credentials through the CLIs' own accessors (`gh auth token`,
# `gws auth export`) rather than scraping config files, because both tools may
# keep secrets in an OS keychain instead of on disk — in which case there is no
# file to scrape.

set -eou pipefail

cd "$(dirname "$0")/../.."

./scripts/secrets/decrypt.sh

# Refuse to run against a STALE working copy. decrypt.sh deliberately never
# overwrites an existing secrets.yaml, and encrypt.sh at the end overwrites
# secrets.enc.yaml from it — so on a machine whose working copy predates the
# committed secrets, capturing would silently republish that old base and drop
# every key added since. That is not hypothetical: it wiped an Obsidian auth
# token and three API tokens the first time this script ran on a second machine.
if ! ./scripts/secrets/check.sh >/dev/null 2>&1; then
  echo "❌ secrets.yaml is out of step with secrets.enc.yaml — refusing to capture."
  echo ""
  echo "   Capturing now would overwrite secrets.enc.yaml from this stale working"
  echo "   copy and drop any key it is missing. Reconcile first:"
  echo ""
  echo "   • working copy has no edits worth keeping (the usual case):"
  echo "       rm secrets.yaml && ./scripts/secrets/decrypt.sh"
  echo "   • it has edits you need: merge them, then ./scripts/secrets/encrypt.sh"
  echo ""
  echo "   Then re-run this script."
  exit 1
fi

captured=0
skipped=0

note_skip() {
  echo "⏭️  $1"
  skipped=$((skipped + 1))
}

set_secret() {
  # yq -i with strenv keeps the value out of argv (visible via ps) and survives
  # multi-line content such as a JSON credential blob.
  local path="$1" value="$2"
  value="$value" yq -i "$path = strenv(value)" secrets.yaml
  captured=$((captured + 1))
}

############
#   gh     #
############

# Every account shares ONE gh config dir — the multi-gh wrappers only run
# `gh auth switch -u <user>` before exec'ing gh (see programs.multi-gh in
# home-template.nix). So capture is per-USER token, and load-secrets rebuilds a
# hosts.yml containing all of them.
if command -v gh >/dev/null 2>&1; then
  gh_wrapper="$(command -v gh)"

  # Take the account list from the multi-gh smart wrapper, NOT from
  # `gh auth status`: status only reports accounts that happen to be logged in, so
  # capturing from it would silently miss any account this machine never
  # authenticated and produce a partial secrets file that looks complete. The
  # wrapper is generated from programs.multi-gh, so its bulk-login loop is the
  # authoritative set of configured accounts and stays in step with the nix config.
  gh_users="$(sed -n 's/^[[:space:]]*for _gh_u in \(.*\); do[[:space:]]*$/\1/p' "$gh_wrapper" | head -1)"

  # Friendly account labels (personal/atomi/durian/liftoff) come from the
  # wrapper's routing-rule comments, so messages name accounts the way the config
  # does rather than by bare GitHub username. First rule per username wins.
  gh_labels="$(awk '
    /# Rule for /            { label = $4; sub(/:$/, "", label); next }
    /^[[:space:]]*echo "/    { if (label != "") { u = $0; gsub(/.*echo "|".*/, "", u); print u "=" label; label = "" } }
  ' "$gh_wrapper" | awk -F= '!seen[$1]++')"

  if [ -z "$gh_users" ]; then
    # Wrapper shape changed — fall back to whatever is logged in, and say so, so a
    # partial capture is never mistaken for a complete one.
    echo "ℹ️  gh: could not read the configured account list from $gh_wrapper — falling back to logged-in accounts only"
    gh_users="$(gh auth status 2>&1 | grep -oE 'account [A-Za-z0-9_-]+' | awk '{print $2}' | sort -u || true)"
  fi

  if [ -z "$gh_users" ]; then
    note_skip "gh: no accounts found at all — run 'gh login' first"
  else
    gh_total=0
    gh_missing=0
    for gh_user in $gh_users; do
      gh_total=$((gh_total + 1))
      gh_label="$(printf '%s\n' "$gh_labels" | grep "^$gh_user=" | cut -d= -f2 || true)"
      gh_desc="$gh_user${gh_label:+ ($gh_label)}"
      if token="$(gh auth token -u "$gh_user" 2>/dev/null)" && [ -n "$token" ]; then
        set_secret ".gh.tokens.\"$gh_user\"" "$token"
        echo "🔑 gh: captured token for $gh_desc"
      else
        note_skip "gh: NOT logged in as $gh_desc — no token to capture"
        gh_missing=$((gh_missing + 1))
      fi
      unset token
    done
    if [ "$gh_missing" -gt 0 ]; then
      echo ""
      echo "⚠️  gh: captured $((gh_total - gh_missing))/$gh_total accounts — $gh_missing missing."
      echo "   Run 'gh login' on this machine (it walks every configured account),"
      echo "   then re-run this script so all $gh_total land in sops."
    else
      echo "✅ gh: all $gh_total configured accounts captured."
    fi
  fi
else
  note_skip "gh: not installed on this machine"
fi

############
#   gws    #
############

# Accounts are discovered from the installed per-account wrappers, so adding an
# account to programs.multi-gws is picked up here with no edit to this script.
gws_found=0
for gws_bin in "$HOME"/.nix-profile/bin/gws-*; do
  [ -x "$gws_bin" ] || continue
  gws_acct="$(basename "$gws_bin")"
  gws_acct="${gws_acct#gws-}"
  gws_found=1

  # The OAuth client is a plain file in the account's config dir, so read it
  # directly; there is no CLI accessor for it.
  gws_client="$HOME/.config/gws-$gws_acct/client_secret.json"
  if [ -f "$gws_client" ]; then
    set_secret ".gws.\"$gws_acct\".client_secret" "$(cat "$gws_client")"
    echo "🔑 gws: captured client_secret.json for $gws_acct"
  else
    note_skip "gws/$gws_acct: no client_secret.json — run 'gws-$gws_acct auth setup' first"
  fi

  # Credentials may live in a keychain, so go through `auth export`. Validate it
  # is JSON before storing: a masked or human-readable dump would otherwise be
  # written to secrets and silently produce an unusable credentials.json on every
  # box that consumes it.
  if gws_creds="$("$gws_bin" auth export --unmasked 2>/dev/null)" &&
    [ -n "$gws_creds" ] &&
    printf '%s' "$gws_creds" | jq -e . >/dev/null 2>&1; then
    set_secret ".gws.\"$gws_acct\".credentials" "$gws_creds"
    echo "🔑 gws: captured credentials for $gws_acct"
  else
    note_skip "gws/$gws_acct: no exportable JSON credentials — run 'gws-$gws_acct auth login' first"
  fi
  unset gws_creds
done
[ "$gws_found" -eq 1 ] || note_skip "gws: no per-account wrappers found on this machine"

############
#  finish  #
############

if [ "$captured" -eq 0 ]; then
  echo ""
  echo "❌ Nothing captured ($skipped skipped) — secrets.yaml left unchanged."
  echo "   Run this on a machine where the accounts already work."
  exit 1
fi

./scripts/secrets/encrypt.sh

echo ""
echo "✅ Captured $captured secret(s), $skipped skipped."
echo "   Next: git add secrets.enc.yaml && git commit && git push"
echo "   Then on each box: git pull && hms"
