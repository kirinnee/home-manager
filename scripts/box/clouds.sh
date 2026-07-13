#!/usr/bin/env bash

# Shared cloud plumbing for scripts/box/up.sh and down.sh — sourced, not run.
# Validates the cloud arg, reads that cloud's credentials from the DECRYPTED
# secrets.yaml (.box.clouds.<cloud>) and exports them the way each tofu
# provider expects. Fails with the exact secrets paths to fill when missing.

# shellcheck disable=SC2034  # consumers use these after sourcing
CLOUDS="aws|digitalocean|oci"

# secret_get <yq-path> — empty string when absent
secret_get() {
  yq -r "$1 // \"\"" "$DEC"
}

require_secrets() {
  local missing=("$@")
  echo "❌ Missing credentials in secrets.yaml — fill these keys, then retry:"
  printf '   .box.clouds.%s\n' "${missing[@]}"
  echo "   (then run ./scripts/secrets/encrypt.sh before committing)"
  exit 1
}

# export_cloud_env <cloud> — export provider credentials from sops
export_cloud_env() {
  local cloud="$1"
  case "$cloud" in
  aws)
    AWS_ACCESS_KEY_ID="$(secret_get '.box.clouds.aws.access_key_id')"
    AWS_SECRET_ACCESS_KEY="$(secret_get '.box.clouds.aws.secret_access_key')"
    local region
    region="$(secret_get '.box.clouds.aws.region')"
    [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] ||
      require_secrets "aws.access_key_id" "aws.secret_access_key"
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
    [ -n "$region" ] && export TF_VAR_region="$region"
    ;;
  digitalocean)
    DIGITALOCEAN_TOKEN="$(secret_get '.box.clouds.digitalocean.token')"
    local region
    region="$(secret_get '.box.clouds.digitalocean.region')"
    [ -n "$DIGITALOCEAN_TOKEN" ] || require_secrets "digitalocean.token"
    export DIGITALOCEAN_TOKEN
    [ -n "$region" ] && export TF_VAR_region="$region"
    ;;
  oci)
    TF_VAR_tenancy_ocid="$(secret_get '.box.clouds.oci.tenancy_ocid')"
    TF_VAR_user_ocid="$(secret_get '.box.clouds.oci.user_ocid')"
    TF_VAR_fingerprint="$(secret_get '.box.clouds.oci.fingerprint')"
    TF_VAR_private_key="$(secret_get '.box.clouds.oci.private_key')"
    TF_VAR_compartment_ocid="$(secret_get '.box.clouds.oci.compartment_ocid')"
    local region
    region="$(secret_get '.box.clouds.oci.region')"
    local missing=()
    [ -n "$TF_VAR_tenancy_ocid" ] || missing+=("oci.tenancy_ocid")
    [ -n "$TF_VAR_user_ocid" ] || missing+=("oci.user_ocid")
    [ -n "$TF_VAR_fingerprint" ] || missing+=("oci.fingerprint")
    [ -n "$TF_VAR_private_key" ] || missing+=("oci.private_key")
    [ ${#missing[@]} -eq 0 ] || require_secrets "${missing[@]}"
    export TF_VAR_tenancy_ocid TF_VAR_user_ocid TF_VAR_fingerprint TF_VAR_private_key TF_VAR_compartment_ocid
    [ -n "$region" ] && export TF_VAR_region="$region"
    ;;
  *)
    echo "❌ Unknown cloud '$cloud' — expected one of: aws | digitalocean | oci"
    exit 1
    ;;
  esac
}

# export_ssh_key_var — the box login key: sops ssh_keys.<BOX_SSH_KEY>.public
export_ssh_key_var() {
  local key_name="${BOX_SSH_KEY:-id_ed25519_kirin}"
  TF_VAR_ssh_public_key="$(secret_get ".ssh_keys.\"$key_name\".public")"
  if [ -z "$TF_VAR_ssh_public_key" ]; then
    echo "❌ No public key at .ssh_keys.$key_name.public in secrets.yaml (override with BOX_SSH_KEY=<name>)."
    exit 1
  fi
  export TF_VAR_ssh_public_key
  BOX_SSH_PRIVATE_KEY_PATH="$HOME/.ssh/$key_name"
}
