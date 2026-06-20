#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: k8s-merge [output-file]

Merges kubeconfig files from these sources (each may be a directory of
kubeconfig files or a single kubeconfig file):
  ~/.kube/atomiconfigs  (atomi)
  ~/.kube/k3dconfigs    (k3d)
  ~/.kube/ociconfigs    (OCI/OKE)
  ~/.kube/eksconfigs    (EKS)
  ~/.kube/agentconfigs  (tailscale)
  ~/.kube/k3sconfigs    (k3s)

Default output:
  ~/.kube/config
USAGE
}

case "${1:-}" in
-h | --help)
  usage
  exit 0
  ;;
esac

out="${1:-${KUBE_MERGED_CONFIG:-$HOME/.kube/config}}"

sources=(
  "${ATOMI_KUBE_CONFIG_DIR:-$HOME/.kube/atomiconfigs}"
  "${KUBE_K3D_CONFIG_DIR:-$HOME/.kube/k3dconfigs}"
  "${OCI_KUBE_CONFIG_DIR:-$HOME/.kube/ociconfigs}"
  "${KUBE_CONFIG_DIR:-$HOME/.kube/eksconfigs}"
  "${AGENT_KUBE_CONFIG_DIR:-$HOME/.kube/agentconfigs}"
  "${KUBE_K3S_CONFIG_DIR:-$HOME/.kube/k3sconfigs}"
)

files=()
for src in "${sources[@]}"; do
  if [ -d "$src" ]; then
    while IFS= read -r -d '' file; do
      files+=("$file")
    done < <(find "$src" -type f \( -name '*.yaml' -o -name '*.yml' -o ! -name '*.*' \) -print0 | sort -z)
  elif [ -f "$src" ]; then
    files+=("$src")
  fi
done

if [ "${#files[@]}" -eq 0 ]; then
  echo "No kubeconfig files found." >&2
  exit 1
fi

kubeconfig=""
for file in "${files[@]}"; do
  kubeconfig="${kubeconfig}${file}:"
done
kubeconfig="${kubeconfig%:}"

mkdir -p "$(dirname "$out")"
tmp="$(mktemp)"
KUBECONFIG="$kubeconfig" kubectl config view --flatten >"$tmp"
mv -- "$tmp" "$out"
chmod 600 -- "$out"

echo "Merged ${#files[@]} kubeconfig file(s) into $out"
