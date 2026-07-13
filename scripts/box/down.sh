#!/usr/bin/env bash

set -eou pipefail

# Destroy the box provisioned by scripts/box/up.sh:
#
#   ./scripts/box/down.sh <aws|digitalocean|oci>
#
# Uses the same sops credentials and the LOCAL gitignored tofu state, so run
# it from the machine that ran up.sh. Everything on the box is lost — the box
# is disposable by design (all state replays from this repo + sops).

CLOUD="${1:?usage: down.sh <aws|digitalocean|oci>}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC2034 # DEC is read by the sourced clouds.sh (secret_get)
DEC="$ROOT/secrets.yaml"
STACK="$ROOT/infra/$CLOUD"

# shellcheck source=scripts/box/clouds.sh disable=SC1091
. "$ROOT/scripts/box/clouds.sh"

"$ROOT/scripts/secrets/decrypt.sh" >/dev/null
export_cloud_env "$CLOUD"
export_ssh_key_var

if [ ! -f "$STACK/terraform.tfstate" ]; then
  echo "⚠️  No local state at infra/$CLOUD/terraform.tfstate — nothing to destroy from this machine."
  exit 1
fi

echo "💥 Destroying the $CLOUD box..."
tofu -chdir="$STACK" init -input=false >/dev/null
tofu -chdir="$STACK" destroy -input=false -auto-approve
rm -f "$HOME/.ssh/config.d/box.conf"
echo "✅ Box destroyed (and ~/.ssh/config.d/box.conf removed)."
