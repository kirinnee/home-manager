#!/usr/bin/env bash
set -euo pipefail

echo "🛠 Generating kubeconfig"
DIRECTORY="$HOME/.kube/configs"
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

k8s-merge
echo "✅ kubeconfig generated"
