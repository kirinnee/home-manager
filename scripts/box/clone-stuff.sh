#!/usr/bin/env bash

set -eou pipefail

# Clone every repo in the sops-encrypted manifest (.box.repos) into
# ~/Workspace, preserving the <group>/<repo> layout. Runs ON the box, after
# home-manager switch: the switch already materialized ~/.ssh/id_ed25519_*
# from sops (load-secrets) and the github-personal/github-atomi/... aliases
# the manifest URLs use, so cloning needs no extra credentials — only the
# age key. The manifest lives INSIDE secrets (this repo is public; the repo
# list names private/work repositories). Idempotent: existing clones are
# skipped, failures are reported but don't abort the rest.

export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

CONFIG_DIR="${HM_CONFIG_DIR:-$HOME/.config/home-manager}"
WORKSPACE="${WORKSPACE_DIR:-$HOME/Workspace}"
ENC="$CONFIG_DIR/secrets.enc.yaml"

# On a freshly-switched box git/sops/yq are in the home-manager profile but
# this non-interactive shell may not have sourced it yet.
export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"

# First-ever contact with github.com on a fresh box: accept its host key
# instead of prompting (there is no tty here).
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"

if [ ! -f "$ENC" ]; then
  echo "❌ $ENC not found — run scripts/setup.sh first."
  exit 1
fi

manifest="$(sops --decrypt "$ENC" | yq -r '.box.repos[] | .path + "\t" + .url')"
if [ -z "$manifest" ]; then
  echo "⚠️  No .box.repos in secrets — run scripts/box/gen-repos.sh on your main machine."
  exit 0
fi

ok=0
skipped=0
failed=0
while IFS=$'\t' read -r path url; do
  [ -n "$path" ] || continue
  dest="$WORKSPACE/$path"
  if [ -e "$dest/.git" ]; then
    echo "⏭  $path (already cloned)"
    skipped=$((skipped + 1))
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  echo "⬇️  $path <- $url"
  if git clone -- "$url" "$dest"; then
    ok=$((ok + 1))
  else
    echo "⚠️  FAILED: $path ($url)"
    failed=$((failed + 1))
  fi
done <<<"$manifest"

echo ""
echo "📦 Clone summary: $ok cloned, $skipped already present, $failed failed."
[ "$failed" -eq 0 ]
