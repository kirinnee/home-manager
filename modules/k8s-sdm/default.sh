#!/bin/sh

echo "🛠 Generating kubeconfig"
mkdir -p "$HOME/.kube/configs"
mkdir -p "$HOME/.kube/k3dconfigs"

rm "$HOME/.kube/config" || true
rm "$HOME/.kube/configs/sdm" || true

sdm k8s update-config --dry-run >"$HOME/.kube/configs/sdm"

#!/bin/bash

# Directory containing YAML files
DIRECTORY="$HOME/.kube/configs"

# Iterate over YAML files
for file in "$DIRECTORY"/*.yaml; do
  if [ -f "$file" ]; then
    echo "Processing $file"

    # Use yq to remove prefixes before '/' in context names
    # e.g., changes 'prefix/contextName' to 'contextName'
    yq eval '.contexts[].name |= sub("^[^/]+/", "")' -i "$file"

    echo "Processed $file"
  fi
done

KUBECONFIG=$(cd ~/.kube/configs && find "$(pwd)"/* | awk 'ORS=":"')$(cd ~/.kube/k3dconfigs && find "$(pwd)"/* | awk 'ORS=":"') kubectl config view --flatten >~/.kube/config
chmod 600 ~/.kube/config
echo "✅ kubeconfig generated"
