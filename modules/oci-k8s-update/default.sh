#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: oci-k8s-update [options]

Discovers active OKE clusters and writes per-cluster kubeconfigs to
~/.kube/oci-configs. It does not start tunnels, create Bastion sessions,
run kubectl, or write ~/.kube/config.

Options:
  --all-regions             Discover OKE clusters in all subscribed regions.
  --region REGION           Discover only REGION. Defaults to OCI_CLI_REGION/current OCI default.
  --compartment-id OCID     Override compartment. Defaults to COMPARTMENT_ID or ~/.oci/oci_cli_rc.
  --endpoint MODE           Kube endpoint: PRIVATE_ENDPOINT, PUBLIC_ENDPOINT, VCN_HOSTNAME, LEGACY_KUBERNETES.
                            Defaults to OCI_OKE_ENDPOINT or PUBLIC_ENDPOINT.
  -h, --help                Show this help.

Then run:
  k8s-merge                 Merge all kubeconfig folders into ~/.kube/config.
USAGE
}

config_dir="${OCI_KUBE_CONFIG_DIR:-$HOME/.kube/oci-configs}"
endpoint="${OCI_OKE_ENDPOINT:-PUBLIC_ENDPOINT}"
region="${OCI_CLI_REGION:-}"
all_regions=0
compartment_id="${COMPARTMENT_ID:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
  --all-regions)
    all_regions=1
    ;;
  --region)
    region="$2"
    shift
    ;;
  --compartment-id)
    compartment_id="$2"
    shift
    ;;
  --endpoint)
    endpoint="$2"
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    usage >&2
    exit 2
    ;;
  esac
  shift
done

case "$endpoint" in
PRIVATE_ENDPOINT | PUBLIC_ENDPOINT | VCN_HOSTNAME | LEGACY_KUBERNETES) ;;
*)
  echo "Invalid --endpoint: $endpoint" >&2
  exit 2
  ;;
esac

mkdir -p "$config_dir"

if [ -n "$compartment_id" ]; then
  compartment_args=(--compartment-id "$compartment_id")
else
  compartment_args=()
fi

if [ "$all_regions" -eq 1 ]; then
  mapfile -t regions < <(oci iam region-subscription list --all --query 'data[]."region-name"' --raw-output | sed '/^$/d')
elif [ -n "$region" ]; then
  regions=("$region")
else
  regions=("")
fi

safe_name() {
  printf '%s' "$1" | tr -c '[:alnum:]._-' '-'
}

endpoint_host() {
  case "$endpoint" in
  PRIVATE_ENDPOINT) jq -r '.endpoints."private-endpoint" // empty' ;;
  PUBLIC_ENDPOINT) jq -r '.endpoints."public-endpoint" // empty' ;;
  VCN_HOSTNAME) jq -r '.endpoints."vcn-hostname-endpoint" // empty' ;;
  LEGACY_KUBERNETES) jq -r '.endpoints.kubernetes // empty' ;;
  esac
}

updated=0

for current_region in "${regions[@]}"; do
  region_args=()
  region_label="default"
  if [ -n "$current_region" ]; then
    region_args=(--region "$current_region")
    region_label="$current_region"
  fi

  clusters_json="$(oci ce cluster list "${compartment_args[@]}" "${region_args[@]}" --all --output json)"

  while IFS= read -r cluster; do
    [ -n "$cluster" ] || continue

    name="$(printf '%s\n' "$cluster" | jq -r '.name')"
    id="$(printf '%s\n' "$cluster" | jq -r '.id')"
    target_endpoint="$(printf '%s\n' "$cluster" | endpoint_host)"

    if [ -z "$target_endpoint" ]; then
      echo "Skipping $name in $region_label: no $endpoint endpoint." >&2
      continue
    fi

    safe="$(safe_name "$region_label-$name")"
    kubeconfig_file="$config_dir/$safe.yaml"
    context_name="oci-$region_label-$name"

    echo "Writing kubeconfig for $name ($region_label)"
    oci ce cluster create-kubeconfig \
      "${region_args[@]}" \
      --cluster-id "$id" \
      --file "$kubeconfig_file" \
      --overwrite \
      --with-auth-context \
      --kube-endpoint "$endpoint" >/dev/null

    CTX="$context_name" yq eval '
      .clusters[0].name = strenv(CTX) |
      .contexts[0].name = strenv(CTX) |
      .contexts[0].context.cluster = strenv(CTX) |
      .contexts[0].context.user = strenv(CTX) |
      .users[0].name = strenv(CTX) |
      .current-context = strenv(CTX)
    ' -i "$kubeconfig_file"

    chmod 600 "$kubeconfig_file"
    updated="$((updated + 1))"
  done < <(printf '%s\n' "$clusters_json" | jq -c '.data[] | select(."lifecycle-state" == "ACTIVE")')
done

if [ "$updated" -eq 0 ]; then
  echo "No active OKE clusters found." >&2
  exit 1
fi

echo "Wrote $updated OCI kubeconfig file(s) to $config_dir"
echo "Run k8s-merge to merge them into ~/.kube/config"
