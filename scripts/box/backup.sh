#!/usr/bin/env bash

set -eou pipefail

# Nightly restic backup of ~/Workspace to Cloudflare R2. Runs ON the box
# (installed as ~/.local/bin/box-backup by scripts/box/backup-install.sh and
# triggered by the box-backup systemd user timer). Everything is derived at
# runtime from the sops-encrypted secrets (the age key is the only secret the
# box was seeded with):
#
#   .box.backup.restic_password    repo encryption password
#   .box.backup.bucket             R2 bucket (restic init auto-creates it)
#   .box.backup.r2.account_id      Cloudflare account holding the bucket
#                                  (PERSONAL account — intentionally NOT
#                                  .env.CLOUDFLARE_ACCOUNT_ID, which is AtomiCloud)
#   .box.backup.r2.*               R2 S3 access key pair from that account
#
# Retention: nightly snapshots, keep 7 days (forget --keep-daily 7 --prune).

export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"

ENC="${HM_CONFIG_DIR:-$HOME/.config/home-manager}/secrets.enc.yaml"
TARGET="${BACKUP_TARGET:-$HOME/Workspace}"

yaml="$(sops --decrypt "$ENC")"

sget() { yq -r "$1 // \"\"" <<<"$yaml"; }

RESTIC_PASSWORD="$(sget '.box.backup.restic_password')"
BUCKET="$(sget '.box.backup.bucket')"
AWS_ACCESS_KEY_ID="$(sget '.box.backup.r2.access_key_id')"
AWS_SECRET_ACCESS_KEY="$(sget '.box.backup.r2.secret_access_key')"
ACCOUNT_ID="$(sget '.box.backup.r2.account_id')"

for v in RESTIC_PASSWORD BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY ACCOUNT_ID; do
  if [ -z "${!v}" ]; then
    echo "❌ Missing secret for $v — fill .box.backup.* in secrets.yaml (decrypted), encrypt, push, and refresh the box's secrets.enc.yaml."
    exit 1
  fi
done

export RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export RESTIC_REPOSITORY="s3:https://$ACCOUNT_ID.r2.cloudflarestorage.com/$BUCKET"

if ! restic cat config >/dev/null 2>&1; then
  echo "🆕 Initializing restic repository in R2 bucket '$BUCKET'..."
  restic init
fi

echo "💾 Backing up $TARGET..."
restic backup "$TARGET" \
  --exclude '**/node_modules' \
  --exclude '**/.direnv' \
  --exclude '**/target/debug' \
  --exclude '**/target/release' \
  --exclude '**/.terraform' \
  --exclude '**/dist' \
  --exclude '**/.next'

echo "🧹 Pruning: keep last 7 daily snapshots..."
restic forget --keep-daily 7 --prune

echo "✅ Backup complete: $(restic snapshots --json | yq 'length') snapshots in repo."
