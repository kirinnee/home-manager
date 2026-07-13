#!/usr/bin/env bash

set -eou pipefail

# Decrypt the committed secrets.enc.yaml into the gitignored working copy
# secrets.yaml. The working copy is the source of truth while working —
# NEVER overwrite it if it already exists (it may hold unencrypted edits).
# Workflow: edit secrets.yaml directly; re-encrypt before committing with
# scripts/secrets/encrypt.sh (the a-secrets-sync pre-commit hook enforces it).

export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENC="$ROOT/secrets.enc.yaml"
DEC="$ROOT/secrets.yaml"

if [ -f "$DEC" ]; then
  echo "✅ secrets.yaml already exists — it is the working source of truth, not overwriting."
  echo "   (delete it first if you really want a fresh decrypt from secrets.enc.yaml)"
  exit 0
fi

sops --decrypt "$ENC" >"$DEC"
echo "🔓 Decrypted secrets.enc.yaml -> secrets.yaml (gitignored). Edit it directly."
