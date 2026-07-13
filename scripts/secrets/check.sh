#!/usr/bin/env bash

set -eou pipefail

# Pre-commit sync check (a-secrets-sync): block a commit when the decrypted
# working copy (secrets.yaml) holds edits that secrets.enc.yaml doesn't —
# i.e. someone edited secrets but forgot to run scripts/secrets/encrypt.sh.
# Ciphertext is never compared (SOPS re-encryption is non-deterministic);
# decrypted content is, key-sorted so formatting/key order never read as
# drift. A missing working copy (fresh checkout / CI without the age key) is
# nothing to verify, so it passes without needing the age key.

export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENC="$ROOT/secrets.enc.yaml"
DEC="$ROOT/secrets.yaml"

if [ ! -f "$DEC" ]; then
  # no working copy -> nothing to keep in step (and no age key needed)
  exit 0
fi

if [ ! -f "$ENC" ]; then
  echo "❌ secrets.yaml exists but secrets.enc.yaml does not."
  echo "   Run: ./scripts/secrets/encrypt.sh  (then: git add secrets.enc.yaml)"
  exit 1
fi

enc_content="$(sops --decrypt "$ENC" | yq -oj 'sort_keys(..)' -)"
dec_content="$(yq -oj 'sort_keys(..)' "$DEC")"

if [ "$enc_content" != "$dec_content" ]; then
  echo "❌ secrets.yaml is out of step with secrets.enc.yaml — secret edits are not encrypted."
  echo "   Run: ./scripts/secrets/encrypt.sh && git add secrets.enc.yaml"
  exit 1
fi
