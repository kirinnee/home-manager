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

# --- Aptakube context icons ---
# Aptakube reads a per-context `aptakube` extension from the kubeconfig
# (https://aptakube.com/docs/context-extension). Each context gets a simple
# generated SVG: provider colour + short name, and an environment badge.
# Set KUBE_APTAKUBE_ICONS=0 to skip.
if [ "${KUBE_APTAKUBE_ICONS:-1}" = "1" ]; then
  icon_dir="${KUBE_APTAKUBE_ICON_DIR:-$HOME/.kube/icons}"
  mkdir -p "$icon_dir"

  # provider -> "label|background"
  provider_style() {
    case "$1" in
    aws) echo "AWS|#E8780C" ;;
    oci) echo "OCI|#9E3B2A" ;;
    do) echo "DO|#0061EB" ;;
    k3d) echo "K3D|#55636E" ;;
    k3s) echo "K3S|#55636E" ;;
    *) echo "K8S|#55636E" ;;
    esac
  }

  # environment -> badge colour
  env_colour() {
    case "$1" in
    PROD) echo "#E11D2E" ;;
    OPS) echo "#1D6FE1" ;;
    STAGE) echo "#D98200" ;;
    QA) echo "#7B3FE4" ;;
    DB) echo "#0E9384" ;;
    DATA) echo "#2E9E44" ;;
    SPARK) echo "#C2410C" ;;
    LLM) echo "#C2185B" ;;
    ML) echo "#6A4C93" ;;
    DASH) echo "#3F6E85" ;;
    POC) echo "#37474F" ;;
    RUBY) echo "#B3124A" ;;
    OPAL) echo "#1F8A7F" ;;
    *) echo "#37474F" ;;
    esac
  }

  context_provider() {
    case "$1" in
    k3d-*) echo k3d ;;
    primordial) echo k3s ;;
    *-ruby | *-opal) echo "do" ;;
    *oke* | *oci* | *mx-poc*) echo oci ;;
    *eks* | *aws*) echo aws ;;
    *) echo other ;;
    esac
  }

  context_env() {
    case "$1" in
    *prod*) echo PROD ;;
    *-ops-* | *-ops.*) echo OPS ;;
    *stage*) echo STAGE ;;
    *-qa-*) echo QA ;;
    *-db-*) echo DB ;;
    *-data-*) echo DATA ;;
    *spark*) echo SPARK ;;
    *-llm-*) echo LLM ;;
    *-ml-*) echo ML ;;
    *dashboard*) echo DASH ;;
    *poc*) echo POC ;;
    *-ruby) echo RUBY ;;
    *-opal) echo OPAL ;;
    k3d-* | primordial) echo LOCAL ;;
    *) echo "" ;;
    esac
  }

  write_icon() {
    local file="$1" label="$2" bg="$3" env="$4" badge="$5"
    {
      echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
      echo "<circle cx=\"64\" cy=\"64\" r=\"64\" fill=\"$bg\"/>"
      if [ -n "$env" ]; then
        echo "<text x=\"64\" y=\"58\" text-anchor=\"middle\" font-family=\"Helvetica, Arial, sans-serif\" font-weight=\"800\" font-size=\"34\" fill=\"#fff\">$label</text>"
        echo "<rect x=\"16\" y=\"70\" width=\"96\" height=\"34\" rx=\"17\" fill=\"$badge\" stroke=\"#fff\" stroke-width=\"4\"/>"
        echo "<text x=\"64\" y=\"94\" text-anchor=\"middle\" font-family=\"Helvetica, Arial, sans-serif\" font-weight=\"800\" font-size=\"20\" fill=\"#fff\">$env</text>"
      else
        echo "<text x=\"64\" y=\"77\" text-anchor=\"middle\" font-family=\"Helvetica, Arial, sans-serif\" font-weight=\"800\" font-size=\"38\" fill=\"#fff\">$label</text>"
      fi
      echo '</svg>'
    } >"$file"
  }

  iconed=0
  while IFS= read -r ctx; do
    [ -n "$ctx" ] || continue
    provider="$(context_provider "$ctx")"
    env="$(context_env "$ctx")"
    style="$(provider_style "$provider")"
    label="${style%%|*}"
    bg="${style#*|}"
    name="$provider${env:+-$(printf '%s' "$env" | tr '[:upper:]' '[:lower:]')}"
    icon="$icon_dir/$name.svg"
    write_icon "$icon" "$label" "$bg" "$env" "$(env_colour "$env")"
    CTX="$ctx" ICON="$icon" yq eval -i '
      (.contexts[] | select(.name == strenv(CTX)) | .context.extensions) |= (
        ((. // []) | map(select(.name != "aptakube")))
        + [{"name": "aptakube", "extension": {"icon": strenv(ICON)}}]
      )
    ' "$out"
    iconed="$((iconed + 1))"
  done < <(yq eval '.contexts[].name' "$out")

  echo "Set Aptakube icons on $iconed context(s) (icons in $icon_dir)"
fi
