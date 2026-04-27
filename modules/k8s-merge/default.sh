#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: k8s-merge [output-file]

Merges kubeconfig files from:
  ~/.kube/configs
  ~/.kube/k3dconfigs
  ~/.kube/oci-configs

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

dirs=(
  "${KUBE_CONFIG_DIR:-$HOME/.kube/configs}"
  "${KUBE_K3D_CONFIG_DIR:-$HOME/.kube/k3dconfigs}"
  "${OCI_KUBE_CONFIG_DIR:-$HOME/.kube/oci-configs}"
)

files=()
for dir in "${dirs[@]}"; do
  [ -d "$dir" ] || continue
  while IFS= read -r -d '' file; do
    files+=("$file")
  done < <(find "$dir" -type f \( -name '*.yaml' -o -name '*.yml' -o -name '*.conf' -o -name '*.config' \) -print0 | sort -z)
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
