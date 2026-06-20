#!/usr/bin/env bash
set -euo pipefail

echo "🛠 Generating kubeconfig"
DIRECTORY="$HOME/.kube/eksconfigs"
REGIONS="${K8S_EKS_REGIONS:-${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}}"
EXTRA_CLUSTER_SPECS="${K8S_EKS_EXTRA_CLUSTER_SPECS:-}"

mkdir -p "$DIRECTORY"
mkdir -p "$HOME/.kube/k3dconfigs"

append_cluster_once() {
  local cluster="$1"

  case " $clusters " in
  *" $cluster "*) ;;
  *) clusters="${clusters}${clusters:+ }${cluster}" ;;
  esac
}

for region in $REGIONS; do
  echo "Discovering EKS clusters in $region"
  clusters="$(aws eks list-clusters --region "$region" --query 'clusters[]' --output text)"

  for spec in $EXTRA_CLUSTER_SPECS; do
    spec_region="${spec%%:*}"
    spec_cluster="${spec#*:}"

    if [ "$spec_region" = "$spec" ] || [ -z "$spec_region" ] || [ -z "$spec_cluster" ]; then
      echo "Invalid K8S_EKS_EXTRA_CLUSTER_SPECS entry: $spec" >&2
      echo "Expected entries like: us-east-1:eks-llm-us-east-1" >&2
      exit 2
    fi

    if [ "$spec_region" = "$region" ]; then
      append_cluster_once "$spec_cluster"
    fi
  done

  for cluster in $clusters; do
    echo "Updating EKS kubeconfig $cluster ($region)"
    aws eks update-kubeconfig \
      --region "$region" \
      --name "$cluster" \
      --alias "$cluster" \
      --user-alias "$cluster" \
      --kubeconfig "$DIRECTORY/$cluster.yaml" >/dev/null
  done
done

shopt -s nullglob
for file in "$DIRECTORY"/*.yaml; do
  echo "Processing $file"
  yq eval '
    .contexts[]?.name |= (
      sub("^arn:aws:eks:[^:]+:[^:]+:cluster/"; "")
      | sub("^[^/]+/"; "")
    )
  ' -i "$file"

  if [ "$(yq eval 'has("current-context")' "$file")" = "true" ]; then
    yq eval '
      ."current-context" |= (
        sub("^arn:aws:eks:[^:]+:[^:]+:cluster/"; "")
        | sub("^[^/]+/"; "")
      )
    ' -i "$file"
  fi
  echo "Processed $file"
done

# --- Tailscale (Kubernetes operator API server proxies) ---
# Discover peers tagged as Tailscale Kubernetes operators and write a
# per-cluster kubeconfig for each into ~/.kube/agentconfigs. `tailscale
# configure kubeconfig` honours $KUBECONFIG, so we point it at a dedicated file
# per cluster (it creates the file, sets cluster/context name to the peer FQDN
# and a shared `tailscale-auth` user).
AGENT_DIRECTORY="$HOME/.kube/agentconfigs"
TS_OPERATOR_TAGS="${TS_K8S_OPERATOR_TAGS:-tag:k8s-operator}"
mkdir -p "$AGENT_DIRECTORY"

if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  echo "Discovering Tailscale Kubernetes operators (tags: $TS_OPERATOR_TAGS)"
  read -r -a ts_tag_arr <<<"$TS_OPERATOR_TAGS"
  tags_json="$(printf '%s\n' "${ts_tag_arr[@]}" | jq -R . | jq -s .)"

  mapfile -t ts_peers < <(
    tailscale status --json | jq -r --argjson want "$tags_json" '
      (.Peer // {})
      | to_entries[]
      | .value
      | select(.Online == true)
      | select((.Tags // []) as $t | any($want[]; . as $w | ($t | index($w)) != null))
      | .DNSName
      | sub("\\.$"; "")
    ' | sort -u
  )

  if [ "${#ts_peers[@]}" -eq 0 ]; then
    echo "No online Tailscale operator peers found for tags: $TS_OPERATOR_TAGS"
  else
    for fqdn in "${ts_peers[@]}"; do
      [ -n "$fqdn" ] || continue
      short="${fqdn%%.*}"
      echo "Writing Tailscale kubeconfig for $fqdn"
      if ! KUBECONFIG="$AGENT_DIRECTORY/$short.yaml" tailscale configure kubeconfig "$fqdn"; then
        echo "Failed to configure kubeconfig for $fqdn; skipping" >&2
      fi
    done
  fi
else
  echo "Tailscale not running; skipping Tailscale kubeconfig discovery"
fi

# --- OCI (OKE Kubernetes clusters) ---
# Discover active OKE clusters and write a per-cluster kubeconfig into
# ~/.kube/ociconfigs (merged by k8s-merge below). Env-driven:
#   OCI_OKE_ENDPOINT       Kube endpoint mode (default PUBLIC_ENDPOINT)
#   OCI_CLI_REGION         Region to scan (default: OCI CLI default region)
#   COMPARTMENT_ID         Compartment OCID (default: ~/.oci/oci_cli_rc)
#   K8S_OKE_ALL_REGIONS=1  Scan all subscribed regions instead of one
OCI_DIRECTORY="${OCI_KUBE_CONFIG_DIR:-$HOME/.kube/ociconfigs}"
oci_endpoint="${OCI_OKE_ENDPOINT:-PUBLIC_ENDPOINT}"
oci_region="${OCI_CLI_REGION:-}"
oci_compartment_id="${COMPARTMENT_ID:-}"
mkdir -p "$OCI_DIRECTORY"

oci_endpoint_host() {
  case "$oci_endpoint" in
  PRIVATE_ENDPOINT) jq -r '.endpoints."private-endpoint" // empty' ;;
  PUBLIC_ENDPOINT) jq -r '.endpoints."public-endpoint" // empty' ;;
  VCN_HOSTNAME) jq -r '.endpoints."vcn-hostname-endpoint" // empty' ;;
  LEGACY_KUBERNETES) jq -r '.endpoints.kubernetes // empty' ;;
  esac
}

oci_safe_name() {
  printf '%s' "$1" | tr -c '[:alnum:]._-' '-'
}

if ! command -v oci >/dev/null 2>&1; then
  echo "OCI CLI not available; skipping OKE kubeconfig discovery"
else
  case "$oci_endpoint" in
  PRIVATE_ENDPOINT | PUBLIC_ENDPOINT | VCN_HOSTNAME | LEGACY_KUBERNETES) ;;
  *)
    echo "Invalid OCI_OKE_ENDPOINT: $oci_endpoint; skipping OKE discovery" >&2
    oci_endpoint=""
    ;;
  esac

  if [ -n "$oci_endpoint" ]; then
    echo "Discovering OKE clusters"

    if [ -n "$oci_compartment_id" ]; then
      oci_compartment_args=(--compartment-id "$oci_compartment_id")
    else
      oci_compartment_args=()
    fi

    if [ "${K8S_OKE_ALL_REGIONS:-0}" = "1" ]; then
      mapfile -t oci_regions < <(oci iam region-subscription list --all --query 'data[]."region-name"' --raw-output | sed '/^$/d')
    elif [ -n "$oci_region" ]; then
      oci_regions=("$oci_region")
    else
      oci_regions=("")
    fi

    oci_updated=0
    for current_region in "${oci_regions[@]}"; do
      oci_region_args=()
      region_label="default"
      if [ -n "$current_region" ]; then
        oci_region_args=(--region "$current_region")
        region_label="$current_region"
      fi

      if ! clusters_json="$(oci ce cluster list "${oci_compartment_args[@]}" "${oci_region_args[@]}" --all --output json 2>/dev/null)"; then
        echo "Failed to list OKE clusters in $region_label; skipping" >&2
        continue
      fi

      while IFS= read -r cluster; do
        [ -n "$cluster" ] || continue

        cname="$(printf '%s\n' "$cluster" | jq -r '.name')"
        cid="$(printf '%s\n' "$cluster" | jq -r '.id')"
        target_endpoint="$(printf '%s\n' "$cluster" | oci_endpoint_host)"

        if [ -z "$target_endpoint" ]; then
          echo "Skipping $cname in $region_label: no $oci_endpoint endpoint." >&2
          continue
        fi

        safe="$(oci_safe_name "$region_label-$cname")"
        kubeconfig_file="$OCI_DIRECTORY/$safe.yaml"
        context_name="oci-$region_label-$cname"

        echo "Writing OKE kubeconfig for $cname ($region_label)"
        oci ce cluster create-kubeconfig \
          "${oci_region_args[@]}" \
          --cluster-id "$cid" \
          --file "$kubeconfig_file" \
          --overwrite \
          --with-auth-context \
          --kube-endpoint "$oci_endpoint" >/dev/null

        CTX="$context_name" yq eval '
          .clusters[0].name = strenv(CTX) |
          .contexts[0].name = strenv(CTX) |
          .contexts[0].context.cluster = strenv(CTX) |
          .contexts[0].context.user = strenv(CTX) |
          .users[0].name = strenv(CTX) |
          .current-context = strenv(CTX)
        ' -i "$kubeconfig_file"

        chmod 600 "$kubeconfig_file"
        oci_updated="$((oci_updated + 1))"
      done < <(printf '%s\n' "$clusters_json" | jq -c '.data[] | select(."lifecycle-state" == "ACTIVE")')
    done

    echo "Wrote $oci_updated OKE kubeconfig file(s) to $OCI_DIRECTORY"
  fi
fi

k8s-merge
echo "✅ kubeconfig generated"
