#!/usr/bin/env bash

set -eou pipefail

# Re-encrypt the decrypted working copy (secrets.yaml) into the committed
# secrets.enc.yaml. SOPS re-encryption is non-deterministic (fresh nonce/MAC
# every run), so encrypting unconditionally would churn ciphertext into every
# commit — instead the decrypted CONTENT is compared (key-sorted JSON) and an
# in-step pair is left untouched. Run this before committing secret edits; the
# a-secrets-sync pre-commit hook blocks commits when this hasn't been run.

export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENC="$ROOT/secrets.enc.yaml"
DEC="$ROOT/secrets.yaml"

if [ ! -f "$DEC" ]; then
  echo "✅ No secrets.yaml working copy — nothing to encrypt."
  exit 0
fi

if [ -f "$ENC" ]; then
  enc_content="$(sops --decrypt "$ENC" | yq -oj 'sort_keys(..)' -)"
  dec_content="$(yq -oj 'sort_keys(..)' "$DEC")"
  if [ "$enc_content" = "$dec_content" ]; then
    echo "✅ secrets.enc.yaml already in step with secrets.yaml — skipping (no churn)."
    exit 0
  fi
fi

sops --encrypt "$DEC" >"$ENC"
echo "🔐 Re-encrypted secrets.yaml -> secrets.enc.yaml. Commit secrets.enc.yaml."
