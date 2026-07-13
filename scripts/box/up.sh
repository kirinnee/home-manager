#!/usr/bin/env bash

set -eou pipefail

# Provision a box on a cloud, then (optionally) replicate this whole
# home-manager + Workspace repos onto it in one shot:
#
#   ./scripts/box/up.sh <aws|digitalocean|oci> [--replicate] [profile]
#
# Credentials live in sops (.box.clouds.<cloud> in secrets.yaml) — see
# scripts/box/clouds.sh for the exact keys per cloud. The box login key is
# sops ssh_keys.id_ed25519_kirin (override: BOX_SSH_KEY=<name>). OpenTofu
# state is LOCAL and gitignored (infra/<cloud>/terraform.tfstate): bring the
# box down from the same machine that brought it up.

CLOUD="${1:?usage: up.sh <aws|digitalocean|oci> [--replicate] [profile]}"
shift
REPLICATE=0
if [ "${1:-}" = "--replicate" ]; then
  REPLICATE=1
  shift
fi
PROFILE="${1:-kirin}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC2034 # DEC is read by the sourced clouds.sh (secret_get)
DEC="$ROOT/secrets.yaml"
STACK="$ROOT/infra/$CLOUD"

# shellcheck source=scripts/box/clouds.sh disable=SC1091
. "$ROOT/scripts/box/clouds.sh"

"$ROOT/scripts/secrets/decrypt.sh" >/dev/null # ensure the working copy exists (never overwrites)
export_cloud_env "$CLOUD"
export_ssh_key_var

echo "☁️  Provisioning box on $CLOUD..."
tofu -chdir="$STACK" init -input=false >/dev/null
tofu -chdir="$STACK" apply -input=false -auto-approve

IP="$(tofu -chdir="$STACK" output -raw public_ip)"
BOX_USER="$(tofu -chdir="$STACK" output -raw user)"
echo ""
echo "✅ Box is up: $BOX_USER@$IP"

# Local `Host box` ssh entry (~/.ssh/config is nix-generated + read-only; the
# nix config Includes ~/.ssh/config.d/*.conf). Enables `ssh box`, `scp box:...`
# and Zed remote (`zed ssh://box/...`).
mkdir -p "$HOME/.ssh/config.d"
cat >"$HOME/.ssh/config.d/box.conf" <<EOF
Host box
  HostName $IP
  User $BOX_USER
  IdentityFile $BOX_SSH_PRIVATE_KEY_PATH
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
echo "🔗 Wrote ~/.ssh/config.d/box.conf — connect with: ssh box | zed ssh://box/~/Workspace"

if [ "$REPLICATE" -eq 0 ]; then
  echo ""
  echo "Next:"
  echo "  SSH_OPTS='-i $BOX_SSH_PRIVATE_KEY_PATH -o StrictHostKeyChecking=accept-new' \\"
  echo "    ./scripts/box/replicate.sh $BOX_USER@$IP $PROFILE"
  exit 0
fi

echo "⏳ Waiting for SSH (cloud-init) ..."
for i in $(seq 1 60); do
  if ssh -i "$BOX_SSH_PRIVATE_KEY_PATH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 \
    "$BOX_USER@$IP" true 2>/dev/null; then
    break
  fi
  [ "$i" -eq 60 ] && {
    echo "❌ SSH not reachable after 5 minutes."
    exit 1
  }
  sleep 5
done

SSH_OPTS="-i $BOX_SSH_PRIVATE_KEY_PATH -o StrictHostKeyChecking=accept-new" \
  "$ROOT/scripts/box/replicate.sh" "$BOX_USER@$IP" "$PROFILE"
